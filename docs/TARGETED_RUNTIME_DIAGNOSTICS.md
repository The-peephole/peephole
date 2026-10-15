# Targeted runtime diagnostics (D2B-4 Stage E)

Three production Canary failures reached temporary-database ownership INSERT,
then recorded `revoked` about one second later and parent `BACKEND_FAILED`.
The completed D1 report separates primary and cleanup errors but groups
material/network/OCI setup and cannot distinguish runsc, bootstrap, and app
exits before TCP readiness. Stage E adds bounded internal evidence at those
boundaries. It does not fix an established runtime cause or deploy anything.

## Compatibility and scope

- Existing `failureStage`, public backend/parent error codes, lifecycle,
  admission, ownership transitions, readiness policy, and completed D1 report
  remain unchanged. No public DTO, route, schema, database write, or feature
  flag is added.
- An optional observer carries fixed metadata from the process starter.
  Existing adapters without the observer/detail accessor keep working.
- The tenant provisioner optionally reports the ownership resource ID just
  after INSERT. This is diagnostic correlation only. The worker's separate
  revoke-ownership variable is still set only after `provision()` returns.
  A partial provisioning failure does not acquire normal worker revoke rights.
- Existing Error/AggregateError identities and internal causes are retained
  for compatibility. Fixed detail is projected through a weak sidecar; the
  original errors are never serialized into the new evidence.
- The bootstrap adds fixed stderr tokens, with no new arguments/environment
  variables. An old image still executes normally but lacks this evidence.
  A new image is required for the new bootstrap observations; none was built
  or installed during Stage E.

## Events and storage

The production `BackendRuntimeControlPlane.onFailureEvidence` sink sends a
JSON line tagged `[peephole] backend runtime failure evidence` via
`console.info`. Only this projection is emitted:

| Field | Meaning |
| --- | --- |
| kind | `primary_failure` or `cleanup_complete` |
| runtimeId | Backend runtime UUID |
| parentId | Fullstack parent ID, or null for standalone runtimes |
| resourceId | Observed ownership resource ID, or null before INSERT/with older adapters |
| elapsedMs | Integer monotonic milliseconds since this supervisor execution began; not a phase duration |
| failureStage | Existing D1 coarse stage |
| primaryFailureCode | Original fixed execution code; null for cleanup-only failure |
| cleanupFailureCode | null before supervisor teardown; a D1 cleanup code after tracked attempts |
| failureStep | Fixed substep from the table below |
| exitCode | Foreground runsc exit in 0..255, or null; not independently proof of an app exit |
| startupCleanupFailed | Whether starter-owned rollback was observed to fail; false is not a resource inventory |

The first primary observation wins for this supervisor execution. A completed
event retains that primary and adds the cleanup result. A later database
revoke failure may still change the legacy public error, but cannot replace
the first evidence. Existing D1 completed-report semantics are separate.

Evidence bypasses the runtime store and is not placed in PostgreSQL, queue
payloads, plans, files, or public responses. The completed D1 report remains
in the process-local runtime store. The production retention path for new
evidence is therefore console -> service stdout capture -> journal/collector.
Only code wiring and portable sink invocation were verified here. Actual
production capture, flush, journal retention, and restart survival remain
**UNVERIFIED**.

## Failure boundaries

