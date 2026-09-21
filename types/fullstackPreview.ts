import type { PreviewRepositoryRef } from "./preview"

/**
 * `fullstack-v1` is a fully separate orchestration contract from
 * `static-v1`/`static-v2` (`types/preview.ts`) and `backend-v1`
 * (`types/backendRuntime.ts`). It never replaces either -- a
 * `FullStackPreview` only ever *pairs* one independently-authorized
 * frontend build with one independently-authorized backend runtime for the
 * exact same repository and commit. See docs/DECISIONS.md D-031 (M9).
 */
export const FULLSTACK_PREVIEW_CONTRACT_VERSION = "fullstack-v1"

export type FullStackPreviewStatus =
  | "queued"
  | "building_frontend"
  | "starting_backend"
  | "awaiting_activation"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "cancelled"
  | "expired"

export type FullStackPreviewErrorCode =
  | "UNSUPPORTED_FRONTEND"
  | "UNSUPPORTED_BACKEND"
  | "FRONTEND_FAILED"
  | "BACKEND_FAILED"
  | "PROVISIONING_TIMEOUT"
  | "ORCHESTRATION_UNAVAILABLE"

/**
 * Public, client-facing shape. Deliberately excludes every internal
 * orchestration/network identity -- see `StoredFullStackPreview`
 * (services/fullstack-preview-api/ports.ts) for the fields this never
 * exposes. `url` stays `null` until a future phase's routing/origin
 * activation exists; this phase never invents one.
 */
export interface FullStackPreview {
  id: string
  repository: PreviewRepositoryRef
  frontendSourceRoot: string
  backendSourceRoot: string
  status: FullStackPreviewStatus
  url: string | null
  errorCode: FullStackPreviewErrorCode | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

/**
 * The client may provide only exact source identity -- never an internal
 * id, a network target, or a hostname. See
 * services/fullstack-preview-api/controlPlane.ts for the independent,
 * server-side re-derivation of both the frontend `BuildPlan` and the
 * `BackendRuntimePlan` this request is checked against.
 */
export interface CreateFullStackPreviewRequest {
  contractVersion: typeof FULLSTACK_PREVIEW_CONTRACT_VERSION
  repository: PreviewRepositoryRef
  frontendTarget: {
    sourceRoot: string
  }
  backendSourceRoot: string
}

export type FullStackPreviewApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_FRONTEND"
  | "UNSUPPORTED_BACKEND"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_TRANSITION"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR"

/**
 * Durable queue payload -- stable server-side orchestration identity only.
 * Never a network target, client-supplied host, arbitrary command, or
 * generated env/secret. A future worker re-checks the authoritative stored
 * `FullStackPreview` row and uses the existing static/backend control
 * planes; this payload is never trusted as authorization by itself.
 */
export interface QueuedFullStackPreview {
  previewId: string
  repository: PreviewRepositoryRef
  frontendSourceRoot: string
  backendSourceRoot: string
}
