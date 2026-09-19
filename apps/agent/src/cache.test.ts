import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchCacheDoc } from '@lumina/contract';
import {
  CachedPage,
  CachedSearch,
  Lru,
  cacheKey,
  isTimeSensitive,
  normalizeQuery,
  type CacheStore
} from './cache.js';
import type { PageFetcher, SearchHit, SearchKey, SearchProvider } from './providers.js';

/**
 * The cache is policy, not plumbing, so it is tested through its seam rather than against
 * Mongo: a fake store and a fake clock make "expired", "restart" and "database down"
 * ordinary test cases instead of things you wait for.
 *
 * The hit rate this protects has no margin. The bench workload is 40 web queries of which
 * 20 are exact repeats, and the gate is >= 50%, so every repeat must hit.
 */
const hit = (title: string): SearchHit => ({ title, url: `https://x/${title}`, snippet: title });

/** Counts provider calls, because "did it hit" really means "did we pay". */
class FakeSearch implements SearchProvider {
  readonly name = 'tavily';
  calls: string[] = [];
  constructor(private readonly onCall: (q: string) => Promise<SearchHit[]> = async (q) => [hit(q)]) {}
  async search(query: string, _key?: SearchKey): Promise<{ hits: SearchHit[]; cached: boolean }> {
    this.calls.push(query);
    return { hits: await this.onCall(query), cached: false };
  }
}

class FakeStore implements CacheStore {
  rows = new Map<string, SearchCacheDoc>();
  reads = 0;
  failRead = false;
  failWrite = false;
  async get(key: string): Promise<SearchCacheDoc | null> {
    this.reads++;
    if (this.failRead) throw new Error('store down');
    return this.rows.get(key) ?? null;
  }
  async put(doc: SearchCacheDoc): Promise<void> {
    if (this.failWrite) throw new Error('store down');
    this.rows.set(doc._id, doc);
  }
}

// ---------------------------------------------------------------- key

test('normalizeQuery folds case, whitespace and trailing punctuation', () => {
  assert.equal(normalizeQuery('  What   is a TTL index? '), 'what is a ttl index');
  assert.equal(normalizeQuery('What is a TTL index'), 'what is a ttl index');
});

test('the key is stable across those differences and separates providers', () => {
  assert.equal(cacheKey('What is a TTL index?', 'tavily'), cacheKey('what is  a ttl index', 'tavily'));
  assert.notEqual(cacheKey('q', 'tavily'), cacheKey('q', 'serpapi'));
});

test('the ordinal separates a refinement from the search it refines', () => {
  assert.notEqual(cacheKey('q', 'tavily', 0), cacheKey('q', 'tavily', 1));
  assert.equal(cacheKey('q', 'tavily'), cacheKey('q', 'tavily', 0), 'the first search is ordinal 0');
});

test('the key does not fuse genuinely different questions', () => {
  assert.notEqual(cacheKey('what is BM25', 'tavily'), cacheKey('what is BM52', 'tavily'));
});

// ---------------------------------------------------------------- freshness policy

test('time-sensitive queries are recognised', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  assert.equal(isTimeSensitive('what happened today', now), true);
  assert.equal(isTimeSensitive('the LATEST Node release', now), true);
  assert.equal(isTimeSensitive('EU AI Act obligations in 2027', now), true);
});

test('a past year is not time-sensitive, and neither is the bench workload', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  assert.equal(isTimeSensitive('what shipped in 2019', now), false);
  // Every query in benchmark/queries.json must stay cacheable or the gate cannot be met.
  for (const q of [
    'What are the GPAI obligations in the EU AI Act?',
    'How does reciprocal rank fusion combine two ranked lists?',
    'What is a TTL index in MongoDB?',
    'How large is a text-embedding-3-small vector?'
  ]) {
    assert.equal(isTimeSensitive(q, now), false, q);
  }
});

// ---------------------------------------------------------------- LRU

test('the LRU evicts least-recently-used, and a read counts as use', () => {
  const lru = new Lru<number>(2);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.get('a');
  lru.set('c', 3);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('b'), undefined, 'b was least recently used');
  assert.equal(lru.get('c'), 3);
  assert.equal(lru.size, 2);
});

// ---------------------------------------------------------------- the two tiers

test('a repeated query hits and does not call the provider again', async () => {
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, new FakeStore(), { ttlSeconds: 3600 });

  const first = await cache.search('What is a TTL index?');
  const second = await cache.search('what is a ttl index');

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.hits, first.hits);
  assert.equal(inner.calls.length, 1, 'the repeat must not reach the provider');
});

