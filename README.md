# LUMINA

> A Perplexity-style AI search engine. Ask a question, get a streamed answer with citations
> you can click, built from live web search and from your own documents. Ask a harder one and
> it plans sub-questions, researches each, and merges the citations into one numbering.

Two answer modes, deliberately separated:

| Mode | What it does | Envelope |
| ---- | ------------ | -------- |
| **Quick** (default) | One pass, a couple of searches, a cited answer in seconds | 8 tool calls / 90 s |
| **Deep** | Plans sub-questions, researches each, merges the results | 24 tool calls / 240 s |

The server never upgrades a request to deep on its own — cost stays a user decision.

## Architecture

A pnpm + Turborepo monorepo. The browser talks only to the gateway; provider keys live only
in the agent service.

```
  apps/web  (Next.js 16 · React 19)          :3000
       │  HTTP + SSE  (X-User-Id, X-Request-Id)
       ▼
  apps/gateway  (Express 5)                  :8787
       │  CORS · zod validation · rate limit · SSE pass-through · request log
       ▼
  apps/agent  (Express 5)                    :8000
       │  agent loop · tools · memory · RAG · deep search · jobs worker
       ▼
  MongoDB Atlas  (vector + text search, GridFS, TTL'd cache)
```

| Package | Role |
| ------- | ---- |
| [`apps/web`](apps/web) | `@lumina/web` — the UI |
| [`apps/gateway`](apps/gateway) | `@lumina/gateway` — the edge: auth header, validation, rate limits, SSE pass-through |
| [`apps/agent`](apps/agent) | `@lumina/agent` — the agent loop, tools, memory, RAG, jobs worker |
| [`packages/contract`](packages/contract) | `@lumina/contract` — zod schemas + types for every route, SSE event and document. Source of truth. |
| [`packages/ui`](packages/ui) | `@lumina/ui` — shared React components |
| `packages/eslint-config`, `packages/typescript-config` | shared tooling config |

## Getting started

Requires **Node >= 24** and **pnpm 11**.

```bash
pnpm install
cp .env.example .env      # MONGODB_URI, LLM key, SEARCH_PROVIDER + key, OPENAI_API_KEY
node scripts/create-indexes.mjs          # vector + text + TTL indexes on Atlas
node scripts/create-indexes.mjs --status # search indexes build async; wait for queryable
pnpm dev                  # web :3000 · gateway :8787 · agent :8000
```

No Atlas? Run a plain local `mongod` and set `VECTOR_BACKEND=mongo-cosine-scan` — cosine
scored in Node, fine up to a few thousand chunks.

### Commands

```sh
pnpm dev                            # everything in watch mode, via Turborepo
pnpm build
pnpm lint
pnpm check-types

pnpm dev --filter=@lumina/agent     # one app only
pnpm --filter=@lumina/agent worker  # the jobs worker
```

## How it works

**Streaming.** `POST /threads/{id}/ask` streams `trace → sources → token → done`, with `plan`
first on a deep search. `sources` is emitted *before* the first token, so citations are on
screen while the answer is still being written. Every `[n]` in the text has exactly one
matching entry in `sources`.

**Grounding.** Answers cite or they don't ship. A fabricated citation is a bug, not a
cosmetic issue — the benchmark checks every claim's `[n]` against the sources actually
retrieved.

**Failing loud.** A provider exception ends the run with `terminated: "error"` and a `502`.
No `try/catch` that returns a plausible-looking answer when the real cause was a thrown
exception.

**Retrieval.** Uploaded documents are parsed, chunked, embedded and indexed by a background
worker (upload returns `202`, never blocking the answer stream). Retrieval fuses vector and
text search with RRF, and citations carry page locators (`filename, p. 4`).

**Caching.** Search results go through an in-process LRU over a TTL'd Mongo collection, so
repeated questions don't re-bill the search provider.

## Design notes

[`TECHNICAL.md`](TECHNICAL.md) covers the architecture, the build order, performance and cost
budgets, and troubleshooting. [`AGENTS.md`](AGENTS.md) is the engineering contract — the
invariants any contributor (human or AI) has to preserve.

`packages/contract/` outranks prose: if a doc and a zod schema disagree, the schema is right.

## Status

Backend services are scaffolded and return `501` for routes that aren't implemented yet;
`/health` is live and reports the model, search provider, vector store and DB status.
`apps/web` is currently the starter page — the UI is being built out.

## Notes

`eval/gold/corpus/` contains third-party CC BY material — see `eval/gold/LICENSE-corpus.md`
for attribution. No project license is declared yet; add a `LICENSE` file before publishing.
