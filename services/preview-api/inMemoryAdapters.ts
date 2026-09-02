import type {
  PreviewArtifactReference,
  PreviewRequester,
  PreviewRepositoryRef,
  QueuedPreviewJob,
} from "../../types/preview"
import { PreviewControlError } from "./errors"
import type {
  PreviewArtifactCache,
  PreviewArtifactSigner,
  PreviewJobStore,
  PreviewQueue,
  PreviewQuota,
  StoredPreviewJob,
} from "./ports"

export class InMemoryPreviewJobStore implements PreviewJobStore {
  private readonly jobs = new Map<string, StoredPreviewJob>()
  private readonly idempotency = new Map<
    string,
    { requestFingerprint: string; jobId: string }
  >()

  async get(jobId: string): Promise<StoredPreviewJob | null> {
    return clone(this.jobs.get(jobId) ?? null)
  }

  async getByIdempotencyKey(
    requesterId: string,
    idempotencyKey: string,
  ): Promise<{
    requestFingerprint: string
    job: StoredPreviewJob
  } | null> {
    const entry = this.idempotency.get(
      createIdempotencyScope(requesterId, idempotencyKey),
    )

    if (!entry) {
      return null
    }

    const job = this.jobs.get(entry.jobId)
    return job
      ? { requestFingerprint: entry.requestFingerprint, job: clone(job) }
      : null
  }

  async createOrGet(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    job: StoredPreviewJob
  }): Promise<{ created: boolean; job: StoredPreviewJob }> {
    const scope = createIdempotencyScope(
      input.requesterId,
      input.idempotencyKey,
    )
    const existing = this.idempotency.get(scope)

    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new PreviewControlError(
          "CONFLICT",
          "The idempotency key was already used for a different request.",
          409,
        )
      }

      const existingJob = this.jobs.get(existing.jobId)

      if (!existingJob) {
        throw new PreviewControlError(
          "INTERNAL_ERROR",
          "Preview job persistence is inconsistent.",
          500,
        )
      }

      return { created: false, job: clone(existingJob) }
    }

    if (this.jobs.has(input.job.id)) {
      throw new PreviewControlError(
        "INTERNAL_ERROR",
        "Preview job id collision detected.",
        500,
      )
    }

    this.jobs.set(input.job.id, clone(input.job))
    this.idempotency.set(scope, {
      requestFingerprint: input.requestFingerprint,
      jobId: input.job.id,
    })

    return { created: true, job: clone(input.job) }
  }

  async update(
    jobId: string,
    update: (current: StoredPreviewJob) => StoredPreviewJob,
  ): Promise<StoredPreviewJob> {
    const current = this.jobs.get(jobId)

    if (!current) {
      throw new PreviewControlError("NOT_FOUND", "Preview job not found.", 404)
    }

    const updated = update(clone(current))
    this.jobs.set(jobId, clone(updated))
    return clone(updated)
  }
}

export class InMemoryPreviewQueue implements PreviewQueue {
  private readonly queued: QueuedPreviewJob[] = []
  private readonly cancelled = new Set<string>()

  async enqueue(job: QueuedPreviewJob): Promise<void> {
    if (!this.queued.some((queued) => queued.jobId === job.jobId)) {
      this.queued.push(clone(job))
    }
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId)
  }

  dequeue(): QueuedPreviewJob | null {
    while (this.queued.length > 0) {
      const job = this.queued.shift()

      if (job && !this.cancelled.has(job.jobId)) {
        return clone(job)
      }
    }

    return null
  }

  get size(): number {
    return this.queued.filter((job) => !this.cancelled.has(job.jobId)).length
  }
}

export class InMemoryPreviewArtifactCache implements PreviewArtifactCache {
  private readonly artifacts = new Map<
    string,
    { artifactId: string; expiresAt: number }
  >()

  async get(
    cacheKey: string,
    now: Date,
  ): Promise<{ artifactId: string; expiresAt: Date } | null> {
    const artifact = this.artifacts.get(cacheKey)

    if (!artifact || artifact.expiresAt <= now.getTime()) {
      this.artifacts.delete(cacheKey)
      return null
    }

    return {
      artifactId: artifact.artifactId,
      expiresAt: new Date(artifact.expiresAt),
    }
  }

