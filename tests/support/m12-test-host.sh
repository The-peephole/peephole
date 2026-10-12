#!/usr/bin/env bash
# Guarded setup and teardown of the dedicated M12 real-gVisor test parent
# (docs/M12_REAL_GVISOR_VERIFICATION.md). Every destructive step targets a
# fixed child of a parent this script itself created and marked, and is
# refused unless ownership, mounts, and active resources are verified first.
# Every inspection that cannot complete stops the script; an empty result is
# never inferred from a failed command.
#
# Usage:
#   m12-test-host.sh setup        <parent>   # create parent, tmpfs, marker
#   m12-test-host.sh build-rootfs <parent>   # build <parent>/rootfs (new path only)
#   m12-test-host.sh status       <parent>   # read-only verification
#   m12-test-host.sh teardown     <parent>   # verified, narrow removal
#
# Run it as a script, never paste its steps into an interactive shell: it
# relies on `set -euo pipefail` to stop at the first failed check. (Tests
# may `source` it to exercise individual functions; `main` then does not
# run, and a real invocation always inspects the real /proc.)
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

# Device:inode of an existing path, without following a final symlink.
identity_of() {
  stat -c '%d:%i' -- "$1"
}

# Proves <parent> is the directory `setup` created: an ordinary directory
# reached without symlinks, holding a regular marker naming exactly it.
verify_parent() {
  local parent="$1"
  validate_parent_syntax "$parent"
  [[ -d "$parent" && ! -L "$parent" ]] ||
    die "$parent is not a verified dedicated test parent (missing or symlink)"
  local resolved
  resolved="$(realpath -e -- "$parent")" || die "$parent could not be resolved"
  [[ "$resolved" == "$parent" ]] || die "$parent resolves through a symlink"
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

# Prints every mount target at or below <parent>. Returns non-zero (never an
# empty listing) when the mount table cannot be read. Callers must use
#   out="$(mounts_under ...)" || die ...
mounts_under() {
  local parent="$1" targets target
  targets="$(findmnt -rn -o TARGET)" || return 1
  [[ -n "$targets" ]] || return 1 # a real system always has "/" mounted
  while IFS= read -r target; do
    if [[ "$target" == "$parent" || "$target" == "$parent"/* ]]; then
      echo "$target"
    fi
  done <<<"$targets"
}

# Prints run directories (`peephole-m12-*`) directly under <directory>;
# returns non-zero when the directory cannot be fully listed.
run_directories_in() {
  find "$1" -mindepth 1 -maxdepth 1 -name 'peephole-m12-*' -print
}

# --- process inspection --------------------------------------------------
# Implemented with bash builtins only (no forks), so the listing cannot be
# polluted by this script's own helper processes.

# Sets PROC_READ to the space-joined argv of <proc_root>/<pid>. Returns
# 0 when read, 1 when the process no longer exists, 2 when it exists but
# cannot be inspected.
read_process_cmdline() {
  local proc_root="$1" pid="$2" arg
  PROC_READ=""
  if [[ ! -e "$proc_root/$pid" ]]; then return 1; fi
  if [[ ! -r "$proc_root/$pid/cmdline" || -d "$proc_root/$pid/cmdline" ]]; then
    [[ -e "$proc_root/$pid" ]] && return 2
    return 1
  fi
  if ! { while IFS= read -r -d '' arg || [[ -n "$arg" ]]; do PROC_READ+="$arg "; done; } \
    <"$proc_root/$pid/cmdline" 2>/dev/null; then
    [[ -e "$proc_root/$pid" ]] && return 2
    return 1
  fi
  return 0
}

# Sets PROC_READ to the parent PID of <proc_root>/<pid>; same return codes.
read_process_ppid() {
  local proc_root="$1" pid="$2" key value
  PROC_READ=""
  if [[ ! -e "$proc_root/$pid" ]]; then return 1; fi
  if [[ ! -r "$proc_root/$pid/status" || -d "$proc_root/$pid/status" ]]; then
    [[ -e "$proc_root/$pid" ]] && return 2
    return 1
  fi
  while IFS=$':\t ' read -r key value; do
    if [[ "$key" == "PPid" ]]; then
      PROC_READ="${value//[[:space:]]/}"
      break
    fi
  done <"$proc_root/$pid/status" 2>/dev/null || true
  if [[ ! "$PROC_READ" =~ ^[0-9]+$ ]]; then
    [[ -e "$proc_root/$pid" ]] && return 2
    return 1
  fi
  return 0
}

# Fails if any process other than this script, its own ancestors (the
# legitimate launchers: e.g. `sudo` and its pty monitor), and its own
# descendants names <parent> on its command line -- e.g. a lingering runsc
# with a --root under it. Never kills anything and never prints another
# process's command line. A process that exists but cannot be inspected
# fails the check; one that exited meanwhile is ignored.
assert_no_processes_reference() {
  local parent="$1" proc_root="$2" self="$3"
  [[ -d "$proc_root/$self" ]] ||
    die "process table at $proc_root is not readable; refusing to continue"

  declare -A excluded=()
  local pid="$self" depth=0 code
  while [[ "$pid" != "0" ]]; do
    excluded["$pid"]=1
    depth=$((depth + 1))
    ((depth <= 128)) || die "process ancestry of $self is too deep; refusing to continue"
    code=0
    read_process_ppid "$proc_root" "$pid" || code=$?
    ((code == 0)) || die "ancestry of process $self could not be inspected; refusing to continue"
    pid="$PROC_READ"
  done

  shopt -s nullglob
  local entries=("$proc_root"/[0-9]*)
  shopt -u nullglob
  ((${#entries[@]} > 0)) || die "process table at $proc_root is empty; refusing to continue"

  local entry candidate walker steps
  for entry in "${entries[@]}"; do
    candidate="${entry##*/}"
    [[ "$candidate" =~ ^[0-9]+$ ]] || continue
    [[ -z "${excluded[$candidate]:-}" ]] || continue
    code=0
    read_process_cmdline "$proc_root" "$candidate" || code=$?
    ((code != 1)) || continue # exited meanwhile
    ((code == 0)) || die "process $candidate could not be inspected; refusing to continue"
    [[ -n "$PROC_READ" && "$PROC_READ" == *"$parent"* ]] || continue
    # Only this script's own descendants (its helpers) are exempt.
    walker="$candidate" steps=0
    while [[ "$walker" != "0" && "$walker" != "1" && "$walker" != "$self" ]]; do
      steps=$((steps + 1))
      ((steps <= 128)) || break
      code=0
      read_process_ppid "$proc_root" "$walker" || code=$?
      if ((code == 1)); then
        # The candidate itself exited: ignore it. An intermediate process
        # exiting while the candidate lives means ancestry is unproven.
        [[ ! -e "$proc_root/$candidate" ]] ||
          die "process $candidate could not be inspected; refusing to continue"
        walker=""
        break
      fi
      ((code == 0)) || die "process $candidate could not be inspected; refusing to continue"
      walker="$PROC_READ"
    done
    [[ "$walker" == "$self" || -z "$walker" ]] && continue
    die "process $candidate still references $parent; stop it by its own handle first"
  done
}

# --- commands ------------------------------------------------------------

cmd_setup() {
  local parent="$1"
  validate_parent_syntax "$parent"
  [[ ! -e "$parent" && ! -L "$parent" ]] ||
    die "$parent already exists; choose a never-used path"
  local base resolved
  base="$(dirname -- "$parent")"
  [[ -d "$base" && ! -L "$base" ]] ||
    die "$base must be an existing directory reached without symlinks"
  resolved="$(realpath -e -- "$base")" || die "$base could not be resolved"
  [[ "$resolved" == "$base" ]] || die "$base must not traverse symlinks"
  require_root

  # Everything from here on is rolled back on any failure, but only what
  # this run itself created (tracked below) and only after re-proving it.
  SETUP_PARENT="$parent"
  SETUP_IDENTITY=""
  SETUP_MOUNTED=0
  trap 'setup_rollback $?' EXIT

  mkdir -m 0700 -- "$parent"
  SETUP_IDENTITY="$(identity_of "$parent")"
  mkdir -m 0700 -- "$parent/workspace" "$parent/runsc" "$parent/tmpfs"
  mount -t tmpfs -o size=16m,mode=0700,nosuid,nodev,noexec tmpfs "$parent/tmpfs"
  SETUP_MOUNTED=1
  local fstype
  fstype="$(findmnt -n -o FSTYPE -M "$parent/tmpfs")" ||
    die "$parent/tmpfs mount could not be inspected"
  [[ "$fstype" == "tmpfs" ]] || die "$parent/tmpfs did not mount as tmpfs"
  local token
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$token" =~ ^[a-f0-9]{32}$ ]] || die "could not generate a marker token"
  printf '%s\n%s\n%s\n' "$MARKER_SCHEMA" "$token" "$parent" >"$parent/$MARKER_NAME"
  chmod 0400 -- "$parent/$MARKER_NAME"

  trap - EXIT
  cat <<EOF
Dedicated M12 test parent ready. Next: m12-test-host.sh build-rootfs $parent
export PEEPHOLE_M12_TEST_WORKSPACE_ROOT=$parent/workspace
export PEEPHOLE_M12_TEST_RUNSC_ROOT=$parent/runsc
export PEEPHOLE_M12_TEST_TMPFS_ROOT=$parent/tmpfs
export PEEPHOLE_M12_TEST_BASE_ROOTFS=$parent/rootfs
EOF
}

# EXIT trap for a failed setup. Undoes only this run's own mount and
# directories, only while <parent> is still the same inode, never
# recursively; anything it cannot prove is preserved and reported.
setup_rollback() {
  local status="$1" parent="$SETUP_PARENT"
  trap - EXIT
  ((status != 0)) || return 0
  set +e
  local preserved=0
  if [[ -z "$SETUP_IDENTITY" ]]; then
    # mkdir itself failed (or its identity could not be read): nothing of
    # ours is provably there.
    [[ -e "$parent" ]] && preserved=1
  elif [[ ! -d "$parent" || -L "$parent" || "$(identity_of "$parent" 2>/dev/null)" != "$SETUP_IDENTITY" ]]; then
    preserved=1
  else
    if ((SETUP_MOUNTED == 1)); then
      if ! umount -- "$parent/tmpfs"; then
        preserved=1
      fi
    fi
    if ((preserved == 0)); then
      local remaining
      if ! remaining="$(mounts_under "$parent")" || [[ -n "$remaining" ]]; then
        preserved=1
      fi
    fi
    if ((preserved == 0)); then
      if [[ -f "$parent/$MARKER_NAME" && ! -L "$parent/$MARKER_NAME" ]]; then
        rm -f -- "$parent/$MARKER_NAME" || preserved=1
      fi
      local child
      for child in workspace runsc tmpfs; do
        if [[ -e "$parent/$child" || -L "$parent/$child" ]]; then
          rmdir -- "$parent/$child" 2>/dev/null || preserved=1
        fi
      done
      ((preserved == 1)) || rmdir -- "$parent" 2>/dev/null || preserved=1
    fi
  fi
  if ((preserved == 1)); then
    cat >&2 <<EOF
m12-test-host: setup failed; preserved for manual recovery: $parent
  Inspect:  findmnt -R $parent ; ls -la $parent
  If $parent/tmpfs is still mounted:  umount -- $parent/tmpfs
  Then remove only the empty directories this setup created:
    rmdir -- $parent/workspace $parent/runsc $parent/tmpfs $parent
EOF
  else
    echo "m12-test-host: setup failed; rolled back everything it created under $parent" >&2
  fi
  exit "$status"
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
  local parent="$1" incomplete=0 listing child
  verify_parent "$parent"
  echo "marker: verified"
  if listing="$(mounts_under "$parent")"; then
    echo "mounts under parent:"
    [[ -z "$listing" ]] || sed 's/^/  /' <<<"$listing"
  else
    echo "mounts under parent: INCOMPLETE (mount table unreadable)"
    incomplete=1
  fi
  for child in workspace runsc tmpfs; do
    if listing="$(run_directories_in "$parent/$child")"; then
      echo "$child run directories:"
      [[ -z "$listing" ]] || sed 's/^/  /' <<<"$listing"
    else
      echo "$child run directories: INCOMPLETE (could not be listed)"
      incomplete=1
    fi
  done
  ((incomplete == 0)) || die "status is INCOMPLETE; do not treat this parent as clean"
}

cmd_teardown() {
  local parent="$1"
  verify_parent "$parent"
  require_root

  local child listing
  for child in workspace runsc tmpfs; do
    [[ -d "$parent/$child" && ! -L "$parent/$child" ]] ||
      die "$parent/$child is missing or a symlink; refusing"
    listing="$(run_directories_in "$parent/$child")" ||
      die "$parent/$child could not be inspected; refusing"
    [[ -z "$listing" ]] ||
      die "$parent/$child still holds preserved run directories; inspect them first (status)"
  done
  assert_no_processes_reference "$parent" /proc "$$"

  local mounts target
  mounts="$(mounts_under "$parent")" ||
    die "mount table could not be read; refusing to continue"
  while IFS= read -r target; do
    [[ -z "$target" || "$target" == "$parent/tmpfs" ]] ||
      die "unexpected mount remains under $parent: $target"
  done <<<"$mounts"
  if [[ -n "$mounts" ]]; then
    local fstype
    fstype="$(findmnt -n -o FSTYPE -M "$parent/tmpfs")" ||
      die "$parent/tmpfs mount could not be inspected; refusing"
    [[ "$fstype" == "tmpfs" ]] || die "$parent/tmpfs is mounted but not tmpfs; refusing"
    echo "umount $parent/tmpfs"
    umount -- "$parent/tmpfs"
  fi
  mounts="$(mounts_under "$parent")" ||
    die "mount table could not be re-read after unmounting; $parent is preserved"
  [[ -z "$mounts" ]] ||
    die "mounts still remain under $parent after unmounting the tmpfs; $parent is preserved"

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

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