test('tier 2 serves a process whose LRU is empty, as after a restart', async () => {
  const store = new FakeStore();
  const warm = new CachedSearch(new FakeSearch(), store, { ttlSeconds: 3600 });
  await warm.search('what is bm25');

  const inner = new FakeSearch();
  const cold = new CachedSearch(inner, store, { ttlSeconds: 3600 });
  const res = await cold.search('what is bm25');

  assert.equal(res.cached, true);
  assert.equal(inner.calls.length, 0);
  assert.deepEqual(res.hits, [hit('what is bm25')]);
});

test('an expired row is a miss even while the TTL index has not swept it', async () => {
  const store = new FakeStore();
  let clock = 1_000_000;
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, store, { ttlSeconds: 60, now: () => clock });

  await cache.search('q');
  clock += 61_000;
  const res = await cache.search('q');

  assert.equal(res.cached, false, 'past expiresAt is stale however the row got there');
  assert.equal(inner.calls.length, 2);
  assert.equal(store.rows.size, 1, 'and the refreshed result overwrites the same key');
});

test('concurrent copies of one query make a single provider call', async () => {
  // The gate exists up front: the provider must still be in flight when the second and
  // third callers arrive, which is the only state in which coalescing is observable.
  let release: (v: SearchHit[]) => void = () => {};
  const gate = new Promise<SearchHit[]>((r) => (release = r));
  const inner = new FakeSearch(() => gate);
  const cache = new CachedSearch(inner, new FakeStore(), { ttlSeconds: 3600 });

  const all = Promise.all([cache.search('q'), cache.search('q'), cache.search('q')]);
  await new Promise((r) => setImmediate(r));
  release([hit('q')]);
  const [a, b, c] = await all;

  assert.equal(inner.calls.length, 1, 'concurrent copies must not become three bills');
  assert.equal(a?.cached, false, 'the originator paid');
  assert.equal(b?.cached, true);
  assert.equal(c?.cached, true);
  assert.deepEqual(c?.hits, [hit('q')]);
});

test('a failed provider call is not cached and is not swallowed', async () => {
  const inner = new FakeSearch(async () => {
    throw new Error('tavily 500');
  });
  const store = new FakeStore();
  const cache = new CachedSearch(inner, store, { ttlSeconds: 3600 });

  await assert.rejects(cache.search('q'), /tavily 500/);
  assert.equal(store.rows.size, 0);
  // The in-flight entry must be released, or the key is poisoned for the process's life.
  await assert.rejects(cache.search('q'), /tavily 500/);
  assert.equal(inner.calls.length, 2);
});

// ---------------------------------------------------------------- degradation

test('a store that is down costs money, not answers', async () => {
  const store = new FakeStore();
  store.failRead = true;
  store.failWrite = true;
  const errors: string[] = [];
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, store, {
    ttlSeconds: 3600,
    onError: (which) => errors.push(which)
  });

  const res = await cache.search('q');
  assert.equal(res.cached, false);
  assert.deepEqual(res.hits, [hit('q')]);
  assert.deepEqual(errors, ['read', 'write'], 'degraded loudly, both directions');

  // The LRU still works, so the process is not reduced to no cache at all.
  assert.equal((await cache.search('q')).cached, true);
  assert.equal(inner.calls.length, 1);
});

test('a time-sensitive query bypasses both tiers in both directions', async () => {
  const store = new FakeStore();
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, store, { ttlSeconds: 3600 });

  const first = await cache.search('latest node release');
  const second = await cache.search('latest node release');

  assert.equal(first.cached, false);
  assert.equal(second.cached, false);
  assert.equal(inner.calls.length, 2);
  assert.equal(store.rows.size, 0, 'writing it would serve it stale for the whole TTL');
  assert.equal(store.reads, 0, 'and reading it is pointless work');
});

// ---------------------------------------------------------------- keying on the question

/**
 * Measured, not assumed: asked the same bench question twice, the model emitted the same
 * search terms only 2 times in 5 ("SerpApi pricing per search request" one run, "SerpApi
 * pricing how does it charge per search request" the next). The workload repeats
 * questions, so the question is what the entry has to be filed under.
 */
test('the same question hits even when the model rewrites it differently', async () => {
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, new FakeStore(), { ttlSeconds: 3600 });
  const basis = 'How does SerpApi price its search requests?';

  const first = await cache.search('SerpApi pricing per search request', { basis, ordinal: 0 });
  const second = await cache.search('SerpApi pricing how does it charge', { basis, ordinal: 0 });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true, 'a drifting rewrite must not cost a hit');
  assert.equal(inner.calls.length, 1);
});

