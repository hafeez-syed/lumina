/**
 * The search cache: two tiers in front of the web search provider.
 *
 * Tier 1 is an in-process LRU, which costs a map lookup. Tier 2 is the `searchCache`
 * collection, which survives a restart and is shared by every process pointed at the same
 * database — the tier that matters after a deploy, when the LRU is empty and the provider
 * bill is not.
 *
 * Both tiers are keyed identically, by a SHA-256 of `(provider, normalized query)`. Keying
 * them differently is the bug that looks like a low hit rate: the LRU misses, Mongo hits
 * under another name, and the two tiers quietly disagree about what is cached.
 *
 * `expiresAt` is checked in code as well as by the TTL index. Mongo's sweeper runs about
 * once a minute, so an expired row is readable for up to a minute after its time — the
 * index reclaims space, it does not enforce freshness.
 *
 * Nothing here is allowed to break a search. A cache is an optimisation, and a database
 * that is down must cost money, not answers: every store error degrades to the provider
 * and is reported through `onError` rather than thrown.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { COLLECTIONS, type SearchCacheDoc } from '@lumina/contract';
import { env } from './env.js';
import type { PageFetcher, SearchHit, SearchKey, SearchProvider } from './providers.js';

/**
 * Case and whitespace are not meaning. Trailing punctuation is not either: "what is a TTL
 * index?" and "What is a TTL index" are one query to a search engine and must be one key.
 * Nothing more aggressive than that — stemming or stopword removal would fuse questions
 * that genuinely differ, and serving the wrong cached results is worse than missing.
 */
export function normalizeQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.,;:]+$/, '')
    .trim();
}

/**
 * The key both tiers use. The provider is part of it because their result shapes differ.
 * The ordinal is part of it so that a request which searches twice for one question keeps
 * two entries rather than serving its refinement the first search's results — and so the
 * next run of the same question lines its two searches up with these two.
 */
export function cacheKey(basis: string, provider: string, ordinal = 0): string {
  return createHash('sha256')
    .update(`${provider}\n${ordinal}\n${normalizeQuery(basis)}`)
    .digest('hex');
}

/**
 * Some questions are about now, and a six-hour-old answer to them is wrong rather than
 * stale. These bypass both tiers in each direction: they are not read and not written,
 * because writing one would poison the key for the next six hours.
 *
 * Deliberately literal — the three triggers named in the spec and nothing else. A loose
 * pattern here silently disables caching for queries that were perfectly cacheable, which
 * shows up as a hit rate nobody can explain.
 */
export function isTimeSensitive(query: string, now = new Date()): boolean {
  const q = query.toLowerCase();
  if (/\b(today|latest)\b/.test(q)) return true;

  const currentYear = now.getUTCFullYear();
  for (const match of q.matchAll(/\b(\d{4})\b/g)) {
    if (Number(match[1]) >= currentYear) return true;
  }
  return false;
}

/** A bounded map in recency order: `Map` iterates by insertion, so re-insert on read. */
export class Lru<V> {
  private readonly items = new Map<string, V>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.items.size;
  }

  get(key: string): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.max) {
      // The first key in insertion order is the least recently used.
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }
}

/** The durable tier, behind an interface so the policy above can be tested without Mongo. */
export interface CacheStore {
  get(key: string): Promise<SearchCacheDoc | null>;
  put(doc: SearchCacheDoc): Promise<void>;
}

export function mongoCacheStore(getDb: () => Promise<Db>): CacheStore {
  return {
    async get(key) {
      const db = await getDb();
      const row = await db.collection(COLLECTIONS.searchCache).findOne({ _id: key as never });
      return (row as SearchCacheDoc | null) ?? null;
    },
    async put(doc) {
      const db = await getDb();
      const { _id, ...rest } = doc;
      // Upsert, not insert: two processes can miss the same key at the same moment, and
      // the second one losing a race must not be an error.
      await db
        .collection(COLLECTIONS.searchCache)
        .updateOne({ _id: _id as never }, { $set: rest }, { upsert: true });
    }
  };
}

type Entry = { hits: SearchHit[]; expiresAt: number };

export type CachedSearchDeps = {
  ttlSeconds?: number;
  maxEntries?: number;
  now?: () => number;
  /** A cache that fails silently is indistinguishable from one that is not there. */
  onError?: (which: 'read' | 'write', err: unknown) => void;
};

/**
 * `SearchProvider` in, `SearchProvider` out. The ask loop is unchanged: it already reads
 * `cached` off the result and only reports `searchCached: true` when every search in the
 * request was a hit.
 */
export class CachedSearch implements SearchProvider {
  readonly name: string;

  private readonly lru: Lru<Entry>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /**
   * Requests for a key whose provider call is already running. Without this, four
   * concurrent copies of one query all miss, and all four pay the provider for the same
   * results — the exact case a cache exists to prevent.
   */
  private readonly inflight = new Map<string, Promise<SearchHit[]>>();

  constructor(
    private readonly inner: SearchProvider,
    private readonly store: CacheStore,
    private readonly deps: CachedSearchDeps = {}
  ) {
    this.name = inner.name;
    this.ttlMs = (deps.ttlSeconds ?? env.searchCacheTtlSeconds) * 1000;
    this.lru = new Lru<Entry>(deps.maxEntries ?? 500);
    this.now = deps.now ?? Date.now;
  }

