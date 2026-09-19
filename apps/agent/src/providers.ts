/**
 * The outside world, behind four small interfaces.
 *
 * The loop depends on these rather than on an SDK so its guarantees — event order, caps,
 * failing loud — can be proven in a test without spending a cent. The real
 * implementations below are the only place a provider key is ever read.
 *
 * None of them catch their own errors. A provider that throws must reach the loop, which
 * ends the run as `terminated: "error"`. Swallowing it here and returning an empty result
 * is precisely the Live Translate failure.
 */
import type { AskTool, PlanEvent } from '@lumina/contract';
import { CachedPage, CachedSearch, mongoCacheStore } from './cache.js';
import { db } from './db.js';
import { env, secrets } from './env.js';

export type ToolDecision = {
  tool: AskTool;
  input: Record<string, unknown>;
  /** Why this step happened. It is what makes the trace a debugging surface. */
  reason?: string;
};

export type SearchHit = { title: string; url: string; snippet: string };

export type DecideContext = {
  query: string;
  depth: 'quick' | 'deep';
  /** What has already been observed, so the model can stop when it has enough. */
  observations: string[];
  toolsUsed: AskTool[];
};

export type AnswerContext = {
  query: string;
  sources: { n: number; title: string; snippet: string }[];
  history: { role: 'user' | 'assistant'; content: string }[];
  memories: string[];
};

export interface LlmProvider {
  readonly model: string;
  /** Deep search only: decompose the question before retrieving anything. */
  plan(query: string): Promise<PlanEvent>;
  /** The next tool to call, or null when there is enough to answer. */
  decide(ctx: DecideContext): Promise<ToolDecision | null>;
  streamAnswer(ctx: AnswerContext): AsyncIterable<string>;
  /** Totals for the run so far, for the done event and the cost budget. */
  usage(): { tokensIn: number; tokensOut: number; costUsd: number };
}

/**
 * `query` is what the provider is asked. `key` is what the result is filed under, and the
 * two are deliberately allowed to differ: the model rewrites a question into search terms
 * and does not rewrite it the same way twice, so keying on the rewrite means the same
 * question asked twice is two different cache entries and a repeat never hits.
 */
export type SearchKey = {
  /** What the user (or the sub-question) actually asked. Stable across runs; the rewrite is not. */
  basis: string;
  /** Which search this is for that basis within one request, so a refinement gets its own entry. */
  ordinal: number;
};

export interface SearchProvider {
  readonly name: string;
  search(query: string, key?: SearchKey): Promise<{ hits: SearchHit[]; cached: boolean }>;
}

export interface PageFetcher {
  fetch(url: string): Promise<{ title: string; text: string }>;
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type Providers = {
  llm: LlmProvider;
  search: SearchProvider;
  page: PageFetcher;
  embed: Embedder;
};

// ---------------------------------------------------------------- Anthropic

/** Per-million-token prices, so cost is a real number rather than a placeholder. */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-5': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 }
};

const DECIDE_SYSTEM = `You are the controller of a cited-answer search loop.
Reply with ONE json object and nothing else.
To use a tool: {"tool":"web_search"|"fetch_page"|"search_documents"|"recall_memory"|"save_memory","input":{...},"reason":"<one short clause>"}
When the observations are enough to answer: {"done":true}
Prefer to stop early. Every extra tool call costs money and latency.`;

const ANSWER_SYSTEM = `Answer the question from the numbered sources only.
Cite with [n] matching the source numbers. Never cite a number that is not in the list.
If the sources do not answer the question, say so plainly and cite nothing.
Be direct and specific. No preamble.`;

/**
 * The control plane is a <=1024-token JSON reply, so 20s is far beyond any healthy call
 * and only catches a genuine hang. It is deliberately not tighter: `decide` throwing
 * propagates to the ask loop's outer catch, which loses the whole answer, so a bound
 * tight enough to trip a merely slow call would trade latency for error rate — and the
 * error-rate SLA is one of the few currently passing.
 *
 * A hung call with no bound was never answered either, so this cannot make a run worse
 * than it already was. Letting a decide timeout break the loop and answer from what is
 * already retrieved would be strictly better still, but that is an ask-loop change.
 */
const LLM_TIMEOUT_MS = 20_000;

export class AnthropicLlm implements LlmProvider {
  readonly model: string;
  private tokensIn = 0;
  private tokensOut = 0;

