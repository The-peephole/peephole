import { describe, expect, it, vi } from "vitest"

import { createBuildCacheKey } from "../core/preview/buildPlan"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import type { PreviewArtifactCache } from "../services/preview-api/ports"
import {
  FullStackPreviewSupervisor,
  frontendIdempotencyKey,
} from "../services/fullstack-preview-worker/fullStackPreviewSupervisor"
import {
  FakeBackendPlanResolver,
  FakeFrontendPlanResolver,
  FakeFullStackPreviewQueue,
  FakeFullStackPreviewStore,
  repository,
  validBackendPlan,
  validFrontendPlan,
} from "./support/fakeFullStackPreview"

const requester = { subject: "user-1", ip: "203.0.113.10" }
const previewId = "fullstack-00000000-0000-0000-0000-000000000001"

function createHarness(options: { artifacts?: PreviewArtifactCache } = {}) {
  let staticQuotaCalls = 0
  let fullStackQuotaCalls = 0
  let staticSequence = 0
  let backendSequence = 0
  const fullStackStore = new FakeFullStackPreviewStore()
  const fullStackQueue = new FakeFullStackPreviewQueue()
  const fullStack = new FullStackPreviewControlPlane(
    new FakeFrontendPlanResolver(),
    new FakeBackendPlanResolver(),
    fullStackStore,
    fullStackQueue,
    {
      consume: async () => {
        fullStackQuotaCalls += 1
        return { allowed: true as const }
      },
    },
    {
      createId: () => previewId,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    },
  )
  const frontendStore = new InMemoryPreviewJobStore()
  const frontendQueue = new InMemoryPreviewQueue()
  const artifacts = options.artifacts ?? new InMemoryPreviewArtifactCache()
  const frontend = new PreviewControlPlane(
    { resolve: vi.fn().mockResolvedValue(validFrontendPlan) },
    frontendStore,
    frontendQueue,
    artifacts,
    {
      sign: async (_artifactId, jobId, expiresAt) => ({
        // Deliberately unrelated to the artifact id. The orchestrator must
        // resolve authority from cacheKey, never this URL.
        url: `https://${jobId}.invalid/not-an-artifact-identity`,
        expiresAt: expiresAt.toISOString(),
      }),
    },
    {
      consume: async () => {
        staticQuotaCalls += 1
        return { allowed: true as const }
      },
    },
    {
      runnerVersion: "runner-v1",
      createId: () => `frontend-job-${++staticSequence}`,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    },
  )
  const backendStore = new InMemoryBackendRuntimeStore()
  const backendQueue = new InMemoryBackendRuntimeQueue()
  const backend = new BackendRuntimeControlPlane(
    { resolve: vi.fn().mockResolvedValue(validBackendPlan) },
    backendStore,
    backendQueue,
    {
      maxActiveRuntimesPerRequester: 4,
      createId: () => `backend-runtime-${++backendSequence}`,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    },
  )

  const createParent = async () =>
    fullStack.create(
      {
        contractVersion: "fullstack-v1",
        repository,
        frontendTarget: { sourceRoot: "frontend" },
        backendSourceRoot: "backend",
      },
      "request-key-0123456789abcdef",
      requester,
    )
  const queued = {
    previewId,
    repository,
    frontendSourceRoot: "frontend",
    backendSourceRoot: "backend",
  }

  return {
    fullStack,
    fullStackStore,
    fullStackQueue,
    frontend,
    frontendStore,
    frontendQueue,
    artifacts,
    backend,
    backendStore,
    backendQueue,
    createParent,
    queued,
    quotaCalls: () => ({ staticQuotaCalls, fullStackQuotaCalls }),
  }
}

async function completeFrontendAndBackend(
  harness: ReturnType<typeof createHarness>,
  cancelOnAwaiting = true,
) {
  const parent = await harness.fullStackStore.get(previewId)
  if (parent?.status === "building_frontend" && parent.frontendJobId) {
    const job = await harness.frontend.getForOrchestration(
      parent.frontendJobId,
      requester.subject,
    )
    if (job.status === "queued") {
      await harness.frontend.startWorkerJob(job.id)
      await harness.frontend.markPhase(job.id, "publishing")
      await harness.frontend.complete(job.id, "authoritative-artifact")
    }
  }
  if (parent?.status === "starting_backend" && parent.backendRuntimeId) {
    const runtime = await harness.backend.getForOrchestration(
      parent.backendRuntimeId,
      requester.subject,
    )
    if (runtime.status === "queued") {
      await harness.backend.startWorkerRuntime(runtime.id)
      await harness.backend.markPhase(runtime.id, "installing")
      await harness.backend.markPhase(runtime.id, "starting")
      await harness.backend.markPhase(runtime.id, "running")
    }
  }
  if (parent?.status === "awaiting_activation" && cancelOnAwaiting) {
    await harness.fullStack.cancel(previewId, requester)
  }
}

