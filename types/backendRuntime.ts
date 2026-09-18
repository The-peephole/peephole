import type { PreviewRepositoryRef } from "./preview"

/**
 * `backend-v1` is a fully separate execution contract from
 * `static-v1`/`static-v2` (`types/preview.ts`). A `BackendRuntimePlan`
 * describes a bounded, non-cacheable, short-lived process, never a static
 * build output. See `docs/PREVIEW_RUNTIME.md` for the full rationale.
 */
export const BACKEND_RUNTIME_CONTRACT_VERSION = "backend-v1"

/** The only backend execution adapter implemented so far. */
export type BackendRuntimeAdapterId = "express-node-npm-v1"

export interface BackendRuntimePlan {
  contractVersion: typeof BACKEND_RUNTIME_CONTRACT_VERSION
  repository: PreviewRepositoryRef
  sourceRoot: string
  adapterId: BackendRuntimeAdapterId
  packageManager: "npm"
  install: {
    command: "npm"
    args: readonly string[]
  }
  start: {
    command: "node"
    /** Exactly one element: the safe, structurally-derived entrypoint path. */
    args: readonly [string]
  }
  /** Internal-namespace port only; never published as a public endpoint. */
  internalPort: number
  /**
   * The only values ever placed in the runtime process's environment.
   * Never a user/repository-declared value -- see
   * `core/analyzer/backendRuntimeAdapter.ts` module docs.
   */
  platformEnvironment: {
    PORT: string
    HOST: string
    NODE_ENV: string
  }
}

export type BackendRuntimeStatus =
  | "queued"
  | "fetching"
  | "installing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "cancelled"
  | "expired"

export type BackendRuntimeErrorCode =
  | "FETCH_FAILED"
  | "UNSUPPORTED_BACKEND"
  | "INSTALL_FAILED"
  | "RUNTIME_START_FAILED"
  | "RUNTIME_READINESS_TIMEOUT"
  | "RUNTIME_EXITED"
  | "RUNTIME_TIMEOUT"
  | "RUNTIME_DISK_LIMIT"
  | "RUNTIME_UNAVAILABLE"

/**
 * Public, client-facing shape. Deliberately has no URL/hostname field of any
 * kind -- see docs/PREVIEW_RUNTIME.md "No public backend URL yet". Raw
 * process output is never included (may contain secret-like content).
 */
export interface BackendRuntime {
  id: string
  repository: PreviewRepositoryRef
  sourceRoot: string
  adapterId: BackendRuntimeAdapterId
  status: BackendRuntimeStatus
  errorCode: BackendRuntimeErrorCode | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export interface CreateBackendRuntimeRequest {
  repository: PreviewRepositoryRef
  contractVersion: typeof BACKEND_RUNTIME_CONTRACT_VERSION
  /** A hint only -- the server independently re-resolves the candidate at
   * the exact commit and never trusts this as authorization. */
  sourceRoot?: string
}

export type BackendRuntimeApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_BACKEND"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_TRANSITION"
  | "INTERNAL_ERROR"

export interface QueuedBackendRuntime {
  runtimeId: string
  repository: PreviewRepositoryRef
  plan: BackendRuntimePlan
}

/**
 * Client-side, best-effort execution-support signal derived from M7
 * evidence -- never authorization. The server independently re-resolves a
 * `BackendRuntimePlan` from a fresh exact-commit read before ever starting
 * anything (see `core/analyzer/backendRuntimeAdapter.ts`).
 */
export interface BackendExecutionSupport {
  supported: boolean
  adapterId: BackendRuntimeAdapterId | null
  /** Human-readable reasons the candidate is/isn't supported. */
  evidence: string[]
}
