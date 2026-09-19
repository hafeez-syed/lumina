import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * X-User-Id is the whole auth story: one header, required on every contract route but
 * /health and /evals/report.json. These run against a real server on an ephemeral port
 * rather than a mocked request, because the thing being tested is middleware ordering —
 * a unit test that called the handler directly would pass even if the middleware never
 * ran.
 */
let server: Server;
let base: string;

before(async () => {
  // Silent logger: the request log is production behaviour, not test output.
  server = createApp(pino({ level: 'silent' })).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers });

test('rejects a request with no X-User-Id', async () => {
  const res = await get('/stats');
  assert.equal(res.status, 401);
});

test('the 401 body names the missing header', async () => {
  const res = await get('/stats');
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.status, 401);
  assert.match(body.error, /x-user-id/i);
});

test('rejects an X-User-Id that is only whitespace', async () => {
  const res = await get('/stats', { 'x-user-id': '   ' });
  assert.equal(res.status, 401);
});

test('lets a request with X-User-Id through to the route handler', async () => {
  const res = await get('/stats', { 'x-user-id': 'dev' });
  assert.notEqual(res.status, 401);
});

test('/health needs no X-User-Id', async () => {
  const res = await get('/health');
  assert.notEqual(res.status, 401);
});

test('/evals/report.json needs no X-User-Id', async () => {
  // The submission page is read by a stranger who has no header to send.
  const res = await get('/evals/report.json');
  assert.notEqual(res.status, 401);
});

test('an unknown route still 404s rather than 401s', async () => {
  const res = await get('/nope', { 'x-user-id': 'dev' });
  assert.equal(res.status, 404);
});
