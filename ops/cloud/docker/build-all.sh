#!/usr/bin/env bash
# Builds every Czar cloud image from a clean clone (PM-013).
#
#   ops/cloud/docker/build-all.sh
#
# Tags each image czar-<app>:<git-sha>, where <git-sha> is the short HEAD commit.
# The base stage is built first, as czar-base:<git-sha>, and passed to each app
# image as BASE_IMAGE.
#
# This script builds. It never pushes, publishes, tags a registry or deploys:
# pushing images is part of the approved deployment, not of this task.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
docker_dir="${repo_root}/ops/cloud/docker"
cd "${repo_root}"

# The pinned base image, from the one file that names it.
# shellcheck source=/dev/null
. "${docker_dir}/base-image.env"

if [[ -z "${NODE_BASE_IMAGE_DIGEST:-}" ]]; then
  cat >&2 <<'MSG'
build-all.sh: no base image digest.

ops/cloud/docker/base-image.env has NODE_BASE_IMAGE_DIGEST empty. Every Czar image
is pinned by digest, never by tag, so the build stops here rather than resolving a
floating tag.

Resolve it once, from a machine that can reach Docker Hub:

  docker buildx imagetools inspect node:22.22.0-bookworm-slim \
    --format '{{.Manifest.Digest}}'

then paste the sha256:... value into NODE_BASE_IMAGE_DIGEST in
ops/cloud/docker/base-image.env and run this script again.
MSG
  exit 1
fi

if [[ "${NODE_BASE_IMAGE_DIGEST}" != sha256:* ]]; then
  echo "build-all.sh: NODE_BASE_IMAGE_DIGEST must start with sha256:" >&2
  exit 1
fi

node_base_image="${NODE_BASE_IMAGE_TAG}@${NODE_BASE_IMAGE_DIGEST}"

git_sha="$(git rev-parse --short HEAD)"
base_tag="czar-base:${git_sha}"

echo "==> base ${base_tag} from ${node_base_image}"
docker build \
  --file "${docker_dir}/base.Dockerfile" \
  --build-arg "NODE_BASE_IMAGE=${node_base_image}" \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  --tag "${base_tag}" \
  "${repo_root}"

# The signer is built last so a failure in it cannot be mistaken for a failure in
# one of the images that share the ordinary runtime UID.
for app in server merchants indexer web signer; do
  tag="czar-${app}:${git_sha}"
  echo "==> ${tag}"
  docker build \
    --file "${docker_dir}/${app}.Dockerfile" \
    --build-arg "BASE_IMAGE=${base_tag}" \
    --tag "${tag}" \
    "${repo_root}"
done

echo
echo "==> built, tagged :${git_sha}"
# Sizes go in the task report, so print them here rather than making the reader
# look them up. docker image ls takes one reference at a time, so inspect each.
for image in base server merchants indexer web signer; do
  tag="czar-${image}:${git_sha}"
  bytes="$(docker image inspect "${tag}" --format '{{.Size}}')"
  printf '%-28s %5d MB (%s bytes)\n' "${tag}" "$((bytes / 1000000))" "${bytes}"
done
