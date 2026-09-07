#!/usr/bin/env bash
set -euo pipefail

# Builds the read-only Node + npm rootfs tree that GVisorSandboxProvisioner
# copies into every job's OCI bundle (see
# services/preview-worker/gvisor/gvisorSandboxProvisioner.ts). Linux only --
# run this from inside a real Linux environment (a gVisor host, or WSL2 for
# local verification).
#
# Usage: sudo ./scripts/gvisor/build-base-rootfs.sh [output-dir]

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (it uses debootstrap and chroot-installs packages)." >&2
  exit 1
fi

OUT_DIR="${1:-/var/lib/peephole/base-rootfs}"
NODE_VERSION="24.20.0"
NODE_ARCH="x64"
UBUNTU_RELEASE="noble"

if [[ -d "$OUT_DIR" ]]; then
  echo "Removing existing rootfs at $OUT_DIR"
  rm -rf "$OUT_DIR"
fi

echo "Debootstrapping a minimal $UBUNTU_RELEASE base into $OUT_DIR"
debootstrap --variant=minbase "$UBUNTU_RELEASE" "$OUT_DIR" http://archive.ubuntu.com/ubuntu

echo "Installing ca-certificates (needed for npm's HTTPS registry calls)"
chroot "$OUT_DIR" /bin/sh -c "apt-get update -qq && apt-get install -y -qq ca-certificates && rm -rf /var/lib/apt/lists/*"

echo "Installing Node.js $NODE_VERSION (official linux-$NODE_ARCH tarball) into /usr/local"
NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "/tmp/${NODE_TARBALL}"
tar -xJf "/tmp/${NODE_TARBALL}" -C "$OUT_DIR/usr/local" --strip-components=1
rm -f "/tmp/${NODE_TARBALL}"

echo "Verifying node/npm inside the rootfs"
chroot "$OUT_DIR" /usr/local/bin/node --version
chroot "$OUT_DIR" /usr/local/bin/npm --version

# The sandbox process runs as uid/gid 65534 (nobody/nogroup), never root
# (see SANDBOX_UID/SANDBOX_GID in runscCommandRunner.ts). npm needs a
# writable HOME and cache directory owned by that uid.
mkdir -p "$OUT_DIR/home/sandbox"
chown 65534:65534 "$OUT_DIR/home/sandbox"
chmod 700 "$OUT_DIR/home/sandbox"

echo "Base rootfs ready at $OUT_DIR"
du -sh "$OUT_DIR"
