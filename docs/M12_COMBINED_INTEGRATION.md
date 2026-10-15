# M10/M11/M12 combined integration (D2A)

## Baseline and verification gap

Baseline main: `eb1c14d4c9b935c91b9cdcbbd9887f4dfb1ba83f`, including merged
PR #56 (D1). No production runtime, schema, workflow or feature flag is changed.

| Existing evidence | Proves | Does not prove |
| --- | --- | --- |
| `postgresTemporaryDatabase.test.ts` | Real PG18 restricted-role provisioning, SCRAM authentication, tenant query, revoke; backend lifecycle with a substituted process starter | Real sandbox/mount/readiness/network |
| `postgresTemporaryDatabaseReaper.test.ts` | Durable ownership, partial provisioning recovery, physical cleanup and rejection of unowned/mismatched resources | Actual gVisor M12 combination |
| `realTemporaryDatabaseRuntime.test.ts` | Real M11 PG/network/runtime; source/install replaced by test implementations | Real fetch/npm install, M10/M12 combination, Fullstack admission |
| `realUserEnvironmentRuntime.test.ts` E3/E4 | Independent credential mounts, bootstrap/delivery with a synthetic DATABASE_URL | PostgreSQL connectivity (`databaseConnectivity: NOT_RUN`); Fullstack or backend supervisor fetch/install/provisioning |
| Historical Canary | Three frontend READY/backend BACKEND_FAILED outcomes | Original failure stage: still UNCONFIRMED; D1 was not deployed or used retroactively |

Existing PG integration tests and their CI job are reused, not duplicated.
The M11 real test's existing `TestOwnershipStore` was moved unchanged in its
default behavior into a shared test helper; D2A optionally writes a receipt on
each transition. Its existing real assertions and gates are unchanged.

## New scenario and its boundaries

`tests/realCombinedEnvironmentRuntime.test.ts` uses the **unmodified pinned
backend** from `The-peephole/peephole-fixture-fullstack`, commit
`90afaa0c3f650744300afc5d8fed00fd4a0ef5c8` (the Canary's
`test/m12-user-environment` branch). It never resolves a moving branch and
does not use a substitute backend fixture.

The test runs real Fullstack admission/broker registration and the Fullstack
supervisor, then `composeProductionBackendRuntime()` unchanged:

1. Create a uniquely owned parent and backend runtime.
2. Download/extract the pinned public source; run real npm ci in the real
   gVisor install sandbox. No GitHub token or source/install mock.
3. Generate M10 material, take M12 material from the admitted broker, and
   provision a real temporary PG18 role/database using the existing restricted
   provisioner and SCRAM verifier implementation.
4. Deliver three separate real tmpfs files, check their mount destinations,
   read-only options, UID/GID/mode and distinct file identities. Only platform
   variables may appear in OCI env. File contents are not read by the test.
5. Start the real ingress-only gVisor backend and require TCP readiness and
   Fullstack routing activation independently of HTTP checks.
6. Check HTTP health, exact harmless config delivery and real DB query success.
   The pinned `/api/db-check` returns connected only after the real pg Client
   connects and completes CREATE TABLE/SELECT 1. HBA requires SCRAM.
7. Check M10 presence through `/api/secret-check`. Its digest is discarded
   during JSON parsing, never reported or persisted. This checks presence,
   not a separately recorded/hash-compared secret value.
8. Stop through Fullstack cancellation, await both supervisors, verify stopped
   states, revoked ownership and absence of the specific PG role/database.
9. Require zero owned disk allocations, containers, bundles, leases and tmpfs
   files; inspect actual netns/veth/IPv4+IPv6 firewall state. Reconcile the
   dedicated runsc state using the existing helper, then re-prove ownership
   before removing run directories.

Explicit substitutions: plan resolvers use pinned fixture metadata; Fullstack
and backend stores/queues are process-local test adapters. A frontend cache hit
and artifact-expiry metadata are seeded. The real routing activator runs, but
no frontend build, artifact bytes, public origin/proxy, Chrome, OAuth or Gateway
E2E is claimed. SQL control-plane FKs/restart durability remain covered by the
existing PG integration tests, not by this test's in-memory ownership store.

