/**
 * The proxy to the agent service.
 *
 * The gateway owns the edge — identity, validation, limits — and owns no answers. So
 * every contract route but /health is forwarded, and the agent's own 501 is what the UI
 * renders while a route is still unbuilt.
 *
 * Two things this must never do: buffer an SSE stream (tokens arriving in one burst
 * reads as "the model is slow" and fails TTFT for a reason no profiler shows), and
 * answer 2xx when the upstream threw.
 */
import type { Express, Request, Response } from 'express';
import type { Logger } from 'pino';
import { Readable } from 'node:stream';
import { REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { sseHeaders } from './sse.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
]);

/**
 * How long to wait for the agent's response *headers*. Deliberately not a whole-request
 * timeout: a deep search streams for minutes, and cutting that off mid-answer would be
 * the bug this guard exists to prevent. The timer is cleared the moment headers land, so
 * only a silent or dead upstream trips it.
 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export function proxyHandler(
  agentUrl: () => string,
  log: Logger,
  upstreamTimeoutMs: number = DEFAULT_UPSTREAM_TIMEOUT_MS
) {
  return async (req: Request, res: Response): Promise<void> => {
    const target = `${agentUrl().replace(/\/$/, '')}${req.originalUrl}`;
    const requestId = String(res.locals.requestId);

    const headers: Record<string, string> = {
      [USER_HEADER]: String(res.locals.userId ?? ''),
      [REQUEST_HEADER]: requestId,
      accept: req.header('accept') ?? '*/*'
    };

    /**
     * Two body shapes. express.json() already consumed JSON, so that gets re-serialised.
     * An upload is deliberately NOT parsed here (the agent owns multipart), so its raw
     * stream is piped straight through — re-serialising `req.body` there would send
     * `undefined` and silently drop the file.
     */
    let body: string | ReadableStream | undefined;
    const hasBody = req.method !== 'GET' && req.method !== 'DELETE';
    const contentType = req.header('content-type') ?? '';

    if (hasBody && contentType.includes('application/json')) {
      body = JSON.stringify(req.body ?? {});
      headers['content-type'] = 'application/json';
    } else if (hasBody && contentType) {
      body = Readable.toWeb(req) as ReadableStream;
      headers['content-type'] = contentType;
    }

    let upstream: globalThis.Response;
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error(`agent service did not respond in ${upstreamTimeoutMs}ms`)),
      upstreamTimeoutMs
    );
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: ac.signal,
        // Required by undici whenever the body is a stream.
        ...(typeof body === 'object' && body ? { duplex: 'half' } : {})
      } as RequestInit);
    } catch (err) {
      // A dead dependency is a 502 with a log line. Never a plausible 200.
      log.error({ err, requestId, target }, 'agent service unreachable');
      res.status(502).json({ error: (err as Error).message, status: 502, requestId });
      return;
    } finally {
      // Headers are in (or we failed); the body may still stream for minutes.
      clearTimeout(timer);
    }

    for (const [k, v] of upstream.headers) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k, v);
    }

    const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');

    if (!isStream || !upstream.body) {
      const text = await upstream.text();
      res.status(upstream.status).send(text);
      return;
    }

    // SSE: write straight through, flushing each chunk as it arrives.
    res.status(upstream.status);
    sseHeaders(res);

    const reader = upstream.body.getReader();
    // A browser that navigates away must stop the upstream work, not orphan it.
    req.on('close', () => void reader.cancel().catch(() => {}));

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        // @ts-expect-error `flush` exists when a compression middleware is present.
        if (typeof res.flush === 'function') res.flush();
      }
    } catch (err) {
      log.error({ err, requestId }, 'stream from agent service broke');
    } finally {
      res.end();
    }
  };
}

/** Forward every contract route the gateway does not answer itself. */
export function registerProxy(
  app: Express,
  paths: { method: string; path: string }[],
  agentUrl: () => string,
  log: Logger,
  upstreamTimeoutMs?: number
): void {
  const handler = proxyHandler(agentUrl, log, upstreamTimeoutMs);
  for (const route of paths) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
    app[method](route.path, handler);
  }
}
