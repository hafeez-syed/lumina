/**
 * Memory routes.
 *
 * The contract the user is given is "nothing is remembered that /memory does not show,
 * and deleting one makes its effect disappear". So the list is authoritative and the
 * delete is a real delete — not a tombstone the recall step might still read.
 *
 * Writing memories is the `save_memory` tool's job, inside the loop. These routes only
 * expose and remove them.
 */
import type { Express, Request, Response } from 'express';
import type { Db } from 'mongodb';
import { COLLECTIONS, type Memory, type MemoryDoc, type ListMemoryResponse } from '@lumina/contract';

const isoString = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

const memoriesOf = (db: Db) => db.collection<MemoryDoc>(COLLECTIONS.memories);

export function registerMemoryRoutes(app: Express, getDb: () => Promise<Db>): void {
  app.get('/memory', async (_req: Request, res: Response) => {
    const rows = await memoriesOf(await getDb())
      .find(
        { userId: String(res.locals.userId) },
        // The embedding is several thousand floats and is of no use to the client.
        { projection: { embedding: 0 } }
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const body: ListMemoryResponse = {
      memories: rows.map(
        (m): Memory => ({
          id: m._id,
          text: m.text,
          sourceThread: m.sourceThread,
          createdAt: isoString(m.createdAt)
        })
      )
    };
    res.json(body);
  });

  app.delete('/memory/:memoryId', async (req: Request, res: Response) => {
    const memoryId = String(req.params.memoryId);

    // Ownership is part of the filter: deleting someone else's memory must be
    // indistinguishable from deleting one that never existed.
    const { deletedCount } = await memoriesOf(await getDb()).deleteOne({
      _id: memoryId,
      userId: String(res.locals.userId)
    });

    if (!deletedCount) {
      res.status(404).json({ error: `no memory ${memoryId}`, status: 404 });
      return;
    }
    res.status(204).end();
  });
}
