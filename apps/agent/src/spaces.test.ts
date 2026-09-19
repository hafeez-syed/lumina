import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * Spaces and uploads. The load-bearing assertion is that POST /documents returns 202
 * quickly and leaves a queued job behind: parsing a 60-page PDF on the request thread is
 * the failure the bench catches as a blown search p95, not as an obvious bug.
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
  db = client.db('lumina_test_spaces');
  server = createApp({ db: async () => db, log: pino({ level: 'silent' }) }).listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  for (const c of ['spaces', 'documents', 'jobs', 'uploads.files', 'uploads.chunks']) {
    await db.collection(c).deleteMany({});
  }
});

after(async () => {
  server?.close();
  await client?.close();
});

const json = (method: string, path: string, userId?: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(userId ? { 'x-user-id': userId } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

const upload = (spaceId: string, userId: string, name: string, content: string, type: string) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${base}/spaces/${spaceId}/documents`, {
    method: 'POST',
    headers: { 'x-user-id': userId },
    body: form
  });
};

const makeSpace = async (userId: string, name = 'Papers') =>
  (await (await json('POST', '/spaces', userId, { name })).json()) as { spaceId: string };

test('creating a Space returns a prefixed id and its name', async () => {
  const res = await json('POST', '/spaces', 'alice', { name: 'Papers' });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { spaceId: string; name: string };
  assert.match(body.spaceId, /^spc_[A-Za-z0-9_-]+$/);
  assert.equal(body.name, 'Papers');
});

test('a Space with no name is rejected', async () => {
  assert.equal((await json('POST', '/spaces', 'alice', { name: '' })).status, 400);
});

test('listing Spaces returns only the caller’s own', async () => {
  await makeSpace('alice', 'alice space');
  await makeSpace('bob', 'bob space');

  const body = (await (await json('GET', '/spaces', 'alice')).json()) as {
    spaces: { name: string }[];
  };
  assert.equal(body.spaces.length, 1);
  assert.equal(body.spaces[0]?.name, 'alice space');
});

test('uploading a document is accepted with 202 and status pending', async () => {
  const { spaceId } = await makeSpace('alice');
  const res = await upload(spaceId, 'alice', 'notes.md', '# hello', 'text/markdown');

  assert.equal(res.status, 202);
  const body = (await res.json()) as { docId: string; status: string };
  assert.match(body.docId, /^doc_[A-Za-z0-9_-]+$/);
  assert.equal(body.status, 'pending');
});

test('an upload queues a job instead of parsing inline', async () => {
  const { spaceId } = await makeSpace('alice');
  const { docId } = (await (
    await upload(spaceId, 'alice', 'notes.md', '# hello', 'text/markdown')
  ).json()) as { docId: string };

  const job = await db.collection('jobs').findOne({ 'payload.docId': docId });
  assert.ok(job, 'expected an index_document job to be queued');
  assert.equal(job?.kind, 'index_document');
  assert.equal(job?.status, 'pending');
});

test('the uploaded bytes are stored, not discarded', async () => {
  const { spaceId } = await makeSpace('alice');
  await upload(spaceId, 'alice', 'notes.md', '# hello', 'text/markdown');

  assert.equal(await db.collection('uploads.files').countDocuments({}), 1);
});

test('an unsupported file type is rejected with 415', async () => {
  const { spaceId } = await makeSpace('alice');
  const res = await upload(spaceId, 'alice', 'evil.exe', 'MZ', 'application/x-msdownload');

  assert.equal(res.status, 415);
});

test('a .md file the browser labelled application/octet-stream is still accepted', async () => {
  // Browsers routinely send octet-stream for markdown; rejecting on mime alone would
  // fail a file the product is documented to support.
  const { spaceId } = await makeSpace('alice');
  const res = await upload(spaceId, 'alice', 'notes.md', '# hello', 'application/octet-stream');

  assert.equal(res.status, 202);
});

test('uploading into another user’s Space is a 404', async () => {
  const { spaceId } = await makeSpace('alice');
  const res = await upload(spaceId, 'bob', 'notes.md', '# hello', 'text/markdown');

  assert.equal(res.status, 404);
});

test('listing documents shows the pending upload', async () => {
  const { spaceId } = await makeSpace('alice');
  await upload(spaceId, 'alice', 'notes.md', '# hello', 'text/markdown');

  const body = (await (await json('GET', `/spaces/${spaceId}/documents`, 'alice')).json()) as {
    documents: { title: string; status: string; pct: number }[];
  };

  assert.equal(body.documents.length, 1);
  assert.equal(body.documents[0]?.title, 'notes.md');
  assert.equal(body.documents[0]?.status, 'pending');
  assert.equal(body.documents[0]?.pct, 0);
});

test('listing documents in another user’s Space is a 404', async () => {
  const { spaceId } = await makeSpace('alice');
  assert.equal((await json('GET', `/spaces/${spaceId}/documents`, 'bob')).status, 404);
});

test('spaces need X-User-Id', async () => {
  assert.equal((await json('GET', '/spaces')).status, 401);
});
