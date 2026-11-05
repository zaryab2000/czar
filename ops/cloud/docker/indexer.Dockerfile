# syntax=docker/dockerfile:1.7
#
# Czar indexer image (PM-013).
#
# The indexer gets no new entry file (SCR-170 §3): it runs `ponder start` with the
# cloud config found through the CZAR_CLOUD_CONFIG pointer, and ponder.config.ts
# takes its additive cloud branch only when that pointer is set.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

# @czar/indexer's workspace closure: config, hashing, logging, schemas, vault-client.
RUN pnpm install --frozen-lockfile --offline --filter @czar/indexer...

COPY packages/config       packages/config
COPY packages/hashing      packages/hashing
COPY packages/logging      packages/logging
COPY packages/schemas      packages/schemas
COPY packages/vault-client packages/vault-client
COPY apps/indexer          apps/indexer

COPY ops/cloud/docker/healthcheck/http-health.mjs ops/cloud/docker/healthcheck/

# ponder writes its build and sync state under apps/indexer/.ponder at run time, so
# that one directory belongs to the runtime user. Everything else in /app stays
# root-owned and read-only to the process.
RUN install -d -o 10001 -g 10010 -m 0750 apps/indexer/.ponder

USER 10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "ops/cloud/docker/healthcheck/http-health.mjs", "http://127.0.0.1:42069/health"]

# `ponder start` refuses to run without a schema. `public` is the schema the local
# stack uses, so every unqualified table name in the signer projection and the
# server keeps resolving (SCR-170 §5).
CMD ["pnpm", "--filter", "@czar/indexer", "exec", "ponder", "start", \
     "--schema", "public", "--port", "42069", "--hostname", "127.0.0.1"]
