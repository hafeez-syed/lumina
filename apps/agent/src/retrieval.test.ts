import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, type Db } from 'mongodb';
import { EMBEDDING_DIMS, SEARCH_INDEXES } from '@lumina/contract';
// `env` is what loads the root .env; this file imports no app module that would.
import { env } from './env.js';
import {
  cosineSimilarity,
  cosineScanSearch,
  memoryVectorStage,
  recallMemories,
  rrfFuse,
  textSearchStage,
  vectorSearchStage
} from './retrieval.js';

/**
 * Two halves are tested differently, on purpose.
 *
 * The fusion and the pipeline *shape* are pure and are asserted directly — the shape
 * matters because filtering a Space in a later `$match` instead of inside `$vectorSearch`
 * returns another Space's chunks first and then hides them, which looks like poor recall
 * rather than a leak.
 *
 * The Atlas half cannot run here: the search indexes exist on the real database, not on a
 * throwaway one. The cosine-scan backend needs no index, so the ranking behaviour is
 * exercised against real Mongo through that path.
 */
const uri = env.mongoUri;
let client: MongoClient;
let db: Db;

/**
 * A unit vector along one axis. Cosine ignores magnitude, so two vectors differ only by
 * pointing in different directions — scaling one is not "further away", it is identical.
 */
const vec = (axis: number): number[] =>
  Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === axis ? 1 : 0));

before(async () => {
  assert.ok(uri, 'MONGODB_URI must be set to run the agent tests');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Own database per file: node runs test files in parallel processes.
  db = client.db('lumina_test_retrieval');
});

beforeEach(async () => {
  await db.collection('chunks').deleteMany({});
});

after(async () => {
  await client?.close();
});

// ---------------------------------------------------------------- fusion

test('a chunk ranked well by both retrievers beats one ranked well by only one', () => {
  const both = { _id: 'a' };
  const vectorOnly = { _id: 'b' };
  const textOnly = { _id: 'c' };

  const fused = rrfFuse([
    [both, vectorOnly],
    [both, textOnly]
  ]);

  assert.equal(fused[0]?._id, 'a');
});

test('a chunk found by only one retriever is still returned', () => {
  const fused = rrfFuse([[{ _id: 'a' }], [{ _id: 'b' }]]);
  assert.deepEqual(
    fused.map((f) => f._id).sort(),
    ['a', 'b']
  );
});

test('fusion de-duplicates a chunk both retrievers found', () => {
  const fused = rrfFuse([
    [{ _id: 'a' }, { _id: 'b' }],
    [{ _id: 'a' }]
  ]);
  assert.equal(fused.filter((f) => f._id === 'a').length, 1);
});

test('a first-place chunk outranks a second-place one from either list', () => {
  // Fusion is symmetric: rank 0 scores the same whichever retriever found it, so `z` and
  // `b` tie at the top and `a` — second in its list — must come last.
  const fused = rrfFuse([
    [{ _id: 'z' }, { _id: 'a' }],
    [{ _id: 'b' }]
  ]);

  assert.deepEqual(fused.slice(0, 2).map((f) => f._id).sort(), ['b', 'z']);
  assert.equal(fused.at(-1)?._id, 'a');
});

// ---------------------------------------------------------------- pipeline shape

test('the Space filter lives inside $vectorSearch, never in a later $match', () => {
  const stage = vectorSearchStage({
    embedding: vec(1),
    userId: 'alice',
    spaceId: 'spc_1',
    limit: 5
  });

  const vs = (stage as { $vectorSearch: Record<string, unknown> }).$vectorSearch;
  assert.ok(vs, 'expected a $vectorSearch stage');
  assert.equal(vs.index, SEARCH_INDEXES.chunksVector);
  assert.equal(vs.path, 'embedding');

  const filter = vs.filter as Record<string, unknown>;
  assert.ok(filter, 'a $vectorSearch with no filter returns every Space');
  assert.equal(filter.spaceId, 'spc_1');
  assert.equal(filter.userId, 'alice');
});

test('a vector search without a Space is still scoped to the caller', () => {
  const vs = (
    vectorSearchStage({ embedding: vec(1), userId: 'alice', limit: 5 }) as {
      $vectorSearch: Record<string, unknown>;
    }
  ).$vectorSearch;

  const filter = vs.filter as Record<string, unknown>;
  assert.equal(filter.userId, 'alice');
  assert.equal('spaceId' in filter, false);
});

test('the vector search over-fetches so fusion has something to work with', () => {
  const vs = (
    vectorSearchStage({ embedding: vec(1), userId: 'alice', limit: 5 }) as {
      $vectorSearch: Record<string, number>;
    }
  ).$vectorSearch;

  assert.equal(vs.limit, 5);
  assert.ok(
    (vs.numCandidates ?? 0) >= 50,
    'numCandidates below ~10x limit gives poor recall'
  );
});

