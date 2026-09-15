# `@lumina/web`

The LUMINA web UI — a [Next.js](https://nextjs.org) app (App Router, React 19).

> [!IMPORTANT]
> This is currently the **stock Turborepo starter page**, not the LUMINA interface. The
> React 18 + Vite UI that `SPEC.md` and `TECHNICAL.md` describe as "provided" is not present
> in this repository. Building it here is part of the assignment — see the root
> [`README.md`](../../README.md).

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

The browser talks **only** to the gateway (`:8787`), never to the agent service. Point the app
at the gateway with a public env var, e.g. `NEXT_PUBLIC_API_URL=http://localhost:8787`.

The gateway's CORS allowlist defaults to `http://localhost:3000`; override it with
`CORS_ORIGINS` when you deploy.

Types for every route and SSE event come from [`@lumina/contract`](../../packages/contract) —
import them rather than restating shapes.
