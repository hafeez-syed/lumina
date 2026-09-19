/**
 * /stats.
 *
 * Every number is derived from the `requests` collection rather than from a counter this
 * process keeps, because a statistic the request log disagrees with is worse than no
 * statistic: it is the one a reader trusts and should not.
 *
 * `ttftMs` and `searchCached` are written onto the request row by the ask loop. Until
 * that exists there is nothing to average, and these read as zero — which is true.
 */
import type { Express, Request, Response } from 'express';
import type { Db } from 'mongodb';
import { COLLECTIONS, type StatsResponse } from '@lumina/contract';
import { env } from './env.js';

/** Request rows as they are stored, plus the two fields the ask loop adds. */
type RequestRow = {
  userId: string;
  route?: string;
  depth?: 'quick' | 'deep';
  costUsd?: number;
  ttftMs?: number;
  searchCached?: boolean;
  createdAt: string | Date;
};

/** UTC midnight — "today" has to mean the same thing to the user and to the cap. */
function startOfTodayIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

/** Nearest-rank p95: the smallest sample at or above 95% of the ordered set. */
export function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

const round = (n: number, dp = 4) => Number(n.toFixed(dp));

export function registerStatsRoutes(app: Express, getDb: () => Promise<Db>): void {
  app.get('/stats', async (_req: Request, res: Response) => {
    const db = await getDb();
    const userId = String(res.locals.userId);
    const since = startOfTodayIso();

    const rows = await db
      .collection<RequestRow>(COLLECTIONS.requests)
      .find({ userId })
      .toArray();

    // An "answer" is a run of the loop, which is what carries a depth.
    const answers = rows.filter((r) => r.depth === 'quick' || r.depth === 'deep');
    const today = rows.filter((r) => String(r.createdAt) >= since);

    const cacheable = answers.filter((r) => typeof r.searchCached === 'boolean');
    const ttfts = answers
      .map((r) => r.ttftMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const body: StatsResponse = {
      requests: rows.length,
      answers: answers.length,
      searchCacheHitRatePct: cacheable.length
        ? round((cacheable.filter((r) => r.searchCached).length / cacheable.length) * 100, 1)
        : 0,
      ttftP95Ms: percentile95(ttfts),
      costUsdToday: round(today.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)),
      deepToday: today.filter((r) => r.depth === 'deep').length,
      deepDailyCap: env.deepDailyCap
    };

    res.json(body);
  });
}
