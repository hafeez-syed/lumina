# LUMINA — the technical guide

> **This is the build guide: commands, architecture, checklists, and what the gates
> actually measure.** Keep it open while you work.
>
> Start at [`README.md`](README.md) if you have not run the app yet.
> [`AGENTS.md`](AGENTS.md) is the engineering contract, and `packages/contract/` is the
> executable source of truth.
>
> **No number here is authoritative.** Thresholds live in `benchmark/sla.json`,
> `expectations.json` and `eval/rubric.json`. If prose and JSON disagree, the JSON wins and
> this page is stale.

---

## Architecture

Three moving parts. The **UI is done**. You build the **two backend services** — Express on the
default path — and one MongoDB Atlas cluster holds everything, vectors included. The contract
is what matters; the stack behind it is replaceable.

```
   ┌──────────────────────────────┐
   │  Web UI  (apps/web/)         │   ← 🔨 YOURS · Next.js 16 + React 19
   │  query · quick/deep · plan   │      types from packages/contract
   │  stream · citations · trace  │
   └──────────────┬───────────────┘
                  │  HTTP + SSE   (X-User-Id, X-Request-Id)
                  ▼
   ┌──────────────────────────────┐
   │  Express gateway   :8787     │   ← YOU (software backend)
   │  CORS · zod-validate · log   │      rate-limit · SSE pass-through
   └──────────────┬───────────────┘
                  │  same contract
                  ▼
   ┌──────────────────────────────┐
   │  Express agent service :8000 │   ← YOU (AI backend): the real work
   │  loop · quick + deep gears   │      planner · fan-out · merge
   │  tools · memory · RAG        │      jobs worker · run logs
   └───┬──────┬──────────┬────────┘
       ▼      ▼          ▼
    Search   LLM +    MongoDB Atlas: threads · messages · memories (vector idx)
   (Tavily/  embed    chunks (vector + text idx) · searchCache (TTL) · jobs
   SerpApi) (env)     requests · runs · GridFS uploads
```

**Why two services?** Browser-facing concerns (CORS, validation, rate limiting, request logs,
serving the UI) are different from AI concerns (prompts, tools, keys, cost). Splitting them is the
FDE habit: each deploys and fails on its own, and your API keys never live on the edge the browser
can reach.

**Why one database?** Atlas Vector Search puts the embedding in the same document as the chunk text
and its page locator, so a citation is one document and `spaceId` is a plain filter. No second
store to keep in sync.

---

---

## Component map

| Component | Path |
|-----------|------|
| Web UI (query, quick/deep toggle, streaming, citation chips, sources rail with sub-question tags, plan panel, trace panel, memory panel, Spaces, `/evals`) | `apps/web/` |
| API contract as zod schemas + TypeScript types, for every route, SSE event and collection | `packages/contract/` |
| **Express gateway** — CORS, auth header, request id, logging, validation, rate limit, SSE pass-through | `apps/gateway/` |
| **Express agent service** — the quick loop, deep search, tools, memory, RAG, jobs worker, run logs | `apps/agent/` |
| Atlas index script (2 vector + 1 text + TTL indexes from one JSON), and a run-log exporter | `scripts/` |
| Benchmark + SLA (latency, grounding, recall, cache, decoupling, cost) | `benchmark/` |
| RAG gold set (39 questions) + a 4-document CC BY corpus, 2 of them PDFs with stable page numbers | `eval/gold/` |
| Six-gate runner, report builder, quality kit | `eval/`, `quality/` |

`packages/contract/`, `benchmark/`, `eval/`, `quality/` and `scripts/` are treated as fixed:
read them to understand the contract, then build against it.
`packages/contract/src/` is the best half hour you can spend before you start: it is the answer
to "what exactly am I supposed to return?", and the UI compiles against the same types, so drift
fails `pnpm check-types` before it fails you.

---

---

## The API contract (do not change it)

The full contract, with every SSE event and status code, is enforced by `packages/contract/`. The rules that matter:

