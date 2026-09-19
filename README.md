# Assignment 1: LUMINA

> Build a Perplexity-style AI search engine. Ask a question, get a streamed answer with
> citations you can click, built from a live web search and from your own documents. Ask a
> harder one and it plans sub-questions, researches each, and merges the citations.

You are given a **typed API contract** and `501` skeletons for the two backend services.
You build those services out, and the UI they talk to. When the backend works, the UI lights
up. That's the whole game.

---

## Start here

```bash
pnpm install
cp .env.example .env      # fill in MONGODB_URI and your provider keys
pnpm dev                  # web on :3000, gateway on :8787, agent on :8000
```

Open <http://localhost:3000> and click everything. A route that is not built yet answers
`501 not implemented yet`, which is correct: that message is your progress bar, and each
route you finish lights one up.

Requires **Node >= 24** and **pnpm 11**.

## Then read, in this order

| # | Read | Why |
|---|---|---|
| 1 | [`PRD.md`](PRD.md) | What the product is and the four rules that decide your grade. ~15 min. |
| 2 | `packages/contract/src/` | The contract, as zod schemas rather than prose — the literal answer to "what do I return?". Start with `sse.ts`, then `http.ts`. Best half hour you can spend. |
| 3 | [`DESIGN.template.md`](DESIGN.template.md) | Copy to `DESIGN.md` and answer the five questions **before you write code**. It is graded. |
| 4 | `benchmark/sla.json`, `expectations.json`, `eval/rubric.json` | The targets, the budgets, the points. Declared before you run, on purpose. |
| 5 | [`TECHNICAL.md`](TECHNICAL.md) | The build guide: architecture, commands, checklists, troubleshooting. |

Your coding agent should read [`AGENTS.md`](AGENTS.md) and [`SPEC.md`](SPEC.md) instead —
the first is the non-negotiables, the second is every requirement stated explicitly.

## What you build

| | |
|---|---|
| ✅ **Provided** | The API contract, `501` skeletons for both services, the Atlas index script, the benchmark, the gold set and corpus, the grader, and the eval skill. |
| 🔨 **Yours** | `apps/gateway/` — the edge: CORS, the `X-User-Id` check, request ids, logging, validation, rate limits, SSE pass-through. |
| 🔨 **Yours** | `apps/agent/` — the work: the agent loop, its tools, memory, RAG, deep search, the jobs worker, run logs. Provider keys live only here. |
| 🔨 **Yours** | `apps/web/` — the UI: query box, quick/deep toggle, streaming answer with citation chips, sources rail, trace and plan panels, Spaces, `/evals`. |

Do not edit `packages/contract/`, `benchmark/`, `eval/`, `quality/` or `scripts/`.
Those are the contract and the grader; editing them is a red line and it is checked.
Read them, then build a backend that satisfies them.

## The build, in one screen

Build the agent service first — you can drive it entirely with `curl -N`, no browser needed.
Then the gateway. Then the UI, and watch it light up.

1. `/health`, then the **quick loop** with `web_search` + `fetch_page`, streaming
   `trace → sources → token → done`. Sources before the first token.
2. The **search cache**: in-process LRU over a TTL'd Mongo collection.
3. **Threads and messages**, so a follow-up sees the conversation.
4. **Memory**: `save_memory` / `recall_memory`, listed and deletable at `/memory`.
5. The **run log** — one file per answer. Ten lines of adapter, and the gates read it.
6. **Spaces and the jobs worker**: upload → `202` → parse → chunk → embed → probe → indexed.
7. **Hybrid retrieval**: vector + text, fused, with page locators in the citations.
8. **Deep search**: plan sub-questions, research each, merge into one citation numbering.
9. The **gateway**, then the **deploy**.

Each step is a section in [`TECHNICAL.md`](TECHNICAL.md) with the commands and the gotchas.

## Where this build has got to

| Step | State |
|---|---|
| `/health`, threads, memory, Spaces, `/stats` | done |
| The quick loop: `trace → sources → token → done`, caps, run logs | done |
| Uploads + the jobs worker: `202` → parse → chunk → embed → probe → `indexed` | done |
| Gateway: `X-User-Id`, SSE pass-through, `502` on a dead upstream | done |
| Deep search: `plan` event and the daily cap | done — the per-sub-question fan-out is not |
| Hybrid retrieval: vector + text, RRF-fused, page locators in the citations | done |
| Search cache: in-process LRU over the TTL'd `searchCache` collection | done |
| `GET /evals/report.json` | not built — `/evals` has nothing to render until it is |

`pnpm test` runs 143 tests across the two services.

## Common commands

```sh
pnpm dev                            # every app in watch mode, via Turborepo
pnpm build
pnpm lint
pnpm check-types
pnpm test

pnpm dev --filter=@lumina/agent     # one app only
pnpm --filter=@lumina/agent worker  # the jobs worker
```

## How you prove it

```bash
node benchmark/bench.mjs      # the SLA: latency, grounding, recall, cache, cost. Exits 0 or tells you why.
node quality/check.mjs .      # the rules, over your run logs
node eval/eval.mjs            # all six gates, in order, stopping at the first failure
```

Correct but slow, expensive, or ungrounded fails. The targets are in
`benchmark/sla.json`, declared before your first run — [`TECHNICAL.md`](TECHNICAL.md)
explains what each one measures and how the grounding check works.

## How you submit

**One URL**: your deployed app, with `/` working for a stranger and `/evals` rendering the
evaluation your run produced. No repo, no zip, no code.

In Claude Code, run `/fde-lumina-eval --deploy-url https://<your-gateway>`. It runs the
gates against the deployed app, walks you through your two trajectories, and writes the
`report.json` the UI renders at `/evals`.

Full flow, the deploy table, and the 60–90 second video checklist:
[`TECHNICAL.md`](TECHNICAL.md#deploy).

## Stuck?

[`TECHNICAL.md`](TECHNICAL.md#troubleshooting) covers the failures that cost people the most
time: tokens arriving all at once, a document that indexes but cannot be found, retrieval
that leaks across Spaces, uploads that stall the answer stream, and a "deep" search that is
only slower.
