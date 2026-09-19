/**
 * Threads and their messages.
 *
 * Every query is scoped by `userId` at the database level rather than filtered after the
 * fact: a thread belonging to someone else must be indistinguishable from one that does
 * not exist, so ownership is part of the lookup and a miss is a 404.
 */
import type { Express, Request, Response } from 'express';
import type { Db } from 'mongodb';
import {
  CreateThreadBody,
  type CreateThreadResponse,
  type GetThreadResponse,
  type ListThreadsResponse,
  type MessageDoc,
  type ThreadDoc,
  type ThreadMessage,
  newId
} from '@lumina/contract';

const DEFAULT_TITLE = 'New thread';

/** The contract stores timestamps as `string | Date`; the wire shape is always a string. */
const isoString = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());

const threadsOf = (db: Db) => db.collection<ThreadDoc>('threads');
const messagesOf = (db: Db) => db.collection<MessageDoc>('messages');

/** The caller, as established by the auth middleware. */
const callerId = (res: Response): string => String(res.locals.userId);

export function registerThreadRoutes(app: Express, getDb: () => Promise<Db>): void {
  app.post('/threads', async (req: Request, res: Response) => {
    const parsed = CreateThreadBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '),
        status: 400
      });
      return;
    }

    const doc: ThreadDoc = {
      _id: newId('thr'),
      userId: callerId(res),
      title: parsed.data.title ?? DEFAULT_TITLE,
      createdAt: new Date().toISOString()
    };
    await threadsOf(await getDb()).insertOne(doc);

    const body: CreateThreadResponse = { threadId: doc._id };
    res.status(201).json(body);
  });

  app.get('/threads', async (_req: Request, res: Response) => {
    const rows = await threadsOf(await getDb())
      .find({ userId: callerId(res) })
      // `_id` breaks the tie when two threads land in the same millisecond.
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const body: ListThreadsResponse = {
      threads: rows.map((t) => ({
        threadId: t._id,
        title: t.title,
        createdAt: isoString(t.createdAt)
      }))
    };
    res.json(body);
  });

  app.get('/threads/:threadId', async (req: Request, res: Response) => {
    const db = await getDb();
    const userId = callerId(res);
    const threadId = String(req.params.threadId);

    // Ownership is part of the lookup, not a check afterwards.
    const thread = await threadsOf(db).findOne({ _id: threadId, userId });
    if (!thread) {
      res.status(404).json({ error: `no thread ${threadId}`, status: 404 });
      return;
    }

    const rows = await messagesOf(db)
      .find({ threadId, userId })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();

    const body: GetThreadResponse = {
      threadId: thread._id,
      title: thread.title,
      messages: rows.map(
        (m): ThreadMessage => ({
          role: m.role,
          content: m.content,
          sources: m.sources,
          answerId: m.answerId,
          done: m.done,
          createdAt: isoString(m.createdAt)
        })
      )
    };
    res.json(body);
  });
}
