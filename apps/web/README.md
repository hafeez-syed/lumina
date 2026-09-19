# `@lumina/web`

The LUMINA web UI — a [Next.js](https://nextjs.org) app (App Router, React 19).

> [!NOTE]
> This is currently the **stock Turborepo starter page**, not the LUMINA interface — the UI
> is still being built out. See the root [`README.md`](../../README.md).

It must eventually serve:

- `/` — query box, quick/deep toggle, streaming answer with citation chips, sources rail,
  plan panel, trace panel, thread list, memory panel, Spaces upload.
- `/evals` — renders `GET /evals/report.json` from your gateway.

## Getting started

From the repo root (preferred, so the gateway and agent come up too):

```bash
pnpm dev
```

Or this app alone:

```bash
pnpm dev --filter=@lumina/web
```

Open <http://localhost:3000>.

## Talking to the backend

The browser calls this app's own `/api/*` Route Handlers, which proxy to the gateway
server-side ([`app/api/[...path]/route.ts`](app/api/%5B...path%5D/route.ts)). The browser
never reaches the agent service and never holds a key.

Point the proxy at the gateway with a **server-only** env var:

```bash
GATEWAY_URL=http://localhost:8787   # defaults to this if unset
```

It is deliberately not `NEXT_PUBLIC_*` — the gateway address stays out of the client bundle.
Because the UI is now same-origin, it triggers no CORS preflight; the gateway's `CORS_ORIGINS`
still matters for the benchmark and eval harness, which call it directly.

Types for every route and SSE event come from [`@lumina/contract`](../../packages/contract) —
import them rather than restating shapes.
