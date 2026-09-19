# syntax=docker/dockerfile:1
#
# The LUMINA gateway — the only service the browser reaches. Build from the REPOSITORY
# ROOT, not this directory:
#
#   docker build -f apps/gateway/Dockerfile .
#
# fly.toml sets that context for you. See apps/agent/Dockerfile for why this ships the
# whole built workspace rather than a pruned bundle.
#
# No provider key is ever read in this process. Its only upstream secret is AGENT_URL,
# which is a private address, not a credential.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/contract/package.json      packages/contract/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/agent/package.json             apps/agent/
COPY apps/gateway/package.json           apps/gateway/
COPY apps/web/package.json               apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY packages/contract packages/contract
COPY packages/typescript-config packages/typescript-config
COPY apps/gateway apps/gateway
RUN pnpm --filter @lumina/contract build \
 && pnpm --filter @lumina/gateway build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build /repo /repo

USER node
WORKDIR /repo/apps/gateway

EXPOSE 8787
CMD ["node", "dist/index.js"]
