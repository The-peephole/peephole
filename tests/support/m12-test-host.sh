#!/usr/bin/env bash
# Guarded setup and teardown of the dedicated M12 real-gVisor test parent
# (docs/M12_REAL_GVISOR_VERIFICATION.md). Every destructive step targets a
# fixed child of a parent this script itself created and marked, and is
# refused unless ownership, mounts, and active resources are verified first.
#
# Usage:
#   m12-test-host.sh setup        <parent>   # create parent, tmpfs, marker
#   m12-test-host.sh build-rootfs <parent>   # build <parent>/rootfs (new path only)
#   m12-test-host.sh status       <parent>   # read-only verification
#   m12-test-host.sh teardown     <parent>   # verified, narrow removal
#
# Run it as a script, never paste its steps into an interactive shell: it
# relies on `set -euo pipefail` to stop at the first failed check.
set -euo pipefail
umask 077

readonly MARKER_NAME=".peephole-m12-test-parent"
readonly MARKER_SCHEMA="peephole-m12-test-parent/v1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPOSITORY_ROOT="$SCRIPT_DIR/../.."

die() {
  echo "m12-test-host: $*" >&2
  exit 1
}

validate_parent_syntax() {
  local parent="$1"
  [[ "$parent" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    die "parent must be an absolute path of [A-Za-z0-9._/-] only"
  case "$parent" in
    */ | *//* | */./* | */. | */../* | */..) die "parent must be a normalized path" ;;
  esac
  local system
  for system in / /run /var /var/lib /var/run /tmp /etc /usr /home /root \
    /opt /dev /proc /sys /srv /mnt /media /boot /var/tmp; do
    [[ "$parent" != "$system" ]] || die "refusing the system directory $system"
  done
  local protected
  for protected in /run/peephole /var/lib/peephole /var/run/peephole \
    /run/netns /var/run/netns /etc /usr /proc /sys /dev /boot; do
    [[ "$parent" != "$protected" && "$parent" != "$protected"/* ]] ||
      die "refusing a path at or under $protected"
  done
}

require_root() {
  [[ "$(id -u)" == "0" ]] || die "this step requires root"
}

# Proves <parent> is the directory `setup` created: an ordinary directory
# reached without symlinks, holding a regular marker naming exactly it.
verify_parent() {
  local parent="$1"
  validate_parent_syntax "$parent"
  [[ -d "$parent" && ! -L "$parent" ]] ||
    die "$parent is not a verified dedicated test parent (missing or symlink)"
  [[ "$(realpath -e -- "$parent")" == "$parent" ]] ||
    die "$parent resolves through a symlink"
  local marker="$parent/$MARKER_NAME"
  [[ -f "$marker" && ! -L "$marker" ]] ||
    die "$parent is not a verified dedicated test parent (no marker)"
  local schema="" token="" recorded=""
  {
    IFS= read -r schema || true
    IFS= read -r token || true
    IFS= read -r recorded || true
  } <"$marker"
  [[ "$schema" == "$MARKER_SCHEMA" && "$token" =~ ^[a-f0-9]{32}$ && "$recorded" == "$parent" ]] ||
    die "$parent marker does not match this parent"
}

# All mount targets at or below <parent>. Fails closed if findmnt fails.
mounts_under() {
  local parent="$1" targets
  if ! targets="$(findmnt -rn -o TARGET)"; then
    die "mount table could not be read; refusing to continue"
  fi
  local target
  while IFS= read -r target; do
    [[ "$target" == "$parent" || "$target" == "$parent"/* ]] && echo "$target"
  done <<<"$targets"
  return 0
}

# Fails if any process other than this script names <parent> on its command
# line (e.g. a lingering runsc with a --root under it). Never kills anything.
assert_no_processes_reference() {
  local parent="$1" own="" pid cmdline
  own="$(tr '\0' ' ' <"/proc/$$/cmdline")"
  for pid in /proc/[0-9]*; do
    cmdline="$(tr '\0' ' ' <"$pid/cmdline" 2>/dev/null || true)"
    [[ -n "$cmdline" && "$cmdline" != "$own" ]] || continue
    [[ "$cmdline" != *"$parent"* ]] ||
      die "process ${pid#/proc/} still references $parent; stop it by its own handle first"
  done
}

cmd_setup() {
  local parent="$1"
  validate_parent_syntax "$parent"
  [[ ! -e "$parent" && ! -L "$parent" ]] ||
    die "$parent already exists; choose a never-used path"
  local base
  base="$(dirname -- "$parent")"
  [[ -d "$base" && ! -L "$base" && "$(realpath -e -- "$base")" == "$base" ]] ||
    die "$base must be an existing directory reached without symlinks"
  require_root
  mkdir -m 0700 -- "$parent"
  mkdir -m 0700 -- "$parent/workspace" "$parent/runsc" "$parent/tmpfs"
  mount -t tmpfs -o size=16m,mode=0700,nosuid,nodev,noexec tmpfs "$parent/tmpfs"
  [[ "$(findmnt -n -o FSTYPE -M "$parent/tmpfs")" == "tmpfs" ]] ||
    die "$parent/tmpfs did not mount as tmpfs"
  local token
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s\n%s\n%s\n' "$MARKER_SCHEMA" "$token" "$parent" >"$parent/$MARKER_NAME"
  chmod 0400 -- "$parent/$MARKER_NAME"
  cat <<EOF
Dedicated M12 test parent ready. Next: m12-test-host.sh build-rootfs $parent
export PEEPHOLE_M12_TEST_WORKSPACE_ROOT=$parent/workspace
export PEEPHOLE_M12_TEST_RUNSC_ROOT=$parent/runsc
export PEEPHOLE_M12_TEST_TMPFS_ROOT=$parent/tmpfs
export PEEPHOLE_M12_TEST_BASE_ROOTFS=$parent/rootfs
EOF
}

cmd_build_rootfs() {
  local parent="$1"
  verify_parent "$parent"
  require_root
  local rootfs="$parent/rootfs"
  # build-base-rootfs.sh deletes an existing output directory, so only a
  # never-used path under the verified parent is ever passed to it.
  [[ ! -e "$rootfs" && ! -L "$rootfs" ]] ||
    die "$rootfs already exists; tear down and set up a new parent instead"
  "$REPOSITORY_ROOT/scripts/gvisor/build-base-rootfs.sh" "$rootfs"
}

cmd_status() {
  local parent="$1"
  verify_parent "$parent"
  echo "marker: verified"
  echo "mounts under parent:"
  mounts_under "$parent" | sed 's/^/  /'
  local child
  for child in workspace runsc tmpfs; do
    echo "$child run directories:"
    find "$parent/$child" -mindepth 1 -maxdepth 1 -name 'peephole-m12-*' -printf '  %p\n' 2>/dev/null || true
  done
}

cmd_teardown() {
  local parent="$1"
  verify_parent "$parent"
  require_root

  local child
  for child in workspace runsc tmpfs; do
    [[ -d "$parent/$child" && ! -L "$parent/$child" ]] ||
      die "$parent/$child is missing or a symlink; refusing"
    if [[ -n "$(find "$parent/$child" -mindepth 1 -maxdepth 1 -name 'peephole-m12-*' -print -quit)" ]]; then
      die "$parent/$child still holds preserved run directories; inspect them first (status)"
    fi
  done
  assert_no_processes_reference "$parent"

  local mounts unexpected
  mounts="$(mounts_under "$parent")"
  unexpected="$(grep -vxF -- "$parent/tmpfs" <<<"$mounts" || true)"
  [[ -z "$unexpected" ]] ||
    die "unexpected mounts remain under $parent: $(tr '\n' ' ' <<<"$unexpected")"
  if [[ -n "$mounts" ]]; then
    [[ "$(findmnt -n -o FSTYPE -M "$parent/tmpfs")" == "tmpfs" ]] ||
      die "$parent/tmpfs is mounted but not tmpfs; refusing"
    echo "umount $parent/tmpfs"
    umount -- "$parent/tmpfs"
  fi
  [[ -z "$(mounts_under "$parent")" ]] ||
    die "mounts still remain under $parent after unmounting the tmpfs"

  # Narrow, auditable removal: empty fixed children with non-recursive
  # rmdir; only the rootfs is removed recursively, on one filesystem.
  echo "rmdir $parent/workspace $parent/runsc $parent/tmpfs"
  rmdir -- "$parent/workspace" "$parent/runsc" "$parent/tmpfs"
  if [[ -e "$parent/rootfs" || -L "$parent/rootfs" ]]; then
    [[ -d "$parent/rootfs" && ! -L "$parent/rootfs" ]] ||
      die "$parent/rootfs is not an ordinary directory; refusing"
    echo "rm -r --one-file-system $parent/rootfs"
    rm -r --one-file-system -- "$parent/rootfs"
  fi
  rm -f -- "$parent/$MARKER_NAME"
  echo "rmdir $parent"
  rmdir -- "$parent"
  echo "Dedicated M12 test parent removed."
}

main() {
  [[ $# -eq 2 ]] || die "usage: $0 setup|build-rootfs|status|teardown <parent>"
  case "$1" in
    setup) cmd_setup "$2" ;;
    build-rootfs) cmd_build_rootfs "$2" ;;
    status) cmd_status "$2" ;;
    teardown) cmd_teardown "$2" ;;
    *) die "unknown command $1" ;;
  esac
}

main "$@"
