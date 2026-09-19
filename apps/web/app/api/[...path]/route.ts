/**
 * Next.js Route Handlers that proxy the browser to the LUMINA gateway.
 *
 * The browser now talks same-origin to `/api/*`; this runs server-side and forwards to the
 * gateway. Two consequences worth stating: the gateway URL never reaches the client bundle,
 * and there is no cross-origin preflight from the UI.
 *
 * It is a pass-through on purpose. The gateway owns the contract — validation, status codes,
 * rate limits — so a catch-all here cannot drift from it the way twelve hand-written handlers
 * would. Nothing is parsed that does not have to be.
 */
import type { NextRequest } from 'next/server';

// The proxy streams and reads per-request headers; it must never be prerendered or cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://localhost:8787').replace(/\/$/, '');

/** Hop-by-hop and host-specific headers must not be forwarded. */
const STRIP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-length',
  'accept-encoding'
]);

function forwardHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Asking upstream for an identity encoding keeps SSE frames from being compressed,
  // which is one of the ways token-by-token streaming turns into one lump at the end.
  headers.set('accept-encoding', 'identity');
  return headers;
}

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const search = req.nextUrl.search;
  const target = `${GATEWAY}/${path.join('/')}${search}`;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req),
      // Streaming the request body through covers JSON and the multipart upload alike, with
      // no buffering. `duplex` is required by undici whenever the body is a stream.
      body: hasBody ? req.body : undefined,
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
      signal: req.signal
    } as RequestInit & { duplex?: 'half' });
  } catch (err) {
    // The gateway being unreachable is an upstream failure, and it says so: never a 2xx.
    return Response.json(
      { error: `gateway unreachable: ${(err as Error).message}`, status: 502 },
      { status: 502 }
    );
  }

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP.has(key.toLowerCase())) headers.set(key, value);
  });

  // SSE: hand the upstream stream straight back and tell every hop not to buffer or
  // transform it. Re-reading the body here would collect the whole answer and deliver the
  // tokens in one burst, which is the bug this project calls out by name.
  if (headers.get('content-type')?.includes('text/event-stream')) {
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
    headers.delete('content-encoding');
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  return proxy(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  return proxy(req, (await ctx.params).path);
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  return proxy(req, (await ctx.params).path);
}
