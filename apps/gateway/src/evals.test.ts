import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { createApp } from './app.js';

/**
 * `GET /evals/report.json` is the submission surface: the provided UI renders it at
 * /evals, and a stranger opens that page with no header to send. The gateway serves it
 * itself rather than proxying — the agent has no such route, and forwarding there is how
 * this ended up a 404.
 */
let upstream: Server;
let gateway: Server;
let base: string;
let reachedAgent = 0;
let dir: string;

const REPORT = { assignment: 'LUMINA', student: 'Hafeez Syed', rubric: { total: 100, awarded: 0 } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lumina-reports-'));

  upstream = createServer((_req, res) => {
    reachedAgent += 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent has no such route', status: 404 }));
  }).listen(0);
  await new Promise<void>((r) => upstream.once('listening', r));
  const ua = upstream.address();
  if (ua === null || typeof ua === 'string') throw new Error('no upstream port');

  gateway = createApp(pino({ level: 'silent' }), {
    agentUrl: `http://127.0.0.1:${ua.port}`,
    upstreamTimeoutMs: 500,
    evalsReportPath: join(dir, 'report.json')
  }).listen(0);
  await new Promise<void>((r) => gateway.once('listening', r));
  const ga = gateway.address();
  if (ga === null || typeof ga === 'string') throw new Error('no gateway port');
  base = `http://127.0.0.1:${ga.port}`;
});

beforeEach(() => {
  reachedAgent = 0;
  rmSync(join(dir, 'report.json'), { force: true });
});

after(() => {
  gateway?.close();
  upstream?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('serves the report the eval run produced', async () => {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(REPORT));

  const res = await fetch(`${base}/evals/report.json`);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), REPORT);
});

test('a stranger with no X-User-Id can read it', async () => {
  // The submission is a link someone opens cold. A 401 here would make the page useless.
  writeFileSync(join(dir, 'report.json'), JSON.stringify(REPORT));

  const res = await fetch(`${base}/evals/report.json`);
  assert.notEqual(res.status, 401);
});

test('the request never reaches the agent service', async () => {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(REPORT));

  await fetch(`${base}/evals/report.json`);
  assert.equal(reachedAgent, 0, 'the gateway owns this route; the agent has no such handler');
});

test('before any eval has run it is a 404 that says what to do', async () => {
  const res = await fetch(`${base}/evals/report.json`);

  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /fde-lumina-eval/, 'the 404 should name the command that writes it');
});

test('a corrupt report is a 500, not a silent empty page', async () => {
  writeFileSync(join(dir, 'report.json'), '{ this is not json');

  const res = await fetch(`${base}/evals/report.json`);
  assert.equal(res.status, 500);
});
