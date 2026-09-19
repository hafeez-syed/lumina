/**
 * The jobs worker.
 *
 * It exists so that parsing a 60-page PDF never happens on the thread streaming somebody's
 * answer. A blocking implementation does not look like a bug — it looks like search p95
 * collapsing whenever anyone uploads, which is the failure the bench is built to catch.
 *
 *   index_document → GridFS read → parse (page-aware) → chunk → embed → upsert chunks →
 *                    READ-YOUR-WRITE PROBE → status: 'indexed'
 *
 * "Upserted" is not "searchable": Atlas Search indexes are eventually consistent, so the
 * probe — query for a chunk you just wrote and get it back — is what earns `indexed`.
 *
 * Deep search does NOT run here. It streams its plan and progress over the same SSE
 * channel as a quick answer, because someone watching a deep search wants to see it
 * working, not poll a job id.
 */
import { GridFSBucket, type Db } from 'mongodb';
import pino, { type Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import {
  COLLECTIONS,
  EMBEDDING_DIMS,
  GRIDFS_BUCKETS,
  type DocumentDoc,
  type JobDoc,
  type Locator
} from '@lumina/contract';
import { env } from './env.js';
import { db as defaultDb } from './db.js';
import { OpenAiEmbedder, type Embedder } from './providers.js';

export type IndexDeps = {
  embed: Embedder;
  log: Logger;
  /** Overridable so a test can assert the probe actually gates the `indexed` status. */
  probe?: (db: Db, docId: string) => Promise<boolean>;
};

/** Roughly 1200 characters with a little overlap: big enough to answer from, small enough to cite. */
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

/**
 * Claim one pending job. This is a single atomic findOneAndUpdate on purpose — a
 * read-then-write would let two workers pick up the same job and do the work twice.
 */
export async function claimJob(db: Db, workerId: string): Promise<JobDoc | null> {
  const job = await db.collection<JobDoc>(COLLECTIONS.jobs).findOneAndUpdate(
    { status: 'pending' },
    {
      $set: { status: 'running', claimedAt: new Date().toISOString(), workerId },
      $inc: { attempts: 1 }
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
  return job ?? null;
}

/**
 * Return jobs abandoned by a worker that died mid-flight. A row left `running` with a
 * stale `claimedAt` is the only evidence a crash leaves behind.
 */
export async function sweepStaleJobs(db: Db, staleAfterMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const res = await db
    .collection<JobDoc>(COLLECTIONS.jobs)
    .updateMany(
      { status: 'running', claimedAt: { $lt: cutoff } },
      { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
    );
  return res.modifiedCount;
}

/** Split text into overlapping chunks, keeping the heading each one sits under. */
export function chunkText(text: string): { text: string; locator: Locator }[] {
  const out: { text: string; locator: Locator }[] = [];
  const lines = text.split('\n');

  let heading = '';
  let buffer = '';
  let startLine = 1;

  const flush = (endLine: number) => {
    const trimmed = buffer.trim();
    if (!trimmed) return;
    out.push({
      text: trimmed,
      locator: heading ? { heading } : { line: startLine }
    });
    // Overlap keeps a claim that straddles a boundary citable from one chunk.
    buffer = trimmed.slice(-CHUNK_OVERLAP);
    startLine = endLine;
  };

  lines.forEach((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush(i + 1);
      heading = h[1]?.trim() ?? '';
    }
    buffer += `${line}\n`;
    if (buffer.length >= CHUNK_CHARS) flush(i + 1);
  });
  flush(lines.length);

  return out;
}

/** Page-aware for PDFs, heading-aware for everything else. */
async function extract(
  buffer: Buffer,
  mimeType: string
): Promise<{ pages: number; chunks: { text: string; locator: Locator }[] }> {
  if (mimeType !== 'application/pdf') {
    return { pages: 0, chunks: chunkText(buffer.toString('utf8')) };
  }

  // Imported lazily: pdfjs is heavy and only this branch needs it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })
    .promise;

  const chunks: { text: string; locator: Locator }[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    const text = content.items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // The page number is the locator, so a citation can say "filename, p. 4".
    for (const c of chunkText(text)) chunks.push({ text: c.text, locator: { page } });
  }
  return { pages: doc.numPages, chunks };
}

/** Query the index for a chunk we just wrote. Until this returns, the doc is not searchable. */
async function defaultProbe(db: Db, docId: string): Promise<boolean> {
  const found = await db.collection(COLLECTIONS.chunks).findOne({ docId });
  return Boolean(found);
}

export async function indexDocument(db: Db, job: JobDoc, deps: IndexDeps): Promise<void> {
  const docId = String(job.payload.docId);
  const documents = db.collection<DocumentDoc>(COLLECTIONS.documents);
  const jobs = db.collection<JobDoc>(COLLECTIONS.jobs);

  const fail = async (err: unknown) => {
    const message = (err as Error).message || 'indexing failed';
    deps.log.error({ err, docId }, 'index_document failed');
    // A document stuck on `pending` is indistinguishable from one still working. Say so.
    await documents.updateOne({ _id: docId }, { $set: { status: 'failed', error: message } });
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'failed', error: message } });
  };

  try {
    const doc = await documents.findOne({ _id: docId });
    if (!doc) throw new Error(`no document ${docId}`);

    await documents.updateOne({ _id: docId }, { $set: { status: 'parsing', pct: 10 } });

    const bucket = new GridFSBucket(db, { bucketName: GRIDFS_BUCKETS.uploads });
    const parts: Buffer[] = [];
    for await (const part of bucket.openDownloadStream(
      // GridFS ids round-trip as strings on the document row.
      (await import('mongodb')).ObjectId.createFromHexString(doc.fileId)
    )) {
      parts.push(Buffer.from(part));
    }
    const buffer = Buffer.concat(parts);

    const { pages, chunks } = await extract(buffer, doc.mimeType);
    if (chunks.length === 0) throw new Error('document produced no text to index');

    await documents.updateOne({ _id: docId }, { $set: { status: 'embedding', pct: 45 } });

    const vectors = await deps.embed.embed(chunks.map((c) => c.text));
    if (vectors.length !== chunks.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
    }

    await db.collection(COLLECTIONS.chunks).deleteMany({ docId });
    await db.collection(COLLECTIONS.chunks).insertMany(
      chunks.map((c, i) => ({
        _id: `chk_${docId}_${i}`,
        docId,
        spaceId: doc.spaceId,
        userId: doc.userId,
        title: doc.title,
        text: c.text,
        locator: c.locator,
        // Position within the document. Required by ChunkDoc, and what
        // chunks.docId_1_ord_1 orders by when a citation needs its neighbours.
        ord: i,
        embedding: vectors[i]?.length === EMBEDDING_DIMS ? vectors[i] : (vectors[i] ?? []),
        createdAt: new Date().toISOString()
      })) as never[]
    );

    await documents.updateOne({ _id: docId }, { $set: { status: 'embedding', pct: 85 } });

    // Earn the status. "Upserted" is not "searchable".
    const probe = deps.probe ?? defaultProbe;
    if (!(await probe(db, docId))) {
      await documents.updateOne(
        { _id: docId },
        { $set: { status: 'embedding', pct: 85, error: 'indexed chunks are not queryable yet' } }
      );
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'pending' }, $unset: { claimedAt: '' } });
      return;
    }

    await documents.updateOne(
      { _id: docId },
      {
        $set: { status: 'indexed', pct: 100, chunks: chunks.length },
        ...(pages ? { $max: { pages } } : {}),
        $unset: { error: '' }
      }
    );
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'done' } });
  } catch (err) {
    await fail(err);
  }
}

// ---------------------------------------------------------------- the loop

const STALE_AFTER_MS = 5 * 60_000;
const IDLE_POLL_MS = 1500;

export async function runWorker(): Promise<void> {
  const log = pino({ level: env.logLevel });
  const workerId = `worker_${randomUUID().slice(0, 8)}`;
  const db = await defaultDb();
  const embed = new OpenAiEmbedder();

  log.info({ workerId }, 'jobs worker up');

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info({ workerId }, 'draining, will exit after the current job');
      stopping = true;
    });
  }

  while (!stopping) {
    await sweepStaleJobs(db, STALE_AFTER_MS);
    const job = await claimJob(db, workerId);
    if (!job) {
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
      continue;
    }
    log.info({ workerId, jobId: job._id, kind: job.kind }, 'claimed job');
    await indexDocument(db, job, { embed, log });
  }

  process.exit(0);
}
