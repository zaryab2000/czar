# syntax=docker/dockerfile:1.7
#
# Czar merchants image (PM-013; entry point from SCR-170 §3).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

# @czar/merchants' workspace closure: config, hashing, logging, x402, and
# @czar/signer (apps/signer), which pulls in schemas and vault-client.
RUN pnpm install --frozen-lockfile --offline --filter @czar/merchants...

COPY packages/config       packages/config
COPY packages/hashing      packages/hashing
COPY packages/logging      packages/logging
COPY packages/schemas      packages/schemas
COPY packages/vault-client packages/vault-client
COPY packages/x402         packages/x402
COPY apps/signer           apps/signer
COPY apps/merchants        apps/merchants

COPY ops/cloud/docker/healthcheck/http-health.mjs ops/cloud/docker/healthcheck/

USER 10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "ops/cloud/docker/healthcheck/http-health.mjs", "http://127.0.0.1:8787/health"]

CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", \
     "apps/merchants/src/cloud-main.ts"]