  /**
   * `key.basis` is the question, `query` is the model's rewrite of it. We file under the
   * question and ask the provider the rewrite. Without a key — a caller that has no
   * question to attribute the search to — the rewrite is all there is, and the entry is
   * as stable as the model is.
   */
  async search(query: string, key?: SearchKey): Promise<{ hits: SearchHit[]; cached: boolean }> {
    const basis = key?.basis ?? query;

    // Judged on the question, not the rewrite: a model that adds "2026" to its search
    // terms must not quietly turn a cacheable question into an uncacheable one.
    if (isTimeSensitive(basis, new Date(this.now()))) {
      return { hits: await this.inner.search(query).then((r) => r.hits), cached: false };
    }

    const cacheId = cacheKey(basis, this.name, key?.ordinal ?? 0);
    const now = this.now();

    const local = this.lru.get(cacheId);
    if (local && local.expiresAt > now) return { hits: local.hits, cached: true };

    /**
     * A joiner reports a hit. It made no provider call — which is what the hit rate is a
     * proxy for — and treating it as a miss would understate a cache that just did its
     * job.
     */
    const running = this.inflight.get(cacheId);
    if (running) return { hits: await running, cached: true };

    /**
     * Everything from here to `inflight.set` must stay synchronous. An `await` before the
     * key is registered — reading the durable tier, say — lets every concurrent copy of
     * the query past the check, and four callers each pay for the same results. The work
     * therefore goes inside a promise that is registered in the same tick it is created.
     */
    let fromStore = false;
    const work = (async (): Promise<SearchHit[]> => {
      const stored = await this.readStore(cacheId, now);
      if (stored) {
        fromStore = true;
        this.lru.set(cacheId, stored);
        return stored.hits;
      }

      const { hits } = await this.inner.search(query, key);
      const expiresAt = this.now() + this.ttlMs;
      this.lru.set(cacheId, { hits, expiresAt });
      await this.writeStore(cacheId, basis, hits, expiresAt);
      return hits;
    })();
    this.inflight.set(cacheId, work);

    try {
      return { hits: await work, cached: fromStore };
    } finally {
      // Released on failure too, or one bad provider call poisons the key for the life
      // of the process.
      this.inflight.delete(cacheId);
    }
  }

  private async readStore(key: string, now: number): Promise<Entry | null> {
    try {
      const row = await this.store.get(key);
      if (!row) return null;
      // The TTL index reclaims space on its own schedule; freshness is decided here.
      const expiresAt = new Date(row.expiresAt as string | Date).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
      return { hits: row.results as unknown as SearchHit[], expiresAt };
    } catch (err) {
      this.deps.onError?.('read', err);
      return null;
    }
  }

  private async writeStore(
    key: string,
    basis: string,
    hits: SearchHit[],
    expiresAt: number
  ): Promise<void> {
    try {
      await this.store.put({
        _id: key,
        provider: this.name as SearchCacheDoc['provider'],
        query: normalizeQuery(basis),
        results: hits as unknown as Record<string, unknown>[],
        expiresAt: new Date(expiresAt).toISOString(),
        createdAt: new Date(this.now()).toISOString()
      });
    } catch (err) {
      // The LRU already has it, so this process still benefits; the next one will not.
      this.deps.onError?.('write', err);
    }
  }
}

type PageEntry = { page: { title: string; text: string }; expiresAt: number };

export type CachedPageDeps = {
  ttlSeconds?: number;
  maxEntries?: number;
  now?: () => number;
};

/**
 * A cache in front of `fetch_page`, which had none: `providers.ts` built a bare
 * `ReadablePage()`, so a repeated question re-downloaded pages it had already read and
 * paid the latency again before the first token.
 *
 * One tier, not two. The durable tier would need a `pageCache` collection declared in
 * `packages/contract`, which this assignment may not modify, so this is an in-process LRU
 * and a restart starts cold. That is the honest trade: it helps a warm process and does
 * nothing after a deploy.
 *
 * The TTL is short by default. The grounding checker re-fetches each cited page live and
 * looks for the stored snippet inside it, so a page served from a long-lived cache can
 * drift out of the document it claims to quote — a cache that costs grounding is not worth
 * the milliseconds.
 */
export class CachedPage implements PageFetcher {
  private readonly lru: Lru<PageEntry>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** As in `CachedSearch`: concurrent readers of one url must not all pay for it. */
  private readonly inflight = new Map<string, Promise<{ title: string; text: string }>>();

  constructor(
    private readonly inner: PageFetcher,
    deps: CachedPageDeps = {}
  ) {
    this.ttlMs = (deps.ttlSeconds ?? 300) * 1000;
    this.lru = new Lru<PageEntry>(deps.maxEntries ?? 200);
    this.now = deps.now ?? Date.now;
  }

  async fetch(url: string): Promise<{ title: string; text: string }> {
    const now = this.now();

    const local = this.lru.get(url);
    if (local && local.expiresAt > now) return local.page;

    const running = this.inflight.get(url);
    if (running) return running;

    const work = (async () => {
      const page = await this.inner.fetch(url);
      this.lru.set(url, { page, expiresAt: this.now() + this.ttlMs });
      return page;
    })();
    this.inflight.set(url, work);

    try {
      return await work;
    } finally {
      // Released on failure too: a page that failed once must be retryable, and an
      // errored promise left in the map would be re-awaited by every later caller.
      this.inflight.delete(url);
    }
  }
}
