import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * The memory routes are the "listed and deletable" half of the contract: nothing is
 * remembered that GET /memory does not show, and deleting one makes its effect vanish.
 * Memories are written by the save_memory tool, so these tests seed them directly.
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
  db = client.db('lumina_test_memory');
  server = createApp({ db: async () => db, log: pino({ level: 'silent' }) }).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await db.collection('memories').deleteMany({});
});

after(async () => {
  server?.close();
  await client?.close();
});

const call = (method: string, path: string, userId?: string) =>
  fetch(base + path, {
    method,
    headers: userId ? { 'x-user-id': userId } : {}
  });

const seed = (id: string, userId: string, text: string, createdAt: string) =>
  db.collection('memories').insertOne({
    _id: id as unknown as never,
    userId,
    text,
    // Real memories carry an embedding; the list route must not depend on it.
    embedding: [],
    createdAt
  });

test('listing memory is an empty list, not a 404, when nothing is remembered', async () => {
  const res = await call('GET', '/memory', 'alice');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { memories: [] });
});

test('listing returns only the caller’s memories', async () => {
  await seed('mem_a', 'alice', 'prefers British English', '2026-01-01T00:00:00.000Z');
  await seed('mem_b', 'bob', 'prefers tabs', '2026-01-01T00:00:00.000Z');

  const body = (await (await call('GET', '/memory', 'alice')).json()) as {
    memories: { id: string; text: string }[];
  };

  assert.equal(body.memories.length, 1);
  assert.equal(body.memories[0]?.text, 'prefers British English');
});

test('the embedding is never exposed to the client', async () => {
  await seed('mem_a', 'alice', 'prefers British English', '2026-01-01T00:00:00.000Z');
  const body = (await (await call('GET', '/memory', 'alice')).json()) as {
    memories: Record<string, unknown>[];
  };
  assert.ok(body.memories[0]);
  assert.equal('embedding' in body.memories[0], false);
});

test('memories are listed newest first', async () => {
  await seed('mem_old', 'alice', 'older', '2026-01-01T00:00:00.000Z');
  await seed('mem_new', 'alice', 'newer', '2026-06-01T00:00:00.000Z');

  const body = (await (await call('GET', '/memory', 'alice')).json()) as {
    memories: { text: string }[];
  };
  assert.deepEqual(
    body.memories.map((m) => m.text),
    ['newer', 'older']
  );
});

test('deleting a memory removes it from the list', async () => {
  await seed('mem_a', 'alice', 'prefers British English', '2026-01-01T00:00:00.000Z');

  const res = await call('DELETE', '/memory/mem_a', 'alice');
  assert.equal(res.status, 204);

  const body = (await (await call('GET', '/memory', 'alice')).json()) as { memories: unknown[] };
  assert.deepEqual(body.memories, []);
});

test('deleting another user’s memory is a 404 and leaves it intact', async () => {
  await seed('mem_a', 'alice', 'prefers British English', '2026-01-01T00:00:00.000Z');

  const res = await call('DELETE', '/memory/mem_a', 'bob');
  assert.equal(res.status, 404);

  assert.equal(await db.collection('memories').countDocuments({ _id: 'mem_a' as never }), 1);
});

test('deleting an unknown memory is a 404', async () => {
  const res = await call('DELETE', '/memory/mem_nope', 'alice');
  assert.equal(res.status, 404);
});

test('memory needs X-User-Id', async () => {
  assert.equal((await call('GET', '/memory')).status, 401);
});