test('different questions do not collide just because they are both searched', async () => {
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, new FakeStore(), { ttlSeconds: 3600 });

  await cache.search('a', { basis: 'what is BM25', ordinal: 0 });
  const other = await cache.search('b', { basis: 'what is RRF', ordinal: 0 });

  assert.equal(other.cached, false);
  assert.equal(inner.calls.length, 2);
});

test('a second search for one question is its own entry, not the first one replayed', async () => {
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, new FakeStore(), { ttlSeconds: 3600 });
  const basis = 'what is BM25';

  const first = await cache.search('BM25 definition', { basis, ordinal: 0 });
  const refine = await cache.search('BM25 saturation parameter k1', { basis, ordinal: 1 });

  assert.equal(refine.cached, false, 'a refinement must reach the provider');
  assert.deepEqual(refine.hits, [hit('BM25 saturation parameter k1')]);
  assert.notDeepEqual(refine.hits, first.hits);
  // ...and the next run of the same question lines its two searches up with these two.
  assert.equal((await cache.search('anything', { basis, ordinal: 1 })).cached, true);
});

test('time-sensitivity is judged on the question, not the model rewrite', async () => {
  const store = new FakeStore();
  const inner = new FakeSearch();
  const cache = new CachedSearch(inner, store, { ttlSeconds: 3600 });

  // The model added a year; the question is timeless, so the entry must still be cached.
  await cache.search('EU AI Act GPAI obligations 2027', {
    basis: 'What are the GPAI obligations in the EU AI Act?',
    ordinal: 0
  });
  assert.equal(store.rows.size, 1, 'a rewrite must not make a cacheable question uncacheable');

  // And the reverse: a genuinely time-sensitive question is not cached however it is rewritten.
  await cache.search('node release notes', { basis: 'what is the latest Node release', ordinal: 0 });
  assert.equal(store.rows.size, 1);
});

// ------------------------------------------------------------------ CachedPage
/**
 * `fetch_page` was the one retrieval call with no cache in front of it: providers.ts
 * built a bare `ReadablePage()`, so a repeated question re-downloaded the same pages and
 * paid ~1.1s of TTFT for bytes it already had. Unlike the search cache this is one tier —
 * an in-process LRU — because the durable tier would need a `pageCache` collection in
 * `packages/contract`, which this assignment may not modify.
 *
 * The TTL is deliberately short: the grounding checker re-fetches pages live, so a snippet
 * served from a stale cache can drift out of the page it claims to quote.
 */
class FakePage implements PageFetcher {
  calls: string[] = [];
  fail = false;
  constructor(private readonly onCall: (url: string) => Promise<{ title: string; text: string }> =
    async (url) => ({ title: `t:${url}`, text: `body of ${url}` })) {}
  async fetch(url: string): Promise<{ title: string; text: string }> {
    this.calls.push(url);
    if (this.fail) throw new Error('upstream page fetch failed');
    return this.onCall(url);
  }
}

test('a repeated url is served from cache instead of re-fetched', async () => {
  const inner = new FakePage();
  const page = new CachedPage(inner, { ttlSeconds: 60 });

  const first = await page.fetch('https://example.com/a');
  const second = await page.fetch('https://example.com/a');

  assert.deepEqual(second, first, 'the cached page differs from the fetched one');
  assert.equal(inner.calls.length, 1, 'the provider was paid twice for one url');
});

test('an expired page is re-fetched rather than served stale', async () => {
  const inner = new FakePage();
  let clock = 1_000;
  const page = new CachedPage(inner, { ttlSeconds: 60, now: () => clock });

  await page.fetch('https://example.com/a');
  clock += 61_000;
  await page.fetch('https://example.com/a');

  assert.equal(inner.calls.length, 2, 'a page past its ttl was served from cache');
});

test('concurrent readers of one url share a single fetch', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const inner = new FakePage(async (url) => {
    await gate;
    return { title: 't', text: `body of ${url}` };
  });
  const page = new CachedPage(inner, { ttlSeconds: 60 });

  const all = Promise.all([
    page.fetch('https://example.com/a'),
    page.fetch('https://example.com/a'),
    page.fetch('https://example.com/a')
  ]);
  release();
  const [a, b, c] = await all;

  assert.equal(inner.calls.length, 1, 'three concurrent readers each paid for the same url');
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('a failed fetch is not cached, so the url stays retryable', async () => {
  const inner = new FakePage();
  const page = new CachedPage(inner, { ttlSeconds: 60 });

  inner.fail = true;
  await assert.rejects(() => page.fetch('https://example.com/a'), /upstream page fetch failed/);

  inner.fail = false;
  const ok = await page.fetch('https://example.com/a');
  assert.equal(ok.text, 'body of https://example.com/a', 'a failed fetch poisoned the url');
});
