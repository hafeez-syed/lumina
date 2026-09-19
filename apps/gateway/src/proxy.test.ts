import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { createApp } from './app.js';

/**
 * The proxy is tested against a stub upstream rather than a running agent, so these
 * assert what the gateway does — forward identity, preserve the upstream status, and
 * turn a dead dependency into a 502 instead of a plausible 200.
 */
let upstream: Server;
let gateway: Server;
let base: string;
let seen: {
  url: string;
  userId?: string;
  requestId?: string;
  contentType?: string;
  body: string;
}[] = [];
let upstreamBehaviour: 'ok' | 'notfound' | 'die' = 'ok';

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        userId: req.headers[USER_HEADER] as string | undefined,
        requestId: req.headers[REQUEST_HEADER] as string | undefined,
        contentType: req.headers['content-type'],
        body
      });
      if (upstreamBehaviour === 'die') {
        req.destroy();
        return;
      }
      if (upstreamBehaviour === 'notfound') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no thread', status: 404 }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ threadId: 'thr_fromupstream' }));
    });
  }).listen(0);
  await new Promise<void>((r) => upstream.once('listening', r));
  const uaddr = upstream.address();
  if (uaddr === null || typeof uaddr === 'string') throw new Error('no upstream port');

  gateway = createApp(pino({ level: 'silent' }), {
    agentUrl: `http://127.0.0.1:${uaddr.port}`,
    // Short so the dead-upstream case fails fast; production uses 30s.
    upstreamTimeoutMs: 500
  }).listen(0);
  await new Promise<void>((r) => gateway.once('listening', r));
  const gaddr = gateway.address();
  if (gaddr === null || typeof gaddr === 'string') throw new Error('no gateway port');
  base = `http://127.0.0.1:${gaddr.port}`;
});

after(() => {
  gateway?.close();
  upstream?.close();
});

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

test('a proxied route returns the upstream status and body', async () => {
  upstreamBehaviour = 'ok';
  seen = [];
  const res = await call('POST', '/threads', { [USER_HEADER]: 'alice' }, { title: 'hi' });

  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { threadId: 'thr_fromupstream' });
});

test('the caller’s identity reaches the agent service', async () => {
  upstreamBehaviour = 'ok';
  seen = [];
  await call('POST', '/threads', { [USER_HEADER]: 'alice' }, {});

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.userId, 'alice');
});

test('the request id is forwarded so one request is greppable in both logs', async () => {
  upstreamBehaviour = 'ok';
  seen = [];
  await call('POST', '/threads', { [USER_HEADER]: 'alice', [REQUEST_HEADER]: 'req_abc123' }, {});

  assert.equal(seen[0]?.requestId, 'req_abc123');
});

test('the request body is forwarded intact', async () => {
  upstreamBehaviour = 'ok';
  seen = [];
  await call('POST', '/threads', { [USER_HEADER]: 'alice' }, { title: 'Vector search' });

  assert.deepEqual(JSON.parse(seen[0]?.body ?? '{}'), { title: 'Vector search' });
});

test('a multipart upload reaches the agent with its body intact', async () => {
  // express.json() deliberately skips uploads, so `req.body` is undefined here. A proxy
  // that re-serialises the parsed body would silently drop the file.
  upstreamBehaviour = 'ok';
  seen = [];

  const form = new FormData();
  form.append('file', new Blob(['# hello'], { type: 'text/markdown' }), 'notes.md');
  await fetch(`${base}/spaces/spc_x/documents`, {
    method: 'POST',
    headers: { [USER_HEADER]: 'alice' },
    body: form
  });

  assert.equal(seen.length, 1);
  assert.match(seen[0]?.contentType ?? '', /multipart\/form-data/);
  assert.match(seen[0]?.body ?? '', /# hello/);
  assert.match(seen[0]?.body ?? '', /notes\.md/);
});

test('an upstream 404 is passed through, not rewritten', async () => {
  upstreamBehaviour = 'notfound';
  seen = [];
  const res = await call('GET', '/threads/thr_nope', { [USER_HEADER]: 'alice' });

  assert.equal(res.status, 404);
});

test('an unreachable agent service is a 502, never a 2xx', async () => {
  // Rule A1: never a plausible success when the dependency threw.
  upstreamBehaviour = 'die';
  seen = [];
  const res = await call('GET', '/threads', { [USER_HEADER]: 'alice' });

  assert.equal(res.status, 502);
});

test('the proxy still refuses a request with no X-User-Id', async () => {
  upstreamBehaviour = 'ok';
  seen = [];
  const res = await call('GET', '/threads', {});

  assert.equal(res.status, 401);
  assert.equal(seen.length, 0, 'an unauthenticated request must not reach the agent');
});
