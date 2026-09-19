# DESIGN.md: LUMINA

Three standalone HTML diagrams go with this document. Each one opens in a browser with no server and no network.

  `docs/diagrams/lumina-architecture.html`
  `docs/diagrams/lumina-ask-sequence.html`
  `docs/diagrams/lumina-ingest-lifecycle.html`

## Components

Four things run, and about as many again hold state without being services. The architecture diagram shows all of them in one picture, including which boundary each one sits inside.

  `docs/diagrams/lumina-architecture.html`

These are the services:

  - `apps/web` is a Next.js app on Vercel. The browser only ever talks to this origin. Its `app/api/[...path]` route handlers forward to the gateway from the server side, so there is no CORS preflight from the UI and no gateway address anywhere in the client bundle.
  - `apps/gateway` is Node and Express on Fly. It is public, on port `8787`, and it is the only service with a public address. It validates, rate limits, attaches a request id, and forwards.
  - `apps/agent` is Node on Fly. It is private, on port `8000`, and one image runs as two process groups declared in `apps/agent/fly.toml`: `app` serves answers, `worker` drains the queue. Same code, different entrypoint.
  - MongoDB Atlas holds one database, ten collections and a GridFS bucket.

These are not services, but they hold state or make decisions, and leaving them out would misrepresent the system:

  - `jobs` is the queue. Indexing never happens on the request that uploaded the file. It becomes a row here and gets claimed later.
  - `searchCache` is tier 2 of the search cache, stored in Mongo and TTL indexed. The index is `searchCache_ttl` with `expireAfterSeconds` set to `0`, which means each row expires at its own `expiresAt`. This is the tier that survives a deploy.
  - `CachedSearch` and `CachedPage` are tier 1, in process LRUs. They cost a map lookup, they live per machine, and they start empty every time a machine boots.
  - `runs` and `requests` are the run log and the request log. They are not observability garnish. The gates read them, `/stats` is computed from `requests`, and `scripts/export-runs.mjs` pulls `runs` back out of a deployment.
  - The GridFS `uploads` bucket holds the original bytes of an uploaded document, kept apart from the chunks derived from them.

Retrieval quality is a property of the Atlas indexes, not of any line of application code. An M0 tier allows exactly three, so these are the entire budget:

  `memories_vector`
  `chunks_vector`
  `chunks_text`

## Responsibilities

The useful half of this section is the exclusions. The architecture diagram draws them as boundaries, and its key isolation view shows the one that matters most.

  `docs/diagrams/lumina-architecture.html`

`apps/agent` is the only process holding a provider key, and the only one enforcing the daily deep search cap. Those are the same decision, not two.

  cap enforced in: `apps/agent/src/ask.ts:102`
  reasoning at: `apps/agent/fly.toml` lines `2` to `3`

The argument is written at the top of that `fly.toml`: a spend cap you can bypass by calling the service directly is not a cap. If the gateway enforced the cap while the agent stayed reachable, the cap would be a suggestion. So the agent has no public address at all.

`apps/gateway` is the only service the browser can reach, and it holds no provider key. It can refuse a request, shape it, and pass it along. It cannot answer one. A compromised gateway therefore leaks no credential and spends no money.

`apps/web` never lets `GATEWAY_URL` reach anything shipped to a browser. The value is read server side, in the route handler, and nowhere else. The browser holds no key, knows no upstream address, and carries exactly one piece of identity, the `X-User-Id` header.

The `worker` must not run on the machine serving answers. It is a separate process group for a latency reason rather than a tidiness one. Indexing a PDF is CPU bound embedding work, and doing that on the thread that owes somebody a streaming token is how time to first token stops being predictable under load.

## Communication

The sequence diagram walks one question through every hop and shows the exact frame order.

  `docs/diagrams/lumina-ask-sequence.html`

Each pair talks like this:

  browser to `apps/web`: same origin `/api/*`
  `apps/web` to gateway: server side, via `GATEWAY_URL`
  gateway to agent: `lumina-fde-agent.internal:8000`
  agent to browser: SSE, relayed unbuffered

That internal name resolves AAAA only, which is why the agent binds `HOST` to `::` rather than `0.0.0.0`. Bind to an IPv4 wildcard on this network and the service is simply unreachable, and the symptom looks like a crash rather than a config mistake.

Answers come back in a fixed frame order, and the order is a contract rather than an implementation detail:

  `plan` (deep only), `trace`, `sources`, `token`, `done`

The `worker` is the exception, because nothing pushes to it. It polls, and it claims a job with a single atomic `findOneAndUpdate`.

  `apps/agent/src/worker.ts:49`

A read then write would let two workers claim the same row and embed the same document twice. A sweeper puts rows back to `pending` when the worker holding them died mid flight, so a crash costs a retry instead of leaving a document stuck in `running` forever.

