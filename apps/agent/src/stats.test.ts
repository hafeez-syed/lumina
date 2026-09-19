import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { createApp } from './app.js';
import { env } from './env.js';

/**
 * /stats has to reconcile with the request log rather than keep its own counter — a
 * number the logs disagree with is worse than no number. These seed `requests` rows and
 * assert the route derives from them.
 */
const uri = process.env.MONGODB_URI ?? '';
let client: MongoClient;
let db: Db;
let server: Server;
let base: string;

before(async () => {
  assert.ok(uri, 'MONGODB_URI must be set to run the agent tests');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Own database per file: node runs test files in parallel processes.
  db = client.db('lumina_test_stats');
  server = createApp({ db: async () => db, log: pino({ level: 'silent' }) }).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await db.collection('requests').deleteMany({});
});

after(async () => {
  server?.close();
  await client?.close();
});

const get = (userId?: string) =>
  fetch(`${base}/stats`, { headers: userId ? { 'x-user-id': userId } : {} });

type Req = Record<string, unknown>;
const seed = (rows: Req[]) => db.collection('requests').insertMany(rows as never[]);

const answer = (userId: string, over: Req = {}): Req => ({
  requestId: `req_${Math.random().toString(36).slice(2)}`,
  userId,
  route: 'POST /threads/:threadId/ask',
  status: 200,
  ms: 1000,
  depth: 'quick',
  costUsd: 0.01,
  createdAt: new Date().toISOString(),
  ...over
});

test('stats are all zero before anything has run', async () => {
  const res = await get('alice');
  assert.equal(res.status, 200);

  const body = (await res.json()) as Record<string, number>;
  assert.equal(body.requests, 0);
  assert.equal(body.answers, 0);
  assert.equal(body.costUsdToday, 0);
  assert.equal(body.deepToday, 0);
});

test('the deep daily cap is reported from configuration', async () => {
  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(body.deepDailyCap, env.deepDailyCap);
});

test('requests and answers count only the caller’s own rows', async () => {
  await seed([answer('alice'), answer('alice'), answer('bob')]);

  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(body.requests, 2);
  assert.equal(body.answers, 2);
});

test('a non-answer request counts as a request but not an answer', async () => {
  await seed([answer('alice', { route: 'GET /threads', depth: undefined })]);

  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(body.requests, 1);
  assert.equal(body.answers, 0);
});

test('deepToday counts only deep runs from today', async () => {
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  await seed([
    answer('alice', { depth: 'deep' }),
    answer('alice', { depth: 'deep', createdAt: yesterday }),
    answer('alice', { depth: 'quick' })
  ]);

  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(body.deepToday, 1);
});

test('costUsdToday sums today’s spend and ignores older rows', async () => {
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  await seed([
    answer('alice', { costUsd: 0.02 }),
    answer('alice', { costUsd: 0.03 }),
    answer('alice', { costUsd: 9.99, createdAt: yesterday })
  ]);

  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(Number(body.costUsdToday?.toFixed(4)), 0.05);
});

test('the search cache hit rate is a percentage of answers that were cached', async () => {
  await seed([
    answer('alice', { searchCached: true }),
    answer('alice', { searchCached: true }),
    answer('alice', { searchCached: false }),
    answer('alice', { searchCached: false })
  ]);

  const body = (await (await get('alice')).json()) as Record<string, number>;
  assert.equal(body.searchCacheHitRatePct, 50);
});

test('ttft p95 is reported from recorded time-to-first-token', async () => {
  await seed(Array.from({ length: 20 }, (_, i) => answer('alice', { ttftMs: (i + 1) * 100 })));

  const body = (await (await get('alice')).json()) as Record<string, number>;
  // 20 samples, p95 → the 19th value (1900ms) by nearest-rank.
  assert.equal(body.ttftP95Ms, 1900);
});

test('stats need X-User-Id', async () => {
  assert.equal((await get()).status, 401);
});
