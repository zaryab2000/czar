# syntax=docker/dockerfile:1.7
#
# Czar web image (PM-013).
#
# The only image with a build step: `next build` runs here, at image build time, so
# the container starts a prebuilt app instead of compiling on the VM.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

# @czar/web's workspace closure: api-contract, config, hashing, schemas, vault-client.
# devDependencies are installed because next build needs the React types.
RUN pnpm install --frozen-lockfile --offline --filter @czar/web...

COPY packages/api-contract packages/api-contract
COPY packages/config       packages/config
COPY packages/hashing      packages/hashing
COPY packages/schemas      packages/schemas
COPY packages/vault-client packages/vault-client
COPY apps/web              apps/web
# @czar/schemas reads the spec schema files when it is first imported, so every image that
# ships the package ships them too.
COPY docs/specs/02-data-and-protocol/schemas docs/specs/02-data-and-protocol/schemas
# @czar/api-contract reads the OpenAPI documents at run time.
COPY docs/specs/02-data-and-protocol/api docs/specs/02-data-and-protocol/api

COPY ops/cloud/docker/healthcheck/http-health.mjs ops/cloud/docker/healthcheck/

# The build. next.config.ts reads CZAR_SERVER_URL for its /v1/* rewrite and defaults
# to http://127.0.0.1:3000, which is the server's loopback address on the VM
# (SCR-170 §2), so no build argument is needed and none is passed — a build argument
# is one of the places a secret must never appear (SCR-170 §4).
RUN pnpm --filter @czar/web build

# next start writes to .next/cache at run time, so that tree belongs to the runtime
# user. The rest of /app stays root-owned and read-only to the process.
RUN chown -R 10001:10010 apps/web/.next

# next start is invoked directly rather than through the package's own "start"
# script, which binds localhost. apps/web/package.json is not edited (SCR-170 §7).
WORKDIR /app/apps/web

USER 10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/ops/cloud/docker/healthcheck/http-health.mjs", "http://127.0.0.1:3100/"]

CMD ["pnpm", "exec", "next", "start", "--hostname", "127.0.0.1", "--port", "3100"]
