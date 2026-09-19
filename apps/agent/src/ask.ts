/**
 * The answer loop.
 *
 * Three invariants hold the whole thing together:
 *
 *   1. `sources` is emitted before the first `token`, so citation chips are on screen
 *      while the text is still arriving.
 *   2. The loop terminates for a stated reason — done, cap, or error — set at the call
 *      site. No SDK gives you that, and a run that ends without one is unaccountable.
 *   3. A provider that throws ends the run as `error`. It never becomes a plausible
 *      answer built from nothing.
 *
 * Depth is opted into and never drifted into: a quick run may not reach `plan_research`,
 * however much the model would like to.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import type { Db } from 'mongodb';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AskBody,
  COLLECTIONS,
  DEEP_ONLY_TOOLS,
  type AskTool,
  type Depth,
  type DoneEvent,
  type MessageDoc,
  type PlanEvent,
  type RunLog,
  type Source,
  type ThreadDoc,
  type Locator,
  type TraceEvent,
  newId
} from '@lumina/contract';
import type { Logger } from 'pino';
import { sseHeaders, sseSend } from './sse.js';
import { env } from './env.js';
import { withUsageScope, type Providers, type ToolDecision } from './providers.js';
import { hybridSearch, recallMemories } from './retrieval.js';
import { GROUNDING_WINDOW_TOKENS, bestPassage, groundingTokens } from './passage.js';

type ToolRun = { name: AskTool; ok: boolean; error?: string; ms?: number };

/** MessageDoc ids are plain strings; the contract's newId() has no 'msg' prefix. */
const messageId = (): string =>
  `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const startOfTodayIso = (): string => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
};

const endOfTodayIso = (): string => {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)
  ).toISOString();
};

export function registerAskRoute(
  app: Express,
  getDb: () => Promise<Db>,
  providers: Providers,
  log: Logger,
  runsDir: string = env.runsDir
): void {
  app.post(
    '/threads/:threadId/ask',
    /**
     * Give this request its own token meter before the handler runs. The llm provider is
     * one shared instance, so without a scope `usage()` returns the process total and
     * every row records the whole process's spend as the cost of one answer.
     *
     * `next()` is called inside the scope, so the handler it starts — and every await in
     * it — inherits the async context. A before/after snapshot would be simpler and wrong:
     * requests overlap, and one would bill another's tokens.
     */
    (_req: Request, _res: Response, next: NextFunction) => {
      void withUsageScope(async () => next());
    },
    async (req: Request, res: Response) => {
    const db = await getDb();
    const userId = String(res.locals.userId);
    const threadId = String(req.params.threadId);
    const requestId = String(req.header('x-request-id') ?? newId('req'));

    const parsed = AskBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '),
        status: 400
      });
      return;
    }
    const { query, mode, depth, spaceId } = parsed.data;

    const thread = await db
      .collection<ThreadDoc>(COLLECTIONS.threads)
      .findOne({ _id: threadId, userId });
    if (!thread) {
      res.status(404).json({ error: `no thread ${threadId}`, status: 404 });
      return;
    }

    /**
     * The spend gate lives here, not on the gateway: a cap you bypass by calling the
     * agent service directly is not a cap.
     */
    if (depth === 'deep') {
      const usedToday = await db.collection(COLLECTIONS.requests).countDocuments({
        userId,
        depth: 'deep',
        createdAt: { $gte: startOfTodayIso() }
      });
      if (usedToday >= env.deepDailyCap) {
        res.status(429).json({
          error: `deep-search cap of ${env.deepDailyCap} reached for today`,
          status: 429,
          resetsAt: endOfTodayIso()
        });
        return;
      }
    }

    // ---------------------------------------------------------------- stream

    const startedAt = Date.now();
    const deadlineMs = (depth === 'deep' ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000;
    const maxToolCalls = depth === 'deep' ? env.maxToolCallsDeep : env.maxToolCalls;

    const trace: TraceEvent[] = [];
    const toolRuns: ToolRun[] = [];
    const sources: Source[] = [];
    /**
     * Tool calls that already failed, keyed by tool plus exact input. A model that gets
     * an error back sometimes reissues the identical call; without this it does so until
     * the cap, which rule A2 counts as a failed run however good the answer was.
     */
    const failedCalls = new Set<string>();
    /**
     * How many times in a row one tool may be chosen. A model that reaches for the same
     * tool a fifth consecutive time is not converging on an answer, it is stuck in a
     * groove — and it spends the rest of the budget there, which is how a run ends 'cap'
     * instead of 'done'. Four leaves room for the legitimate pattern (one search, then
     * the three pages it turned up) without room for a loop.
     */
    const MAX_CONSECUTIVE_SAME_TOOL = 4;
    const observations: string[] = [];
    /** Search hits waiting to be fetched. Not citable until they are. */
    const candidates: { title: string; url: string; snippet: string }[] = [];
    const toolsUsed: AskTool[] = [];
    let searchCached = true;
    let sawSearch = false;
    /**
     * How many times this request has searched for each question, so the cache can file a
     * refinement separately from the search it refines. Keyed by the question rather than
     * by the model's search terms, which are not the same twice.
     */
    const searchOrdinal = new Map<string, number>();
    let terminated: 'done' | 'cap' | 'error' = 'done';
    let plan: PlanEvent | undefined;
    let answer = '';
    let ttftMs = 0;
    /**
     * When `sources` went out, from the same origin as `ttftMs`. The pair splits
     * time-to-first-token into retrieval (search, the page fetches, the decide loop) and
     * what follows it (history, memory recall, the model's first token). A ttft that
     * misses its target says only that it missed; these two say which half to fix.
     */
    let sourcesMs = 0;

    sseHeaders(res);

    const addSource = (s: Omit<Source, 'n'>): number => {
      const existing = sources.find(
        (x) => (s.url && x.url === s.url) || (s.docId && x.docId === s.docId)
      );
      if (existing) return existing.n;
      const n = sources.length + 1;
      sources.push({ ...s, n } as Source);
      return n;
    };

    const runTool = async (decision: ToolDecision, subQuestion?: number): Promise<void> => {
      const began = Date.now();
      const step = trace.length + 1;
      let ok = true;
      let error: string | undefined;
      const signature = `${decision.tool}:${JSON.stringify(decision.input ?? {})}`;

      try {
        switch (decision.tool) {
          case 'web_search': {
            const q = String(decision.input.query ?? query);
            /**
             * The cache is keyed on the question, not on `q`. The model rewrites the same
             * question into different search terms from one run to the next, so keying on
             * the rewrite makes every repeat a miss — the cache would be correct and
             * useless.
             */
            const basis = plan?.subQuestions?.[(subQuestion ?? 0) - 1]?.question ?? query;
            const ordinal = searchOrdinal.get(basis) ?? 0;
            searchOrdinal.set(basis, ordinal + 1);

            const { hits, cached } = await providers.search.search(q, { basis, ordinal });
            sawSearch = true;
            if (!cached) searchCached = false;
            /**
             * No source is created here. A search engine's snippet is its own summary of
             * the page, not a span of it, so citing one fails the grounding check even
             * when the claim is true. These are candidates; `fetch_page` turns them into
             * citable sources.
             */
            candidates.push(...hits.slice(0, 5));
            observations.push(`web_search(${q}) → ${hits.map((h) => h.title).join('; ')}`);
            break;
          }
          case 'fetch_page': {
            const url = String(decision.input.url ?? '');
            // Validated here so a bad url is a failed step with a reason, not a crash.
            if (!/^https?:\/\//i.test(url)) throw new Error(`not a fetchable url: ${url}`);
            const page = await providers.page.fetch(url);
            const snippet = bestPassage(page.text, query) || page.text.slice(0, 600);
            /**
             * A JS-rendered page gives Readability nothing but navigation chrome, and
             * citing that is ungrounded by construction: the bench caught a YouTube watch
             * page cited as "AboutPressCopyright...© 2026 Google LLC" — 10 tokens of
             * boilerplate supporting no claim. A page that cannot yield one grounding
             * window is a failed read, not a source.
             */
            if (groundingTokens(snippet) < GROUNDING_WINDOW_TOKENS) {
              throw new Error(
                `page has too little readable text to ground a citation ` +
                  `(${groundingTokens(snippet)} tokens, need ${GROUNDING_WINDOW_TOKENS}): ${url}`
              );
            }
            addSource({
              kind: 'web',
              title: page.title,
              // Verbatim from the page, and about the question: the grounding check
              // re-fetches this page and looks for the snippet inside it.
              snippet,
              url,
              subQuestion
            });
            observations.push(`fetch_page(${url}) → ${page.text.slice(0, 900)}`);
            break;
          }
          case 'search_documents': {
            const q = String(decision.input.query ?? query);
            const found = await searchDocuments(db, providers, log, {
              query: q,
              userId,
              spaceId,
              limit: 5
            });
            for (const c of found) {
              addSource({
                kind: 'doc',
                title: c.title,
                snippet: c.text.slice(0, 600),
                docId: c.docId,
                locator: c.locator,
                subQuestion
              });
            }
            observations.push(
              `search_documents → ${found.length ? found.map((f) => f.title).join('; ') : 'nothing indexed yet'}`
            );
            break;
          }
          case 'recall_memory': {
            const about = String(decision.input.query ?? query);
            const rows = await recallMemory(db, providers, log, about, userId, 5);
            observations.push(
              `recall_memory(${about}) → ${rows.map((r) => r.text).join('; ') || 'nothing'}`
            );
            break;
          }
          case 'save_memory': {
            const text = String(decision.input.text ?? '').trim();
            if (!text) throw new Error('save_memory needs a non-empty text');
            // Embed on the way in. A memory stored without its vector is invisible to
            // recall for ever — nothing backfills it.
            const [vector] = await providers.embed.embed([text]);
            await db.collection(COLLECTIONS.memories).insertOne({
              _id: newId('mem') as never,
              userId,
              text,
              embedding: vector ?? [],
              sourceThread: threadId,
              createdAt: new Date().toISOString()
            } as never);
            observations.push(`save_memory → remembered "${text}"`);
            break;
          }
          default:
            throw new Error(`unknown tool ${decision.tool}`);
        }
      } catch (err) {
        ok = false;
        error = (err as Error).message || 'tool failed';
        // Remember the exact call that failed, so the loop below can refuse to spend the
        // rest of its budget rediscovering the same error.
        failedCalls.add(signature);
        /**
         * `observations` is the only thing decide() reads, and every other push sits on a
         * success path — so a tool that threw reached the trace and the run log but never
         * the model. It would then reissue the same call, or leave a fixable mistake
         * unfixed: the bench caught save_memory called with empty text, told "save_memory
         * needs a non-empty text", with no way to learn that and try again.
         */
        observations.push(`${decision.tool} FAILED → ${error}`);
      }

      const ev: TraceEvent = {
        step,
        tool: decision.tool,
        input: decision.input,
        ok,
        ms: Date.now() - began,
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(ok ? {} : { error: error ?? 'tool failed' }),
        ...(subQuestion ? { subQuestion } : {})
      };
      trace.push(ev);
      toolRuns.push({ name: decision.tool, ok, error, ms: ev.ms });
      toolsUsed.push(decision.tool);
      sseSend(res, 'trace', ev);
    };

    try {
      if (depth === 'deep') {
        // The plan is streamed BEFORE any retrieval: a plan emitted after the fetches is
        // a rationalisation, not a plan.
        plan = await providers.llm.plan(query);
        sseSend(res, 'plan', plan);
      }

      /**
       * The first step is always retrieval. The model is entitled to believe it can answer
       * from what it already knows, but this is a search engine: an answer with no
       * retrieved source is ungrounded by construction, and the grounding check would
       * rightly fail it.
       */
      const firstStep: ToolDecision =
        mode === 'docs'
          ? { tool: 'search_documents', input: { query }, reason: 'answer from the selected Space' }
          : { tool: 'web_search', input: { query }, reason: 'ground the answer in current sources' };
      await runTool(firstStep, depth === 'deep' ? 1 : undefined);

      /**
       * Read the pages the search turned up. This is what makes an answer groundable: the
       * claim has to rest on a span of a real page, not on the search engine's summary of
       * one. Each fetch is its own trace step so the cap accounting stays honest.
       */
      const TOP_TO_READ = 3;
      const toRead = candidates.slice(0, Math.max(0, Math.min(TOP_TO_READ, maxToolCalls - trace.length)));

      /**
       * Concurrently: three pages read one after another put ~9s in front of the first
       * token, which is the whole TTFT budget spent on waiting for unrelated servers.
       * The results are then recorded in order, so the trace stays deterministic and the
       * step numbers do not interleave.
       */
      const reads = await Promise.all(
        toRead.map(async (hit) => {
          const began = Date.now();
          try {
            return { hit, page: await providers.page.fetch(hit.url), ms: Date.now() - began };
          } catch (err) {
            return { hit, error: (err as Error).message, ms: Date.now() - began };
          }
        })
      );

      for (const r of reads) {
        const page = 'page' in r ? r.page : undefined;
        const snippet = page ? bestPassage(page.text, query) || page.text.slice(0, 600) : '';
        // Same rule as the fetch_page tool above: a page that cannot yield one grounding
        // window is a failed read. Not thrown here — one unreadable page must not abandon
        // the others this loop is reading.
        const tooThin = Boolean(page) && groundingTokens(snippet) < GROUNDING_WINDOW_TOKENS;
        const ok = Boolean(page) && !tooThin;
        if (ok && page) {
          addSource({
            kind: 'web',
            title: page.title,
            snippet,
            url: r.hit.url,
            ...(depth === 'deep' ? { subQuestion: 1 } : {})
          });
          observations.push(`fetch_page(${r.hit.url}) → ${page.text.slice(0, 900)}`);
        } else {
          // Same reasoning as the catch above: a page the loop could not read is context
          // the model needs, or it will pick the same url again.
          observations.push(
            `fetch_page(${r.hit.url}) FAILED → ${
              tooThin
                ? 'page has too little readable text to ground a citation'
                : 'error' in r
                  ? r.error
                  : 'fetch failed'
            }`
          );
        }

        const ev: TraceEvent = {
          step: trace.length + 1,
          tool: 'fetch_page',
          input: { url: r.hit.url },
          ok,
          ms: r.ms,
          reason: `read ${r.hit.title} rather than cite the search summary`,
          ...(ok
            ? {}
            : {
                error: tooThin
                  ? `page has too little readable text to ground a citation ` +
                    `(${groundingTokens(snippet)} tokens, need ${GROUNDING_WINDOW_TOKENS})`
                  : 'error' in r
                    ? r.error
                    : 'fetch failed'
              }),
          ...(depth === 'deep' ? { subQuestion: 1 } : {})
        };
        trace.push(ev);
        toolRuns.push({ name: 'fetch_page', ok, error: ok ? undefined : ev.error, ms: r.ms });
        toolsUsed.push('fetch_page');
        sseSend(res, 'trace', ev);
      }

      /**
       * Every page refused us. AGENTS.md allows falling back to snippets; it does not
       * allow doing it silently, so the trace carries a step that says what happened.
       */
      if (sources.length === 0 && candidates.length > 0) {
        for (const hit of candidates.slice(0, TOP_TO_READ)) {
          addSource({ kind: 'web', title: hit.title, snippet: hit.snippet || hit.title, url: hit.url });
        }
        const ev: TraceEvent = {
          step: trace.length + 1,
          tool: 'web_search',
          input: { query },
          ok: false,
          ms: 0,
          error: 'no page could be read; citing search snippets, which are summaries and may not be verifiable',
          reason: 'fell back to search snippets'
        };
        trace.push(ev);
        toolRuns.push({ name: 'web_search', ok: false, error: ev.error, ms: 0 });
        sseSend(res, 'trace', ev);
      }

      while (trace.length < maxToolCalls) {
        if (Date.now() - startedAt > deadlineMs) {
          terminated = 'cap';
          break;
        }

        const decision = await providers.llm.decide({ query, depth, observations, toolsUsed });
        if (!decision) break;

        if (depth === 'quick' && (DEEP_ONLY_TOOLS as readonly string[]).includes(decision.tool)) {
          // A quick run that reaches plan_research has silently escalated into one costing
          // several times more. Refuse and answer with what we have.
          log.warn({ requestId }, 'quick run tried to escalate to plan_research; refused');
          break;
        }

        /**
         * Answer with what is already retrieved rather than grind to the cap. Breaking
         * leaves `terminated` as 'done', which is the honest outcome: the loop stopped
         * because it had nothing new to try, not because it ran out.
         */
        if (failedCalls.has(`${decision.tool}:${JSON.stringify(decision.input ?? {})}`)) {
          log.warn(
            { requestId, tool: decision.tool },
            'model reissued a call that already failed; answering with what we have'
          );
          break;
        }

        let consecutive = 0;
        for (let i = trace.length - 1; i >= 0 && trace[i]?.tool === decision.tool; i--) consecutive++;
        if (consecutive >= MAX_CONSECUTIVE_SAME_TOOL) {
          log.warn(
            { requestId, tool: decision.tool, consecutive },
            'the same tool was chosen too many times in a row; answering with what we have'
          );
          break;
        }

        const sub = plan ? ((trace.length % plan.subQuestions.length) + 1) : undefined;
        await runTool(decision, depth === 'deep' ? sub : undefined);
      }

      if (trace.length >= maxToolCalls) terminated = 'cap';

      // Sources before the first token, always.
      sourcesMs = Date.now() - startedAt;
      sseSend(res, 'sources', sources);

      const history = await db
        .collection<MessageDoc>(COLLECTIONS.messages)
        .find({ threadId, userId })
        .sort({ createdAt: 1 })
        .limit(20)
        .toArray();
      // Relevant to the question, not merely recent.
      const memories = await recallMemory(db, providers, log, query, userId, 5);

      for await (const chunk of providers.llm.streamAnswer({
        query,
        sources: sources.map((s) => ({ n: s.n, title: s.title, snippet: s.snippet })),
        history: history.map((m) => ({ role: m.role, content: m.content })),
        memories: memories.map((m) => m.text)
      })) {
        if (!ttftMs) ttftMs = Date.now() - startedAt;
        answer += chunk;
        sseSend(res, 'token', { text: chunk });
      }
    } catch (err) {
      // Fail loud: the run is over, it says why, and the client is not handed a
      // plausible-looking answer assembled from nothing.
      terminated = 'error';
      const message = (err as Error).message || 'provider failed';
      log.error({ err, requestId, threadId }, 'ask failed');
      sseSend(res, 'error', { status: 502, error: message });
      await persist({
        db,
        requestId,
        userId,
        threadId,
        query,
        answer: '',
        sources: [],
        depth,
        terminated,
        toolRuns,
        startedAt,
        ttftMs,
        sourcesMs,
        searchCached: sawSearch ? searchCached : false,
        usage: providers.llm.usage(),
        model: providers.llm.model,
        answerId: newId('ans'),
        subQuestions: plan?.subQuestions.length,
        runsDir,
        log
      });
      res.end();
      return;
    }

    const answerId = newId('ans');
    const usage = providers.llm.usage();
    const done: DoneEvent = {
      answerId,
      latencyMs: Date.now() - startedAt,
      ttftMs,
      model: providers.llm.model,
      tokens: { in: usage.tokensIn, out: usage.tokensOut },
      costUsd: usage.costUsd,
      searchCached: sawSearch ? searchCached : false,
      terminated,
      depth,
      ...(plan ? { subQuestions: plan.subQuestions.length } : {})
    };
    sseSend(res, 'done', done);

    // Persisted before the connection closes: the run log is what the gates read, and a
    // process that dies between end() and the write would lose it silently.
    await persist({
      db,
      requestId,
      userId,
      threadId,
      query,
      answer,
      sources,
      depth,
      terminated,
      toolRuns,
      startedAt,
      ttftMs,
      sourcesMs,
      searchCached: done.searchCached,
      usage,
      model: providers.llm.model,
      answerId,
      subQuestions: plan?.subQuestions.length,
      runsDir,
      log
    });

    res.end();
  });
}

// ---------------------------------------------------------------- persistence

type PersistArgs = {
  db: Db;
  requestId: string;
  userId: string;
  threadId: string;
  query: string;
  answer: string;
  sources: Source[];
  depth: Depth;
  terminated: 'done' | 'cap' | 'error';
  toolRuns: ToolRun[];
  startedAt: number;
  ttftMs: number;
  sourcesMs: number;
  searchCached: boolean;
  usage: { tokensIn: number; tokensOut: number; costUsd: number };
  model: string;
  answerId: string;
  subQuestions?: number;
  runsDir: string;
  log?: Logger;
};

/**
 * One request row (what /stats reconciles against) and one run log per answer (what the
 * gates read). Written after the stream closes so nothing here can delay a token.
 */
async function persist(a: PersistArgs): Promise<void> {
  const now = new Date().toISOString();
  const wallClockSec = (Date.now() - a.startedAt) / 1000;

  if (a.answer) {
    await a.db.collection(COLLECTIONS.messages).insertMany([
      {
        _id: messageId(),
        threadId: a.threadId,
        userId: a.userId,
        role: 'user',
        content: a.query,
        sources: [],
        // The question was asked when the request arrived and the answer finished now.
        // Real timestamps also give the thread a deterministic order; identical ones left
        // it to the id tiebreak, which is random.
        createdAt: new Date(a.startedAt).toISOString()
      },
      {
        _id: messageId(),
        threadId: a.threadId,
        userId: a.userId,
        role: 'assistant',
        content: a.answer,
        answerId: a.answerId,
        sources: a.sources,
        createdAt: now
      }
    ] as never[]);
  }

  await a.db.collection(COLLECTIONS.requests).insertOne({
    requestId: a.requestId,
    userId: a.userId,
    route: 'POST /threads/:threadId/ask',
    status: a.terminated === 'error' ? 502 : 200,
    ms: Date.now() - a.startedAt,
    tokensIn: a.usage.tokensIn,
    tokensOut: a.usage.tokensOut,
    costUsd: a.usage.costUsd,
    toolCalls: a.toolRuns.length,
    terminated: a.terminated,
    depth: a.depth,
    // Not in RequestDoc, but /stats needs them and the request log is the one place
    // that already has a row per answer.
    ttftMs: a.ttftMs,
    sourcesMs: a.sourcesMs,
    searchCached: a.searchCached,
    createdAt: now
  } as never);

  const run: RunLog = {
    tokens: a.usage.tokensIn + a.usage.tokensOut,
    wallClockSec,
    costUsd: a.usage.costUsd,
    terminated: a.terminated,
    depth: a.depth,
    toolCalls: a.toolRuns.map((t) => ({
      name: t.name,
      ok: t.ok,
      ...(t.ok ? {} : { error: t.error || 'tool failed' }),
      ...(t.ms === undefined ? {} : { ms: t.ms })
    }))
  };

  await a.db.collection(COLLECTIONS.runs).insertOne({
    ...run,
    requestId: a.requestId,
    userId: a.userId,
    threadId: a.threadId,
    answerId: a.answerId,
    query: a.query,
    createdAt: now
  } as never);

  /**
   * The file the quality kit reads locally. The `runs` collection above is the
   * authoritative copy (`scripts/export-runs.mjs` pulls it back from a deployment), so an
   * unwritable path must not take the answer down with it — this runs after `done` is
   * sent but before `res.end()`, and a throw here would hang the response.
   */
  try {
    mkdirSync(a.runsDir, { recursive: true });
    writeFileSync(join(a.runsDir, `${a.requestId}.json`), JSON.stringify(run, null, 2));
  } catch (err) {
    a.log?.error({ err, runsDir: a.runsDir }, 'could not write the run log file');
  }
}

// ---------------------------------------------------------------- document search

/**
 * Semantic memory recall, degraded loudly rather than silently.
 */
async function recallMemory(
  db: Db,
  providers: Providers,
  log: Logger,
  about: string,
  userId: string,
  limit: number
): Promise<{ text: string }[]> {
  const [embedding] = await providers.embed.embed([about]);
  return recallMemories(
    db,
    { embedding: embedding ?? [], userId, limit },
    {
      backend: env.vectorBackend,
      onDegraded: (which, err) => log.error({ err, which }, 'memory recall degraded')
    }
  );
}

/**
 * Retrieval for the `search_documents` tool.
 *
 * The question is embedded with the same model the chunks were, then both halves of
 * hybrid search run and are fused. A degraded half is logged rather than swallowed: an
 * Atlas index that is still building throws, and "nothing matched" must stay
 * distinguishable from "the retriever was broken".
 */
async function searchDocuments(
  db: Db,
  providers: Providers,
  log: Logger,
  args: { query: string; userId: string; spaceId?: string; limit: number }
): Promise<{ title: string; text: string; docId: string; locator?: Locator }[]> {
  const [embedding] = await providers.embed.embed([args.query]);

  const hits = await hybridSearch(
    db,
    { ...args, embedding: embedding ?? [] },
    {
      backend: env.vectorBackend,
      onDegraded: (which, err) =>
        log.error({ err, which }, `${which} retrieval degraded — results are partial`)
    }
  );

  return hits.map((h) => ({
    title: h.title,
    text: h.text,
    docId: h.docId,
    locator: h.locator
  }));
}

