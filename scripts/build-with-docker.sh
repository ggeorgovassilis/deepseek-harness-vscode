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
#   - The repository source is bind-mounted read-write at /work.
#   - node_modules, the pnpm content-addressable store and the Corepack cache
#     live in named Docker volumes. They are persistent and container-local, so
#     Linux-native modules never clobber a host-side install, yet they remain
#     inspectable by re-entering the image (see --shell).
#   - The VSIX is written into the host's artifacts/ directory (a bind mount),
#     then chowned back to the invoking user.
#
# Modes:
#   build-with-docker.sh                build + package + install into VS Code
#   build-with-docker.sh --no-install   build + package only
#   build-with-docker.sh --shell        drop into a shell with source + deps mounted
#   build-with-docker.sh --shell "cmd"  run one command in the build env (no TTY)
#
# The image is overridable (e.g. a digest-pinned image) via DSH_BUILD_IMAGE.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${DSH_BUILD_IMAGE:-node:22-bookworm-slim}"
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

run_args=(
  --rm
  --name "$CONTAINER_NAME"
  -e "COREPACK_HOME=/corepack"
  -e "HOST_UID=$HOST_UID"
  -e "HOST_GID=$HOST_GID"
  -v "$REPO_ROOT:/work"
  -v "$VOLUME_NODE_MODULES:/work/node_modules"
  -v "$VOLUME_PNPM_STORE:/pnpm-store"
  -v "$VOLUME_COREPACK:/corepack"
  -w /work
)

build_steps() {
  # Put a Corepack-delegating `pnpm` on PATH so the `pnpm --filter …` calls
  # inside package.json scripts resolve (the extension uses the same shim trick
  # on the host via node_modules/.bin/pnpm).
  corepack enable
  # pnpm 11 defaults the content-addressable store to <project>/.pnpm-store;
  # pin it to the named volume so it stays container-local and inspectable
  # instead of polluting the bind-mounted source tree.
  corepack pnpm install --frozen-lockfile --store-dir /pnpm-store
  corepack pnpm package:vsix
  # The bind mount is shared with the host. The container runs as root, so
  # restore ownership of everything it wrote so the host user can manage it.
  chown -R "$HOST_UID:$HOST_GID" \
    /work/artifacts \
    /work/apps/extension/dist \
    /work/apps/extension/media 2>/dev/null || true
}

case "$MODE" in
  build|--no-install|-n)
    docker run "${run_args[@]}" "$IMAGE" bash -lc '
      set -euo pipefail
      '"$(declare -f build_steps)"'
      build_steps
    '
    ;;
  --shell|-s)
    if [ $# -gt 1 ]; then
      # Non-interactive inspection: `--shell "ls node_modules/.pnpm"` runs the
      # given command inside the build environment and exits.
      shift
      docker run "${run_args[@]}" "$IMAGE" bash -lc "$*"
    else
      docker run "${run_args[@]}" -it "$IMAGE" bash
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