| failureStep | Observation and limit |
| --- | --- |
| TENANT_DATABASE_PROVISIONING | Tenant operation rejected; resource ID is available if ownership INSERT completed. Does not identify the individual SQL statement. |
| DATABASE_CREDENTIAL_ASSEMBLY | Provisioning returned, then URL/material identity assembly failed. No URL or object name is logged. |
| MATERIAL_FILESYSTEM | Failure while preparing M10/M11/M12 files, including their validation/tmpfs/permissions. Does not identify which file or syscall. |
| NAMESPACE_NETWORK | Ingress namespace, tenant-access network or lease setup rejected. No peer address is logged. |
| OCI_PREPARATION | OCI spec construction, config.json write, or container registration failed. This is preparation, not actual mount application. |
| RUNSC_EXECUTION_REJECTED | The host process-runner call threw/rejected. Does not claim a particular OS errno or whether a late runner failure followed spawn. |
| RUNSC_EXIT_UNVERIFIED | Foreground runsc exited with no usable bootstrap protocol, including old images, truncation and plain-node runs. Actual mount/start vs unobserved bootstrap/app remains unresolved. |
| BOOTSTRAP_REPORTED_FAILURE | First complete protocol outcome reports pre-app bootstrap failure. A sandbox report, not independent root-cause attestation. |
| APPLICATION_START_UNVERIFIED | Bootstrap ready was observed, but no application-started token. Spawn/requested startup and missing/truncated evidence cannot be distinguished. |
| APPLICATION_REPORTED_EXIT | Ordered ready -> application-started tokens preceded foreground exit. The coarse stage separates pre-readiness from runtime-monitor exit. Does not prove why it exited. |
| TCP_READINESS | Existing TCP deadline elapsed. No HTTP or database-query success is implied. |
| CLEANUP | Cleanup-only failure; no invented primary code. Individual outer cleanup category remains in cleanupFailureCode. |
| UNCLASSIFIED | No trusted typed detail at that boundary; never infer a cause from an exception message. |

Actual OCI bind-mount application happens inside runsc. Preparing its spec
is distinguishable, but mount failure inside runsc remains unresolved if no
bootstrap outcome is observed. Exit code 1 alone cannot identify bootstrap,
runsc, or application failure. Numeric exit is never promoted to a cause.

## When evidence is called

1. Material/network/OCI preparation failure: the starter calls its observer
   before its own credential rollback. The observer does not receive an Error.
2. Foreground runsc exit/rejection: the observer runs before the automatic
   container/credential cleanup continuation. Requested Stop is excluded.
3. Other returned execution failures, including provisioning/readiness:
   the supervisor emits before route withdrawal and outer teardown.
4. After process/workspace/DB/extraction cleanup attempts: a completed event
   is emitted before awaiting the completed D1 store write and terminal status.

The early event uses cleanupFailureCode=null, not NONE. Cleanup has not yet
completed. A cleanup-only error is reported after attempts, with primary=null.
Normal successful Stop does not generate failure evidence. A concurrent
lifecycle stop can race with a real exit observation; the observation does
not independently prove which actor requested termination.

Synchronous sink throws and rejected/pending async sink promises are isolated
and never awaited. A truly blocking synchronous sink cannot be interrupted by
try/catch. Failures are best-effort and are not retried automatically. If the
sink fails, neither the caller nor a completed record proves delivery.

Forced process termination before callback delivery can lose evidence. An
operation or its nested filesystem/network rollback may hang before it
returns a failure to the instrumented boundary. In that case no primary
observation is promised. The early event can survive a later outer/starter
cleanup hang only if the external sink has actually retained it. This is not
a durable phase history or a crash-safe local write-ahead log.

## Bootstrap protocol and trust

The standalone immutable bootstrap uses synchronous writes of exactly:

```text
[peephole-bootstrap-v1] ready
[peephole-bootstrap-v1] application-started
[peephole-bootstrap-v1] failed
```

`ready` is emitted after material reads/validation and before spawning
repository code. `application-started` follows the child's spawn event.
The standalone catch emits `failed`; after a ready token this cannot be
reinterpreted as pre-app bootstrap failure. The host accepts only complete,
exact lines and ordered outcomes. Values, exception strings, user output and
arbitrary fields are discarded. The generic legacy stderr failure text is
not evidence of the new protocol.