- `POST /threads/{id}/ask` streams `trace → sources → token → done`. **`sources` arrives before the first `token`.**
- Every `[n]` in the answer has exactly one matching `n` in `sources`. Extra or missing is a grounding failure.
- `done` carries `latencyMs`, `ttftMs`, `tokens`, `costUsd`, `searchCached`, and `terminated: "done" | "cap" | "error"`, all measured server-side.
- `POST /spaces/{id}/documents` returns `202` in < 300 ms. The work happens on the `jobs` worker.
- `depth: "deep"` streams a `plan` event **before any retrieval**, tags every `trace` step and `source` with its `subQuestion`, and merges everything into one contiguous citation numbering. `depth` defaults to `"quick"` and the server never upgrades a request itself.
- `X-User-Id` is required on every route except `/health` (`401` without it). `429` for rate limit or the deep-search daily cap. `502` for any upstream failure.
- `GET /health` names the LLM, search provider, and vector backend. `GET /stats` reconciles with your logs.
- `GET /evals/report.json` serves the Product Evaluation your eval skill wrote ; the UI renders it at `/evals`.

---

---

## Build it: recommended order

Build the agent service first (test it with `curl -N`, no browser needed), then the gateway, then load the UI.

### Part 0: scaffold
```bash
pnpm install                      # workspace: apps/*, packages/* (Node >= 24, pnpm 11)
cp .env.example .env              # MONGODB_URI, LLM key, SEARCH_PROVIDER + key, OPENAI_API_KEY (embeddings)
cp DESIGN.template.md DESIGN.md   # answer the five questions BEFORE you write code
node scripts/create-indexes.mjs   # 2 vector + 1 text + TTL indexes on your Atlas cluster
node scripts/create-indexes.mjs --status   # search indexes build async: wait for queryable
pnpm dev                          # gateway :8787, agent :8000, web on :3000 with hot reload
```

Open the UI. Every panel says `501 not implemented yet`, and that is correct: each route you
finish lights one up. No Atlas yet? A plain local `mongod` (no `docker-compose.yml` ships with this repo) 
has no Vector Search — run with `VECTOR_BACKEND=mongo-cosine-scan` and make `/health` say so.

### Part 1: the agent service (the real work), `apps/agent/`
1. `/health`, then the loop with `web_search` + `fetch_page` and the SSE stream. Disable compression, flush after every event.
2. Search cache: in-process LRU over the `searchCache` collection (TTL index). `searchCached` in `done`.
3. `threads` + `messages`; follow-ups see the thread.
4. Memory: `save_memory` / `recall_memory` over the `memories` vector index; `GET /memory`, `DELETE /memory/{id}`.
5. Run log: one `runs/<requestId>.json` per answer (shape in `packages/contract/src/report.ts`). Ten lines. The gates read it.
6. Spaces + the `jobs` worker: upload → GridFS → parse (`pdfjs-dist`) → chunk → embed → upsert → **read-your-write probe** → `indexed`.
7. Hybrid retrieval: `$vectorSearch` + `$search` fused with RRF. Page locators in citations.
8. **Deep search**, in two sittings. First `plan_research` and the `plan` event: stream it before you retrieve anything, then read three plans out loud. If the sub-questions are not ones you would have asked, fix the prompt before building anything on top of it. Then the fan-out: research each sub-question, merge into one citation numbering (dedupe by URL or `docId`+locator, renumber from 1), tag every step and source with its `subQuestion`, synthesise a structured answer. Finally the gate: `DEEP_DAILY_CAP` → `429 {error, resetsAt}`, and make sure a quick search cannot reach `plan_research`.

Test it in isolation:
```bash
curl -s -X POST localhost:8000/threads -H 'x-user-id: dev' | tee /tmp/t.json
curl -N -X POST localhost:8000/threads/$(jq -r .threadId /tmp/t.json)/ask -H 'x-user-id: dev' \
  -H 'content-type: application/json' -d '{"query":"What is Tavily?","mode":"web"}'   # watch trace → sources → token → done
```

