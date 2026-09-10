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
UBUNTU_RELEASE="noble"

# Debian/Ubuntu's "primary" archive (archive.ubuntu.com) only carries
# amd64/i386 packages; every other architecture (arm64, armhf, ppc64el,
# s390x, riscv64, ...) lives on the separate "ports" archive. debootstrap
# infers the target architecture from `dpkg --print-architecture`
# (effectively the host's own arch, since we're not cross-bootstrapping),
# so the mirror must match it or package resolution fails outright.
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
case "$HOST_ARCH" in
  amd64)
    NODE_ARCH="x64"
    UBUNTU_MIRROR="http://archive.ubuntu.com/ubuntu"
    ;;
  arm64)
    NODE_ARCH="arm64"
    UBUNTU_MIRROR="http://ports.ubuntu.com/ubuntu-ports"
    ;;
  *)
    echo "Unsupported host architecture: '${HOST_ARCH:-unknown}' (expected amd64 or arm64; is dpkg installed?)." >&2
    exit 1
    ;;
esac

if [[ -d "$OUT_DIR" ]]; then
  echo "Removing existing rootfs at $OUT_DIR"
  rm -rf "$OUT_DIR"
fi

echo "Debootstrapping a minimal $UBUNTU_RELEASE ($HOST_ARCH) base into $OUT_DIR from $UBUNTU_MIRROR"
debootstrap --variant=minbase "$UBUNTU_RELEASE" "$OUT_DIR" "$UBUNTU_MIRROR"

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

# The sandbox process runs as uid/gid 65534 (nobody/nogroup), never root.
# Its HOME and npm cache are created on the quota-backed /workspace mount;
# nothing in this copied base rootfs is intentionally writable at runtime.

# debootstrap's base-files postinst reads the ambient hostname of the
# machine running this script (it doesn't get its own UTS namespace) and
# bakes it into /etc/hostname -- found via a sandboxed script reading
# /proc/1/root/etc/hostname and getting this build host's real name back.
# Not a live escape (the OCI spec's own "hostname" field, set per run,
# is what actually governs the sandbox's UTS namespace at runtime), but
# there's no reason to ship the build host's name in every job's image.
echo "peephole-preview" > "$OUT_DIR/etc/hostname"

echo "Base rootfs ready at $OUT_DIR"
du -sh "$OUT_DIR"
