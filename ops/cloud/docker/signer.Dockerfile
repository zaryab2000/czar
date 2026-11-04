# syntax=docker/dockerfile:1.7
#
# Czar signer image (PM-013; entry point from SCR-170 §3, UID from §4).
#
# This is the one image that does not run as UID 10001. It runs as UID 10002,
# because the host's iptables rule lets only root and UID 10002 reach the metadata
# server (SCR-170 §4) — that is what stops any other container from minting a token
# and calling Cloud KMS asymmetricSign directly, around the signer's policy.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

# @czar/signer's workspace closure: config, hashing, logging, schemas, vault-client.
RUN pnpm install --frozen-lockfile --offline --filter @czar/signer...

COPY packages/config       packages/config
COPY packages/hashing      packages/hashing
COPY packages/logging      packages/logging
COPY packages/schemas      packages/schemas
COPY packages/vault-client packages/vault-client
COPY apps/signer           apps/signer

COPY ops/cloud/docker/healthcheck/signer-socket.mjs ops/cloud/docker/healthcheck/

# No keystore and no keychain reach this image. Signing keys live in Cloud KMS, and
# the client tokens the signer checks are mounted files under
# deploy.credentialFilesDir/signer/client-tokens/<service> (SCR-170 §4). The socket
# folder is a mount too, so the signer can create a socket there as 10002 while
# /app stays root-owned and read-only to it.

USER 10002

# The signer has no TCP port, so the probe checks the unix socket at the path the
# cloud config names.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "ops/cloud/docker/healthcheck/signer-socket.mjs"]

CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", \
     "apps/signer/src/cloud-main.ts"]
