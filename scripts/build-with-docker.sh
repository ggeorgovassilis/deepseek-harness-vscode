#!/bin/bash
# Build the DSH VS Code extension inside Docker and (optionally) install it
# into the host's VS Code.
#
# Why Docker: a reproducible build environment (pinned Node + pnpm via Corepack,
# frozen lockfile) that is independent of host toolchain drift. The build is
# pure JS (esbuild bundling + `vsce package --no-dependencies`), so a Linux
# image produces a VSIX that installs on any platform.
#
# Layout:
#   - The repository source is mounted read-only at /src and copied into an
#     ephemeral writable working copy at /work. The build runs against that
#     copy, so a compromised dependency or build script can write only to the
#     throw-away copy — never to the host source tree, .git/hooks or this
#     script. The copy is discarded with the container; the only host path the
#     build writes to is artifacts/ (the VSIX output).
#   - The container runs as the invoking (non-root) user, so every file it
#     writes is already owned by the host user and no privileged `chown` pass is
#     needed afterwards.
#   - node_modules, the pnpm content-addressable store and the Corepack cache
#     live in named Docker volumes. They are persistent and container-local, so
#     Linux-native modules never clobber a host-side install, yet they remain
#     inspectable by re-entering the image (see --shell). A one-time root
#     container chowns those volumes (it mounts no source and no host paths).
#   - The VSIX is written into the host's artifacts/ directory (a bind mount).
#
# Modes:
#   build-with-docker.sh                build + package + install into VS Code
#   build-with-docker.sh --no-install   build + package only
#   build-with-docker.sh --shell        drop into a shell with source + deps mounted
#   build-with-docker.sh --shell "cmd"  run one command in the build env (no TTY)
#
# The image defaults to a digest-pinned `node:22-bookworm-slim`; override with
# a different (still digest-pinned) image via DSH_BUILD_IMAGE.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${DSH_BUILD_IMAGE:-node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee}"
CONTAINER_NAME="${DSH_BUILD_CONTAINER:-dsh-extension-build}"
VOLUME_NODE_MODULES="dsh-build-node-modules"
VOLUME_PNPM_STORE="dsh-build-pnpm-store"
VOLUME_COREPACK="dsh-build-corepack"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: 'docker' is not on PATH" >&2
  exit 1
fi

MODE="${1:-build}"

# Persistent, container-local dependency stores. They survive `--rm` and keep
# node_modules, the pnpm store and the Corepack cache inspectable between runs.
docker volume create "$VOLUME_NODE_MODULES" >/dev/null
docker volume create "$VOLUME_PNPM_STORE" >/dev/null
docker volume create "$VOLUME_COREPACK" >/dev/null

# One-time setup: named volumes are created root-owned, so the non-root build
# user cannot write to them. Chown them once (the build then reuses them).
# This container is root but mounts only the three volumes — no source, no
# host paths — so its blast radius is nil.
docker run --rm \
  -v "$VOLUME_NODE_MODULES:/node_modules" \
  -v "$VOLUME_PNPM_STORE:/pnpm-store" \
  -v "$VOLUME_COREPACK:/corepack" \
  "$IMAGE" sh -c "chown -R $HOST_UID:$HOST_GID /node_modules /pnpm-store /corepack"

# The VSIX output dir must exist on the host before the read-write bind mount,
# otherwise Docker would create it root-owned.
mkdir -p "$REPO_ROOT/artifacts"

run_args=(
  --rm
  --name "$CONTAINER_NAME"
  --user "$HOST_UID:$HOST_GID"
  -e "COREPACK_HOME=/corepack"
  -e "HOME=/tmp"
  # Non-interactive build: let pnpm reconcile the (possibly stale) named
  # node_modules volume without prompting, as it would in CI.
  -e "CI=true"
  -e "HOST_UID=$HOST_UID"
  -e "HOST_GID=$HOST_GID"
  # Ephemeral writable working copy (memory-backed, discarded with --rm),
  # owned by the invoking user. The artifacts bind mount and node_modules
  # volume are layered on top of it.
  --tmpfs "/work:rw,size=2g,uid=$HOST_UID,gid=$HOST_GID,mode=0777"
  -v "$REPO_ROOT:/src:ro"
  -v "$REPO_ROOT/artifacts:/work/artifacts"
  -v "$VOLUME_NODE_MODULES:/work/node_modules"
  -v "$VOLUME_PNPM_STORE:/pnpm-store"
  -v "$VOLUME_COREPACK:/corepack"
  -w /work
)

# Copy the read-only source into the ephemeral writable working copy, skipping
# the node_modules volume mount point, VCS metadata and the build outputs that
# are regenerated anyway. The build then has free rein over /work without ever
# touching /src.
populate_work() {
  (cd /src && tar \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='artifacts' \
    --exclude='dist' \
    --exclude='media' \
    -cf - .) | (cd /work && tar -xf -)
}

build_steps() {
  populate_work
  # `corepack enable` symlinks into the image's root-owned /usr/local/bin, which
  # the non-root user cannot do. Create a Corepack-delegating `pnpm` shim in a
  # writable location instead, so the `pnpm --filter …` calls inside
  # package.json scripts resolve (the extension uses the same shim trick on the
  # host via node_modules/.bin/pnpm).
  mkdir -p /tmp/bin
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > /tmp/bin/pnpm
  chmod +x /tmp/bin/pnpm
  export PATH="/tmp/bin:$PATH"
  # pnpm 11 defaults the content-addressable store to <project>/.pnpm-store;
  # pin it to the named volume so it stays container-local and inspectable
  # instead of polluting the bind-mounted source tree.
  pnpm install --frozen-lockfile --store-dir /pnpm-store
  pnpm package:vsix
}

case "$MODE" in
  build|--no-install|-n)
    docker run "${run_args[@]}" "$IMAGE" bash -lc '
      set -euo pipefail
      '"$(declare -f populate_work build_steps)"'
      build_steps
    '
    ;;
  --shell|-s)
    if [ $# -gt 1 ]; then
      # Non-interactive inspection: `--shell "ls node_modules/.pnpm"` runs the
      # given command inside the build environment and exits.
      shift
      docker run "${run_args[@]}" "$IMAGE" bash -lc '
        set -euo pipefail
        '"$(declare -f populate_work)"'
        populate_work
        '"$*"'
      '
    else
      docker run "${run_args[@]}" -it "$IMAGE" bash -lc '
        set -euo pipefail
        '"$(declare -f populate_work)"'
        populate_work
        exec bash
      '
    fi
    ;;
  *)
    echo "usage: $0 [build|--no-install|--shell]" >&2
    exit 2
    ;;
esac

if [ "$MODE" = "build" ]; then
  VSIX="$REPO_ROOT/artifacts/jabodsh.vsix"
  if [ ! -f "$VSIX" ]; then
    echo "error: build produced no VSIX at $VSIX" >&2
    exit 1
  fi
  if ! command -v code >/dev/null 2>&1; then
    echo "error: 'code' is not on PATH; VSIX is at $VSIX" >&2
    exit 1
  fi
  code --install-extension "$VSIX" --force
  echo "Installed. Run 'Developer: Reload Window' in VS Code to load the new build."
fi
