import { config } from 'dotenv';
import { resolve } from 'node:path';

// Both services read the single .env at the assignment root.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT_GATEWAY ?? process.env.PORT, 8787),
  agentUrl: process.env.AGENT_URL ?? 'http://localhost:8000',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /**
   * Optional: serve a pre-built static UI from the gateway so one host serves / and /evals.
   * Unset by default. The Next.js app in `apps/web` is deployed on its own (see TECHNICAL.md
   * Part 4) and only produces a static directory if you set `output: 'export'` in
   * next.config.js — point WEB_DIST at `apps/web/out` if you do.
   */
  webDist: process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : ''
} as const;