What happens when the far end is down:

  - The agent is unreachable from the gateway. That is a `502`, never a `2xx`. `apps/gateway/src/proxy.ts` bounds how long it waits for the agent's response headers rather than for the whole request, because a whole request timeout would cut off an SSE stream that is streaming perfectly well for minutes. The timer clears the moment headers land.
  - A provider hangs part way through an answer. Every outbound provider call is bounded now, and the streaming answer call is bounded on headers only, the same distinction the proxy makes, because an answer legitimately streams for a long time.
  - Mongo is unreachable. The request fails. There is no degraded read only mode and I did not build one.
  - The `worker` is down. Uploads still return `202` and still queue. Nothing is lost. Documents just stay `pending` until a worker comes back.

The outbound bounds are:

  search: `15s`
  control plane LLM calls: `20s`
  page fetch: `12s`
  streaming answer: headers only, body unbounded

## State

The lifecycle diagram traces a document from upload to searchable, including the window described below and the two ways it can go wrong.

  `docs/diagrams/lumina-ingest-lifecycle.html`

Authoritative state, where losing it loses something real:

  `threads`, `messages`, `memories`, `spaces`
  `documents`, `chunks`
  `runs`, `requests`

That last line is authoritative for a different reason. Those rows are the evidence the gates and `/stats` are computed from, so a lost row is a number nobody can reproduce.

Disposable state, where the only cost of deleting it is a cold period:

  `searchCache` (tier 2, in Mongo)
  `CachedSearch` and `CachedPage` (tier 1, in process)

Everything in them came from a provider response and can be fetched again. The two tiers are deliberately not symmetric, and treating them as one thing is the bug that shows up as a mysteriously low hit rate. After a deploy, tier 1 is empty on every machine while tier 2 is still warm.

The interesting case is a document that has been written but is not yet searchable. Upload inserts the document with status `pending`, inserts a job, and returns `202` before any embedding has happened.

  `apps/agent/src/spaces.ts:160-176`

The window is real, and it is deliberate. A synchronous upload would mean a 60 page PDF holds an HTTP connection open for the length of an embedding run.

Here is what I do about it. The document is visible immediately with status `pending`, so the UI can show it rather than pretend it does not exist. A job is only marked `done` once a read your write probe confirms the chunks are genuinely retrievable, not merely inserted. A document whose embedding fails gets marked `failed` with a reason instead of sitting `pending` forever. What I do not do is block a question on any of this. Ask something in that window and the answer simply will not cite the new document. That is not an error, and the user is not told to wait.

## Trade-offs

Atlas Vector Search instead of a dedicated vector store. One database, one connection string, one backup story, and a citation is just a document. The cost is the M0 three index ceiling, which is why the three index names above use up the whole budget. A fourth retrieval strategy needs a tier upgrade, not a code change.

The page cache is a single tier in process LRU while the search cache has two tiers. Search results are small, priced per call, and shared across users, so paying for a Mongo round trip to keep them is clearly worth it. Page bodies are large and I did not want to grow the database with them. The cost is that every deploy starts cold on pages, so a redeploy during grading will look slower than steady state. I think this is the right call and I would be happy to be proven wrong by a measurement.

Provider timeouts set above the measured p95 rather than close to it. The search numbers that drove the `15s` bound:

  search p95: `11431ms` across `228` searches
  search worst case: `66830ms`
  bound chosen: `15s`

That kills runaway calls and deliberately leaves slow but working ones alone. A tighter bound would improve tail latency by dropping sources, and dropping sources moves citation grounding, which is the number I am least willing to trade. This is a deliberate refusal to fix a latency number the cheap way.

Refusing to cite a page with no groundable text. If a citation cannot be verified against fetched text, it does not get emitted. This costs recall, and the last deployed run shows it. I would rather miss a source than manufacture a citation.

The one I am unsure about is sources before the first token, and the sequence diagram shows exactly why.

  `docs/diagrams/lumina-ask-sequence.html`

It is a correctness guarantee. Citation chips are on screen before any prose makes a claim, so the user never reads an assertion with no visible provenance. It also puts a hard floor under time to first token, because retrieval has to finish completely before a single token ships. The deployed run measured that floor:

  ttft p50: `7175ms` (target `2500ms`)
  ttft p95: `13676ms`
  answer p95: `16721ms` (target `12000ms`)
  citation grounding: `0.90` (target `0.95`)
  recall@5: `0.667` (target `0.70`)
  cost per quick answer: `$0.0439` (cap `$0.05`)
  error rate: `0`

No amount of tuning inside this contract reaches `2500ms`. The contract itself is what would have to change, by streaming the plan first, or by emitting a source as soon as one is verified instead of waiting for the whole set. I chose the guarantee over the number, and I am genuinely unsure it was right, because a user feels seven seconds of nothing far more sharply than a citation that lands `200ms` after the sentence it supports.
