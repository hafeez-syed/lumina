/**
 * Hybrid retrieval over a Space's chunks.
 *
 * Two retrievers, fused. `$vectorSearch` finds passages that mean the same thing as the
 * question; `$search` (BM25) finds the ones that use the same words. Each fails in a way
 * the other covers — semantic search misses an exact identifier, lexical search misses a
 * paraphrase — so the answer to "which is better" is neither, and the fusion is the
 * feature.
 *
 * The load-bearing detail is WHERE the Space filter goes. `$vectorSearch` is an
 * approximate index scan: it picks its candidates first and anything applied afterwards
 * only hides what it already chose. Filtering in a later `$match` therefore returns
 * another Space's chunks, discards them, and leaves you with fewer results than you asked
 * for — which reads as poor recall, not as a leak. The filter belongs inside the stage,
 * which is why `spaceId` and `userId` are declared as filter fields on the index.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, SEARCH_INDEXES, type Locator } from '@lumina/contract';

export type RetrievedChunk = {
  _id: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  score?: number;
};

export type SearchArgs = {
  embedding: number[];
  query?: string;
  userId: string;
  spaceId?: string;
  limit: number;
};

/**
 * Reciprocal Rank Fusion. Scores by *rank*, not by the retrievers' own scores, because a
 * cosine similarity and a BM25 score are not on a comparable scale and normalising them
 * invents a precision neither has.
 *
 * `k` damps the top of each list so one retriever's confident first place cannot outvote
 * broad agreement further down. 60 is the value from the original paper.
 */
export function rrfFuse<T extends { _id: string }>(lists: T[][], k = 60): T[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, T>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      byId.set(item._id, byId.get(item._id) ?? item);
      scores.set(item._id, (scores.get(item._id) ?? 0) + 1 / (k + rank + 1));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, score]) => ({ ...(byId.get(id) as T), score }));
}

/** Cosine similarity. Returns 0 rather than NaN for empty or mismatched vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Scope every retrieval to the caller, and to the Space when one was chosen. */
function scope(userId: string, spaceId?: string): Record<string, string> {
  return spaceId ? { userId, spaceId } : { userId };
}

export function vectorSearchStage(args: Omit<SearchArgs, 'query'>): Record<string, unknown> {
  return {
    $vectorSearch: {
      index: SEARCH_INDEXES.chunksVector,
      path: 'embedding',
      queryVector: args.embedding,
      // The approximate index needs a wide candidate pool to choose from; at roughly the
      // limit it starts missing obvious matches.
      numCandidates: Math.max(50, args.limit * 20),
      limit: args.limit,
      // Inside the stage, never after it. See the header.
      filter: scope(args.userId, args.spaceId)
    }
  };
}

export function textSearchStage(
  args: Omit<SearchArgs, 'embedding'> & { query: string }
): Record<string, unknown> {
  const filters = Object.entries(scope(args.userId, args.spaceId)).map(([path, value]) => ({
    equals: { path, value }
  }));

  return {
    $search: {
      index: SEARCH_INDEXES.chunksText,
      compound: {
        must: [{ text: { query: args.query, path: 'text' } }],
        // `filter` contributes no score, which is what we want from a scope check.
        filter: filters
      }
    }
  };
}

const PROJECTION = { _id: 1, docId: 1, title: 1, text: 1, locator: 1, ord: 1 } as const;

const toChunk = (r: Record<string, unknown>): RetrievedChunk => ({
  _id: String(r._id),
  docId: String(r.docId),
  title: String(r.title ?? r.docId),
  text: String(r.text ?? ''),
  locator: (r.locator ?? {}) as Locator,
  score: typeof r.score === 'number' ? r.score : undefined
});

/**
 * The portable backend: no Atlas Search index required. Scores cosine in Node, which is
 * fine to a few thousand chunks and useless beyond that — `/health` reports which backend
 * is live precisely so a recall number is never read without that context.
 */