  constructor(
    model = env.llmModel,
    private readonly apiKey = secrets.anthropic,
    private readonly timeoutMs = LLM_TIMEOUT_MS
  ) {
    this.model = model;
  }

  private async call(system: string, user: string, maxTokens = 1024): Promise<string> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const body = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    };
    this.tokensIn += body.usage?.input_tokens ?? 0;
    this.tokensOut += body.usage?.output_tokens ?? 0;
    return body.content.map((c) => c.text ?? '').join('');
  }

  /**
   * One call, parsed, with a single retry.
   *
   * The retry is not defensive padding: `claude-sonnet-5` emits a `thinking` block before
   * its `text` block and both are charged against `max_tokens`, so a budget that looks
   * generous for the json alone can still cut the json off. A resample almost always
   * lands, and losing an entire answer to one truncated control-plane reply is a bad
   * trade. Both attempts are billed, and `usage()` counts both — the cost is real and is
   * reported.
   *
   * A second failure throws. The loop must end as `terminated: "error"` rather than treat
   * an unreadable decision as "nothing more to do", which would answer from no sources.
   */
  private async decodeJson<T>(system: string, user: string, maxTokens: number): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.call(system, user, maxTokens);
      try {
        return JSON.parse(extractJson(raw)) as T;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async plan(query: string): Promise<PlanEvent> {
    return this.decodeJson<PlanEvent>(
      'Decompose the question into 3-6 sub-questions a researcher would actually ask. ' +
        'Reply with ONE json object: {"subQuestions":[{"i":1,"question":"...","reason":"..."}],"reason":"..."}',
      query,
      2048
    );
  }

  async decide(ctx: DecideContext): Promise<ToolDecision | null> {
    const parsed = await this.decodeJson<
      { done: true } | { tool: AskTool; input?: Record<string, unknown>; reason?: string }
    >(
      DECIDE_SYSTEM,
      [
        `Question: ${ctx.query}`,
        `Tools used so far: ${ctx.toolsUsed.join(', ') || 'none'}`,
        ctx.observations.length
          ? `Observations:\n${ctx.observations.map((o, i) => `(${i + 1}) ${o.slice(0, 900)}`).join('\n')}`
          : 'No observations yet.'
      ].join('\n\n'),
      // The decision itself is ~60 tokens. The rest is headroom for the thinking block,
      // which is charged here too: at 256 this call was truncated two times in three.
      // Unused budget is not billed, so the ceiling is free and the truncation is not.
      2048
    );

    if ('done' in parsed && parsed.done) return null;
    if (!('tool' in parsed)) return null;
    return { tool: parsed.tool, input: parsed.input ?? {}, reason: parsed.reason };
  }

  async *streamAnswer(ctx: AnswerContext): AsyncIterable<string> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const sourceBlock = ctx.sources
      .map((s) => `[${s.n}] ${s.title}\n${s.snippet}`)
      .join('\n\n');
    const memoryBlock = ctx.memories.length
      ? `\n\nWhat you remember about this user:\n${ctx.memories.join('\n')}`
      : '';

    /**
     * Headers only, not the whole request. An answer legitimately streams for many
     * seconds, so AbortSignal.timeout here would truncate healthy answers; the timer is
     * cleared the moment the response headers land and the body is then free to take as
     * long as it takes. Same distinction apps/gateway/src/proxy.ts makes.
     */
    const controller = new AbortController();
    const headersTimer = setTimeout(
      () => controller.abort(new Error('anthropic stream: aborted waiting for headers')),
      this.timeoutMs
    );
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        stream: true,
        system: ANSWER_SYSTEM + memoryBlock,
        messages: [
          ...ctx.history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: `Sources:\n${sourceBlock}\n\nQuestion: ${ctx.query}` }
        ]
      })
    });
    } finally {
      clearTimeout(headersTimer);
    }
    if (!res.ok || !res.body) {
      throw new Error(`anthropic stream ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = /^data: (.+)$/m.exec(block)?.[1];
        if (!line || line === '[DONE]') continue;
        const ev = JSON.parse(line) as {
          type: string;
          delta?: { text?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens: number; output_tokens: number } };
        };
        if (ev.type === 'message_start' && ev.message?.usage) {
          this.tokensIn += ev.message.usage.input_tokens ?? 0;
        }
        if (ev.type === 'message_delta' && ev.usage?.output_tokens) {
          this.tokensOut += ev.usage.output_tokens;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.text) yield ev.delta.text;
      }
    }
  }

  usage(): { tokensIn: number; tokensOut: number; costUsd: number } {
    const price = PRICING[this.model] ?? { in: 3, out: 15 };
    const costUsd = (this.tokensIn / 1e6) * price.in + (this.tokensOut / 1e6) * price.out;
    return { tokensIn: this.tokensIn, tokensOut: this.tokensOut, costUsd };
  }
}

/**
 * Models like to wrap json in prose or a fence. Take the object, not the packaging.
 *
 * Scans to the brace that *matches* the opening one rather than to the last brace in the
 * string. `lastIndexOf` is wrong in both directions: it swallows trailing junk into the
 * slice, and on a reply that was cut off mid-object it returns a nested closing brace,
 * which reaches `JSON.parse` as an unbalanced string and surfaces as a bare `SyntaxError`
 * about a character position. "Truncated" and "malformed" want different handling, so
 * they are told apart here.
 */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced?.[1] ?? raw;
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`model did not return json: ${raw.slice(0, 200)}`);

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    // A brace inside a string literal is prose, not structure.
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }

  throw new Error(`model reply was truncated mid-json: ${raw.slice(0, 200)}`);
}

// ---------------------------------------------------------------- search

/**
 * Above the measured p95 (11431ms over 228 deployed searches), below the observed max
 * (66830ms). Chosen that way on purpose: a bound tight enough to trim legitimate slow
 * searches would drop sources and push grounding down, which is the one thing a latency
 * fix here may not do. This ends runaway calls, it does not hurry up working ones.
 */
const SEARCH_TIMEOUT_MS = 15_000;

export class WebSearch implements SearchProvider {
  readonly name: string;
  constructor(
    private readonly provider = env.searchProvider,
    private readonly timeoutMs = SEARCH_TIMEOUT_MS
  ) {
    this.name = provider;
  }

  /** The key is the cache's business; the provider is asked the query and nothing else. */
  async search(query: string): Promise<{ hits: SearchHit[]; cached: boolean }> {
    const hits =
      this.provider === 'serpapi' ? await this.serpapi(query) : await this.tavily(query);
    return { hits, cached: false };
  }

  private async tavily(query: string): Promise<SearchHit[]> {
    if (!secrets.tavily) throw new Error('TAVILY_API_KEY is not set');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.tavily}` },
      body: JSON.stringify({ query, max_results: 5 }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
    return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  }

  private async serpapi(query: string): Promise<SearchHit[]> {
    if (!secrets.serpapi) throw new Error('SERPAPI_API_KEY is not set');
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', secrets.serpapi);
    url.searchParams.set('num', '5');

    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`serpapi ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      organic_results?: { title: string; link: string; snippet?: string }[];
    };
    return (body.organic_results ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet ?? ''
    }));
  }
}

// ---------------------------------------------------------------- page fetch

export class ReadablePage implements PageFetcher {
  async fetch(url: string): Promise<{ title: string; text: string }> {
    const res = await fetch(url, {
      headers: { 'user-agent': 'LuminaBot/1.0 (+https://github.com/)' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) throw new Error(`fetch_page ${res.status} for ${url}`);

    const html = await res.text();
    // Imported lazily: jsdom is heavy and only this tool needs it.
    const { JSDOM } = await import('jsdom');
    const { Readability } = await import('@mozilla/readability');

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = (article?.textContent ?? dom.window.document.body.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) throw new Error(`fetch_page extracted no text from ${url}`);
    return { title: article?.title ?? url, text };
  }
}

// ---------------------------------------------------------------- embeddings

export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  constructor(
    model = env.embeddingModel,
    private readonly apiKey = secrets.openai,
    /** Embedding sits on the pre-first-token path via recallMemory, so it needs a bound too. */
    private readonly timeoutMs = LLM_TIMEOUT_MS
  ) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');
    if (texts.length === 0) return [];

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts })
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as { data: { embedding: number[] }[] };
    return body.data.map((d) => d.embedding);
  }
}

export function defaultProviders(): Providers {
  return {
    llm: new AnthropicLlm(),
    // The loop only ever sees a SearchProvider; that the results came from a cache is the
    // decorator's business, and `cached` is the one thing it adds to the answer.
    search: new CachedSearch(new WebSearch(), mongoCacheStore(db)),
    // Same decorator shape as `search`: the loop still sees only a PageFetcher. One tier
    // and a short ttl — see CachedPage for why it is not backed by Mongo.
    page: new CachedPage(new ReadablePage()),
    embed: new OpenAiEmbedder()
  };
}
