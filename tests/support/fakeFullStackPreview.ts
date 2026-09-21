import type { BackendRuntimePlan } from "../../types/backendRuntime"
import type { BuildPlan, PreviewRepositoryRef } from "../../types/preview"
import { FullStackPreviewControlError } from "../../services/fullstack-preview-api/errors"
import type {
  BackendPlanResolver,
  FrontendPlanResolver,
  FullStackPreviewQueue,
  FullStackPreviewStore,
  StoredFullStackPreview,
} from "../../services/fullstack-preview-api/ports"
import type { QueuedFullStackPreview } from "../../types/fullstackPreview"

export const repository: PreviewRepositoryRef = {
  repositoryId: 1,
  owner: "acme",
  name: "fullstack-fixture",
  commitSha: "a".repeat(40),
}

export const validFrontendPlan: BuildPlan = {
  contractVersion: "static-v2",
  repository,
  sourceRoot: "frontend",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

export const validBackendPlan: BackendRuntimePlan = {
  contractVersion: "backend-v1",
  repository,
  sourceRoot: "backend",
  adapterId: "express-node-npm-v1",
  packageManager: "npm",
  install: { command: "npm", args: ["ci", "--no-audit", "--no-fund"] },
  start: { command: "node", args: ["src/server.js"] },
  internalPort: 3000,
  platformEnvironment: {
    PORT: "3000",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
  },
}

const ACTIVE = new Set([
  "queued",
  "building_frontend",
  "starting_backend",
  "awaiting_activation",
  "ready",
  "stopping",
])

export class FakeFrontendPlanResolver implements FrontendPlanResolver {
  nextPlan: BuildPlan | null = validFrontendPlan
  readonly calls: Array<{
    repository: PreviewRepositoryRef
    contractVersion: string
    target: { sourceRoot: string }
  }> = []

  async resolve(
    repository: PreviewRepositoryRef,
    contractVersion: string,
    target: { sourceRoot: string },
  ): Promise<BuildPlan | null> {
    this.calls.push({ repository, contractVersion, target })
    return this.nextPlan
  }
}

export class FakeBackendPlanResolver implements BackendPlanResolver {
  nextPlan: BackendRuntimePlan | null = validBackendPlan
  readonly calls: Array<{
    repository: PreviewRepositoryRef
    sourceRootHint: string | undefined
  }> = []

  async resolve(
    repository: PreviewRepositoryRef,
    sourceRootHint: string | undefined,
  ): Promise<BackendRuntimePlan | null> {
    this.calls.push({ repository, sourceRootHint })
    return this.nextPlan
  }
}

export class FakeFullStackPreviewStore implements FullStackPreviewStore {
  private readonly byId = new Map<string, StoredFullStackPreview>()
  private readonly byKey = new Map<string, string>()
  readonly queuedPreviewIds: string[] = []

  async get(previewId: string): Promise<StoredFullStackPreview | null> {
    return this.byId.get(previewId) ?? null
  }

  async listAll(): Promise<StoredFullStackPreview[]> {
    return [...this.byId.values()].map((preview) => structuredClone(preview))
  }

  async getByIdempotencyKey(requesterId: string, idempotencyKey: string) {
    const id = this.byKey.get(`${requesterId}:${idempotencyKey}`)
    if (!id) return null
    const preview = this.byId.get(id)
    if (!preview) return null
    return { requestFingerprint: preview.requestFingerprint, preview }
  }

  async createOrGetWithCapacity(input: {
    requesterId: string
    idempotencyKey: string
    requestFingerprint: string
    preview: StoredFullStackPreview
    maxActive: number
  }) {
    if (!Number.isSafeInteger(input.maxActive) || input.maxActive < 1) {
      throw new FullStackPreviewControlError(
        "INTERNAL_ERROR",
        "The full-stack preview capacity limit is invalid.",
        500,
      )
    }

    const key = `${input.requesterId}:${input.idempotencyKey}`
    const existingId = this.byKey.get(key)
    if (existingId) {
      const existing = this.byId.get(existingId)!
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new FullStackPreviewControlError(
          "CONFLICT",
          "The idempotency key was already used for a different request.",
          409,
        )
      }
      return { created: false, preview: existing }
    }

    let activeCount = 0
    for (const preview of this.byId.values()) {
      if (
        preview.requesterId === input.requesterId &&
        ACTIVE.has(preview.status)
      ) {
        activeCount += 1
      }
    }
    if (activeCount >= input.maxActive) {
      throw new FullStackPreviewControlError(
        "RATE_LIMITED",
        "The active full-stack preview limit has been reached.",
        429,
        30,
      )
    }

    this.byId.set(input.preview.id, input.preview)
    this.byKey.set(key, input.preview.id)
    this.queuedPreviewIds.push(input.preview.id)
    return {
      created: true,
      preview: input.preview,
      enqueued: input.preview.status === "queued",
    }
  }

  async update(
    previewId: string,
    update: (current: StoredFullStackPreview) => StoredFullStackPreview,
  ): Promise<StoredFullStackPreview> {
    const current = this.byId.get(previewId)
    if (!current) {
      throw new FullStackPreviewControlError(
        "NOT_FOUND",
        "Full-stack preview not found.",
        404,
      )
    }
    const next = update(current)
    this.byId.set(previewId, next)
    return next
  }
}

export class FakeFullStackPreviewQueue implements FullStackPreviewQueue {
  readonly enqueued: QueuedFullStackPreview[] = []
  readonly cancelled: string[] = []
  shouldFailEnqueue = false

  async enqueue(preview: QueuedFullStackPreview): Promise<void> {
    if (this.shouldFailEnqueue) throw new Error("enqueue failed")
    this.enqueued.push(preview)
  }

  async cancel(previewId: string): Promise<void> {
    this.cancelled.push(previewId)
  }
}
