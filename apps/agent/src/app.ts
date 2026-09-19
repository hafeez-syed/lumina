/**
 * The agent application, built as a factory so a test can mount it on an ephemeral port
 * against a throwaway database. `index.ts` is only the entrypoint that listens.
 */
import express from 'express';
import pino, { type Logger } from 'pino';
import type { Db } from 'mongodb';
import { HealthResponse, ROUTES, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { db as defaultDb, pingDb } from './db.js';
import { registerThreadRoutes } from './threads.js';
import { registerMemoryRoutes } from './memory.js';
import { registerSpaceRoutes } from './spaces.js';
import { registerStatsRoutes } from './stats.js';
import { registerAskRoute } from './ask.js';
import { defaultProviders, type Providers } from './providers.js';

export type AppDeps = {
  /** Injected so tests can point at `lumina_test` instead of the real database. */
  db?: () => Promise<Db>;
  log?: Logger;
  /** Injected so the loop's guarantees can be proven without spending on a provider. */
  providers?: Providers;
  /** Injected so a test never writes a synthetic trajectory into the real runs/ folder. */
  runsDir?: string;
};

/** Routes that are reachable without X-User-Id. */
const PUBLIC_PATHS = new Set(ROUTES.filter((r) => !r.auth).map((r) => r.path as string));

export function createApp(deps: AppDeps = {}): express.Express {
  const getDb = deps.db ?? defaultDb;
  const log = deps.log ?? pino({ level: env.logLevel });
  const providers = deps.providers ?? defaultProviders();

  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) =>
    req.path.endsWith('/documents') && req.method === 'POST'
      ? next()
      : express.json({ limit: '1mb' })(req, res, next)
  );

  // -------------------------------------------------------------- auth

  /**
   * The agent enforces the header itself rather than trusting that it was reached
   * through the gateway. A cap or an ownership check that only holds on the edge is one
   * you bypass by calling this service directly.
   */
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const userId = req.header(USER_HEADER)?.trim();
    if (!userId) {
      res.status(401).json({ error: `missing ${USER_HEADER} header`, status: 401 });
      return;
    }
    res.locals.userId = userId;
    next();
  });

  // -------------------------------------------------------------- /health (implemented)

  app.get('/health', async (_req, res) => {
    const dbStatus = await pingDb();
    const body: HealthResponse = {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      db: dbStatus,
      ai: { status: 'ok' }
    };
    res.status(dbStatus === 'ok' ? 200 : 503).json(body);
  });

  // -------------------------------------------------------------- implemented routes

  registerStatsRoutes(app, getDb);
  registerThreadRoutes(app, getDb);
  registerMemoryRoutes(app, getDb);
  registerSpaceRoutes(app, getDb);
  registerAskRoute(app, getDb, providers, log, deps.runsDir ?? env.runsDir);

  // -------------------------------------------------------------- everything else: 501

  const notImplemented = (route: string) => (_req: express.Request, res: express.Response) => {
    res.status(501).json({
      error: `not implemented yet: ${route}. Build it in apps/agent/src/.`,
      status: 501
    });
  };

  const IMPLEMENTED = new Set([
    '/health',
    '/evals/report.json',
    '/stats',
    '/threads',
    '/threads/:threadId',
    '/memory',
    '/memory/:memoryId',
    '/spaces',
    '/spaces/:spaceId/documents',
    '/threads/:threadId/ask'
  ]);

  for (const route of ROUTES) {
    if (IMPLEMENTED.has(route.path)) continue;
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
    app[method](route.path, notImplemented(`${route.method} ${route.path}`));
  }

  app.use((req, res) =>
    res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 })
  );

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error({ err }, 'agent error');
      res.status(502).json({ error: err.message, status: 502 });
    }
  );

  return app;
}
