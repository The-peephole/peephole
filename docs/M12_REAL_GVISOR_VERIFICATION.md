# M12 Real Linux/gVisor Verification — Operator Runbook

**Status (2026-10-12): harness implemented, never executed.** Every
real-host result below is `NOT_RUN` until an operator runs this procedure on
a dedicated test host. A green GitHub CI means only that the harness is
skipped safely and its portable safety tests pass — not that real-host
behavior was verified. Design: docs/USER_PROVIDED_ENVIRONMENT.md (D-035).

Files:

| File | Role |
| --- | --- |
| `tests/realUserEnvironmentRuntime.test.ts` | Gated real-gVisor suite (E1–E5, G1–G5, H2/H3) |
| `tests/support/m12RealGvisorHarness.ts` | Gates, root validation, production-host guard, owned run directories, rootfs check, scan status, cleanup ordering |
| `tests/fixtures/m12-user-env-runtime/digest-server.cjs` | Fixture: reports presence + SHA-256 only, never a value |
| `tests/support/m12-test-host.sh` | Guarded setup / rootfs build / status / teardown of the dedicated test parent |
| `tests/m12RealGvisorHarness.test.ts`, `tests/m12TestHostScript.test.ts` | Portable safety tests (run in normal CI) |

## 1. Preconditions

- A **dedicated** Linux host or VM that has never run Peephole production.
  This is a mandatory precondition, not something the suite can prove. As a
  fail-closed backstop the suite refuses to start (no override) when it finds
  any of:
  - the fixed paths `/etc/peephole`, `/var/lib/peephole`,
    `/var/lib/peephole/{jobs,base-rootfs,artifacts}`,
    `/run/peephole/{secrets,db-credentials,user-env}`,
    `/var/run/peephole/runsc`;
  - any entry whose name starts with `peephole` (a unit such as
    `peephole.service` or `peephole-tenant-network.service`, a `.d` drop-in,
    or a timer) directly in one of systemd's system unit directories
    `/etc/systemd/system`, `/run/systemd/system`,
    `/usr/local/lib/systemd/system`, `/usr/lib/systemd/system`,
    `/lib/systemd/system`, or one level down in a `*.wants` / `*.requires`
    directory there.
  Each listing is bounded (4,096 entries); a path that cannot be inspected,
  or a directory that cannot be listed or is larger than the bound, counts as
  a marker. **Not covered:** user units, units under other names, a
  Peephole checkout or process without these paths, containers/VMs on the
  same hardware, and any former installation that was removed. Finding no
  marker never proves the host is safe to use.
- Root, cgroup v2, `net.ipv4.ip_forward=1`, and on `PATH`: `runsc`, `ip`,
  `iptables`, `ip6tables`, `findmnt`, `losetup`, `mkfs.ext4`, `mount`,
  `umount`, `debootstrap` (rootfs build only), Node 24 + this checkout with
  `npm ci` done.
- Disk: ~1.5 GiB for the rootfs plus ~1 GiB per concurrent sandbox (tests
  run sequentially). tmpfs: 16 MiB is ample.
- No production secret, token, database URL, or API key in the shell
  environment. The only value used is the synthetic
  `PEEPHOLE_E2E_SYNTHETIC_VALUE_2026` (not a credential) plus freshly
  generated M10/M11-shaped synthetic values.
- The suite creates host-global but test-owned network state (one netns,
  veth pair, and iptables chains per sandbox, recorded in a lease directory
  inside the test root) — another reason the host must be dedicated.

## 2. Read-only preflight

```bash
uname -a; id -u                        # Linux, uid 0
runsc --version; findmnt --version
for p in /var/lib/peephole /run/peephole /var/run/peephole \
         /etc/systemd/system/peephole.service; do
  test -e "$p" && echo "PRODUCTION MARKER PRESENT: $p"
done                                   # must print nothing
cat /proc/sys/net/ipv4/ip_forward      # 1
```

## 3. Setup (test-owned resources only)

Setup goes only through the guarded script, run as a script (never paste
its steps into an interactive shell). Choose a never-used parent that is not
a system directory and not under `/run/peephole`, `/var/lib/peephole`,
`/var/run/peephole`, `/run/netns`, or `/var/run/netns`:

```bash
sudo tests/support/m12-test-host.sh setup /srv/peephole-m12-test-20261012
```