test('the text search is scoped to the caller and the Space', () => {
  const stage = textSearchStage({ query: 'vector', userId: 'alice', spaceId: 'spc_1', limit: 5 });
  const s = (stage as { $search: Record<string, unknown> }).$search;

  assert.equal(s.index, SEARCH_INDEXES.chunksText);
  const json = JSON.stringify(s);
  assert.match(json, /spc_1/);
  assert.match(json, /alice/);
});

// ---------------------------------------------------------------- cosine

test('cosine similarity is 1 for identical vectors and 0 for orthogonal ones', () => {
  assert.equal(Math.round(cosineSimilarity([1, 0], [1, 0])), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('an empty or mismatched vector scores 0 rather than throwing', () => {
  assert.equal(cosineSimilarity([], [1, 0]), 0);
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0]), 0);
});

// ---------------------------------------------------------------- cosine-scan backend

const seedChunk = (id: string, userId: string, spaceId: string, embedding: number[], text = 'text') =>
  db.collection('chunks').insertOne({
    _id: id as never,
    docId: 'doc_1',
    spaceId,
    userId,
    title: 'notes.md',
    text,
    locator: { heading: 'H' },
    ord: 0,
    embedding,
    createdAt: new Date().toISOString()
  } as never);

test('the cosine-scan backend ranks the nearest chunk first', async () => {
  await seedChunk('chk_far', 'alice', 'spc_1', vec(1), 'far');
  await seedChunk('chk_near', 'alice', 'spc_1', vec(0), 'near');

  const hits = await cosineScanSearch(db, { embedding: vec(0), userId: 'alice', spaceId: 'spc_1', limit: 5 });

  assert.equal(hits[0]?.text, 'near');
});

test('retrieval never crosses a Space boundary', async () => {
  await seedChunk('chk_mine', 'alice', 'spc_1', vec(1), 'mine');
  await seedChunk('chk_other', 'alice', 'spc_2', vec(1), 'other space');

  const hits = await cosineScanSearch(db, { embedding: vec(1), userId: 'alice', spaceId: 'spc_1', limit: 5 });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, 'mine');
});

test('retrieval never crosses a user boundary', async () => {
  await seedChunk('chk_alice', 'alice', 'spc_1', vec(1), 'alice');
  await seedChunk('chk_bob', 'bob', 'spc_1', vec(1), 'bob');

  const hits = await cosineScanSearch(db, { embedding: vec(1), userId: 'alice', spaceId: 'spc_1', limit: 5 });

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, 'alice');
});

test('a retrieved chunk carries the locator a citation needs', async () => {
  await seedChunk('chk_1', 'alice', 'spc_1', vec(1));

  const hits = await cosineScanSearch(db, { embedding: vec(1), userId: 'alice', spaceId: 'spc_1', limit: 5 });

  assert.ok(hits[0]?.locator, 'a chunk with no locator cannot be cited');
  assert.equal(hits[0]?.docId, 'doc_1');
});

// ---------------------------------------------------------------- memory recall

const seedMemory = (id: string, userId: string, embedding: number[], text: string) =>
  db.collection('memories').insertOne({
    _id: id as never,
    userId,
    text,
    embedding,
    createdAt: new Date().toISOString()
  } as never);

test('memory recall is scoped to the caller inside $vectorSearch', () => {
  const vs = (
    memoryVectorStage({ embedding: vec(0), userId: 'alice', limit: 5 }) as {
      $vectorSearch: Record<string, unknown>;
    }
  ).$vectorSearch;

  assert.equal(vs.index, SEARCH_INDEXES.memoriesVector);
  assert.equal((vs.filter as Record<string, unknown>).userId, 'alice');
});

test('recall returns the memory closest in meaning, not the newest', async () => {
  await db.collection('memories').deleteMany({});
  // The newer memory is about something else; recall must still pick the relevant one.
  await seedMemory('mem_rel', 'alice', vec(0), 'prefers British English');
  await seedMemory('mem_new', 'alice', vec(1), 'likes tabs over spaces');

  const hits = await recallMemories(
    db,
    { embedding: vec(0), userId: 'alice', limit: 1 },
    { backend: 'mongo-cosine-scan' }
  );

  assert.equal(hits[0]?.text, 'prefers British English');
});

test('recall never returns another user’s memory', async () => {
  await db.collection('memories').deleteMany({});
  await seedMemory('mem_a', 'alice', vec(0), 'alice remembers this');
  await seedMemory('mem_b', 'bob', vec(0), 'bob remembers this');

  const hits = await recallMemories(
    db,
    { embedding: vec(0), userId: 'alice', limit: 5 },
    { backend: 'mongo-cosine-scan' }
  );

  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.text, 'alice remembers this');
});

test('recall never exposes the embedding', async () => {
  await db.collection('memories').deleteMany({});
  await seedMemory('mem_a', 'alice', vec(0), 'something');

  const hits = await recallMemories(
    db,
    { embedding: vec(0), userId: 'alice', limit: 5 },
    { backend: 'mongo-cosine-scan' }
  );

  assert.equal('embedding' in (hits[0] as object), false);
});
