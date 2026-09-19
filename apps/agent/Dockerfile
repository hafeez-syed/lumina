# syntax=docker/dockerfile:1
#
# The LUMINA agent service. Build from the REPOSITORY ROOT, not this directory:
#
#   docker build -f apps/agent/Dockerfile .
#
# fly.toml sets that context for you. The root is needed because this is a pnpm workspace:
# the lockfile, the catalog, and `packages/contract` all live above this app.
#
# This image ships the whole built workspace rather than a pruned bundle. It is larger, and
# that is a deliberate trade: `pnpm deploy` and `pnpm prune --prod` both rewrite the
# workspace links, and a link that resolves on your laptop but not in the image fails at
# container start, which is the most expensive place to find out.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- dependencies
# Manifests first: this layer is cached until a dependency actually changes.
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
COPY apps/agent apps/agent
# The contract must be built first: the agent imports it from `dist`.
RUN pnpm --filter @lumina/contract build \
 && pnpm --filter @lumina/agent build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
# Where per-answer run logs land. The `runs` collection in Mongo is the authoritative
# copy; this path only has to be writable.
ENV RUNS_DIR=/repo/runs

COPY --from=build /repo /repo
RUN mkdir -p /repo/runs && chown -R node:node /repo/runs

USER node
WORKDIR /repo/apps/agent

# No EXPOSE and no public port: this service is reached only over Fly's private network.
# It holds every provider key and enforces the deep-search cap, and a cap you can bypass
# by reaching the service directly is not a cap.
CMD ["node", "dist/index.js"]
