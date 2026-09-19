import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GridFSBucket, MongoClient, type Db } from 'mongodb';
import pino from 'pino';
import { claimJob, indexDocument, sweepStaleJobs } from './worker.js';
import type { Embedder } from './providers.js';

/**
 * The worker's contract: claim atomically, do the work off the request path, and only
 * call a document `indexed` once a read-your-write probe has found one of its chunks.
 * "Upserted" is not "searchable".
 */
const uri = process.env.MONGODB_URI ?? '';
let client: MongoClient;
let db: Db;

const embed: Embedder = {
  model: 'fake-embed',
  async embed(texts: string[]) {
    return texts.map((_, i) => Array.from({ length: 1536 }, () => (i + 1) / 1000));
  }
};

const log = pino({ level: 'silent' });

before(async () => {
  assert.ok(uri, 'MONGODB_URI must be set to run the agent tests');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Own database per file: node runs test files in parallel processes.
  db = client.db('lumina_test_worker');
});

beforeEach(async () => {
  for (const c of ['jobs', 'documents', 'chunks', 'uploads.files', 'uploads.chunks']) {
    await db.collection(c).deleteMany({});
  }
});

after(async () => {
  await client?.close();
});

async function storeFile(name: string, content: string): Promise<string> {
  const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
  return new Promise<string>((resolve, reject) => {
    const s = bucket.openUploadStream(name);
    s.on('error', reject);
    s.on('finish', () => resolve(String(s.id)));
    s.end(Buffer.from(content, 'utf8'));
  });
}

async function seedDocument(text: string, title = 'notes.md'): Promise<string> {
  const fileId = await storeFile(title, text);
  const docId = `doc_${Math.random().toString(36).slice(2, 10)}`;
  await db.collection('documents').insertOne({
    _id: docId as never,
    spaceId: 'spc_test',
    userId: 'alice',
    title,
    mimeType: 'text/markdown',
    bytes: text.length,
    status: 'pending',
    pct: 0,
    fileId,
    createdAt: new Date().toISOString()
  } as never);
  await db.collection('jobs').insertOne({
    _id: `job_${docId}` as never,
    kind: 'index_document',
    status: 'pending',
    payload: { docId, spaceId: 'spc_test', fileId },
    userId: 'alice',
    attempts: 0,
    createdAt: new Date().toISOString()
  } as never);
  return docId;
}

test('claiming a job marks it running and records who took it', async () => {
  await seedDocument('# hello');

  const job = await claimJob(db, 'worker-1');

  assert.ok(job, 'expected to claim the pending job');
  assert.equal(job?.status, 'running');
  assert.equal(job?.workerId, 'worker-1');
  assert.equal(job?.attempts, 1);
});

test('two workers never claim the same job', async () => {
  await seedDocument('# hello');

  // The claim must be one atomic findOneAndUpdate, not read-then-write.
  const [a, b] = await Promise.all([claimJob(db, 'worker-1'), claimJob(db, 'worker-2')]);

  const claimed = [a, b].filter(Boolean);
  assert.equal(claimed.length, 1, 'exactly one worker may claim a job');
});

test('claiming returns null when the queue is empty', async () => {
  assert.equal(await claimJob(db, 'worker-1'), null);
});

test('indexing a document chunks it, embeds it and marks it indexed', async () => {
  const docId = await seedDocument('# Retrieval\n\nVector search is approximate. '.repeat(40));
  const job = await claimJob(db, 'worker-1');
  assert.ok(job);

  await indexDocument(db, job, { embed, log });

  const doc = await db.collection('documents').findOne({ _id: docId as never });
  assert.equal(doc?.status, 'indexed');
  assert.equal(doc?.pct, 100);

  const chunks = await db.collection('chunks').countDocuments({ docId });
  assert.ok(chunks > 0, 'expected chunks to be written');
  assert.equal(doc?.chunks, chunks);
});

test('every chunk carries an embedding and a locator', async () => {
  const docId = await seedDocument('# Heading\n\nSome text about vector search. '.repeat(30));
  const job = await claimJob(db, 'worker-1');
  await indexDocument(db, job!, { embed, log });

  const chunk = await db.collection('chunks').findOne({ docId });
  assert.ok(chunk);
  assert.equal((chunk?.embedding as number[])?.length, 1536);
  assert.ok(chunk?.locator, 'a chunk with no locator cannot be cited');
});

test('the job is marked done once the document is indexed', async () => {
  await seedDocument('# hello\n\nsome text. '.repeat(20));
  const job = await claimJob(db, 'worker-1');
  await indexDocument(db, job!, { embed, log });

  const after = await db.collection('jobs').findOne({ _id: job!._id as never });
  assert.equal(after?.status, 'done');
});

test('a document whose embedding fails is marked failed with a reason, not left pending', async () => {
  const docId = await seedDocument('# hello\n\nsome text. '.repeat(20));
  const job = await claimJob(db, 'worker-1');

  const exploding: Embedder = {
    model: 'boom',
    async embed() {
      throw new Error('embeddings provider is down');
    }
  };

  await indexDocument(db, job!, { embed: exploding, log });

  const doc = await db.collection('documents').findOne({ _id: docId as never });
  assert.equal(doc?.status, 'failed');
  assert.match(String(doc?.error), /embeddings provider is down/);

  const after = await db.collection('jobs').findOne({ _id: job!._id as never });
  assert.equal(after?.status, 'failed');
});

test('a document is never indexed without a successful read-your-write probe', async () => {
  const docId = await seedDocument('# hello\n\nsome text. '.repeat(20));
  const job = await claimJob(db, 'worker-1');

  // A probe that finds nothing means the index is not queryable yet.
  await indexDocument(db, job!, { embed, log, probe: async () => false });

  const doc = await db.collection('documents').findOne({ _id: docId as never });
  assert.notEqual(doc?.status, 'indexed');
});

test('a crashed worker’s job is returned to pending by the sweeper', async () => {
  await seedDocument('# hello');
  const job = await claimJob(db, 'worker-1');
  assert.ok(job);

  // Simulate the worker dying: the row stays `running` with a stale claim.
  await db
    .collection('jobs')
    .updateOne(
      { _id: job._id as never },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000).toISOString() } }
    );

  const swept = await sweepStaleJobs(db, 60_000);

  assert.equal(swept, 1);
  const after = await db.collection('jobs').findOne({ _id: job._id as never });
  assert.equal(after?.status, 'pending');
});

test('a job claimed moments ago is left alone by the sweeper', async () => {
  await seedDocument('# hello');
  await claimJob(db, 'worker-1');

  assert.equal(await sweepStaleJobs(db, 60_000), 0);
});