The real production source fetcher stages an archive using os.tmpdir(). This
test temporarily points TMPDIR at its owned run directory and restores it.
It does not change fetcher behavior or stage under a production directory.

## Safety preconditions (all mandatory, before execution)

The current Windows development host cannot run this integration. Record
real-gVisor as **NOT_RUN** until an independently verified dedicated Linux
host/VM is available. EC2 is not required. This change neither discovers nor
starts a host, creates AWS resources, installs PostgreSQL, or configures networking.

Use a host with no Peephole production history, a reviewed dedicated-host
inventory, exclusive use for this scenario, Linux root privileges, runsc,
loopback/ext4 tooling, iproute2, iptables/ip6tables (including NAT tables),
findmnt, and the existing harness's disk headroom. No production credentials
or production environment file may be present in the test process.

Reuse `tests/support/m12-test-host.sh` and
[the existing preparation/teardown procedure](M12_REAL_GVISOR_VERIFICATION.md).
Create a **new** parent, then build its **new** rootfs with those scripts.
Never run build-base-rootfs against an existing image/path.

The four explicit roots must be the script-created children:

```sh
export PEEPHOLE_M12_TEST_WORKSPACE_ROOT=/srv/peephole-m12-combined-review1/workspace
export PEEPHOLE_M12_TEST_RUNSC_ROOT=/srv/peephole-m12-combined-review1/runsc
export PEEPHOLE_M12_TEST_TMPFS_ROOT=/srv/peephole-m12-combined-review1/tmpfs
export PEEPHOLE_M12_TEST_BASE_ROOTFS=/srv/peephole-m12-combined-review1/rootfs
export PEEPHOLE_M12_COMBINED_POSTGRES_ROOT=/srv/peephole-m12-db-review1
```

The harness adds a **positive** operator attestation, not merely an absence of
production markers. After independently reviewing the host, an operator must
create root-owned 0600 `.peephole-m12-combined.json` in both the test parent
and PostgreSQL root, through a private editor:

```json
{
  "schema": "peephole-m12-combined/v1",
  "dedicatedNonProduction": true,
  "machineId": "<this host's exact /etc/machine-id>",
  "bootId": "<this boot's exact /proc/sys/kernel/random/boot_id>",
  "parent": "/srv/peephole-m12-combined-review1",
  "postgresRoot": "/srv/peephole-m12-db-review1"
}
```

This attestation is an operator trust decision bound to the machine/boot and
paths; it is not an automatic proof of a host's entire history. It must be
renewed after reboot. Existing production-marker, path, rootfs/bootstrap and
per-run ownership checks remain required. Existing Peephole netns/veth/rules
or cluster-global pv_* resources cause refusal. The workspace/runsc/tmpfs
parents must be empty before the run; preserved or unowned prior resources
cause refusal. Nothing is reaped on a guess.

## Disposable PostgreSQL prerequisite

Prepare a fresh dedicated PG18 cluster separately, using **only test**
credentials. No infrastructure setup automation is added here. These are
preconditions for a later authorized setup, not commands executed by D2A:

- PostgreSQL root must match `/srv/peephole-m12-db-<name>`, be root-owned 0711,
  canonical and disjoint from the harness parent. 0711 permits the postgres
  OS user to traverse to its own children; root secret files stay 0600.
- `data/` is owned by a non-root postgres OS user; `socket/` belongs to that
  user. The process must be launched exactly as `postgres -D <root>/data`,
  without command-line config overrides. Version file, postmaster PID,
  socket lock PID/UID, `/proc/PID/cwd` and executable must agree.
- Dedicated listener: **192.168.253.1:5433** plus `<root>/socket`. The test
  host's address must already exist. The test never adds addresses or rules
  to set up PostgreSQL. The existing gVisor namespace implementation creates
  and removes only its ordinary owned runtime network resources.
