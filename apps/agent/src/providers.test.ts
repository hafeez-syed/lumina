import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicLlm, extractJson } from './providers.js';

/**
 * These cover the JSON control plane — `plan` and `decide` — and exist because of a
 * specific failure observed against the live API.
 *
 * `claude-sonnet-5` emits a `thinking` block before its `text` block, and both count
 * against `max_tokens`. At the 256 the decide call used to ask for, two calls in three
 * came back `stop_reason: "max_tokens"` with the JSON cut off mid-string — once as
 * `{"tool"`, once with no text block at all. The loop turned that into
 * `terminated: "error"` and lost the whole answer.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A factory, not a `Response`: a body can only be read once, so a stub that replays the
 * same object turns a retry into "Body is unusable" and tests the wrong thing.
 */
const reply =
  (text: string, stopReason = 'end_turn') =>
  () =>
    new Response(
      JSON.stringify({
        content: [{ type: 'thinking', thinking: 'weighing the options' }, { type: 'text', text }],
        stop_reason: stopReason,
        usage: { input_tokens: 10, output_tokens: 20 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

/** Queues replies so a test can say "truncated, then fine". The last one repeats. */
function stubFetch(...responses: (() => Response)[]): { count: () => number } {
  let i = 0;
  globalThis.fetch = (async () => responses[Math.min(i++, responses.length - 1)]!()) as typeof fetch;
  return { count: () => i };
}

// ---------------------------------------------------------------- extractJson

test('extractJson takes the object, not the packaging', () => {
  assert.equal(extractJson('{"done":true}'), '{"done":true}');
  assert.equal(extractJson('```json\n{"done":true}\n```'), '{"done":true}');
  assert.equal(extractJson('Sure thing:\n{"done":true}\nhope that helps'), '{"done":true}');
});

test('extractJson closes on the matching brace, not the last one in the string', () => {
  const raw = '{"tool":"web_search","input":{"query":"a"}} trailing {noise';
  assert.equal(extractJson(raw), '{"tool":"web_search","input":{"query":"a"}}');
});

test('extractJson is not fooled by braces inside strings', () => {
  const raw = '{"reason":"a } brace in prose","done":true}';
  assert.equal(JSON.parse(extractJson(raw)).done, true);
});

test('extractJson says a reply was truncated rather than failing as bad syntax', () => {
  // Exactly what the API returned at max_tokens 256.
  assert.throws(() => extractJson('{"tool":"web_search","input":{"query":"'), /truncated/i);
  assert.throws(() => extractJson('{"tool'), /truncated/i);
});

test('extractJson still reports a reply that contains no object at all', () => {
  assert.throws(() => extractJson(''), /did not return json/i);
  assert.throws(() => extractJson('I cannot help with that'), /did not return json/i);
});

// ---------------------------------------------------------------- decide

test('decide retries a truncated reply instead of losing the answer', async () => {
  const f = stubFetch(
    reply('{"tool":"web_search","input":{"query":"', 'max_tokens'),
    reply('{"tool":"web_search","input":{"query":"p95 latency"},"reason":"find it"}')
  );
  const llm = new AnthropicLlm('claude-sonnet-5', 'test-key');

  const d = await llm.decide({ query: 'q', depth: 'quick', observations: [], toolsUsed: [] });

  assert.equal(f.count(), 2, 'it must actually retry');
  assert.equal(d?.tool, 'web_search');
  assert.equal(d?.input.query, 'p95 latency');
});

test('decide gives up loudly when the retry is also unusable', async () => {
  stubFetch(reply('{"tool"', 'max_tokens'));
  const llm = new AnthropicLlm('claude-sonnet-5', 'test-key');

  // Loudly: the loop must end as `error`, never silently as "nothing more to do",
  // which would produce a confident answer from no sources.
  await assert.rejects(
    llm.decide({ query: 'q', depth: 'quick', observations: [], toolsUsed: [] }),
    /truncated/i
  );
});

test('a valid reply is not retried', async () => {
  const f = stubFetch(reply('{"done":true}'));
  const llm = new AnthropicLlm('claude-sonnet-5', 'test-key');

  assert.equal(await llm.decide({ query: 'q', depth: 'quick', observations: [], toolsUsed: [] }), null);
  assert.equal(f.count(), 1);
});

test('plan retries a truncated reply too', async () => {
  const f = stubFetch(
    reply('{"subQuestions":[{"i":1,', 'max_tokens'),
    reply('{"subQuestions":[{"i":1,"question":"a","reason":"b"}],"reason":"c"}')
  );
  const llm = new AnthropicLlm('claude-sonnet-5', 'test-key');

  const p = await llm.plan('q');
  assert.equal(f.count(), 2);
  assert.equal(p.subQuestions.length, 1);
});

test('the decide budget leaves room for the thinking block', async () => {
  let sentMaxTokens = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sentMaxTokens = JSON.parse(String(init.body)).max_tokens;
    return reply('{"done":true}')();
  }) as unknown as typeof fetch;

  await new AnthropicLlm('claude-sonnet-5', 'test-key').decide({
    query: 'q',
    depth: 'quick',
    observations: [],
    toolsUsed: []
  });

  // 256 is the value that truncated two calls in three against the live API.
  assert.ok(sentMaxTokens >= 1024, `decide asked for only ${sentMaxTokens} tokens`);
});
