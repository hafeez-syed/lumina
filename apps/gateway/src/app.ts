/**
 * The gateway application, built as a factory so a test can mount it on an ephemeral
 * port. `index.ts` is only the entrypoint that listens.
 */
import express from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import pino, { type Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { HealthResponse, REQUEST_HEADER, ROUTES, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { registerProxy } from './proxy.js';
import { readFile } from 'node:fs/promises';

/** Routes a stranger must be able to read: the health probe and the submission page. */
const PUBLIC_PATHS = new Set(
  ROUTES.filter((r) => !r.auth).map((r) => r.path as string)
);

/** Overrides exist so a test can point the proxy at a stub upstream. */
export type AppOverrides = {
  agentUrl?: string;
  upstreamTimeoutMs?: number;
  evalsReportPath?: string;
};

export function createApp(
  log: Logger = pino({ level: env.logLevel }),
  overrides: AppOverrides = {}
): express.Express {
  const agentUrl = () => overrides.agentUrl ?? env.agentUrl;
  const evalsReportPath = overrides.evalsReportPath ?? env.evalsReportPath;
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

  // One request id, reused if the caller sent one, generated if not, forwarded to the agent
  // service and logged by both. This is what makes one request greppable end to end.
  app.use((req, res, next) => {
    const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
    res.locals.requestId = id;
    res.setHeader(REQUEST_HEADER, id);
    next();
  });

  app.use(
    pinoHttp({
      logger: log,
      genReqId: (_req, res) => String(res.locals.requestId),
      customProps: (req, res) => ({
        requestId: res.locals.requestId,
        userId: req.header(USER_HEADER) ?? null
      }),
      // The ask route is a stream; one line when it closes is the useful line.
      autoLogging: true
    })
  );

  // JSON everywhere except the multipart upload route, which your handler owns.
  app.use((req, res, next) =>
    req.path.endsWith('/documents') && req.method === 'POST'
      ? next()
      : express.json({ limit: '1mb' })(req, res, next)
  );

  // -------------------------------------------------------------- auth

  /**
   * One header, enforced once, before any route handler. Doing it here rather than per
   * handler is the point: a route added later is protected by construction instead of by
   * the author remembering. /health and /evals/report.json are public because a probe and
   * a stranger reading the submission page have no header to send.
   */
  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();

    const userId = req.header(USER_HEADER)?.trim();
    if (!userId) {
      res.status(401).json({
        error: `missing ${USER_HEADER} header`,
        status: 401,
        requestId: String(res.locals.requestId)
      });
      return;
    }

    res.locals.userId = userId;
    next();
  });

  // -------------------------------------------------------------- /health (implemented)

  app.get('/health', async (_req, res) => {
    let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
    try {
      const upstream = await fetch(`${agentUrl()}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await upstream.json()) as Record<string, unknown>;
      ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
    } catch (err) {
      // Health tells the truth about a dead dependency. It never pretends.
      ai = { status: 'down', error: (err as Error).message };
    }

    const body: HealthResponse = {
      status: ai.status === 'ok' ? 'ok' : 'degraded',
      model: String(ai.model ?? 'unset'),
      searchProvider: (ai.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
      vectorStore: (ai.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
      db: (ai.db as HealthResponse['db']) ?? 'down',
      ai
    };
    res.status(ai.status === 'ok' ? 200 : 503).json(body);
  });

  // -------------------------------------------------------------- /evals/report.json

  /**
   * Served here, not proxied. The agent has no such route — it is written by the eval run
   * and read by the provided UI at /evals, which a stranger opens cold. Forwarding it to
   * the agent is how this became a 404.
   */
  app.get('/evals/report.json', async (_req, res) => {
    let raw: string;
    try {
      raw = await readFile(evalsReportPath, 'utf8');
    } catch {
      res.status(404).json({
        error:
          'no evaluation yet — run `/fde-lumina-eval --deploy-url <gateway>` in Claude Code; ' +
          `it writes ${evalsReportPath}`,
        status: 404
      });
      return;
    }

    try {
      // Parsed rather than streamed so a corrupt file is a 500 with a reason, not a page
      // that renders blank and looks like a UI bug.
      res.json(JSON.parse(raw));
    } catch (err) {
      log.error({ err, evalsReportPath }, 'the evaluation report is not valid json');
      res.status(500).json({
        error: `the report at ${evalsReportPath} is not valid json — re-run the eval rather than hand-editing it`,
        status: 500
      });
    }
  });

  // -------------------------------------------------------------- everything else: 501

  /**
   * The gateway owns the edge, not the answers: every contract route but /health is
   * forwarded to the agent service. A route the agent has not built yet answers 501
   * from there, and the UI renders that as its progress bar.
   */
  registerProxy(
    app,
    ROUTES.filter((r) => r.path !== '/health' && r.path !== '/evals/report.json').map((r) => ({
      method: r.method,
      path: r.path
    })),
    agentUrl,
    log,
    overrides.upstreamTimeoutMs
  );

  // -------------------------------------------------------------- static UI

  // Optional: with WEB_DIST set to a static export, / and /evals come from one origin.
  if (env.webDist && existsSync(env.webDist)) {
    app.use(express.static(env.webDist));
    app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
      res.sendFile(`${env.webDist}/index.html`);
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
  });

  // A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error({ err, requestId: res.locals.requestId }, 'gateway error');
      res
        .status(502)
        .json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
    }
  );

  return app;
}

export { PUBLIC_PATHS };
