import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { AskStreamEvent, unresolvedCitations, type Source } from '@lumina/contract';
import { createApp } from './app.js';
import type { Providers, ToolDecision } from './providers.js';
import { env } from './env.js';

/**
 * The loop is driven by fake providers so every guarantee here — event order, caps,
 * failing loud, grounding — is proven without spending a cent on a provider. One live
 * smoke test belongs elsewhere; these assert the mechanics.
 */
const uri = process.env.MONGODB_URI ?? '';
let client: MongoClient;
let db: Db;
let server: Server;
let base: string;

/** What the fake model will decide, in order. `null` means "ready to answer". */
/** A throwaway runs dir: synthetic trajectories must never reach the graded runs/. */
const runsDir = mkdtempSync(join(tmpdir(), 'lumina-runs-'));

let script: (ToolDecision | null)[] = [];
let answerText = 'Vector search is approximate [1].';
let llmThrows = false;

const hits = [
  { title: 'Atlas Vector Search', url: 'https://example.com/a', snippet: 'SEARCH-ENGINE-SUMMARY one' },
  { title: 'Cosine scan', url: 'https://example.com/b', snippet: 'SEARCH-ENGINE-SUMMARY two' }
];

/** Distinct from the search snippet so a test can tell which one was cited. */
const PAGE_TEXT =
  'PAGE-BODY Atlas Vector Search uses approximate nearest neighbour indexes to trade a ' +
  'little recall for a great deal of speed, which is the whole point of an approximate index.';
let fetchFails = false;
/**
 * A JS-rendered page Readability cannot read: what comes back is navigation chrome, not
 * content. The bench caught exactly this — a YouTube watch page cited with the snippet
 * "AboutPressCopyright...© 2026 Google LLC", 10 tokens of boilerplate that support no
 * claim and cannot carry the checker's 12-token window.
 */
const CHROME_TEXT = 'About Press Copyright Contact us Creators Advertise Developers © 2026 Google LLC';
const thinPages = new Set<string>();
/** Lets a test put measurable time inside retrieval, so a timing stamp is not just 0. */
let searchDelayMs = 0;

const providers: Providers = {
  llm: {
    model: 'fake-model',
    async plan() {
      return {
        subQuestions: [
          { i: 1, question: 'What is vector search?', reason: 'define it' },
          { i: 2, question: 'How does Atlas index it?', reason: 'the mechanism' }
        ],
        reason: 'two parts'
      };
    },
    async decide() {
      if (llmThrows) throw new Error('provider exploded');
      return script.length ? (script.shift() ?? null) : null;
    },
    async *streamAnswer() {
      if (llmThrows) throw new Error('provider exploded');
      for (const part of answerText.match(/.{1,8}/g) ?? []) yield part;
    },
    usage: () => ({ tokensIn: 100, tokensOut: 40, costUsd: 0.0012 })
  },
  search: {
    name: 'fake-search',
    async search() {
      if (searchDelayMs) await new Promise((r) => setTimeout(r, searchDelayMs));
      return { hits, cached: false };
    }
  },
  page: {
    async fetch(url: string) {
      if (fetchFails) throw new Error(`403 for ${url}`);
      if (thinPages.has(url)) return { title: `Page ${url}`, text: CHROME_TEXT };
      return { title: `Page ${url}`, text: PAGE_TEXT };
    }
  },
  embed: {
    model: 'fake-embed',
    async embed(texts: string[]) {
      return texts.map(() => Array.from({ length: 1536 }, () => 0));
    }
  }
};

before(async () => {
  assert.ok(uri, 'MONGODB_URI must be set to run the agent tests');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Own database per file: node runs test files in parallel processes.
  db = client.db('lumina_test_ask');
  server = createApp({ db: async () => db, log: pino({ level: 'silent' }), providers, runsDir }).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  for (const c of ['threads', 'messages', 'requests', 'runs', 'memories']) {
    await db.collection(c).deleteMany({});
  }
  script = [{ tool: 'web_search', input: { query: 'vector search' }, reason: 'need the web' }];
  answerText = 'Vector search is approximate [1].';
  llmThrows = false;
  fetchFails = false;
  searchDelayMs = 0;
});

after(async () => {
  server?.close();
  await client?.close();
});

async function newThread(userId = 'alice'): Promise<string> {
  const res = await fetch(`${base}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: '{}'
  });
  return ((await res.json()) as { threadId: string }).threadId;
}

type Frame = { event: string; data: unknown };

/** Read the whole SSE stream into ordered frames. */
async function ask(
  threadId: string,
  body: Record<string, unknown>,
  userId = 'alice',
  requestId = `req_${Math.random().toString(36).slice(2, 10)}`
): Promise<{ status: number; frames: Frame[] }> {
  const res = await fetch(`${base}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId, 'x-request-id': requestId },
    body: JSON.stringify(body)
  });
  if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { status: res.status, frames: [] };
  }

  const text = await res.text();
  const frames: Frame[] = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
  }
  return { status: res.status, frames };
}

