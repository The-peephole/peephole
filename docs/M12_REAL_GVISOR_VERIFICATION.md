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
| `tests/m12RealGvisorHarness.test.ts` | Portable safety tests (run in normal CI) |

## 1. Preconditions

- A **dedicated** Linux host or VM that has never run Peephole production.
  The suite refuses to start if any of these exist:
  `/var/lib/peephole/{jobs,base-rootfs,artifacts}`,
  `/run/peephole/{secrets,db-credentials,user-env}`,
  `/var/run/peephole/runsc`, or a `peephole.service` /
  `peephole-tenant-network.service` unit. There is no override.
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

Choose one dedicated parent that is **not** under `/var/lib/peephole`,
`/run/peephole`, or `/var/run/peephole`:

```bash
export M12_TEST_PARENT=/srv/peephole-m12-test
test ! -e "$M12_TEST_PARENT" || { echo "parent already exists; pick a new one"; exit 1; }
install -d -m 0700 "$M12_TEST_PARENT" \
  "$M12_TEST_PARENT/workspace" "$M12_TEST_PARENT/runsc" "$M12_TEST_PARENT/tmpfs"
mount -t tmpfs -o size=16m,mode=0700 tmpfs "$M12_TEST_PARENT/tmpfs"
findmnt -n -o FSTYPE -T "$M12_TEST_PARENT/tmpfs"    # tmpfs
```

Build a **separate** rootfs. `build-base-rootfs.sh` deletes its output
directory if it exists and defaults to the production path, so always pass a
never-used path and check it first:

```bash
export M12_TEST_ROOTFS="$M12_TEST_PARENT/rootfs-$(date +%Y%m%d%H%M%S)"
test ! -e "$M12_TEST_ROOTFS" || { echo "rootfs path exists; refusing"; exit 1; }
sudo ./scripts/gvisor/build-base-rootfs.sh "$M12_TEST_ROOTFS"
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
export PEEPHOLE_M12_TEST_WORKSPACE_ROOT="$M12_TEST_PARENT/workspace"
export PEEPHOLE_M12_TEST_RUNSC_ROOT="$M12_TEST_PARENT/runsc"
export PEEPHOLE_M12_TEST_BASE_ROOTFS="$M12_TEST_ROOTFS"
export PEEPHOLE_M12_TEST_TMPFS_ROOT="$M12_TEST_PARENT/tmpfs"

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
"$M12_TEST_ROOTFS/opt/peephole/secret-bootstrap.mjs"`), and the final
`ls -la` of the three roots (each must contain no `peephole-m12-*` run
directory after a passing run).

## 6. Cleanup

Each test creates `peephole-m12-{workspaceRoot,runscRoot,tmpfsRoot}-*` run
directories with an owner marker, and removes them only after re-proving
ownership (in-memory run id + device/inode + marker), finding no owned disk
allocation, network lease, or container, reconciling the dedicated runsc
`null-netns` mount, and finding no mount inside. Otherwise it **preserves**
the directory and names it in the error.

After all runs, remove only the dedicated parent you created:

```bash
umount "$M12_TEST_PARENT/tmpfs"
findmnt -R "$M12_TEST_PARENT"           # must print nothing before removal
rm -rf --one-file-system "$M12_TEST_PARENT"
```

## 7. Failure recovery

Never restart or touch a production Peephole service for a test failure.

| Symptom | Action |
| --- | --- |
| `runsc delete` failed | `runsc --root "$M12_TEST_PARENT/runsc/<run>/state" list`; delete only listed ids with the same `--root`; never the default root |
| Mount busy / preserved run directory | `findmnt -R "<run dir>"`; unmount only those mount points; re-run removal |
| Namespace or veth remains | Read the lease files under `<workspace run>/network-leases`; remove only the netns/veth/chains named there |
| Credential tmpfs not empty | Inspect `<tmpfs run>/{user-env,secrets,db-credentials}`; `umount` the dedicated tmpfs to discard everything |
| Process ownership ambiguous | Stop; do not kill by name. Identify only `runsc` processes whose `--root` is the dedicated state dir |
| Rootfs stale (bootstrap mismatch) | Build a new rootfs at a new path (section 3); never rebuild in place |