export async function cosineScanSearch(db: Db, args: SearchArgs): Promise<RetrievedChunk[]> {
  const rows = await db
    .collection(COLLECTIONS.chunks)
    .find(scope(args.userId, args.spaceId))
    .limit(5000)
    .toArray();

  return rows
    .map((r) => ({
      ...toChunk(r as Record<string, unknown>),
      score: cosineSimilarity(args.embedding, (r.embedding as number[]) ?? [])
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, args.limit);
}

/** Vector half, through the Atlas index. */
export async function vectorSearch(db: Db, args: SearchArgs): Promise<RetrievedChunk[]> {
  const rows = await db
    .collection(COLLECTIONS.chunks)
    .aggregate([
      vectorSearchStage(args),
      { $project: { ...PROJECTION, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
  return rows.map((r) => toChunk(r as Record<string, unknown>));
}

/** Lexical half, through the Atlas index. */
export async function textSearch(
  db: Db,
  args: SearchArgs & { query: string }
): Promise<RetrievedChunk[]> {
  const rows = await db
    .collection(COLLECTIONS.chunks)
    .aggregate([
      textSearchStage(args),
      { $limit: args.limit },
      { $project: { ...PROJECTION, score: { $meta: 'searchScore' } } }
    ])
    .toArray();
  return rows.map((r) => toChunk(r as Record<string, unknown>));
}

export type RetrievalDeps = {
  backend: 'atlas-vector-search' | 'mongo-cosine-scan';
  /** Logged, not swallowed: a retriever that silently returns nothing is the worst case. */
  onDegraded?: (which: string, err: unknown) => void;
};

/**
 * Hybrid retrieval, or the honest subset of it that this deployment can serve.
 *
 * Each half is allowed to fail independently — an Atlas index that is still building
 * throws rather than returning empty — but a failure is reported, never hidden. Returning
 * nothing and returning "nothing matched" are different answers and the trace has to be
 * able to tell them apart.
 */
export async function hybridSearch(
  db: Db,
  args: SearchArgs & { query: string },
  deps: RetrievalDeps
): Promise<RetrievedChunk[]> {
  if (deps.backend === 'mongo-cosine-scan') {
    return cosineScanSearch(db, args);
  }

  // Over-fetch each half: fusion needs more than the final count to work with.
  const wide = { ...args, limit: args.limit * 2 };

  const [vector, text] = await Promise.all([
    vectorSearch(db, wide).catch((err) => {
      deps.onDegraded?.('vector', err);
      return [] as RetrievedChunk[];
    }),
    textSearch(db, wide).catch((err) => {
      deps.onDegraded?.('text', err);
      return [] as RetrievedChunk[];
    })
  ]);

  return rrfFuse([vector, text]).slice(0, args.limit);
}

// ---------------------------------------------------------------- memory

export type RecalledMemory = {
  _id: string;
  text: string;
  sourceThread?: string;
  createdAt: string;
  score?: number;
};

/**
 * Memory recall is semantic, not chronological. "What do you remember about how I like
 * answers written?" has to reach a preference saved weeks ago, which a `find().limit(10)`
 * over recent rows would never surface.
 *
 * `GET /memory` stays chronological on purpose — that is a list the user audits and
 * deletes from, not a search.
 */
export function memoryVectorStage(args: {
  embedding: number[];
  userId: string;
  limit: number;
}): Record<string, unknown> {
  return {
    $vectorSearch: {
      index: SEARCH_INDEXES.memoriesVector,
      path: 'embedding',
      queryVector: args.embedding,
      numCandidates: Math.max(50, args.limit * 20),
      limit: args.limit,
      // Inside the stage: one user's memory must never be a candidate for another's.
      filter: { userId: args.userId }
    }
  };
}

const toMemory = (r: Record<string, unknown>): RecalledMemory => ({
  _id: String(r._id),
  text: String(r.text ?? ''),
  sourceThread: r.sourceThread ? String(r.sourceThread) : undefined,
  createdAt: String(r.createdAt ?? ''),
  score: typeof r.score === 'number' ? r.score : undefined
});

export async function recallMemories(
  db: Db,
  args: { embedding: number[]; userId: string; limit: number },
  deps: RetrievalDeps
): Promise<RecalledMemory[]> {
  // The embedding is several thousand floats and is never of use to a caller.
  const projection = { _id: 1, text: 1, sourceThread: 1, createdAt: 1 } as const;

  if (deps.backend === 'mongo-cosine-scan') {
    const rows = await db
      .collection(COLLECTIONS.memories)
      .find({ userId: args.userId })
      .limit(5000)
      .toArray();

    return rows
      .map((r) => ({
        ...toMemory(r as Record<string, unknown>),
        score: cosineSimilarity(args.embedding, (r.embedding as number[]) ?? [])
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, args.limit);
  }

  try {
    const rows = await db
      .collection(COLLECTIONS.memories)
      .aggregate([
        memoryVectorStage(args),
        { $project: { ...projection, score: { $meta: 'vectorSearchScore' } } }
      ])
      .toArray();
    return rows.map((r) => toMemory(r as Record<string, unknown>));
  } catch (err) {
    // A memory that cannot be recalled is a feature quietly not working; say so.
    deps.onDegraded?.('memory', err);
    return [];
  }
}
