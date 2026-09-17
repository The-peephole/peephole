import type {
  BackendRuntime,
  BackendRuntimePlan,
  QueuedBackendRuntime,
} from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"

export interface StoredBackendRuntime extends BackendRuntime {
  requesterId: string
  plan: BackendRuntimePlan
  /** Identity fingerprint for idempotent active-runtime reuse -- see
   * `controlPlane.ts#create`. */
  fingerprint: string
}

/**
 * Independently re-derives a `BackendRuntimePlan` from the repository at
 * its exact requested commit -- never trusts a client-supplied plan. See
 * `githubRuntimePlanResolver.ts`.
 */
export interface BackendRuntimePlanResolver {
  resolve(
    repository: PreviewRepositoryRef,
    sourceRootHint: string | undefined,
  ): Promise<BackendRuntimePlan | null>
}

export interface BackendRuntimeStore {
  get(runtimeId: string): Promise<StoredBackendRuntime | null>
  /** Any non-terminal runtime for this requester+fingerprint -- the
   * idempotent "reuse the existing active runtime" path. */
  getActiveByFingerprint(
    requesterId: string,
    fingerprint: string,
  ): Promise<StoredBackendRuntime | null>
  countActiveByRequester(requesterId: string): Promise<number>
  create(runtime: StoredBackendRuntime): Promise<StoredBackendRuntime>
  update(
    runtimeId: string,
    update: (current: StoredBackendRuntime) => StoredBackendRuntime,
  ): Promise<StoredBackendRuntime>
}

export interface BackendRuntimeQueue {
  enqueue(job: QueuedBackendRuntime): Promise<void>
  cancel(runtimeId: string): Promise<void>
}

export interface BackendRuntimeQueueLease {
  job: QueuedBackendRuntime
  attempts: number
}

/** Deliberately shaped like `services/preview-api/ports.ts`'s
 * `PreviewQueueConsumer` so the same leasing/renewal discipline applies,
 * without sharing storage with the static artifact queue -- a backend
 * runtime is not cacheable output. */
export interface BackendRuntimeQueueConsumer {
  lease(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<BackendRuntimeQueueLease | null>
  acknowledge(
    runtimeId: string,
    workerId: string,
    attempt: number,
  ): Promise<boolean>
  release(
    runtimeId: string,
    workerId: string,
    availableAt: Date,
    attempt: number,
  ): Promise<boolean>
  renew(
    runtimeId: string,
    workerId: string,
    attempt: number,
    leaseMs: number,
  ): Promise<boolean>
}
