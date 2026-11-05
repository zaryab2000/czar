# syntax=docker/dockerfile:1.7
#
# Czar server image (PM-013; entry point from SCR-170 §3).
#
# BASE_IMAGE is the tag build-all.sh gave the base stage built from base.Dockerfile.
# It has no default, so this file cannot be built against an unknown parent.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Install and copy as root; the last instruction drops to the runtime UID.
USER root

# @czar/server's workspace closure: api-contract, config, hashing, logging, schemas,
# vault-client, x402, and @czar/signer (which is apps/signer, not a package).
# --offline keeps the install inside the store the base stage fetched, so this layer
# never reaches the network.
#
# `pnpm deploy` is deliberately not used anywhere in these images: it copies
# workspace TypeScript into node_modules, and Node refuses to strip types there.
RUN pnpm install --frozen-lockfile --offline --filter @czar/server...

# Source, after the install so a source change does not redo it. Only this app's
# own tree and its workspace closure are copied.
COPY packages/api-contract packages/api-contract
COPY packages/config       packages/config
COPY packages/hashing      packages/hashing
COPY packages/logging      packages/logging
COPY packages/schemas      packages/schemas
COPY packages/vault-client packages/vault-client
COPY packages/x402         packages/x402
COPY apps/signer           apps/signer
COPY apps/server           apps/server
# @czar/schemas reads the spec schema files when it is first imported, so every image that
# ships the package ships them too.
COPY docs/specs/02-data-and-protocol/schemas docs/specs/02-data-and-protocol/schemas
# @czar/api-contract reads the OpenAPI documents at run time.
COPY docs/specs/02-data-and-protocol/api docs/specs/02-data-and-protocol/api

# The prompt files computePromptHash reads, resolved relative to
# apps/server/src/models/proxy.ts as ../../../../models/<prompt>.md. The eval
# fixtures beside them are test data and stay out.
COPY models/P-01.md models/P-02.md models/

COPY ops/cloud/docker/healthcheck/http-health.mjs ops/cloud/docker/healthcheck/

# env/cloud.toml, the testnet deployment record and every credential are mounted at
# run time, never baked in (SCR-170 §4; the compose file is PM-014). The server's
# object store path (deploy.objectStorePath) is on the persistent disk, also mounted.

USER 10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "ops/cloud/docker/healthcheck/http-health.mjs", "http://127.0.0.1:3000/health"]

CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", \
     "apps/server/src/cloud-main.ts"]