const names = (frames: Frame[]) => frames.map((f) => f.event);

test('a quick ask streams trace, then sources, then tokens, then done', async () => {
  const { frames } = await ask(await newThread(), { query: 'what is vector search?' });
  const order = names(frames);

  assert.ok(order.includes('trace'), 'expected at least one trace step');
  assert.equal(order.at(-1), 'done');
  assert.ok(order.indexOf('sources') < order.indexOf('token'), 'sources must precede the first token');
});

test('every event validates against the contract', async () => {
  const { frames } = await ask(await newThread(), { query: 'what is vector search?' });
  for (const f of frames) {
    const parsed = AskStreamEvent.safeParse(f);
    assert.ok(parsed.success, `bad ${f.event} frame: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test('every [n] in the answer resolves to a source that was retrieved', async () => {
  const { frames } = await ask(await newThread(), { query: 'what is vector search?' });

  const sources = frames.find((f) => f.event === 'sources')?.data as Source[];
  const answer = frames
    .filter((f) => f.event === 'token')
    .map((f) => (f.data as { text: string }).text)
    .join('');

  assert.deepEqual(unresolvedCitations(answer, sources), []);
});

test('an answer is never produced without at least one retrieval step', async () => {
  // The model is entitled to think it can answer from memory. This is a search engine:
  // an answer with no retrieved sources is ungrounded by construction.
  script = [];

  const { frames } = await ask(await newThread(), { query: 'what is vector search?' });

  const retrieval = frames
    .filter((f) => f.event === 'trace')
    .map((f) => (f.data as { tool: string }).tool)
    .filter((t) => t === 'web_search' || t === 'search_documents');

  assert.ok(retrieval.length >= 1, 'expected at least one retrieval step before answering');
  assert.ok((frames.find((f) => f.event === 'sources')?.data as Source[]).length > 0);
});

test('a citation quotes the fetched page, not the search engine’s summary', async () => {
  // The grounding check re-fetches the page and looks for the snippet in it. A search
  // engine's summary is a paraphrase and is not present in the page, which is exactly how
  // grounding measured 0.625 against a 0.95 target.
  const { frames } = await ask(await newThread(), { query: 'approximate nearest neighbour' });
  const sources = frames.find((f) => f.event === 'sources')?.data as Source[];

  assert.ok(sources.length > 0, 'expected at least one source');
  for (const s of sources) {
    assert.ok(
      PAGE_TEXT.includes(s.snippet),
      `snippet is not a verbatim span of the page: ${s.snippet.slice(0, 60)}`
    );
    assert.equal(s.snippet.includes('SEARCH-ENGINE-SUMMARY'), false);
  }
});

test('when every page fetch fails it falls back to snippets and says so in the trace', async () => {
  // AGENTS.md permits the fallback; it does not permit hiding it.
  fetchFails = true;

  const { frames } = await ask(await newThread(), { query: 'approximate nearest neighbour' });
  const sources = frames.find((f) => f.event === 'sources')?.data as Source[];
  const trace = frames.filter((f) => f.event === 'trace').map((f) => f.data as Record<string, unknown>);

  assert.ok(sources.length > 0, 'an answer with no sources is worse than a snippet-based one');
  assert.ok(
    trace.some((t) => /snippet/i.test(String(t.reason ?? '')) || /snippet/i.test(String(t.error ?? ''))),
    'the fallback to search snippets must be visible in the trace'
  );
});

test('the done event reports the gear that actually ran', async () => {
  const { frames } = await ask(await newThread(), { query: 'q' });
  const done = frames.at(-1)?.data as { depth: string; terminated: string; model: string };

  assert.equal(done.depth, 'quick');
  assert.equal(done.terminated, 'done');
  assert.equal(done.model, 'fake-model');
});

test('a run that hits the tool-call cap terminates as cap, not as success', async () => {
  // More decisions than the quick cap allows.
  script = Array.from({ length: env.maxToolCalls + 4 }, () => ({
    tool: 'web_search' as const,
    input: { query: 'again' },
    reason: 'loop'
  }));

  const { frames } = await ask(await newThread(), { query: 'q' });
  const done = frames.at(-1)?.data as { terminated: string };

  assert.equal(done.terminated, 'cap');
  assert.ok(
    frames.filter((f) => f.event === 'trace').length <= env.maxToolCalls,
    'must not exceed the tool-call cap'
  );
});

test('a provider exception ends the stream as an error, never a plausible answer', async () => {
  llmThrows = true;
  const { frames } = await ask(await newThread(), { query: 'q' });

  assert.equal(names(frames).at(-1), 'error');
  assert.equal(
    frames.some((f) => f.event === 'token'),
    false,
    'no answer text may be emitted when the provider threw'
  );
});

test('a failed tool step carries a non-empty error string', async () => {
  script = [{ tool: 'fetch_page', input: { url: 'not-a-url' }, reason: 'try a bad page' }];
  const { frames } = await ask(await newThread(), { query: 'q' });

  const failed = frames
    .filter((f) => f.event === 'trace')
    .map((f) => f.data as { ok: boolean; error?: string })
    .filter((t) => !t.ok);

  for (const t of failed) assert.ok(t.error?.trim(), 'ok:false must carry an error (A1)');
});

test('a quick search may never call plan_research', async () => {
  // Even when the model asks for it.
  script = [{ tool: 'plan_research', input: {}, reason: 'I want to escalate' }];
  const { frames } = await ask(await newThread(), { query: 'q' });

  const used = frames.filter((f) => f.event === 'trace').map((f) => (f.data as { tool: string }).tool);
  assert.equal(used.includes('plan_research'), false, 'a quick run escalated itself');
});

test('a deep search streams its plan before any retrieval', async () => {
  const { frames } = await ask(await newThread(), { query: 'q', depth: 'deep' });
  const order = names(frames);

  assert.equal(order[0], 'plan');
  assert.ok(order.indexOf('plan') < order.indexOf('trace'), 'the plan must precede retrieval');
});

test('a deep run reports its sub-question count', async () => {
  const { frames } = await ask(await newThread(), { query: 'q', depth: 'deep' });
  const done = frames.at(-1)?.data as { depth: string; subQuestions?: number };

  assert.equal(done.depth, 'deep');
  assert.equal(done.subQuestions, 2);
});

test('the server never upgrades a request to deep on its own', async () => {
  const { frames } = await ask(await newThread(), { query: 'a hard multi-part question' });
  const done = frames.at(-1)?.data as { depth: string };
  assert.equal(done.depth, 'quick');
});

test('an unknown thread is a 404 before any stream starts', async () => {
  const { status, frames } = await ask('thr_nope', { query: 'q' });
  assert.equal(status, 404);
  assert.deepEqual(frames, []);
});

test('another user’s thread is a 404', async () => {
  const threadId = await newThread('alice');
  const { status } = await ask(threadId, { query: 'q' }, 'bob');
  assert.equal(status, 404);
});

test('an empty query is a 400', async () => {
  const { status } = await ask(await newThread(), { query: '' });
  assert.equal(status, 400);
});

test('the question and the answer are persisted to the thread', async () => {
  const threadId = await newThread();
  await ask(threadId, { query: 'what is vector search?' });

  const res = await fetch(`${base}/threads/${threadId}`, { headers: { 'x-user-id': 'alice' } });
  const body = (await res.json()) as { messages: { role: string; content: string }[] };

  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0]?.role, 'user');
  assert.equal(body.messages[0]?.content, 'what is vector search?');
  assert.equal(body.messages[1]?.role, 'assistant');
  assert.ok(body.messages[1]?.content.includes('[1]'));
});

test('each answer writes one run log the gates can read', async () => {
  const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
  await ask(await newThread(), { query: 'q' }, 'alice', requestId);

  const file = join(runsDir, `${requestId}.json`);
  assert.ok(existsSync(file), `expected a run log at ${file}`);

  const run = JSON.parse(readFileSync(file, 'utf8')) as {
    tokens: number;
    terminated: string;
    depth: string;
    toolCalls: { name: string; ok: boolean }[];
  };
  assert.equal(run.terminated, 'done');
  assert.equal(run.depth, 'quick');
  assert.ok(Array.isArray(run.toolCalls));
});

test('the request row records what /stats needs', async () => {
  await ask(await newThread(), { query: 'q' });

  const row = await db.collection('requests').findOne({ userId: 'alice' });
  assert.ok(row, 'expected a request row');
  assert.equal(typeof row?.ttftMs, 'number');
  assert.equal(typeof row?.searchCached, 'boolean');
  assert.equal(row?.depth, 'quick');
});

/**
 * `ttftMs` alone cannot say whether a slow first token went on retrieval or on waiting for
 * the model after retrieval finished. `sourcesMs` is the boundary between the two.
 *
 * The stubs normally finish retrieval inside a millisecond, which would make every stamp
 * read 0 and let this test pass wherever the stamp was placed — including after the stream
 * loop, which is precisely the bug worth catching. So retrieval is given a real 25ms and
 * the assertion is that the stamp lands on the retrieval side of it.
 */
const SEARCH_DELAY_MS = 25;

test('the request row splits ttft into retrieval and everything after it', async () => {
  searchDelayMs = SEARCH_DELAY_MS;
  await ask(await newThread(), { query: 'q' });

  const row = await db.collection('requests').findOne({ userId: 'alice' });
  assert.ok(row, 'expected a request row');
  assert.equal(typeof row?.sourcesMs, 'number');
  assert.ok(
    (row?.sourcesMs as number) >= SEARCH_DELAY_MS,
    `sourcesMs ${row?.sourcesMs} is below the ${SEARCH_DELAY_MS}ms spent searching, so it was not stamped after retrieval`
  );
  assert.ok(
    (row?.sourcesMs as number) <= (row?.ttftMs as number),
    'sources are emitted before the first token, so sourcesMs cannot exceed ttftMs'
  );
});

test('a saved memory is stored with an embedding, not an empty vector', async () => {
  script = [
    { tool: 'save_memory', input: { text: 'always answer in British English' }, reason: 'a stated preference' }
  ];

  await ask(await newThread(), { query: 'remember that' });

  const row = await db.collection('memories').findOne({ userId: 'alice' });
  assert.ok(row, 'expected the memory to be saved');
  assert.ok(
    Array.isArray(row?.embedding) && (row.embedding as number[]).length > 0,
    'a memory with no vector can never be recalled'
  );
});

test('the deep daily cap is enforced in the agent, with a resetsAt', async () => {
  const threadId = await newThread();
  const today = new Date().toISOString();
  await db.collection('requests').insertMany(
    Array.from({ length: env.deepDailyCap }, (_, i) => ({
      requestId: `req_seed${i}`,
      userId: 'alice',
      route: 'POST /threads/:threadId/ask',
      status: 200,
      ms: 1,
      depth: 'deep',
      createdAt: today
    })) as never[]
  );

  const res = await fetch(`${base}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'alice' },
    body: JSON.stringify({ query: 'q', depth: 'deep' })
  });

  assert.equal(res.status, 429);
  const body = (await res.json()) as { resetsAt?: string };
  assert.ok(body.resetsAt, 'a 429 must say when the cap resets');
});

