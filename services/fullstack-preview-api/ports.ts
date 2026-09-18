import type { BuildPlan, PreviewRequester } from "../../types/preview"
import type { BackendRuntimePlan } from "../../types/backendRuntime"
import type {
  FullStackPreview,
  QueuedFullStackPreview,
} from "../../types/fullstackPreview"

/**
 * Internal orchestration record. Every field beyond the public
 * `FullStackPreview` shape is either ownership/idempotency bookkeeping or a
 * nullable pointer to a child resource created by a *future* worker phase
 * -- never a network coordinate. In particular, `peerIp`/`dialTarget`-style
 * fields must NEVER be added here: the live backend dial target
 * (`services/backend-runtime-worker/liveRuntimeRegistry.ts`) is
 * process-local by design and must never become durable.
 */
export interface StoredFullStackPreview extends FullStackPreview {
  requesterId: string
  /** Set only once, at creation; compared against on every later create()
   * call using the same Idempotency-Key. */
  requestFingerprint: string
  /** Null until a future worker phase builds the paired frontend. */
  frontendJobId: string | null
  /** Null until a future worker phase publishes the paired frontend
   * artifact (which may itself be a build-cache hit reusing an artifact
   * another, unrelated preview also references -- see D-031). */
  artifactId: string | null
  /** Null until a future worker phase starts the paired backend runtime. */
  backendRuntimeId: string | null
}

/** Independently re-derives the frontend `BuildPlan` for the exact
 * requested repository/commit/sourceRoot -- the same authoritative port
 * `PreviewControlPlane` already uses (`services/preview-api/ports.ts`).
 * Reused here, never reimplemented. */
export interface FrontendPlanResolver {
  resolve(
    repository: {
      repositoryId: number
      owner: string
      name: string
      commitSha: string
    },
    contractVersion: string,
    target: { sourceRoot: string },
  ): Promise<BuildPlan | null>
}

/** Independently re-derives the `BackendRuntimePlan` for the exact
 * requested repository/commit -- the same authoritative port
 * `BackendRuntimeControlPlane` already uses
 * (`services/backend-runtime-api/ports.ts`). Reused here, never
 * reimplemented. */
export interface BackendPlanResolver {
  resolve(
    repository: {
      repositoryId: number
      owner: string
      name: string
      commitSha: string
    },
    sourceRootHint: string | undefined,
  ): Promise<BackendRuntimePlan | null>
}

export interface FullStackPreviewStore {
  get(previewId: string): Promise<StoredFullStackPreview | null>
  getByIdempotencyKey(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{
    requestFingerprint: string
    preview: StoredFullStackPreview
  } | null>
  /** Counts only non-terminal rows -- see the control plane's
   * `ACTIVE_STATUSES`. Used solely to enforce
   * `maxActiveFullStackPreviewsPerRequester`. */
  countActiveByRequester(requesterId: string): Promise<number>
  /** Inserts the resource row and its initial queue row atomically (or
   * returns the existing idempotent resource on a conflicting key) -- see
   * PostgresFullStackPreviewStore's doc comment for why this must never be
   * split into two separate calls. */
  createOrGet(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    preview: StoredFullStackPreview
  }): Promise<{
    created: boolean
    preview: StoredFullStackPreview
    enqueued?: boolean
  }>
  update(
    previewId: string,
    update: (current: StoredFullStackPreview) => StoredFullStackPreview,
  ): Promise<StoredFullStackPreview>
}

export interface FullStackPreviewQueue {
  enqueue(preview: QueuedFullStackPreview): Promise<void>
  cancel(previewId: string): Promise<void>
}

export interface FullStackPreviewQueueLease {
  preview: QueuedFullStackPreview
  attempts: number
}

export interface FullStackPreviewQueueConsumer {
  lease(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<FullStackPreviewQueueLease | null>
  acknowledge(
    previewId: string,
    workerId: string,
    attempt: number,
  ): Promise<boolean>
  release(
    previewId: string,
    workerId: string,
    availableAt: Date,
    attempt: number,
  ): Promise<boolean>
  renew(
    previewId: string,
    workerId: string,
    attempt: number,
    leaseMs: number,
  ): Promise<boolean>
}

export type { PreviewRequester }
