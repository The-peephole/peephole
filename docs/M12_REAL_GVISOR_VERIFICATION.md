# M12 Real Linux/gVisor Verification — Operator Runbook

**REAL_GVISOR_VERIFIED (2026-10-13, commit
`5ed0f925c4d8e3d9c7a549fda926b4983d087253`): Linux host checks 306 PASS;
E1–E5 5/5, G1–G5 6/6, H2/H3 1/1 — 12/12 PASS.**
The final execution (`reverify-20261013-3a2e1079/FINAL_REPORT.md`) also
verified the Guard's actual EC2 termination and zero newly created residual
AWS resources. That run was not production deployment. At that milestone,
H1 actual SIGKILL, actual PostgreSQL connectivity and Chrome E2E were
**NOT_VERIFIED**.
The later concurrent-exit/SIGTERM correction has portable regressions only;
the 12/12 result above does not attest to that newer code. Recheck G lifecycle
and H2/H3 on Linux before production activation. A green GitHub CI alone is
not real-host verification. Design: docs/USER_PROVIDED_ENVIRONMENT.md (D-035).

**2026-10-16 update:** a separately approved Production Chrome Fullstack
Canary at `aa26a11` passed frontend/backend/config delivery and ordinary Stop/
physical cleanup, followed by Stable rollback with M12 OFF. This closes that
limited Chrome E2E gap, not H1, all post-correction G/H interleavings, a
separately recorded application SQL-query E2E or actual D1 failure capture.
The 12/12 historical result above remains bound to its original SHA. See
[Canary closure and remaining release gates](M12_PRODUCTION_CANARY_20261016.md).
Stage3A files are restored; actual browser Reload/login remains user-pending.

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
`build-base-rootfs.sh` refuses an existing output path and defaults
to the production path (see [rootfs build policy](ROOTFS_BUILD.md)), so the
script only ever passes it
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

**Outside this 12-case harness:**

- **M11 + M12 with real PostgreSQL connectivity.** Requires the prepared
  host-local PostgreSQL 18 tenant used by
  `tests/realTemporaryDatabaseRuntime.test.ts`
  (`PEEPHOLE_M11_REAL_GVISOR_DATABASE_TESTS=1`); run that M11 suite
  separately for M11 connectivity. The separate combined scenario now exists
  in `tests/realCombinedEnvironmentRuntime.test.ts`; follow
  [its dedicated-host/PG runbook](M12_COMBINED_INTEGRATION.md). No passing
  execution receipt for that combined SQL path is supplied by this closure.
- **H1 — crash before START with an isolated supervisor process (not implemented here).** Needs a
  harness-owned child process that composes the control planes and is
  terminated by its own `ChildProcess` handle (never by name). The
  property (a fresh process has an empty broker → `CONFIGURATION_UNAVAILABLE`)
  is covered by portable tests only. No `SIGKILL` is sent by this harness.

## 5. Evidence

### Historical failure and completed follow-up (2026-10-13)

E1–E5 passed on the dedicated EC2 host. G1/G2/G3 reached their scenario
assertions but failed when owned cleanup called `stop()` after
`waitForExit()` had already deleted the container. G4/G5 passed; H2/H3
were not run. Scenario evidence printed before cleanup is not a test PASS.

The runtime now skips SIGTERM only after observing process exit, while
retaining shared container deletion and credential cleanup error reporting.
Use a source archive containing this fix on a newly approved dedicated host;
do not replay the old EC2 creation manifest. Complete sections 1–3 and the
AWS guard/timer checks before running these commands. Include `/usr/sbin`
and `/sbin` in the clean test PATH so host iptables is discoverable.

With the four explicit test roots exported as in section 4, execute G first
and H2/H3 only after G and its owned cleanup pass:

```bash
set -o pipefail
node node_modules/vitest/vitest.mjs run tests/realUserEnvironmentRuntime.test.ts \
  -t 'G[1-5]:' 2>&1 | tee "$EVIDENCE/G-recheck.log" &&
node node_modules/vitest/vitest.mjs run tests/realUserEnvironmentRuntime.test.ts \
  -t 'H2/H3:' 2>&1 | tee "$EVIDENCE/H2-H3-recheck.log"
```

Run under the same root, credential-free environment as the initial run.
Require six passing G cases and one passing H2/H3 case, their evidence
records, and clean parent status; retain failures and stop rather than
weakening cleanup. This follow-up was completed at `5ed0f92`: all six G
cases and H2/H3 passed, as did E1–E5 and parent teardown (12/12 total).
The initial failure is retained above as history, not the current result.

### Subsequent concurrent-exit correction (portable verification only)

The final review reproduced natural exit while a SIGTERM request is pending.
Even with successful deletion and credential cleanup, the failed signal
could make `stop()` report failure. The subsequent correction suppresses
that signal error only for a confirmed exit observed before forced cleanup
and successful deletion and credential cleanup. Live-process signal errors,
unknown/timed-out exits and cleanup failures remain errors; independent
cleanup failures are preserved. Deterministic portable tests cover the
interleavings and repeated `stop()`/`waitForExit()` calls. No AWS or real-gVisor
execution was performed for this correction. The commands above define the
remaining Linux lifecycle recheck; retain the historical 12/12 evidence at
its exact commit rather than attributing it to the newer branch HEAD.

### R5-1A pending-signal test addition (real execution still pending)

`G6` adds a test-only `PendingSignalProcessRunner` around the existing real
`NodeProcessRunner`; no production hook or runtime behavior changes. It holds
only the exact test-root/container SIGTERM request at the awaited runner
boundary. The host kill command has not started while held: this is not a
claim that a kernel signal syscall is suspended. The fixture's `/exit` then
causes actual natural exit, observed as exit code 0, and all three material
cleanups must finish before release. The unchanged runner then executes the
actual runsc kill against the deleted container; its nonzero, non-timeout
result must be tolerated only with that confirmed exit and successful cleanup.
The evidence record is emitted after outer owned-resource cleanup succeeds.

Portable tests validate this gate and M10/M11/M12 independent cleanup failure
handling; the existing forced-deletion/unconfirmed-exit and graceful-stop
regressions remain required. Portable PASS and an opt-in skip are not Linux
boundary PASS. G6 has not been executed on a real host by this implementation
phase. **B1 remains OPEN**, including journal non-leakage (R5-1B).

On a separately approved dedicated host, reuse the gates/roots above and run
`-t 'G6:'` in addition to the existing six G1-G5 cases and one H2/H3 case.
Require test exit 0, the `G6-pending-signal` evidence, real nonzero signal exit
code, and clean parent status. A missing boundary, timeout, skipped suite,
unreadable inventory or cleanup failure never closes B1. G6 uses synthetic
M11-shaped material only; it does not establish SQL connectivity or B2's
actual-server SIGKILL/startup recovery.

The log contains only safe codes, booleans, statuses, and paths:

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