`setup` refuses an existing path or a symlinked base directory, then
creates `<parent>/{workspace,runsc,tmpfs}` (0700), mounts a 16 MiB tmpfs
on `<parent>/tmpfs` and verifies its type, and writes a root-owned
read-only marker (`.peephole-m12-test-parent`: schema, random token, the
exact parent path). It prints the four `PEEPHOLE_M12_TEST_*` exports.

If any step after creating the parent fails (directory creation, the
mount, the tmpfs type check, or writing/finalizing the marker), `setup`
rolls back only what this run created: it unmounts its own tmpfs, removes
a partial marker, and removes the directories with a non-recursive
`rmdir`, and only while the parent is still the same inode. If it cannot
prove that (or `umount`/`rmdir` fails), it removes nothing further and
prints `setup failed; preserved for manual recovery: <parent>` with the
exact inspection and recovery commands. A path that already existed is
never touched.

Build the separate rootfs through the same script.
`build-base-rootfs.sh` deletes an existing output directory and defaults
to the production path, so the script only ever passes it
`<parent>/rootfs`, and only after re-verifying the marker and that this
path does not exist yet:

```bash
sudo tests/support/m12-test-host.sh build-rootfs /srv/peephole-m12-test-20261012
```

The suite then requires that rootfs to contain `usr/local/bin/node`, empty
root-owned `0644` placeholders `run/secrets/{env,database-url,user-env}`, and
a root-owned `0555` `opt/peephole/secret-bootstrap.mjs` that is
**byte-identical** to this checkout's `scripts/gvisor/secret-bootstrap.mjs`
(a stale bootstrap that merely exists is refused).

## 4. Execution

```bash
export PEEPHOLE_REAL_GVISOR_TESTS=1
export PEEPHOLE_M12_REAL_GVISOR_TESTS=1
# The four exports printed by `setup`, e.g.:
export PEEPHOLE_M12_TEST_WORKSPACE_ROOT=/srv/peephole-m12-test-20261012/workspace
export PEEPHOLE_M12_TEST_RUNSC_ROOT=/srv/peephole-m12-test-20261012/runsc
export PEEPHOLE_M12_TEST_BASE_ROOTFS=/srv/peephole-m12-test-20261012/rootfs
export PEEPHOLE_M12_TEST_TMPFS_ROOT=/srv/peephole-m12-test-20261012/tmpfs

npx vitest run tests/realUserEnvironmentRuntime.test.ts 2>&1 | tee m12-real.log
```

Both gates must be exactly `1`; every `PEEPHOLE_M12_TEST_*` root must be an
existing, symlink-free directory, disjoint from the others and from every
production root (including any production override such as
`PEEPHOLE_USER_ENVIRONMENT_ROOT`). Nothing falls back to a default path.

Subsets (vitest `-t`):

| Scenario | Command | Covers |
| --- | --- | --- |
| M12 only | `-t "E1"` | Delivery, digest, platform env, `config.json`/argv/runsc/workspace/lease non-persistence, modes, tmpfs cleanup, repeated stop |
| M10 + M12 | `-t "E2"` | Independent `/run/secrets/env` + `/run/secrets/user-env`, no collision |
| M11 + M12 mounts | `-t "E3"` | Synthetic canonical `DATABASE_URL` + M12 file; **no PostgreSQL connectivity** |
| M10 + M11 + M12 mounts | `-t "E4"` | Three independent files; **no PostgreSQL connectivity** |
| No configuration | `-t "E5"` | Previous runtime path: no mount, no flag |
| Failure / cleanup | `-t "G"` | Natural exit, startup failure, bootstrap fail-closed (emptied and malformed file), independent cleanup, stale reaper |
| Ownership loss | `-t "H2"` | Abandoned live runtime reconciled by fresh test-root reapers, twice |

**Planned, not implemented:**

- **M11 + M12 with real PostgreSQL connectivity.** Requires the prepared
  host-local PostgreSQL 18 tenant used by
  `tests/realTemporaryDatabaseRuntime.test.ts`
  (`PEEPHOLE_M11_REAL_GVISOR_DATABASE_TESTS=1`); run that M11 suite
  separately for connectivity. A combined suite would duplicate ~300 lines
  of M11 tenant provisioning and is deferred.
- **H1 — crash before START with an isolated supervisor process.** Needs a
  harness-owned child process that composes the control planes and is
  terminated by its own `ChildProcess` handle (never by name). The
  property (a fresh process has an empty broker → `CONFIGURATION_UNAVAILABLE`)
  is covered by portable tests only. No `SIGKILL` is sent by this harness.

## 5. Evidence

The log contains only booleans, statuses, and paths:

- `[m12-real-preflight]` — gate booleans, the four roots, and the protected
  roots.
- `[m12-real-evidence]` — one record per scenario: `digestMatch`,
  `active`/`postStop` persistence status (`PASS`/`FAIL`/`INCOMPLETE`),
  cleanup booleans, `databaseConnectivity: "NOT_RUN"` for E3/E4.

Persistence status combines, per raw value, `config.json` (whole file), the
dedicated runsc state root (bounded scan; only a proven `null-netns` nsfs
mount is skipped), the mounted workspace tree, and the lease directory. Any
unreadable area yields `INCOMPLETE`, which fails the test. **Not inspected:**
unallocated blocks of the loop-backed workspace image, journald (no
isolated journal — `NOT_RUN`), and host memory.

Record for the report: the full log, `runsc --version`, kernel version, the
rootfs path and its bootstrap SHA-256 (`sha256sum
<parent>/rootfs/opt/peephole/secret-bootstrap.mjs`), and the final
output of `tests/support/m12-test-host.sh status <parent>` (each root must
list no `peephole-m12-*` run directory after a passing run, and the only
mount under the parent must be its tmpfs). `status` prints `INCOMPLETE` and
exits non-zero whenever the mount table or a root cannot be listed; an
INCOMPLETE status is never evidence of a clean parent.

## 6. Cleanup

Each test creates `peephole-m12-{workspaceRoot,runscRoot,tmpfsRoot}-*` run
directories with an owner marker, and removes them only after re-proving
ownership (in-memory run id + device/inode + marker), finding no owned disk
allocation, network lease, or container, reconciling the dedicated runsc
`null-netns` mount, and finding no mount inside. Otherwise it **preserves**
the directory and names it in the error.

After all runs, remove the dedicated parent only through the script:

```bash
sudo tests/support/m12-test-host.sh status   /srv/peephole-m12-test-20261012
sudo tests/support/m12-test-host.sh teardown /srv/peephole-m12-test-20261012
```

`teardown` runs under `set -euo pipefail` and stops at the first failed
check. It deletes nothing unless all of these hold:

1. the parent passes the same syntax and protected-path checks as `setup`,
   is an ordinary directory reached without symlinks, and holds a regular
   (non-symlink) marker naming exactly this parent;
2. it runs as root;
3. `workspace`, `runsc`, and `tmpfs` are ordinary directories that can be
   listed and hold no `peephole-m12-*` run directory (the harness preserves
   those when it cannot prove them clean; inspect them first);
4. no process names the parent on its command line except the script
   itself, its own ancestors (the legitimate launchers, e.g. `sudo` and its
   pty monitor, found by following `PPid` in `/proc/<pid>/status`), and its
   own descendants. Any other process -- such as a leftover `runsc` with a
   `--root` under the parent, even a sibling of `sudo` -- blocks teardown;
   it is reported by PID only (never its command line) and never killed. A
   process that exits during inspection is ignored; one that exists but
   cannot be inspected, an unreadable or empty `/proc`, or an ancestry that
   cannot be proven also blocks teardown;
5. `findmnt` can be read (otherwise it refuses), and the only mount under
   the parent is its own tmpfs; after unmounting it, the mount table must be
   readable again and show nothing under the parent, or the parent is
   preserved.

It then unmounts that tmpfs, re-checks that no mount remains, removes the
three now-empty children with a non-recursive `rmdir`, removes only
`<parent>/rootfs` recursively (`rm -r --one-file-system`, which does not
follow symlinks), removes the marker, and finally `rmdir`s the parent —
which fails, leaving everything else in place, if anything unexpected is
still there.

## 7. Failure recovery

Never restart or touch a production Peephole service for a test failure.

| Symptom | Action |
| --- | --- |
| `runsc delete` failed | `runsc --root <parent>/runsc/<run>/state list`; delete only listed ids with the same `--root`; never the default root |
| Mount busy / preserved run directory | `findmnt -R "<run dir>"`; unmount only those mount points; re-run removal |
| Namespace or veth remains | Read the lease files under `<workspace run>/network-leases`; remove only the netns/veth/chains named there |
| Credential tmpfs not empty | Inspect `<tmpfs run>/{user-env,secrets,db-credentials}`; `teardown` unmounts the dedicated tmpfs once no run directory or other mount remains |
| Process ownership ambiguous | Stop; do not kill by name. Identify only `runsc` processes whose `--root` is the dedicated state dir |
| Rootfs stale (bootstrap mismatch) | Build a new rootfs at a new path (section 3); never rebuild in place |
