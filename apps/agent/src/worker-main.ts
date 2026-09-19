/**
 * Entrypoint for the jobs worker. The loop itself lives in `worker.ts` so its pieces can
 * be imported and tested without starting anything.
 *
 *   pnpm --filter=@lumina/agent worker
 */
import { runWorker } from './worker.js';

void runWorker();
