import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * pino-http serialises the whole inbound header block, so anything a proxy attaches
 * travels straight into `fly logs`. Vercel puts a live OIDC JWT on every forwarded
 * request and a bearer token inside x-vercel-sc-headers; both were readable in this
 * service's production logs. These run against a real server because the leak is a
 * property of the request serialiser, not of any handler — calling a handler directly
 * would log nothing and pass regardless.
 */
let server: Server;
let base: string;
let lines: string[];

/** Collects every emitted log line so a test can assert on what was written. */
const sink = () =>
  new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    }
  });

before(async () => {
  lines = [];
  server = createApp(pino({ level: 'info' }, sink())).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

/** Distinctive values: a substring match cannot pass by accident. */
const OIDC = 'eyJraWQiOiJTRUNSRVQtT0lEQy1UT0tFTi1WQUxVRSJ9.payload.sig';
const BEARER = 'Bearer SECRET-AUTHORIZATION-VALUE';
const SIGNATURE = 'Bearer SECRET-PROXY-SIGNATURE-VALUE';
const SC_HEADERS = '{"Authorization":"Bearer SECRET-SC-HEADERS-VALUE"}';

const logsAfter = async (headers: Record<string, string>) => {
  lines = [];
  await fetch(base + '/health', { headers });
  // autoLogging writes on response close, which can land after fetch resolves.
  await new Promise((r) => setTimeout(r, 50));
  return lines.join('\n');
};

test('does not log the x-vercel-oidc-token value', async () => {
  const out = await logsAfter({ 'x-vercel-oidc-token': OIDC });
  assert.ok(!out.includes(OIDC), 'OIDC token value was written to the log');
});

test('does not log the authorization header value', async () => {
  const out = await logsAfter({ authorization: BEARER });
  assert.ok(!out.includes('SECRET-AUTHORIZATION-VALUE'), 'authorization value was logged');
});

test('does not log the x-vercel-proxy-signature value', async () => {
  const out = await logsAfter({ 'x-vercel-proxy-signature': SIGNATURE });
  assert.ok(!out.includes('SECRET-PROXY-SIGNATURE-VALUE'), 'proxy signature was logged');
});

test('does not log the bearer token nested in x-vercel-sc-headers', async () => {
  const out = await logsAfter({ 'x-vercel-sc-headers': SC_HEADERS });
  assert.ok(!out.includes('SECRET-SC-HEADERS-VALUE'), 'sc-headers bearer token was logged');
});

test('marks a redacted header rather than dropping it silently', async () => {
  const out = await logsAfter({ authorization: BEARER });
  assert.match(out, /\[Redacted\]/, 'no [Redacted] marker: the header vanished instead');
});

test('still logs the non-sensitive headers that make a request greppable', async () => {
  const out = await logsAfter({ authorization: BEARER, 'x-user-id': 'u_keepme' });
  assert.ok(out.includes('u_keepme'), 'redaction removed a header that is safe to log');
});
