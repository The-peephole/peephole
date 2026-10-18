# Peephole v0.3.0 release risk review (B1/B2)

**Status: B1/B2 RISK_ACCEPTED (release owner, 2026-10-18); B3 open and
managed privately.** This document records the residual risk of releasing
v0.3.0 without running the B1/B2 real-host tests, and the release owner's
decision to accept it. B1 and B2 remain NOT_RUN. Accepting the risk is not a
deployment approval or an M12 activation approval, and approvals given for
the 2026-10-18 read-only inspections are none of those either.

Context: [RELEASE_V0.3.0.md](RELEASE_V0.3.0.md) (build, package, preflight)
and [M12_PRODUCTION_CANARY_20261016.md](M12_PRODUCTION_CANARY_20261016.md#release-readiness)
(original gate definitions). No credential, token, database URL or secret
appears in this document.

Control status labels:

- **IMPLEMENTED:** present in the code or the deployed design, as recorded.
- **VERIFIED:** directly observed, with the date and source given.
- **PROPOSED:** not in place; would need its own approval to adopt.

## Scope of the decision

| Item | Value |
| --- | --- |
| Release commit | `d6bd6c39309233772465759dfb509ef91ff147ba` |
| Extension | 0.3.0, ZIP SHA-256 `593d621292442ef7da11a02a8aa7fb4672d9166617130c39cc7e21ed09023fe4`; final Production E2E NOT_RUN |
| Production today | Stable `87d691e`, M12 OFF, M11 ON (preflight 2026-10-18) |
| Activation path | Pinned release package (activate/rollback), each step separately approved |
| M12 Canary reference | Backend `aa26a11`, 2026-10-16, one preview, then Stable rollback |

B1 and B2 are **verification gaps**: tests that were designed but not run on
a real host. B3 is a different kind of item, a security approval handled
outside this document (see [B3](#b3--security-approval-item)).

## B1 — Real Linux concurrent exit, isolation and journal verification

**Status: NOT_RUN.**

**Unverified scenarios.**

- The real-host M12 lifecycle result (REAL_GVISOR_VERIFIED, 12/12 cases, 306
  host checks) is bound to `5ed0f92`. Later corrections to concurrent exit
  and pending `SIGTERM` handling in the backend runtime process are covered
  by portable tests only (`tests/backendRuntimeProcess.test.ts`, PR #66).
- G-lifecycle (6 cases) and H2/H3 (1 case) have not been re-run at the
  release commit.
- Journal non-leakage of M12 values in an isolated real journal: the harness
  exists (PR #67, `tests/support/runM12JournalVerification.ts`), but the
  real-host result is NOT_RUN.

**Portable versus real Linux.** Portable tests replace runsc, tmpfs
ownership, network namespaces and the journal with fakes or stubs. They prove
the decision logic, including signal ordering and discard paths. They do not
prove what the kernel, gVisor or systemd-journald actually do under those
interleavings.

**Residual risk.**

- A stop could report failure when the backend exited at the same moment, or
  an independent cleanup step could be skipped. That could leave a sandbox,
  network lease, tmpfs material file or temporary database behind.
- An M12 value could reach the system journal through a path the portable
  tests do not model. The design never logs values or backend output, but
  this has not been observed on a real host.

**Evidence available.**

| Evidence | What it covers | Limit |
| --- | --- | --- |
| REAL_GVISOR_VERIFIED at `5ed0f92` (2026-10-13), [runbook record](M12_REAL_GVISOR_VERIFICATION.md) | Child env delivery, tmpfs lifetime, non-persistence, abandoned-ownership reap | Earlier revision; not the concurrent-exit correction |
| Portable suites at `d6bd6c3` (3,165 passed) | Signal boundary, discard paths, sentinel non-leakage through responses, rows, queue, `config.json`, argv | Fakes and stubs |
| 2026-10-16 Canary | One ordinary Stop with zero residue on Production | One normal path; no interleaving |
| 2026-10-18 preflight | Zero residue on Production today | Static snapshot |

**Compensating controls.**

| Control | Status |
| --- | --- |
| Startup and periodic reapers for runtime, network, user-env tmpfs, M10/M11 material | IMPLEMENTED |
| Fail-closed broker: values are single-use, discarded on every exit path, and swept by TTL | IMPLEMENTED |
| Production concurrency 1 for backend/full-stack, which narrows interleavings | IMPLEMENTED |
| Values never written by Peephole to its logs; backend stdout/stderr not logged | IMPLEMENTED (portable-verified; real journal NOT_RUN) |
| Read-only resource inventory after activation and after any anomaly, using the existing inventory step | PROPOSED |
| Bounded watch window after activation (R3) | PROPOSED |

**Proposed stop criteria (if accepted).** Any of the following stops new M12
use, and rollback is then considered under its own approval:

- a stop that ends with a cleanup error;
- any non-zero host or tenant residue while no preview is active;
- a non-revoked M11 ownership row without an active preview;
- any report of a configuration value appearing outside its preview.

**If accepted, the release owner acknowledges:**

- concurrent-exit and journal behaviour at the release commit is unverified
  on real Linux;
- the reapers are the remaining safety net for missed cleanup;
- a journal leak of a non-sensitive M12 value cannot be ruled out by
  evidence.

## B2 — Real server SIGKILL and startup recovery

**Status: NOT_RUN.**

**Unverified paths.**

- An ungraceful kill of the actual server child while M12 values are held in
  the broker before START.
- An ungraceful kill while an M12-enabled backend is running.
- The fresh process's startup reconciliation of M12 user-env tmpfs files
  together with M10/M11 material, sandbox and route state, before listeners
  open.
- The owned-server crash harness exists (PR #68,
  `tests/realServerCrashRecovery.test.ts`) but was not run on a real host.

**Canary versus crash recovery.** The 2026-10-16 Canary exercised activation,
one preview, an ordinary Stop and a planned rollback. No process was killed,
so it says nothing about recovery from an ungraceful exit.

**Residual risk.**

- After a crash, the restarted service could leave a user-env tmpfs file, a
  network lease, a temporary database or an ownership row out of step with
  the durable parent state.
- It could fail to fail a preview that was waiting for broker values. By
  design that preview should fail with `CONFIGURATION_UNAVAILABLE`, but this
  has not been observed on a real host.

**Evidence available.**

| Evidence | What it covers | Limit |
| --- | --- | --- |
| M11-E6, 2026-10-07, at `83f1d1b` ([record](TEMPORARY_DATABASES.md#production-acceptance-record-m11-e-2026-10-07)) | Real `SIGKILL` of the verified server child on Production; `Restart=on-failure` restart; startup reconciliation removed the DB, role, credential and runtime state; durable parent failed closed | Before M12; no broker or user-env material |
| M9 restart fail-closed | A `ready` full-stack preview is invalidated, not reconstructed | Graceful restart, not a kill |
| H2/H3 at `5ed0f92` | Abandoned-ownership reaping | Models abandonment, not an actual kill |
| Portable broker and reaper tests | Restart before START gives `CONFIGURATION_UNAVAILABLE`; tmpfs reaper | Fakes |
| 2026-10-16 Canary rollback | The scripted rollback to Stable works (`ROLLBACK_COMMITTED`, exit 0) | Planned, not after a crash |

**Compensating controls.**

| Control | Status |
| --- | --- |
| Broker values are in process memory only, so a restart cannot reuse them; it fails closed | IMPLEMENTED |
| Startup reconciliation before listeners open (M9/M10/M11) and user-env tmpfs reaper at startup | IMPLEMENTED (M11 part VERIFIED 2026-10-07 by E6; M12 part portable only) |
| `Restart=on-failure`, `KillMode=control-group` | IMPLEMENTED (recorded in the E6 record) |
| Activation package: automatic rollback to Stable if activation fails within its 480 s budget | IMPLEMENTED; package tests 34/34 locally; the Canary package rollback step executed successfully on 2026-10-16 |
| After any unplanned restart (NRestarts increase), run the read-only inventory before more previews | PROPOSED |

**Proposed stop and rollback criteria.** Any of the following stops new
previews and leads to a separately approved rollback to `87d691e` with M12
OFF:

- an unplanned restart followed by non-zero residue or a non-revoked
  ownership row without an active preview;
- health or readiness failing after a restart;
- the service failing to start.

**Uncertainty that remains if accepted:** M12-specific crash recovery,
including user-env material reaping and broker loss handling after a real
kill, is known only from design and portable tests, plus the pre-M12 E6
result.

## B3 — Security approval item

B3 is a separate security approval item. Its details are managed in a private operational record, not in this repository. It is open: not passed, not remediated and not verified safe. Formal M12 activation still requires the release owner's separate
security sign-off for B3. This document records no decision on it.

## Release owner risk acceptance form

Filled in from the release owner's decision. B3 is not part of this form.

| Risk | Current status | Evidence | Remaining risk | Controls relied on | Acceptance | Release owner approval date | Release owner approval record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 — real Linux concurrent exit / isolation / journal | NOT_RUN | [B1](#b1--real-linux-concurrent-exit-isolation-and-journal-verification) | Missed cleanup or journal leak under unverified interleavings | Reapers, fail-closed broker, concurrency 1; proposed inventory and stop criteria | ACCEPTED | 2026-10-18 | Release owner decision: B1 tests are skipped for v0.3.0 and the residual risk is accepted. |
| B2 — real server SIGKILL / startup recovery | NOT_RUN | [B2](#b2--real-server-sigkill-and-startup-recovery) | M12-specific crash recovery unobserved | Memory-only broker, startup reconciliation, auto-rollback package; proposed post-restart inventory | ACCEPTED | 2026-10-18 | Release owner decision: B2 tests are skipped for v0.3.0 and the residual risk is accepted. |

Overall: **B1/B2 RISK_ACCEPTED (2026-10-18)**. B1 and B2 stay NOT_RUN; the
proposed controls above are not adopted by this record. B3 remains open and
is managed privately.

Accepting a risk does not approve activation. Activation and, if needed,
rollback each still need their own explicit approval through the pinned
package.
