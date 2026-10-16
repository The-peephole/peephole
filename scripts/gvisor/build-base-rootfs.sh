#!/usr/bin/env bash
set -euo pipefail

# Builds the read-only Node + npm rootfs tree that GVisorSandboxProvisioner
# copies into every job's OCI bundle (see
# services/preview-worker/gvisor/gvisorSandboxProvisioner.ts). Linux only --
# run this from inside a real Linux environment (a gVisor host, or WSL2 for
# local verification).
#
# Usage: sudo ./scripts/gvisor/build-base-rootfs.sh [output-dir]
# Output must be a new, canonical absolute path. Existing/partial images
# are preserved, never replaced. See docs/ROOTFS_BUILD.md.

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (it uses debootstrap and chroot-installs packages)." >&2
  exit 1
fi

OUT_DIR="${1:-/var/lib/peephole/base-rootfs}"
NODE_VERSION="24.20.0"
UBUNTU_RELEASE="noble"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$OUT_DIR" != /* || "$OUT_DIR" == / || "$OUT_DIR" != "$(realpath -m -- "$OUT_DIR")" ]]; then
  echo "Refusing: output must be a canonical absolute path without symlink ancestors." >&2
  exit 1
fi
if [[ -e "$OUT_DIR" || -L "$OUT_DIR" ]]; then
  echo "Refusing: $OUT_DIR already exists; existing and partial images are never deleted." >&2
  exit 1
fi

# Debian/Ubuntu's "primary" archive (archive.ubuntu.com) only carries
# amd64/i386 packages; every other architecture (arm64, armhf, ppc64el,
# s390x, riscv64, ...) lives on the separate "ports" archive. debootstrap
# infers the target architecture from `dpkg --print-architecture`
# (effectively the host's own arch, since we're not cross-bootstrapping),
# so the mirror must match it or package resolution fails outright.
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
# Pin the version/architecture tuple, not a checksum fetched alongside the
# archive. Updating Node requires reviewing BOTH hashes from its signed
# SHASUMS256.txt.asc (see docs/ROOTFS_BUILD.md).
case "$NODE_VERSION/$HOST_ARCH" in
  24.20.0/amd64)
    NODE_ARCH="x64"
    NODE_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"
    UBUNTU_MIRROR="http://archive.ubuntu.com/ubuntu"
    ;;
  24.20.0/arm64)
    NODE_ARCH="arm64"
    NODE_SHA256="5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7"
    UBUNTU_MIRROR="http://ports.ubuntu.com/ubuntu-ports"
    ;;
  *)
    echo "Unsupported Node version/host architecture: '$NODE_VERSION/${HOST_ARCH:-unknown}' (expected pinned amd64 or arm64; is dpkg installed?)." >&2
    exit 1
    ;;
esac

# Claim the leaf atomically so a path created since the check also fails.
mkdir -p -- "$(dirname -- "$OUT_DIR")"
mkdir -m 0755 -- "$OUT_DIR"

# Host-only download storage; never export this path into the chroot.
# Ambient host TMPDIR can be absent inside debootstrap's chroot too.
unset TMPDIR TMP TEMP
NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
BUILD_TMP="$(mktemp -d /var/tmp/peephole-rootfs-node.XXXXXXXX)"
NODE_DOWNLOAD="$BUILD_TMP/$NODE_TARBALL"
# Remove only this build's download, never any rootfs or other directory tree.
trap 'rm -f -- "$NODE_DOWNLOAD"; rmdir -- "$BUILD_TMP"' EXIT

echo "Debootstrapping a minimal $UBUNTU_RELEASE ($HOST_ARCH) base into $OUT_DIR from $UBUNTU_MIRROR"
debootstrap --variant=minbase "$UBUNTU_RELEASE" "$OUT_DIR" "$UBUNTU_MIRROR"

echo "Installing ca-certificates (needed for npm's HTTPS registry calls)"
chroot "$OUT_DIR" /bin/sh -c "apt-get update -qq && apt-get install -y -qq ca-certificates && rm -rf /var/lib/apt/lists/*"

echo "Installing Node.js $NODE_VERSION (official linux-$NODE_ARCH tarball) into /usr/local"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "$NODE_DOWNLOAD"
if ! printf '%s  %s\n' "$NODE_SHA256" "$NODE_DOWNLOAD" | sha256sum --check --strict --quiet -; then
  echo "Node tarball SHA256 mismatch; refusing extraction and execution." >&2
  exit 1
fi
# The official tarball records 1000/1000 as owner; running as root, GNU tar
# would keep it, leaving the sandbox's Node/npm writable by that host UID.
tar -xJf "$NODE_DOWNLOAD" -C "$OUT_DIR/usr/local" --strip-components=1 --no-same-owner
NON_ROOT="$(find "$OUT_DIR/usr/local" -xdev \( ! -uid 0 -o ! -gid 0 \) -print -quit)"
if [[ -n "$NON_ROOT" ]]; then
  echo "Node.js install left files under $OUT_DIR/usr/local not owned by root:root." >&2
  exit 1
fi

echo "Verifying node/npm inside the rootfs"
chroot "$OUT_DIR" /usr/local/bin/node --version
chroot "$OUT_DIR" /usr/local/bin/npm --version

# This fixed, Peephole-owned parent is the only process allowed to parse the
# generated-secret mount. It lives in the immutable rootfs, never /workspace,
# and launches the real Node entrypoint without a shell. Node cannot replace
# itself with execve, so it remains PID 1 and mirrors signals/exit status to
# and from its one direct child.
install -D -m 0555 \
  "$SCRIPT_DIR/secret-bootstrap.mjs" \
  "$OUT_DIR/opt/peephole/secret-bootstrap.mjs"
install -d -m 0755 "$OUT_DIR/run/secrets"

# Fixed, empty placeholder files for the two credential bind mounts
# (ociConfig.ts). Baking both destinations into the immutable image lets
# each be bind-mounted individually -- never a directory bind onto
# `/run/secrets` itself -- so the M10 generated-secret file and the M11
# database-credential file can coexist as independent sibling mounts. A
# destination created only by mounting over an already-read-only parent
# would not be creatable by runsc at all, which is exactly why these two
# files must already exist here rather than being created at mount time.
#
# Mode 0644 (root-owned, world-readable): when only ONE of the two
# credentials is present for a run, the trusted bootstrap (running as the
# unprivileged sandbox uid, never root) still needs to open the OTHER,
# unmounted placeholder to observe that it is empty and skip it -- a
# root-owned 0000 file would instead fail with EACCES, not the "absent"
# ENOENT/empty case the bootstrap actually handles. Both files are always
# empty here, so world-readability leaks nothing.
install -D -m 0644 /dev/null "$OUT_DIR/run/secrets/env"
install -D -m 0644 /dev/null "$OUT_DIR/run/secrets/database-url"
# M12 (D-035): a third, independent sibling placeholder for user-provided,
# non-sensitive configuration. Same reasoning and mode as the two above. Its
# presence is also the production preflight's evidence that this rootfs
# carries an M12-aware bootstrap (services/production/preflight.ts).
install -D -m 0644 /dev/null "$OUT_DIR/run/secrets/user-env"

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
