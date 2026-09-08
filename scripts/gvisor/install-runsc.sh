#!/usr/bin/env bash
set -euo pipefail

# Downloads and installs the gVisor runtime (runsc + the containerd shim)
# for whatever architecture this script runs on -- gVisor publishes both
# x86_64 and aarch64 builds under the same release path, keyed by
# `uname -m`, so this needs no per-arch branching itself (unlike
# build-base-rootfs.sh, which depends on Debian/Ubuntu's differently-named
# amd64/arm64 archives).
#
# Usage: sudo ./scripts/gvisor/install-runsc.sh

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (it installs into /usr/local/bin)." >&2
  exit 1
fi

ARCH="$(uname -m)"
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
echo "Downloading gVisor for arch=${ARCH} from ${URL}"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

wget -q "${URL}/runsc" "${URL}/runsc.sha512" "${URL}/containerd-shim-runsc-v1" "${URL}/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
chmod a+rx runsc containerd-shim-runsc-v1
mv runsc containerd-shim-runsc-v1 /usr/local/bin

runsc --version
