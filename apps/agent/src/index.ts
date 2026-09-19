/**
 * LUMINA agent service — the AI backend. Provider keys live only in this process.
 *
 * Implemented: /health (Mongo ping + which model, provider and vector backend are live),
 * the X-User-Id check, and threads + messages. Everything else still answers 501.
 *
 * Still to build (TECHNICAL.md Part 1, in order — each step is testable with curl -N):
 *   1. the QUICK loop: plan → choose tool → observe → repeat → answer, with web_search
 *      and fetch_page, streaming trace → sources → token → done. sources BEFORE the
 *      first token. Disable compression on this route and flush after every event.
 *   2. the search cache: in-process LRU over the searchCache collection (TTL index).
 *   3. memory: save_memory / recall_memory; GET /memory, DELETE /memory/:id.
 *   4. the run log: one runs/<requestId>.json per answer, in the RunLog shape.
 *   5. spaces + the jobs worker: upload → GridFS → parse → chunk → embed → upsert →
 *      read-your-write probe → indexed.
 *   6. hybrid retrieval: $vectorSearch + $search fused with RRF, page locators.
 *   7. DEEP search behind DEEP_DAILY_CAP → 429 {error, resetsAt}.
 *
 * Three rules to hold on to while you write it:
 *   - Fail loud. A provider exception ends the run with terminated:"error" and a 502.
 *   - Grounded or nothing. A citation that does not resolve to something retrieved in
 *     THIS request is an automatic fail.
 *   - Depth is opted into, never drifted into. A quick search may not call plan_research.
 *
 * The app itself lives in `app.ts` so tests can mount it against a throwaway database.
 */
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { env } from './env.js';

const log = pino({ level: env.logLevel });

/**
 * Bind on all interfaces including IPv6. Fly's private `.internal` DNS returns
 * AAAA records only, so an IPv4-only bind is unreachable from a sibling app and
 * the symptom looks like a networking fault rather than a bind one.
 */
const HOST = process.env.HOST ?? '::';

mkdirSync(env.runsDir, { recursive: true });

createApp({ log }).listen(env.port, HOST, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: {
          toolCalls: env.maxToolCallsDeep,
          wallClockSec: env.maxWallClockSecDeep,
          dailyCap: env.deepDailyCap
        }
      }
    },
    'agent up — /health, the X-User-Id check and threads are live; the rest returns 501'
  );
});
