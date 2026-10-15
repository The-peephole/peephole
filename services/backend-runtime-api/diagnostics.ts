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
