import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * Threads run against a real Mongo on a throwaway database rather than a mocked
 * collection: the behaviour worth protecting is "one user never sees another user's
 * thread", and a mock would happily return whatever the test told it to.
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
  db = client.db('lumina_test_threads');

  server = createApp({ db: async () => db, log: pino({ level: 'silent' }) }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await db.collection('threads').deleteMany({});
  await db.collection('messages').deleteMany({});
});

after(async () => {
  server?.close();
  await client?.close();
});

const call = (method: string, path: string, userId?: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(userId ? { 'x-user-id': userId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

test('creating a thread returns a prefixed threadId', async () => {
  const res = await call('POST', '/threads', 'alice', {});
  assert.equal(res.status, 201);
  const body = (await res.json()) as { threadId: string };
  assert.match(body.threadId, /^thr_[A-Za-z0-9_-]+$/);
});

test('a created thread keeps the title it was given', async () => {
  const created = await (await call('POST', '/threads', 'alice', { title: 'Vector search' })).json();
  const res = await call('GET', `/threads/${(created as { threadId: string }).threadId}`, 'alice');

  assert.equal(res.status, 200);
  const body = (await res.json()) as { title: string; messages: unknown[] };
  assert.equal(body.title, 'Vector search');
  assert.deepEqual(body.messages, []);
});

test('a thread created without a title still has one', async () => {
  const created = await (await call('POST', '/threads', 'alice', {})).json();
  const body = (await (
    await call('GET', `/threads/${(created as { threadId: string }).threadId}`, 'alice')
  ).json()) as { title: string };

  assert.ok(body.title.length > 0, 'expected a fallback title');
});

test('rejects a title longer than the contract allows', async () => {
  const res = await call('POST', '/threads', 'alice', { title: 'x'.repeat(201) });
  assert.equal(res.status, 400);
});

test('listing threads returns only the caller’s own', async () => {
  await call('POST', '/threads', 'alice', { title: 'alice one' });
  await call('POST', '/threads', 'bob', { title: 'bob one' });

  const body = (await (await call('GET', '/threads', 'alice')).json()) as {
    threads: { title: string }[];
  };

  assert.equal(body.threads.length, 1);
  assert.equal(body.threads[0]?.title, 'alice one');
});

test('reading another user’s thread is a 404, not a 403', async () => {
  // 403 would confirm the id exists. A stranger learns nothing from a 404.
  const created = (await (await call('POST', '/threads', 'alice', {})).json()) as {
    threadId: string;
  };
  const res = await call('GET', `/threads/${created.threadId}`, 'bob');
  assert.equal(res.status, 404);
});

test('an unknown threadId is a 404', async () => {
  const res = await call('GET', '/threads/thr_doesnotexist', 'alice');
  assert.equal(res.status, 404);
});

test('threads are listed newest first', async () => {
  await call('POST', '/threads', 'alice', { title: 'older' });
  await call('POST', '/threads', 'alice', { title: 'newer' });

  const body = (await (await call('GET', '/threads', 'alice')).json()) as {
    threads: { title: string }[];
  };

  assert.deepEqual(
    body.threads.map((t) => t.title),
    ['newer', 'older']
  );
});

test('the agent also requires X-User-Id', async () => {
  // The gateway enforces it too, but the agent must not trust that it was called
  // through the gateway.
  const res = await call('GET', '/threads');
  assert.equal(res.status, 401);
});