  async put(
    cacheKey: string,
    artifactId: string,
    expiresAt: Date,
  ): Promise<void> {
    this.artifacts.set(cacheKey, {
      artifactId,
      expiresAt: expiresAt.getTime(),
    })
  }
}

export class HmacPreviewArtifactSigner implements PreviewArtifactSigner {
  private readonly previewDomain: string

  constructor(
    previewDomain: string,
    private readonly signingSecret: string,
  ) {
    this.previewDomain = normalizePreviewDomain(previewDomain)

    if (new TextEncoder().encode(signingSecret).byteLength < 32) {
      throw new Error("Artifact signing secret must be at least 32 bytes.")
    }
  }

  async sign(
    artifactId: string,
    jobId: string,
    expiresAt: Date,
  ): Promise<PreviewArtifactReference> {
    if (!/^[a-z\d-]{8,64}$/i.test(jobId)) {
      throw new Error("Job id cannot be used as a preview origin.")
    }

    if (!/^[a-z\d][a-z\d._-]{0,127}$/i.test(artifactId)) {
      throw new Error("Artifact id is invalid.")
    }

    const expires = Math.floor(expiresAt.getTime() / 1_000)
    const payload = `${jobId}:${artifactId}:${expires}`
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    )
    const encodedSignature = toBase64Url(new Uint8Array(signature))
    const path = [
      "artifacts",
      encodeURIComponent(artifactId),
      "expires",
      String(expires),
      "signature",
      encodedSignature,
      "",
    ].join("/")

    return {
      url: `https://${jobId.toLowerCase()}.${this.previewDomain}/${path}`,
      expiresAt: expiresAt.toISOString(),
    }
  }
}

export interface FixedWindowPreviewQuotaOptions {
  windowMs?: number
  perUser?: number
  perIp?: number
  perUserRepository?: number
}

export class FixedWindowPreviewQuota implements PreviewQuota {
  private readonly counters = new Map<
    string,
    { count: number; resetAt: number }
  >()
  private readonly windowMs: number
  private readonly perUser: number
  private readonly perIp: number
  private readonly perUserRepository: number

  constructor(options: FixedWindowPreviewQuotaOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000
    this.perUser = options.perUser ?? 10
    this.perIp = options.perIp ?? 30
    this.perUserRepository = options.perUserRepository ?? 5
  }

  async consume(
    requester: PreviewRequester,
    repository: PreviewRepositoryRef,
    now: Date,
  ): Promise<
    { allowed: true } | { allowed: false; retryAfterSeconds: number }
  > {
    const keys: Array<[string, number]> = [
      [`user:${requester.subject}`, this.perUser],
      [`ip:${requester.ip}`, this.perIp],
      [
        `repository:${requester.subject}:${repository.repositoryId}`,
        this.perUserRepository,
      ],
    ]
    const nowMs = now.getTime()

    for (const [key, limit] of keys) {
      const counter = this.getCounter(key, nowMs)

      if (counter.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((counter.resetAt - nowMs) / 1_000),
          ),
        }
      }
    }

    for (const [key] of keys) {
      this.getCounter(key, nowMs).count += 1
    }

    return { allowed: true }
  }

  private getCounter(
    key: string,
    nowMs: number,
  ): { count: number; resetAt: number } {
    const current = this.counters.get(key)

    if (!current || current.resetAt <= nowMs) {
      const fresh = { count: 0, resetAt: nowMs + this.windowMs }
      this.counters.set(key, fresh)
      return fresh
    }

    return current
  }
}

function createIdempotencyScope(
  requesterId: string,
  idempotencyKey: string,
): string {
  return `${requesterId}\u0000${idempotencyKey}`
}

function normalizePreviewDomain(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "")

  if (
    !normalized.includes(".") ||
    !/^[a-z\d.-]+$/.test(normalized) ||
    normalized === "localhost"
  ) {
    throw new Error("A separate registrable preview domain is required.")
  }

  return normalized
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
