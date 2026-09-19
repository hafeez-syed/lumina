/**
 * The whole stack in one process, on ports nothing else is using, then the bench against
 * it. In-process because a spawned `tsx` exits 0 and leaves the real server running as an
 * orphan, which makes both startup and teardown unreliable.
 */
import { spawn } from 'node:child_process';
import pino from 'pino';
import { createApp as agentApp } from './src/app.js';
import { createApp as gatewayApp } from '../gateway/src/app.js';
import { runWorker } from './src/worker.js';

const AGENT_PORT = 8100;
const GATEWAY_PORT = 8888;
const ROOT = '/Users/hafeezsyed/Projects/AI/maven-forward-deployed-engineering-bootcamp/assignment-1-lumina';
const log = pino({ level: 'warn' });

const agent = agentApp({ log }).listen(AGENT_PORT);
await new Promise<void>((r) => agent.once('listening', r));
const gateway = gatewayApp(log, { agentUrl: `http://127.0.0.1:${AGENT_PORT}` }).listen(GATEWAY_PORT);
await new Promise<void>((r) => gateway.once('listening', r));

// The jobs worker: the bench uploads the gold corpus and waits for it to be indexed.
void runWorker();

const health = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`)).json();
console.log(`stack up — gateway :${GATEWAY_PORT} → agent :${AGENT_PORT}`);
console.log(`health: ${JSON.stringify(health)}`);

const bench = spawn('node', ['benchmark/bench.mjs', '--target', `http://localhost:${GATEWAY_PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit']
});
const code: number = await new Promise((r) => bench.on('exit', (c) => r(c ?? 1)));
console.log(`\n--- bench exited ${code} ---`);
process.exit(code);
