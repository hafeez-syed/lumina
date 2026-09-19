import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicLlm, OpenAiEmbedder, WebSearch, extractJson } from './providers.js';

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

// ---------------------------------------------------------------- provider timeouts
/**
 * Of every outbound call in this file, only ReadablePage had an AbortSignal. The
 * exported run logs show what that asymmetry costs: fetch_page, which is bounded at
 * 12s, tops out at exactly 12002ms, while web_search — unbounded — reaches 66830ms.
 * A hung upstream had nothing to stop it until the ask loop's own wall-clock cap.
 *
 * A timeout is retrieval-neutral: it only fires on a call that was already delivering
 * a broken experience, so it removes no sources and cannot move grounding or recall.
 *
 * The stub hangs until aborted, which is the real failure being modelled — a socket
 * that accepted the request and then went quiet.
 *
 * The ref'd timer is load-bearing for the test, not for the code: `AbortSignal.timeout`
 * schedules an UNREF'd timer, so a stub holding no other handle lets the event loop
 * drain and node exits before the abort can fire. A real fetch holds a socket open and
 * keeps the loop alive; this stands in for it.
 */
const hangUntilAborted = () => {
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('unbounded: no signal was passed')), 5_000);
      const signal = init?.signal;
      if (!signal) return; // no signal: hang until the guard above, which is the bug
      signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(new Error('The operation was aborted'));
      });
    })) as unknown as typeof fetch;
};

test('a web search that hangs is aborted rather than waited on forever', async () => {
  hangUntilAborted();
  const search = new WebSearch(undefined, 40);

  await assert.rejects(
    () => search.search('anything'),
    /abort/i,
    'the search hung with nothing to stop it'
  );
});

test('a hung decide call is aborted rather than stalling the loop', async () => {
  hangUntilAborted();
  const llm = new AnthropicLlm(undefined, undefined, 40);

  await assert.rejects(
    () => llm.decide({ query: 'q', depth: 'quick', observations: [], toolsUsed: [] }),
    /abort/i,
    'the control-plane call hung with nothing to stop it'
  );
});

/**
 * streamAnswer sets `stream: true` and reads the body with a reader, so it must NOT get
 * the whole-request AbortSignal the other calls use: that would abort a healthy answer
 * partway through and truncate it. The bound has to apply to the headers only and be
 * released the moment they land — the same distinction apps/gateway/src/proxy.ts draws.
 *
 * These two tests are a pair. The first is the fix; the second is the thing the fix must
 * not break, and it is the one that fails if someone "simplifies" this to
 * AbortSignal.timeout later.
 */
const sseBody = (chunks: string[], gapMs: number, signal?: AbortSignal) =>
  new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Real fetch tears the body down when its signal aborts. The stub has to model
      // that, or a whole-request timeout looks identical to a headers-only one here and
      // the test below guards nothing.
      let aborted = false;
      signal?.addEventListener('abort', () => {
        aborted = true;
        controller.error(new Error('The operation was aborted'));
      });
      for (const text of chunks) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (aborted) return;
        const ev = JSON.stringify({ type: 'content_block_delta', delta: { text } });
        controller.enqueue(enc.encode(`data: ${ev}\n\n`));
      }
      controller.close();
    }
  });

const drain = async (llm: AnthropicLlm) => {
  let out = '';
  for await (const chunk of llm.streamAnswer({ query: 'q', sources: [], history: [], memories: [] }))
    out += chunk;
  return out;
};

test('an answer stream whose headers never arrive is aborted', async () => {
  hangUntilAborted();
  const llm = new AnthropicLlm(undefined, undefined, 40);

  await assert.rejects(() => drain(llm), /abort/i, 'the stream hung before headers with nothing to stop it');
});

test('a slow but healthy answer stream is not truncated by the headers bound', async () => {
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
    new Response(sseBody(['alpha ', 'beta ', 'gamma'], 30, init?.signal), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as unknown as typeof fetch;
  // A bound far shorter than the stream takes to finish: only correct if it covers
  // headers alone. A whole-request timeout truncates this.
  const llm = new AnthropicLlm(undefined, undefined, 40);

  assert.equal(await drain(llm), 'alpha beta gamma');
});

test('a hung embedding call is aborted rather than stalling recall', async () => {
  hangUntilAborted();
  const embedder = new OpenAiEmbedder(undefined, undefined, 40);

  await assert.rejects(
    () => embedder.embed(['some text']),
    /abort/i,
    'the embedding call hung with nothing to stop it'
  );
});
