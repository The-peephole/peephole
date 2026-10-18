# Peephole v0.3.0 release risk review (B1/B2/B3)

**Status: RISK_ACCEPTANCE_PENDING.** This document helps the release owner
decide whether to accept the residual risk of releasing v0.3.0 and turning
M12 on without running B1/B2 or remediating B3. It is not an acceptance, a
deployment approval or an M12 activation approval. Approvals given for the
2026-10-18 read-only inspections are none of those either.

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
a real host. B3 is a **security incident disposition**: an earlier
credential exposure with no recorded remediation. They are different kinds
of risk and are decided separately.

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

## B3 — Historical provisioning credential exposure

**Status: UNREMEDIATED.** This is a security incident, not a missing test.

**What is recorded.**

- [Backend failure diagnostics](BACKEND_FAILURE_DIAGNOSTICS.md),
  [M12 combined integration](M12_COMBINED_INTEGRATION.md) and the
  [Canary closure](M12_PRODUCTION_CANARY_20261016.md) record
  `CREDENTIAL_EXPOSURE_UNREMEDIATED` for a previously exposed provisioning
  credential.
- No remediation, rotation or closure evidence exists in the reviewed
  records.
- The repository does not record the exposure channel, its extent, or
  whether the credential is still valid.
- In the deployed M11 design (D-033), the static operator-managed provisioning
  credential is the one for the tenant cluster's `m11_provisioner` role. The
  release owner should confirm that this is the credential the incident
  refers to.

**Current unremediated scope (as far as recorded):**

- the credential has not been rotated;
- it is unknown whether it is still valid;
- there is no secret-free closure record.

**Potential misuse.** `m11_provisioner` is `LOGIN NOSUPERUSER CREATEDB
CREATEROLE NOREPLICATION NOBYPASSRLS` on the separate `18-tenant` cluster
(D-033). Someone who holds a still-valid credential **and** can reach an
accepted authentication path could:

- create or drop databases and `pv_*` roles in the tenant cluster;
- through the admin membership the role holds over the roles it creates,
  possibly reach other previews' temporary databases;
- disrupt temporary-database previews.

By design this does not reach the control-plane `18-main` cluster, which is a
separate cluster. Which authentication paths accept this role is not
verified in this record (see below).

**Applicable controls.**

| Control | Status |
| --- | --- |
| Least-privileged provisioning role, not superuser | IMPLEMENTED (D-033 acceptance record, 2026-10-07); not re-verified since |
| Separate tenant cluster, distinct from the control-plane cluster | IMPLEMENTED; both services active (VERIFIED 2026-10-18 preflight) |
| Tenant cluster bound only to host-only `192.168.253.1:5433` | IMPLEMENTED (D-033); port 5433 listening VERIFIED 2026-10-18; the bind-address restriction was not re-verified |
| Provisioning only over the tenant cluster's Unix socket | IMPLEMENTED in the design; **whether `pg_hba` refuses this role over TCP is NOT VERIFIED** |
| Sandbox egress dropped except one `/32` route to `5433` for a DB-backed preview | IMPLEMENTED (M11-E evidence). Such a backend can reach the tenant port over TCP, so the `pg_hba` question above matters |
| Credential values never stored in the repository or the evidence | IMPLEMENTED (record discipline) |
| Rotation of the provisioning credential | PROPOSED |
| Secret-free verification that the old credential is rejected | PROPOSED |

**Proposed remediation plan (needs its own Production approval).**

1. Confirm which credential the incident refers to.
2. Create a new credential through a controlled change, without displaying
   it, and update only the server-side configuration.
3. Restart only the Peephole service and check health and readiness.
4. Confirm provisioning works: one DB-backed preview, or an approved
   non-preview probe.
5. Confirm the old credential is rejected, using a check that does not print
   it.
6. Record a secret-free closure.
7. Independently, verify read-only that `pg_hba` restricts the role to the
   local socket.

**Security meaning of releasing unremediated.** The exposure already applies
to the current Production Stable, because M11 is ON. Releasing v0.3.0 or
turning M12 on does not widen the role's privileges. However:

- the Canary closure states that a missing B3 disposition keeps M12 ON
  blocked;
- accepting it means continuing to operate with a possibly valid exposed
  credential whose reachable authentication paths are not verified;
- a functional success, such as the Canary, cannot clear it.

## Release owner risk acceptance form

Fill in only by the release owner. Leave a row PENDING if not decided.

| Risk | Current status | Evidence | Remaining risk | Controls relied on | Acceptance | Release owner approval date | Release owner approval record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 — real Linux concurrent exit / isolation / journal | NOT_RUN | [B1](#b1--real-linux-concurrent-exit-isolation-and-journal-verification) | Missed cleanup or journal leak under unverified interleavings | Reapers, fail-closed broker, concurrency 1; proposed inventory and stop criteria | PENDING | | |
| B2 — real server SIGKILL / startup recovery | NOT_RUN | [B2](#b2--real-server-sigkill-and-startup-recovery) | M12-specific crash recovery unobserved | Memory-only broker, startup reconciliation, auto-rollback package; proposed post-restart inventory | PENDING | | |
| B3 — historical provisioning credential exposure | UNREMEDIATED | [B3](#b3--historical-provisioning-credential-exposure) | Possibly valid exposed credential; TCP authentication path unverified | Least privilege, separate cluster, host-only bind; proposed rotation and `pg_hba` check | PENDING | | |

Overall: **RISK_ACCEPTANCE_PENDING**

Accepting a risk does not approve activation. Activation and, if needed,
rollback each still need their own explicit approval through the pinned
package.
