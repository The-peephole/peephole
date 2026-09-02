import type {
  BuildPlan,
  PreviewArtifactReference,
  PreviewJob,
  PreviewRequester,
  PreviewRepositoryRef,
  QueuedPreviewJob,
} from "../../types/preview"

export interface StoredPreviewJob extends PreviewJob {
  requesterId: string
}

export interface PreviewPlanResolver {
  resolve(
    repository: PreviewRepositoryRef,
    contractVersion: string,
  ): Promise<BuildPlan | null>
}

export interface PreviewJobStore {
  get(jobId: string): Promise<StoredPreviewJob | null>
  getByIdempotencyKey(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{ requestFingerprint: string; job: StoredPreviewJob } | null>
  createOrGet(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    job: StoredPreviewJob
  }): Promise<{ created: boolean; job: StoredPreviewJob }>
  update(
    jobId: string,
    update: (current: StoredPreviewJob) => StoredPreviewJob,
  ): Promise<StoredPreviewJob>
}

export interface PreviewQueue {
  enqueue(job: QueuedPreviewJob): Promise<void>
  cancel(jobId: string): Promise<void>
}

export interface PreviewQueueLease {
  job: QueuedPreviewJob
  attempts: number
}

export interface PreviewQueueConsumer {
  lease(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<PreviewQueueLease | null>
  acknowledge(jobId: string, workerId: string): Promise<boolean>
  release(jobId: string, workerId: string, availableAt: Date): Promise<boolean>
}

export interface PreviewArtifactCache {
  get(
    cacheKey: string,
    now: Date,
  ): Promise<{ artifactId: string; expiresAt: Date } | null>
  put(cacheKey: string, artifactId: string, expiresAt: Date): Promise<void>
}

export interface PreviewArtifactSigner {
  sign(
    artifactId: string,
    jobId: string,
    expiresAt: Date,
  ): Promise<PreviewArtifactReference>
}

export interface PreviewQuota {
  consume(
    requester: PreviewRequester,
    repository: PreviewRepositoryRef,
    now: Date,
  ): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>
}