These are **reported observations**, not authenticated host telemetry. The
interpretation assumes the reviewed bootstrap bytes in a read-only image
and successful delivery of the initial token. Old/custom images, missing
writes/truncation, and hostile output without an initial trusted token can
spoof or obscure reported tokens. An app's forged `failed` after a delivered
`ready` cannot overwrite the earlier outcome, which is tested. This is not a
claim that all adversarial provenance is solved. Before a Canary, verify
image identity and keep REPORTED/UNVERIFIED labels in the final assessment.

No raw stderr/stdout is added to the journal. The existing bounded process
buffer is consumed locally for fixed tokens only. Errors, stacks, causes,
credentials, URLs, environment values/hashes, authorization, and extra
properties/custom toJSON never enter the projected event. Event identifiers,
enums, booleans and numeric fields are checked before invoking the sink.
This validates the new evidence path, not every pre-existing console.error
path elsewhere in production.

## Portable validation

Tests cover provisioning and partial-INSERT correlation without revoke
rights; URL assembly; material/network/OCI failure; synchronous runner throw
and async rejection; bootstrap/app reported exit and absent/out-of-order/
forged tokens; TCP timeout; first primary plus cleanup failure; cleanup-only
failure; evidence before starter/automatic/outer teardown; cleanup hang;
throwing/rejecting/pending sinks; invalid metadata and synthetic non-leakage;
and the existing D1 regression cases.

A synthetic local Node child verifies bootstrap token order and app exit.
This does not execute gVisor, bind mounts, Linux UID/tmpfs policy, production
PostgreSQL or an actual production journal. Do not count portable PASS as
real-gVisor verification.

## Canary readiness: BLOCKED

Stage E authorizes local changes/tests and an unmerged PR only. Before any
additional production work, obtain explicit approval for these concrete
operations after their procedures are reviewed:

1. Review/merge this PR and pin the actual approved 40-character deployment
   commit (not a mutable branch, or an assumed pre-merge SHA). Verify checks
   at that commit. No automatic merge is requested.
2. If required, isolated real Linux/gVisor validation and its resources; then
   approved production deployment/rootfs preparation and a scoped restart.
   Pin bootstrap/rootfs identity to reviewed bytes. No such validation or
   host/resource creation was performed here.
3. Approved bounded read-only verification of the real logging sink and
   retention, with an allowlisted local collector/export before restart.
   Do not dump raw journal or secrets. Add a reviewed parent-specific
   metadata lookup only if correlation is otherwise unavailable; the old
   Stage C SQL is tied to past timestamps/three parents and is not reusable.
4. Capture a current idle baseline and an approved stable rollback manifest:
   exact source SHA, rootfs identity, M12 OFF configuration and existing
   service settings. Historical 87d691e is not a fresh live-state check.
   No schema migration is needed for this PR; an old image remains compatible
   but gives less diagnostic evidence. Actual rollback is untested here.
5. Approve exactly one ordinary fullstack Canary at fixture
   90afaa0c3f650744300afc5d8fed00fd4a0ef5c8, explicit frontend/backend targets,
   intended harmless public configuration, fixed extension build and known
   operator. Record request time/IDs without body values or tokens.
6. Approve the specific M12 activation, bounded observation, ordinary Stop,
   ownership-aware reclamation and rollback procedure, without PG/Caddy
   restarts, credential changes, or automatic second Preview attempts.

Collect the first primary event, correlated parent/runtime/resource IDs,
completed cleanup event or its explicit absence, numeric exit and monotonic
elapsed metadata, fixed source/image/fixture identities, safe readiness/
config/DB booleans and Stop/resource inventory outcome. Record missing
evidence as UNVERIFIED. A failed parent without evidence is not “no error.”

Abort before creation on mismatched identity, readiness/observability failure
or unexpected baseline resources. On one Canary failure or the agreed
deadline, do not retry; capture bounded safe evidence and follow the approved
Stop/M12 OFF/rootfs rollback procedure. Do not postpone urgent protection to
wait for diagnostics. No source deployment, image build, production
connection, flag/service/database/AWS change or Canary is authorized by this
document or the portable tests.
