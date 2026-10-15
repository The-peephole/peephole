# Backend failure diagnostics (D1)

Stage E adds correlated, pre-cleanup failure evidence without changing this
D1 completed record or public error codes. See
[Targeted runtime diagnostics](TARGETED_RUNTIME_DIAGNOSTICS.md) for the
substeps, bootstrap protocol, retention limits, and blocked Canary checklist.

## Existing failure path

The backend worker owns fetch, install, generated-secret/user-configuration
delivery, temporary database provisioning, sandbox startup, readiness and
running-process supervision. Its `finally` withdraws the route, discards
broker material, stops the process, destroys the workspace, revokes the
database and cleans extraction state before publishing terminal status.

The Fullstack supervisor intentionally reduces most terminal backend error
codes to `BACKEND_FAILED` (configuration-unavailable is preserved). It can
also report that code after a previously running backend exits or fails to
stop. The public message is not proof of a startup failure.

The existing legacy backend `errorCode` can be changed to
`DATABASE_UNAVAILABLE` by a later database revoke failure. D1 leaves that
public classification and all execution/ownership transitions unchanged.
Operators should use the new internal primary code to identify the original
execution failure, rather than the final public code.

## Internal record and event

`StoredBackendRuntime.diagnostics` starts at `null`. The worker records one
completed report after teardown attempts, without changing runtime status.
The first stored report wins, including for cancelled/expired runtimes.
Public runtime DTOs and HTTP routes exclude this record. There is no new API,
database table, migration, or client field.

| Field | Meaning |
| --- | --- |
| `failureStage` | Fixed stage of the first execution failure; `CLEANUP` for cleanup-only failure; `null` for a successful lifecycle |
| `primaryFailureCode` | Existing `BackendRuntimeErrorCode` for the original execution failure; `null` when there was none |
| `cleanupFailureCode` | Separate fixed cleanup result; `NONE` means the tracked teardown steps succeeded |

The allowlisted stages are `PLAN_VALIDATION`, `CAPABILITY_CHECK`,
`WORKSPACE_ALLOCATION`, `SOURCE_FETCH`, `DEPENDENCY_INSTALL`,
`ENTRYPOINT_VALIDATION`, `GENERATED_SECRET_DELIVERY`,
`USER_ENVIRONMENT_DELIVERY`, `DATABASE_PROVISIONING`, `RUNTIME_START`,
`READINESS`, `ROUTE_REGISTRATION`, `RUNTIME_MONITOR`, `CONTROL_PLANE`,
and `CLEANUP`.

Cleanup codes are `NONE`, `PROCESS_STOP_FAILED`, `WORKSPACE_DESTROY_FAILED`,
`DATABASE_REVOKE_FAILED`, `EXTRACTION_CLEANUP_FAILED`, and
`MULTIPLE_CLEANUP_FAILURES`. Multiple cleanup failures do not replace the
original execution stage/code. `primaryFailureCode` remains `null` when only
cleanup failed, even if the legacy public status becomes failed.

The existing production console sink emits a single JSON line tagged
`[peephole] backend runtime diagnostics` for execution or cleanup failures.
The event contains only the runtime identity and those three fields. It is
not forwarded to the sandbox or client. No event is logged for successful
lifecycles. This lets the existing server journal retain the fixed diagnosis
after the process-local runtime store is lost on restart, subject to normal
journal retention. D1 does not change retention or deploy anything.

## Security boundary

Before storing or emitting, the control plane validates every code against
the fixed lists (the primary list reuses the public safe-message keys), then
constructs a fresh object containing only the allowed fields. It does not
spread caller data, inspect error strings or serialize an exception. The
worker's phase wrapper no longer copies exception messages, and cleanup
collects fixed codes instead of exception objects.

Tests inject synthetic sensitive markers into message, stack, cause,
stdout/stderr and extra credential-like properties. They check serialization
of internal storage, public results and diagnostic events, reject unknown
codes, and ensure extra properties and custom `toJSON` are not copied.
Neither raw errors nor real credentials are test inputs.

The sink is synchronous and best-effort; sink exceptions and diagnostic
storage failures must not prevent resource cleanup or terminal reporting.

## Limits and follow-up validation

- Reports are completed snapshots, not a durable phase history. Process
  termination, teardown hangs, diagnostic storage/sink failure or journal
  loss can leave no completed report. `null` is not a cleanup success.
- `RUNTIME_START` covers file preparation, namespace/OCI setup and runsc
  launch together. D1 does not instrument bootstrap output or each internal
  process-starter operation. `READINESS` separates a timeout from an early
  exit using the existing error classification, without recording output.
- `NONE` covers stop/workspace/database/extraction teardown. Existing
  best-effort broker discard methods still suppress their own errors; this
  report does not assert successful broker bookkeeping or physical resource
  absence. Resource inventory and orphan-reaper checks remain necessary.
- Admission/queue failures and worker claims that fail before an execution
  starts retain their existing behavior; there is no completed worker report
  for those paths. No retrospective diagnosis of the rolled-back Canary is
  possible from this new code.
- Portable tests exercise fake process/DB dependencies, normal disabled
  capability paths, failure stages and cleanup ordering. They do not prove
  PostgreSQL authentication, Linux ownership/mounts, runsc execution or
  actual tenant network connectivity.

After code review, use an isolated disposable PostgreSQL 18 environment to
run the existing restricted-role provision/revoke and reaper tests. Then
verify a real Fullstack supervisor path with M10/M11/M12 together: provision,
three independent material files, backend readiness, harmless config/DB
checks, Stop and resource reclamation. Use a dedicated Linux environment
with isolated test rootfs/state/tmpfs/network and DB resources, not the
production host for the dedicated M12 harness. Repeat current-SHA lifecycle
and H2/H3 checks there. These integrations, production deployment and M12
activation are outside D1 and require their own authorized step.

Security status remains `CREDENTIAL_EXPOSURE_UNREMEDIATED`; D1 neither uses
nor rotates the previously exposed provisioning credential.
