# syntax=docker/dockerfile:1.7
#
# Czar cloud base image (PM-013; SCR-170 §1 for the shape, §4 for the users).
#
# What this stage owns:
#   - the digest-pinned Node runtime
#   - corepack with the pinned pnpm
#   - the two non-root users and the shared signer-client group
#   - every workspace manifest plus a warm `pnpm fetch` store
#
# What it deliberately does NOT own: application source. Each app image adds only
# the source it needs, so a change in one app does not invalidate another's layers.
#
# The base reference arrives as NODE_BASE_IMAGE from ops/cloud/docker/base-image.env
# and has no default. A build that forgets it fails on an empty FROM rather than
# quietly resolving a floating tag.

ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS czar-base

ARG PNPM_VERSION

# Users and groups (SCR-170 §4):
#   GID 10010 czar-signer-clients  the group that may open the signer socket
#   UID 10001 czar-app             every app image except the signer
#   UID 10002 czar-signer          the signer image only
#
# Both users take 10010 as their primary group, so a client can open the 0660
# socket and the signer's own owner checks still see its own UID. Only the signer
# may reach the metadata server, which the host enforces by UID with iptables
# (SCR-170 §4) — that is why the signer's UID differs from every other image's.
# Neither user gets a login shell or a password.
RUN set -eux; \
    groupadd --gid 10010 czar-signer-clients; \
    useradd --uid 10001 --gid 10010 --no-user-group --create-home \
            --shell /usr/sbin/nologin czar-app; \
    useradd --uid 10002 --gid 10010 --no-user-group --create-home \
            --shell /usr/sbin/nologin czar-signer

# corepack activates the pnpm the repository pins in package.json "packageManager".
# PNPM_HOME and the store live outside /app so an app image's source COPY cannot
# shadow them, and the store is readable by both users.
ENV PNPM_HOME=/opt/pnpm \
    PNPM_STORE_DIR=/opt/pnpm/store \
    PATH=/opt/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN set -eux; \
    mkdir -p "${PNPM_HOME}" "${PNPM_STORE_DIR}"; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    pnpm --version; \
    pnpm config set store-dir "${PNPM_STORE_DIR}" --global

WORKDIR /app

# Workspace root files. .npmrc carries the repository's supply-chain rules
# (ignore-scripts, save-exact, engine-strict) and must be present before any install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc .nvmrc tsconfig.base.json ./

# Every workspace manifest, so the workspace pnpm sees matches the lockfile exactly
# and `--frozen-lockfile` holds. Manifests only — no source — so this layer is
# reused across all five app images and survives almost every source change.
COPY apps/daemon/package.json       apps/daemon/
COPY apps/indexer/package.json      apps/indexer/
COPY apps/merchants/package.json    apps/merchants/
COPY apps/server/package.json       apps/server/
COPY apps/signer/package.json       apps/signer/
COPY apps/web/package.json          apps/web/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/config/package.json       packages/config/
COPY packages/hashing/package.json      packages/hashing/
COPY packages/logging/package.json      packages/logging/
COPY packages/redaction/package.json    packages/redaction/
COPY packages/schemas/package.json      packages/schemas/
COPY packages/vault-client/package.json packages/vault-client/
COPY packages/x402/package.json         packages/x402/

# Warm the store from the lockfile alone. Each app image then installs its own
# filtered subset with --offline, so no install layer reaches the network and two
# builds of the same commit resolve the same bytes.
RUN pnpm fetch

# Drop root here so nothing that inherits this stage runs privileged by default.
# Each app image re-enters as root only for its install and build steps, then drops
# to its own runtime UID as the last instruction in the file.
USER 10001
