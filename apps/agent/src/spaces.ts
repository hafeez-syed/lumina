/**
 * Spaces and their documents.
 *
 * The upload route's whole job is to be fast and durable: store the bytes, record a
 * `pending` document, queue one job, return 202. Parsing a 60-page PDF here instead would
 * not look like a bug — it would look like the search p95 mysteriously collapsing
 * whenever someone uploads, which is exactly the failure the bench is built to catch.
 */
import type { Express, Request, Response } from 'express';
import { GridFSBucket, type Db } from 'mongodb';
import multer from 'multer';
import { extname } from 'node:path';
import {
  ACCEPTED_UPLOAD_TYPES,
  COLLECTIONS,
  CreateSpaceBody,
  type CreateSpaceResponse,
  type DocumentDoc,
  type DocumentRow,
  GRIDFS_BUCKETS,
  type JobDoc,
  type ListDocumentsResponse,
  type ListSpacesResponse,
  MAX_UPLOAD_BYTES,
  type SpaceDoc,
  type UploadDocumentResponse,
  newId
} from '@lumina/contract';

const isoString = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

const spacesOf = (db: Db) => db.collection<SpaceDoc>(COLLECTIONS.spaces);
const documentsOf = (db: Db) => db.collection<DocumentDoc>(COLLECTIONS.documents);
const jobsOf = (db: Db) => db.collection<JobDoc>(COLLECTIONS.jobs);

/**
 * Browsers label markdown and plain text inconsistently — `application/octet-stream`
 * for a `.md` is routine — so the extension is a second opinion, not a bypass.
 */
const EXTENSION_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain'
};

function resolveMimeType(filename: string, declared: string): string | null {
  if ((ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(declared)) return declared;
  return EXTENSION_TYPES[extname(filename).toLowerCase()] ?? null;
}

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
}).single('file');

export function registerSpaceRoutes(app: Express, getDb: () => Promise<Db>): void {
  // ---------------------------------------------------------------- spaces

  app.post('/spaces', async (req: Request, res: Response) => {
    const parsed = CreateSpaceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '),
        status: 400
      });
      return;
    }

    const doc: SpaceDoc = {
      _id: newId('spc'),
      userId: String(res.locals.userId),
      name: parsed.data.name,
      createdAt: new Date().toISOString()
    };
    await spacesOf(await getDb()).insertOne(doc);

    const body: CreateSpaceResponse = { spaceId: doc._id, name: doc.name };
    res.status(201).json(body);
  });

  app.get('/spaces', async (_req: Request, res: Response) => {
    const rows = await spacesOf(await getDb())
      .find({ userId: String(res.locals.userId) })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const body: ListSpacesResponse = {
      spaces: rows.map((s) => ({
        spaceId: s._id,
        name: s.name,
        createdAt: isoString(s.createdAt)
      }))
    };
    res.json(body);
  });

  // ---------------------------------------------------------------- documents

  app.post('/spaces/:spaceId/documents', (req: Request, res: Response) => {
    uploadMiddleware(req, res, async (err: unknown) => {
      if (err) {
        // Multer's size guard is the one that must not become a 500.
        const code = (err as { code?: string }).code;
        const status = code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        res.status(status).json({ error: (err as Error).message, status });
        return;
      }

      const db = await getDb();
      const userId = String(res.locals.userId);
      const spaceId = String(req.params.spaceId);

      const space = await spacesOf(db).findOne({ _id: spaceId, userId });
      if (!space) {
        res.status(404).json({ error: `no space ${spaceId}`, status: 404 });
        return;
      }

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'expected a file field named "file"', status: 400 });
        return;
      }

      const mimeType = resolveMimeType(file.originalname, file.mimetype);
      if (!mimeType) {
        res.status(415).json({
          error: `unsupported type ${file.mimetype}; accepted: ${ACCEPTED_UPLOAD_TYPES.join(', ')}`,
          status: 415
        });
        return;
      }

      // Bytes first: a document row pointing at a file that was never stored is worse
      // than an orphaned file.
      const bucket = new GridFSBucket(db, { bucketName: GRIDFS_BUCKETS.uploads });
      const fileId = await new Promise<string>((resolve, reject) => {
        // Driver v7 dropped the `contentType` option; the type travels in metadata and
        // is also recorded on the document row.
        const stream = bucket.openUploadStream(file.originalname, {
          metadata: { userId, spaceId, contentType: mimeType }
        });
        stream.on('error', reject);
        stream.on('finish', () => resolve(String(stream.id)));
        stream.end(file.buffer);
      });

      const doc: DocumentDoc = {
        _id: newId('doc'),
        spaceId,
        userId,
        title: file.originalname,
        mimeType,
        bytes: file.size,
        status: 'pending',
        pct: 0,
        fileId,
        createdAt: new Date().toISOString()
      };
      await documentsOf(db).insertOne(doc);

      // The work happens on the worker, after the 202.
      const job: JobDoc = {
        _id: `job_${doc._id}`,
        kind: 'index_document',
        status: 'pending',
        payload: { docId: doc._id, spaceId, fileId },
        userId,
        attempts: 0,
        createdAt: new Date().toISOString()
      };
      await jobsOf(db).insertOne(job);

      const body: UploadDocumentResponse = { docId: doc._id, status: 'pending' };
      res.status(202).json(body);
    });
  });

  app.get('/spaces/:spaceId/documents', async (req: Request, res: Response) => {
    const db = await getDb();
    const userId = String(res.locals.userId);
    const spaceId = String(req.params.spaceId);

    const space = await spacesOf(db).findOne({ _id: spaceId, userId });
    if (!space) {
      res.status(404).json({ error: `no space ${spaceId}`, status: 404 });
      return;
    }

    const rows = await documentsOf(db)
      .find({ spaceId, userId })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const body: ListDocumentsResponse = {
      documents: rows.map(
        (d): DocumentRow => ({
          docId: d._id,
          title: d.title,
          status: d.status,
          pct: d.pct,
          pages: d.pages,
          chunks: d.chunks,
          error: d.error
        })
      )
    };
    res.json(body);
  });
}