### Part 2: the gateway (software backend), `apps/gateway/`
CORS · `X-User-Id` check · `X-Request-Id` (reuse inbound or generate) · `pino` request log · zod validation from `packages/contract` · per-user rate limit · SSE pass-through · optional static UI via `WEB_DIST`.

### Part 3: see it live
`pnpm dev`, open the UI, ask a question, click a citation. Save a preference, open a new thread, watch it apply. Upload a PDF to a Space, ask about it, see `filename, p. N`. Then ask the *same* question twice — once on Quick, once on Deep — and put the two answers side by side. If the deep one is only longer, you have not finished.

### Part 4: ship it

Three deployables — the UI, the gateway, and the agent service (which must stay private).
Hosts, commands and the evaluation run are in [Deploy](#deploy) below.

---

---

## Performance, SLA & cost

Correct but slow or expensive fails in production. Every target lives in
[`benchmark/sla.json`](benchmark/sla.json), declared **before** you run, and `bench.mjs` exits
non-zero on any miss.

| Metric | Target | Why |
|--------|--------|-----|
| Time to first token, p95 | ≤ 2 500 ms | the "it's thinking" window a user tolerates |
| Full answer, p95 | ≤ 12 000 ms | plan + 2 searches + 4 fetches + synthesis |
| `202` accept latency, p95 | ≤ 300 ms | proves work is off the request path |
| Search p95 during a large ingest | ≤ 1.3 × idle | ingestion never starves answers |
| Citation grounding | ≥ 95 % | arithmetic on snippets, no judge |
| RAG recall@5 on the gold set | ≥ 0.70 | 30 questions, provided corpus |
| Search cache hit rate (bench workload) | ≥ 50 % | repeats are free |
| Deep search: time to plan, p95 | ≤ 4 000 ms | deep's real first paint; silence reads as broken |
| Deep search: full answer, p95 | ≤ 90 s | research takes a minute, not five |
| Deep sub-questions (min) | ≥ 3 | two is a quick search with extra steps |
| Deep / quick distinct-source ratio | ≥ 2.0× | the same question, both gears |
| Cost per deep answer (mean) | ≤ $0.35 | ~7× quick, and capped per user per day |
| Error rate | ≤ 1 % | |
| Cost per answer (mean) | ≤ $0.05 | prices in `sla.json` are placeholders; set yours |

```bash
node benchmark/bench.mjs                 # end to end through the gateway
node benchmark/bench.mjs --smoke         # five queries, Gate 2
node benchmark/bench.mjs --json out.json # machine-readable
node benchmark/bench.mjs --target https://your-gateway.fly.dev   # against the deploy
```

It writes `reports/bench.json` (everything it saw) and `reports/eval.json` (the four metric
names `quality/check.mjs` reads). Two things worth knowing before it judges you:

- **Grounding is verified against the real page.** For a web citation the bench re-fetches the
  URL and looks for your `snippet` in it, normalized, requiring a run of ~12 consecutive tokens.
  A publisher that blocks the bench makes a citation *unverifiable*, not wrong — those are
  excluded from the ratio and reported separately. A `[n]` with no matching source is never
  unverifiable; it is a fabrication and it is an automatic fail.
- **The gold set is 39 questions over a provided 4-document corpus** (`eval/gold/`), two of them
  PDFs whose page numbers are stable because they are generated by `build-corpus.mjs`. The bench
  uploads the corpus into a fresh Space, waits for `indexed`, and measures recall@5 against the
  `sources` event. `node eval/gold/validate-gold.mjs` re-checks every anchor against its
  declared page.

### Run the gates, then build the page

```bash
node eval/eval.mjs                                             # all six, in order, stops at the first failure
node eval/eval.mjs --deploy-url https://your-gateway.fly.dev   # the full gate run
```

Deployed instances write run logs to Mongo rather than to disk, so before the trajectory gate can
read anything: `node scripts/export-runs.mjs`.

**Where a failing run lives.** Rule P1 wants you to keep a trajectory you broke on purpose. Rule
A2 fails any run in `runs/` that did not terminate as `done`. So keep the deliberate failure in
**`runs/failing/`** — the trajectory rules read `runs/*.json` and not that subfolder, and
`eval/build-report.mjs` looks in both. Kill your search key, ask a question, move the log there.

---

---

## Requirements checklist

- [ ] **Loop**: bounded (8 tool calls, 90 s); `terminated` honest; every step a `trace` event; tool failures visible with an error string.
- [ ] **Search**: provider swappable via `SEARCH_PROVIDER`; pages fetched and read, not snippets; two-tier cache with TTL; `searchCached` accurate.
- [ ] **Citations**: every `[n]` resolves to a source retrieved in that request; empty retrieval says so.
- [ ] **Memory**: thread history persists; long-term memory saved explicitly, recalled semantically, listed and deletable at `/memory`; a preference provably crosses threads.
- [ ] **RAG**: `202` upload; async indexing on the `jobs` worker; page locators; one vector index filtered by `spaceId`; read-your-write probe before `indexed`; recall@5 ≥ 0.70.
- [ ] **Deep search**: `plan` before any retrieval with ≥ 3 sub-questions and a reason each; `subQuestion` on every step and source; one contiguous merged numbering that fully resolves; ≥ 2× the distinct sources of the same query run quick; structured answer.
- [ ] **Deep spend gate**: `DEEP_DAILY_CAP` per `X-User-Id` → `429 {error, resetsAt}`, enforced in the agent service; a quick search can never call `plan_research`.
- [ ] **Observability**: `pino` JSON lines in both services; one `X-Request-Id` correlates a request end to end; `/stats` reconciles with the log.
- [ ] **Run logs**: `runs/<requestId>.json` per answer; `node quality/check.mjs .` exits ≤ 1.
- [ ] **Performance**: `node benchmark/bench.mjs` exits 0.
- [ ] **Deploy**: services on Fly.io (or Vercel) against Atlas; the UI on Vercel works against the public gateway.
- [ ] **Product evaluation**: `/fde-lumina-eval` ran against the deployed app and wrote `report.json`; `/evals` renders it, including your design section and both full trajectories.

---

---

## Definition of Done: non-negotiables

> Written for your coding agent as much as for you. The same list lives in [`AGENTS.md`](AGENTS.md).
> Self-verify every box with the commands below before claiming done. Inspection is not verification.

**Contract**: shapes and status codes match `packages/contract` exactly; the provided UI works unmodified; `sources` precedes `token`.

**Loop**: caps exist per gear and are reported (`terminated: "cap"`); provider exceptions → `502` and `terminated: "error"`; **never** a plausible answer on an exception; a quick run never calls `plan_research`.

**Grounding**: a citation that does not resolve to something retrieved in that request is an automatic fail.

**Memory**: nothing is remembered that `GET /memory` does not show.

**Async**: `202` in < 300 ms; status flips only after the work succeeds; `indexed` only after the probe.

**Spend**: `DEEP_DAILY_CAP` enforced server-side in the agent service; cost logged per answer with its `depth`; quick is the default and the server never upgrades a request.

**Hygiene**: `.env`, `node_modules/`, `apps/web/.next/`, `runs/`, `reports/` git-ignored; the Atlas URI is a secret.

**Self-verify (all must pass)**
```bash
curl -sf localhost:8000/health && curl -sf localhost:8787/health                  # 1. both up, health nests the agent
T=$(curl -s -X POST localhost:8787/threads -H 'x-user-id: dev' | jq -r .threadId)
curl -N -X POST localhost:8787/threads/$T/ask -H 'x-user-id: dev' -H 'content-type: application/json' \
  -d '{"query":"latest on EU AI Act GPAI obligations","mode":"web"}' | grep -m1 '^event: sources'   # 2. sources before tokens
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/threads/$T/ask -d '{}'          # 3. 401 without X-User-Id
ls runs/*.json | head -1 && node quality/check.mjs .                                            # 4. run log exists, gates read it
node benchmark/bench.mjs                                                                       # 5. exit 0
git status --porcelain | grep -E '\.env$|node_modules|^runs/|^reports/' && echo "FAIL: unstage" || echo clean   # 6.
curl -sf https://<your-gateway>.fly.dev/health                                                 # 7. deployed for real
```

---

---

## Deploy

Three deployables:

| Piece | Host | Notes |
|---|---|---|
| The UI (`apps/web/`) | Vercel | Serves `/` and `/evals`. |
| The gateway | Fly.io, Vercel functions, anywhere reachable | Must be public — the browser talks to it. |
| The agent service | Fly.io private networking, or anywhere | Must **not** be publicly reachable: it holds the provider keys and enforces the deep-search cap. A cap you can bypass by calling the service directly is not a cap. |
| MongoDB | Atlas | — |

```bash
cd apps/agent      && fly launch --no-deploy && fly secrets set MONGODB_URI=... ANTHROPIC_API_KEY=... TAVILY_API_KEY=... OPENAI_API_KEY=... && fly deploy
cd ../gateway      && fly launch --no-deploy && fly secrets set AGENT_URL=https://<your-agent>.fly.dev && fly deploy
cd ../web          && vercel --prod          # set GATEWAY_URL=https://<your-gateway>.fly.dev (server-only)
```

Evaluation runs against the **deployed** gateway:

```bash
node eval/eval.mjs --deploy-url https://<your-gateway>
node eval/build-report.mjs --video <url> --design DESIGN.md \
  --successful <requestId> --failing <requestId> --notes "<model · provider · Atlas tier>"
```

`build-report.mjs` refuses a report built from a `--smoke` run, and exits non-zero if a red
line was crossed. The result is served at `GET /evals/report.json` and rendered at `/evals`.

---

---

## Troubleshooting

- **Tokens arrive all at once at the end** → something is buffering. Disable `compression` on the ask route, call `res.flushHeaders()`, and flush after each `res.write`. Set `X-Accel-Buffering: no`.
- **`indexed` but the question finds nothing** → Atlas Search indexes are eventually consistent. Your read-your-write probe is missing or too early.
- **`$vectorSearch` returns results from another Space** → the filter must be inside `$vectorSearch`, not a later `$match`, and `spaceId` must be declared as a filter field in the index definition.
- **Uploads stall the answer stream** → your worker is running on the main thread. Move it to `worker_threads` or `pnpm --filter=@lumina/agent worker`.
- **`429` on your first deep search** → `DEEP_DAILY_CAP` is per `X-User-Id`; the bench uses its own ids. Check `/stats.deepToday`.
- **The deep/quick source ratio fails at 1.2×** → your sub-questions are near-duplicates of each other and of the original question, so they retrieve the same pages. Read the plan: if you would not have asked those three questions, neither would a good retriever.
- **A quick search called `plan_research`** → you gave the model the whole toolbelt regardless of depth. Filter the tool list by depth before the first model call; a prompt asking it not to is a suggestion, not a gate.
- **UI shows "not implemented yet"** → expected until you finish that route. That message *is* your progress bar.
- **Gate 3 fails on the run you broke on purpose** → move it to `runs/failing/`. A2 grades the workload in `runs/`; P1 wants the failure kept. The subfolder is how both hold.
- **`bench.mjs` stops at "db is not ok"** → it refuses to measure a system that cannot persist. Fix `MONGODB_URI`, then `node scripts/create-indexes.mjs --status`.
- **Grounding is high but a few citations are "unverifiable"** → the bench could not fetch that page (403, paywall, JS-rendered). Those are excluded from the ratio, not counted against you. Dangling `[n]`s are a different thing and they are fatal.
- **recall@5 is 0 with everything `indexed`** → you are almost certainly filtering `spaceId` in a `$match` after `$vectorSearch` instead of inside it, or the search index is still `building`. Check `--status`.
- **`build-report.mjs` says the report came from a smoke run** → run the full `node benchmark/bench.mjs` first; smoke skips RAG, deep search and memory, so those rows would score zero.
- **The design section on `/evals` says MISSING** → `DESIGN.md` needs the five headings from `DESIGN.template.md`. It is parsed by heading, and it is graded in your own words.
