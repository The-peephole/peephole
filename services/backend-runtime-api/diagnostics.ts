import type { BackendRuntimeErrorCode } from "../../types/backendRuntime"

/** Internal only. Never copy an exception, process output or material into
 * this shape. RUNTIME_START covers the process-starter boundary, including
 * file delivery, namespace/OCI setup and sandbox launch. */
export const BACKEND_FAILURE_STAGES = [
  "PLAN_VALIDATION",
  "CAPABILITY_CHECK",
  "WORKSPACE_ALLOCATION",
  "SOURCE_FETCH",
  "DEPENDENCY_INSTALL",
  "ENTRYPOINT_VALIDATION",
  "GENERATED_SECRET_DELIVERY",
  "USER_ENVIRONMENT_DELIVERY",
  "DATABASE_PROVISIONING",
  "RUNTIME_START",
  "READINESS",
  "ROUTE_REGISTRATION",
  "RUNTIME_MONITOR",
  "CONTROL_PLANE",
  "CLEANUP",
] as const

export type BackendFailureStage = (typeof BACKEND_FAILURE_STAGES)[number]

export const BACKEND_CLEANUP_FAILURE_CODES = [
  "NONE",
  "PROCESS_STOP_FAILED",
  "WORKSPACE_DESTROY_FAILED",
  "DATABASE_REVOKE_FAILED",
  "EXTRACTION_CLEANUP_FAILED",
  "MULTIPLE_CLEANUP_FAILURES",
] as const

export type BackendCleanupFailureCode =
  (typeof BACKEND_CLEANUP_FAILURE_CODES)[number]

export interface BackendRuntimeDiagnostics {
  /** null on a successful lifecycle; CLEANUP for cleanup-only failure. */
  failureStage: BackendFailureStage | null
  /** First execution failure; never replaced by a cleanup failure. */
  primaryFailureCode: BackendRuntimeErrorCode | null
  /** NONE means tracked stop/workspace/DB/extraction teardown succeeded;
   * null diagnostics means no completed report. */
  cleanupFailureCode: BackendCleanupFailureCode
}

export interface BackendRuntimeDiagnosticEvent extends BackendRuntimeDiagnostics {
  runtimeId: string
}

/** Additive E evidence; the D1 completed record and public codes stay unchanged. */
export const BACKEND_FAILURE_STEPS = [
  "UNCLASSIFIED",
  "TENANT_DATABASE_PROVISIONING",
  "DATABASE_CREDENTIAL_ASSEMBLY",
  "MATERIAL_FILESYSTEM",
  "NAMESPACE_NETWORK",
  "OCI_PREPARATION",
  "RUNSC_EXECUTION_REJECTED",
  "RUNSC_EXIT_UNVERIFIED",
  "BOOTSTRAP_REPORTED_FAILURE",
  "APPLICATION_START_UNVERIFIED",
  "APPLICATION_REPORTED_EXIT",
  "TCP_READINESS",
  "CLEANUP",
] as const

export type BackendFailureStep = (typeof BACKEND_FAILURE_STEPS)[number]

export interface RuntimeFailureDetail {
  failureStep: BackendFailureStep
  /** Foreground runsc exit, not necessarily the application exit. */
  exitCode: number | null
  /** Observed starter rollback failure; false is not a resource inventory. */
  startupCleanupFailed: boolean
}

/** No exception/cause/output is retained at this boundary. */
export class RuntimeProcessFailure extends Error {
  constructor(
    readonly failureStep: BackendFailureStep,
    readonly exitCode: number | null = null,
    readonly startupCleanupFailed = false,
  ) {
    super("Backend runtime phase failed.")
    this.name = "RuntimeProcessFailure"
  }
}

// Sidecar metadata preserves existing internal Error/AggregateError contracts.
// Weak keys do not retain the exception; values contain fixed metadata only.
const runtimeDetails = new WeakMap<object, RuntimeFailureDetail>()

export function annotateRuntimeFailure(
  error: unknown,
  detail: RuntimeFailureDetail,
): unknown {
  const safe = projectDetail(detail)
  if (!safe) return error
  if (typeof error === "object" && error !== null) {
    runtimeDetails.set(error, safe)
    return error
  }
  return new RuntimeProcessFailure(
    safe.failureStep,
    safe.exitCode,
    safe.startupCleanupFailed,
  )
}

export function runtimeFailureDetail(
  error: unknown,
): RuntimeFailureDetail | undefined {
  try {
    const detail =
      error instanceof RuntimeProcessFailure
        ? error
        : typeof error === "object" && error !== null
          ? runtimeDetails.get(error)
          : undefined
    return projectDetail(detail)
  } catch {
    return undefined
  }
}

function projectDetail(
  detail: RuntimeFailureDetail | undefined,
): RuntimeFailureDetail | undefined {
  try {
    if (
      !detail ||
      !BACKEND_FAILURE_STEPS.includes(detail.failureStep) ||
      typeof detail.startupCleanupFailed !== "boolean"
    )
      return undefined
    return {
      failureStep: detail.failureStep,
      exitCode:
        Number.isInteger(detail.exitCode) &&
        detail.exitCode !== null &&
        detail.exitCode >= 0 &&
        detail.exitCode <= 255
          ? detail.exitCode
          : null,
      startupCleanupFailed: detail.startupCleanupFailed,
    }
  } catch {
    return undefined
  }
}

export interface BackendRuntimeFailureEvidence
  extends
    Omit<BackendRuntimeDiagnostics, "cleanupFailureCode">,
    RuntimeFailureDetail {
  kind: "primary_failure" | "cleanup_complete"
  runtimeId: string
  parentId: string | null
  resourceId: string | null
  elapsedMs: number
  /** null before supervisor teardown; NONE only after tracked attempts. */
  cleanupFailureCode: BackendCleanupFailureCode | null
}