- `m12_combined_provisioner`: LOGIN, CREATEDB, CREATEROLE, no superuser,
  replication, BYPASSRLS or inherited memberships; current/session identity
  must match and createrole_self_grant must be empty. Password encryption is
  scram-sha-256. Use the existing restricted provisioning contract.
- `postgresql.conf` may not include other files or override data_directory or
  hba_file. `postgresql.auto.conf` must have no active settings. The HBA must
  contain exactly these active rules, in order:

```text
local all postgres peer
local all m12_combined_provisioner scram-sha-256
host all all 10.200.0.0/16 scram-sha-256
```

- To prevent even failed provisioning SQL/parameters from logging a SCRAM
  verifier: log_statement=none; log_min_error_statement=panic;
  log_min_messages=panic; log_duration=off; log_min_duration_statement=-1;
  log_min_duration_sample=-1; log_transaction_sample_rate=0;
  log_parameter_max_length=0; log_parameter_max_length_on_error=0;
  shared_preload_libraries and session_preload_libraries empty. Missing/unreadable settings fail closed.
  Both preload values must be explicitly set once to `''` in postgresql.conf.
  PostgreSQL 18 [marks these settings superuser-only](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/utils/misc/guc_tables.c#L4232),
  so the harness checks the positively owned config rather than granting
  pg_read_all_settings. Ambient PGOPTIONS/PGSERVICE overrides are refused.
- In a separate private root editor, create `<root>/provisioner.json`, root
  0600, containing only user=`m12_combined_provisioner`, database=`postgres`
  and the matching disposable password. Set the role password through an
  approved interactive secure path such as psql's password prompt. Never
  put the password in shell arguments/history, chat, reports or Git. The
  harness derives host/port itself and never accepts a URL/env fallback.

No connection is attempted until host/path/PID/socket ownership proofs pass.
The read-only SQL preflight then checks PG18, Unix-socket connection,
listener/port, restricted role/session and logging policy before creating
anything. An idle-pool error is tracked as a boolean, never printed raw.

## Running only the combined scenario

From a reviewed checkout in a clean root session on that verified host:

```sh
export PEEPHOLE_REAL_GVISOR_TESTS=1
export PEEPHOLE_M12_REAL_GVISOR_TESTS=1
export PEEPHOLE_M12_COMBINED_REAL_TESTS=1
npx vitest run tests/realCombinedEnvironmentRuntime.test.ts
```

All three flags must equal `1`. Run **only that file**, not the complete suite
with real gates enabled. Do not reuse production environment files, broad
environment forwarding, production cluster endpoints or an old test parent.

## Evidence, failure and cleanup

Only `[m12-combined]` emits evidence: runtime ID, validated D1 fields,
fixed harness failure code, per-step PASS/FAIL/NOT_RUN, overall result and
resourcesPreserved. No raw exceptions/stacks, stdout/stderr, HTTP bodies,
SQL results, credentials, config values or credential hashes are emitted.
Sandbox command output is suppressed through a real-runner adapter; it does
not replace process execution or change the process result's exit/timeout.

On incomplete ownership/reclamation, result is **BLOCKED** and every not-yet
verified directory is preserved. There is no force-delete/manual DROP or
fallback reaper to turn failure into PASS. Secret-free ownership receipts
are written under the owned workspace **before provisioning SQL** and at
later transitions; preserved receipts support later separately approved
inspection. D1 remains a completed-report mechanism: a hung/killed worker
may have no diagnostic record, which is not a successful cleanup.

Use the existing `m12-test-host.sh status <parent>` to locate preserved runs.
Do not run teardown until resources are independently reconciled; its own
ownership/process/mount checks must pass. Final parent teardown still uses
that existing script. The separate disposable PG cluster/test secret files
require their own reviewed owner-specific shutdown/removal; this test does
not stop or delete the cluster. No production service is touched.

Portable safety/ownership/D1 tests and existing PG18 CI are separate evidence.
Their PASS must never be reported as real-gVisor or Chrome E2E PASS.
Production's original failure is still unconfirmed until a genuine run yields
usable evidence. Security remains `CREDENTIAL_EXPOSURE_UNREMEDIATED`.