const YT = 'https://www.youtube.com/watch?v=OOwxoPdTN40';

test('a page too thin to carry a grounding window is not cited', async () => {
  thinPages.add(YT);
  script = [{ tool: 'fetch_page', input: { url: YT }, reason: 'read the video page' }];

  const { frames } = await ask(await newThread(), { query: 'approximate nearest neighbour' });
  const sources = frames.find((f) => f.event === 'sources')?.data as Source[];
  thinPages.delete(YT);

  assert.ok(sources.length > 0, 'the readable pages should still be cited');
  assert.equal(
    sources.some((s) => s.url === YT),
    false,
    'a chrome-only page became a citable source, which is an ungrounded citation by construction'
  );
});

test('a page rejected as too thin is a failed step with a reason, not a silent drop', async () => {
  thinPages.add(YT);
  script = [{ tool: 'fetch_page', input: { url: YT }, reason: 'read the video page' }];

  const { frames } = await ask(await newThread(), { query: 'approximate nearest neighbour' });
  thinPages.delete(YT);

  const step = frames
    .filter((f) => f.event === 'trace')
    .map((f) => f.data as { tool: string; ok: boolean; error?: string })
    .find((t) => t.tool === 'fetch_page' && !t.ok);

  assert.ok(step, 'the rejected fetch left no failed trace step');
  assert.ok(step.error?.trim(), 'ok:false must carry an error (A1)');
});

test('a call that already failed with the same input is not retried until the cap', async () => {
  /**
   * The deployed failure this comes from (req_21a83d72-efd): in docs mode
   * search_documents returns chunks with no url, the model called fetch_page with an
   * empty one, got the identical error, and called it again — five times, until the
   * tool cap. 28 seconds and 205k tokens on an answer that never landed, and a run
   * that terminates 'cap', which rule A2 counts as a failure however good the answer.
   *
   * Grinding through the budget on a call that cannot work is the bug. Answering with
   * what has already been retrieved is the fix.
   */
  script = Array.from({ length: env.maxToolCalls + 4 }, () => ({
    tool: 'fetch_page' as const,
    input: { url: '' },
    reason: 'read the document'
  }));

  const { frames } = await ask(await newThread(), { query: 'q' });
  const done = frames.at(-1)?.data as { terminated: string };
  const failed = frames
    .filter((f) => f.event === 'trace')
    .map((f) => f.data as { tool: string; ok: boolean })
    .filter((t) => t.tool === 'fetch_page' && !t.ok);

  assert.equal(done.terminated, 'done', 'the loop ground to the cap on a call it had already failed');
  assert.ok(failed.length <= 1, `the same failing call was repeated ${failed.length} times`);
});