describe("FullStackPreviewSupervisor", () => {
  it("runs fresh children to awaiting_activation, records ids early, and never reaches ready", async () => {
    const harness = createHarness()
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      { wait: async () => completeFrontendAndBackend(harness) },
    )

    await supervisor.run(harness.queued)

    const parent = await harness.fullStackStore.get(previewId)
    expect(parent).toMatchObject({
      status: "cancelled",
      frontendJobId: "frontend-job-1",
      artifactId: "authoritative-artifact",
      backendRuntimeId: "backend-runtime-1",
      url: null,
    })
    expect(parent?.status).not.toBe("ready")
    expect(harness.quotaCalls()).toEqual({
      fullStackQuotaCalls: 1,
      staticQuotaCalls: 0,
    })
    expect(frontendIdempotencyKey(previewId)).toBe(
      `${"fullstack:"}${previewId}:frontend`,
    )
    expect(JSON.stringify(parent)).not.toContain(requester.ip)
    expect(JSON.stringify(harness.queued)).not.toContain(requester.ip)
  })

  it("uses a static cache hit without queueing another build", async () => {
    const harness = createHarness()
    const cacheKey = await createBuildCacheKey(validFrontendPlan, "runner-v1")
    await harness.artifacts.put(
      cacheKey,
      "cached-authoritative-artifact",
      new Date("2099-01-01T00:30:00.000Z"),
    )
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      { wait: async () => completeFrontendAndBackend(harness) },
    )

    await supervisor.run(harness.queued)

    expect(harness.frontendQueue.size).toBe(0)
    expect((await harness.fullStackStore.get(previewId))?.artifactId).toBe(
      "cached-authoritative-artifact",
    )
  })

  it("safely retries a reclaimed delivery whose parent is still queued", async () => {
    const harness = createHarness()
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      { wait: async () => completeFrontendAndBackend(harness) },
    )

    await supervisor.run(harness.queued, { recovered: true })

    expect(await harness.fullStackStore.get(previewId)).toMatchObject({
      status: "cancelled",
      frontendJobId: "frontend-job-1",
      backendRuntimeId: "backend-runtime-1",
    })
  })

  it("rejects a mismatched queue payload before creating children", async () => {
    const harness = createHarness()
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
    )
    await supervisor.run({ ...harness.queued, backendSourceRoot: "tampered" })

    expect(await harness.fullStackStore.get(previewId)).toMatchObject({
      status: "failed",
      errorCode: "ORCHESTRATION_UNAVAILABLE",
      frontendJobId: null,
      backendRuntimeId: null,
    })
    expect(harness.frontendQueue.size).toBe(0)
  })

  it("cancels an active frontend and never creates a backend when the parent is cancelled", async () => {
    const harness = createHarness()
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      {
        wait: async () => {
          await harness.fullStack.cancel(previewId, requester)
        },
      },
    )
    await supervisor.run(harness.queued)

    const parent = await harness.fullStackStore.get(previewId)
    expect(parent?.backendRuntimeId).toBeNull()
    expect(
      (
        await harness.frontend.getForOrchestration(
          parent!.frontendJobId!,
          requester.subject,
        )
      ).status,
    ).toBe("cancelled")
  })

  it("cancels a created backend when cancellation arrives during backend startup", async () => {
    const harness = createHarness()
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      {
        wait: async () => {
          const parent = await harness.fullStackStore.get(previewId)
          if (parent?.status === "building_frontend") {
            await completeFrontendAndBackend(harness, false)
          } else if (
            parent?.status === "starting_backend" &&
            parent.backendRuntimeId
          ) {
            await harness.fullStack.cancel(previewId, requester)
          }
        },
      },
    )
    await supervisor.run(harness.queued)

    const parent = await harness.fullStackStore.get(previewId)
    expect(parent?.status).toBe("cancelled")
    expect(
      (
        await harness.backend.getForOrchestration(
          parent!.backendRuntimeId!,
          requester.subject,
        )
      ).status,
    ).toBe("cancelled")
  })

  it("cleans up a backend and fails safely after an infrastructure exception", async () => {
    const harness = createHarness()
    await harness.createParent()
    const failure = new Error("simulated control-plane outage")
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      {
        wait: async () => {
          const parent = await harness.fullStackStore.get(previewId)
          if (parent?.status === "building_frontend") {
            await completeFrontendAndBackend(harness, false)
          } else if (parent?.backendRuntimeId) {
            throw failure
          }
        },
      },
    )
    await expect(supervisor.run(harness.queued)).rejects.toBe(failure)

    const parent = await harness.fullStackStore.get(previewId)
    expect(parent).toMatchObject({
      status: "failed",
      errorCode: "ORCHESTRATION_UNAVAILABLE",
    })
    expect(
      (
        await harness.backend.getForOrchestration(
          parent!.backendRuntimeId!,
          requester.subject,
        )
      ).status,
    ).toBe("cancelled")
  })

  it("maps frontend and backend child failures to safe parent errors", async () => {
    const frontendHarness = createHarness()
    await frontendHarness.createParent()
    const frontendSupervisor = new FullStackPreviewSupervisor(
      frontendHarness.fullStack,
      frontendHarness.frontend,
      frontendHarness.artifacts,
      frontendHarness.backend,
      {
        wait: async () => {
          const parent = await frontendHarness.fullStackStore.get(previewId)
          if (parent?.frontendJobId) {
            await frontendHarness.frontend.failWorkerJob(
              parent.frontendJobId,
              "BUILD_FAILED",
            )
          }
        },
      },
    )
    await frontendSupervisor.run(frontendHarness.queued)
    expect(await frontendHarness.fullStackStore.get(previewId)).toMatchObject({
      status: "failed",
      errorCode: "FRONTEND_FAILED",
    })

    const backendHarness = createHarness()
    await backendHarness.createParent()
    const backendSupervisor = new FullStackPreviewSupervisor(
      backendHarness.fullStack,
      backendHarness.frontend,
      backendHarness.artifacts,
      backendHarness.backend,
      {
        wait: async () => {
          await completeFrontendAndBackend(backendHarness, false)
          const parent = await backendHarness.fullStackStore.get(previewId)
          if (
            parent?.status === "starting_backend" &&
            parent.backendRuntimeId
          ) {
            await backendHarness.backend.failWorkerRuntime(
              parent.backendRuntimeId,
              "RUNTIME_START_FAILED",
            )
          }
        },
      },
    )
    await backendSupervisor.run(backendHarness.queued)
    expect(await backendHarness.fullStackStore.get(previewId)).toMatchObject({
      status: "failed",
      errorCode: "BACKEND_FAILED",
    })
  })

  it("fails closed when the authoritative artifact cache entry is missing", async () => {
    class VanishingCache extends InMemoryPreviewArtifactCache {
      private published = false
      override async get(cacheKey: string, now: Date) {
        return this.published ? null : super.get(cacheKey, now)
      }
      override async put(
        cacheKey: string,
        artifactId: string,
        expiresAt: Date,
      ) {
        await super.put(cacheKey, artifactId, expiresAt)
        this.published = true
      }
    }
    const harness = createHarness({ artifacts: new VanishingCache() })
    await harness.createParent()
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
      { wait: async () => completeFrontendAndBackend(harness, false) },
    )
    await supervisor.run(harness.queued)

    expect(await harness.fullStackStore.get(previewId)).toMatchObject({
      status: "failed",
      errorCode: "FRONTEND_FAILED",
      artifactId: null,
      backendRuntimeId: null,
    })
  })

  it("reclaimed partial orchestration cancels recorded children and fails closed", async () => {
    const harness = createHarness()
    await harness.createParent()
    await harness.fullStack.startWorkerFullStackPreview(previewId)
    const child = await harness.frontend.createForOrchestration(
      {
        repository,
        contractVersion: "static-v2",
        target: { sourceRoot: "frontend" },
      },
      frontendIdempotencyKey(previewId),
      requester.subject,
    )
    await harness.fullStack.recordFrontendJob(previewId, child.job.id)
    const supervisor = new FullStackPreviewSupervisor(
      harness.fullStack,
      harness.frontend,
      harness.artifacts,
      harness.backend,
    )

    await supervisor.run(harness.queued, { recovered: true })

    expect(await harness.fullStackStore.get(previewId)).toMatchObject({
      status: "failed",
      errorCode: "ORCHESTRATION_UNAVAILABLE",
      frontendJobId: child.job.id,
    })
    expect(
      (
        await harness.frontend.getForOrchestration(
          child.job.id,
          requester.subject,
        )
      ).status,
    ).toBe("cancelled")
  })
})
