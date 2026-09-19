/**
 * LUMINA gateway — the software backend. PROVIDED SKELETON: YOU BUILD THIS OUT.
 *
 * What is already here: the server, CORS, the request id, the pino request log, the
 * X-User-Id check, /health (which nests the agent service's health), a 501 for every
 * remaining contract route, and optional static hosting of a pre-built UI.
 *
 * What you build (apps/gateway/, see TECHNICAL.md Part 2):
 *   1. zod validation from @lumina/contract → 400 on a bad body, with the zod message
 *   2. a per-user rate limit           → 429
 *   3. the proxy to the agent service, and SSE pass-through for /threads/:id/ask
 *   4. 502 for any upstream failure    → never a 2xx when the agent threw
 *
 * The browser talks ONLY to this service. No provider key is ever read here.
 *
 * The app itself lives in `app.ts` so tests can mount it without binding a fixed port.
 */
import pino from 'pino';
import { createApp } from './app.js';
import { env } from './env.js';

const log = pino({ level: env.logLevel });

/**
 * Bind on all interfaces including IPv6. Fly's private `.internal` DNS returns
 * AAAA records only, so an IPv4-only bind is unreachable from a sibling app and
 * the symptom looks like a networking fault rather than a bind one.
 */
const HOST = process.env.HOST ?? '::';

createApp(log).listen(env.port, HOST, () => {
  log.info(
    { port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins },
    'gateway up — /health and the X-User-Id check are live; the rest returns 501'
  );
});
