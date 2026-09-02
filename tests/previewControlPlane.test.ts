import { describe, expect, it, vi } from "vitest"

import { FakePreviewRunner } from "../services/preview-api/fakeRunner"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import type { PreviewPlanResolver } from "../services/preview-api/ports"
import type {
  BuildPlan,
  CreatePreviewJobRequest,
  PreviewRequester,
} from "../types/preview"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
}

const plan: BuildPlan = {
  contractVersion: "static-v1",
  repository,
  sourceRoot: ".",
  packageManager: "npm",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDirectory: "dist",
}

const request: CreatePreviewJobRequest = {
  repository,
  contractVersion: "static-v1",
}

const requester: PreviewRequester = {
  subject: "user-1",
  ip: "203.0.113.10",
}

describe("PreviewControlPlane", () => {
  it("creates one commit-pinned queued job idempotently", async () => {
    const harness = createHarness()

    const first = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )
    const second = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )

    expect(first).toMatchObject({
      created: true,
      job: {
        status: "queued",
        cacheStatus: "miss",
        repository,
        plan,
      },
    })
    expect(second.created).toBe(false)
    expect(second.job.id).toBe(first.job.id)
    expect(harness.queue.size).toBe(1)
    expect(harness.resolve).toHaveBeenCalledTimes(1)
    expect(first.job).not.toHaveProperty("requesterId")
  })

  it("rejects reuse of an idempotency key for another commit", async () => {
    const harness = createHarness()
    await harness.control.create(request, "request-0000000001", requester)

    await expect(
      harness.control.create(
        {
          ...request,
          repository: {
            ...repository,
            commitSha: "abcdef0123456789abcdef0123456789abcdef01",
          },
        },
        "request-0000000001",
        requester,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("runs the complete lifecycle through a fake runner and caches artifacts", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )
    const runner = new FakePreviewRunner(harness.queue, harness.control)

    await expect(
      runner.runNext({ status: "ready", artifactId: "artifact-1" }),
    ).resolves.toBe(created.job.id)

    const ready = await harness.control.get(created.job.id, requester)
    expect(ready).toMatchObject({ status: "ready", cacheStatus: "miss" })
    expect(ready.artifact?.url).toMatch(
      new RegExp(`^https://${created.job.id}\\.peephole\\.run/artifacts/`),
    )
    expect(ready.artifact?.url).not.toContain("?")

    const cached = await harness.control.create(
      request,
      "request-0000000002",
      requester,
    )
    expect(cached).toMatchObject({
      created: true,
      job: { status: "ready", cacheStatus: "hit" },
    })
    expect(cached.job.id).not.toBe(created.job.id)
    expect(harness.queue.size).toBe(0)
  })

  it("cancels active work and ignores duplicate cancellation", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )

    await expect(
      harness.control.cancel(created.job.id, requester),
    ).resolves.toMatchObject({ status: "cancelled" })
    await expect(
      harness.control.cancel(created.job.id, requester),
    ).resolves.toMatchObject({ status: "cancelled" })
    expect(harness.queue.dequeue()).toBeNull()
  })

  it("enforces ownership and valid worker transitions", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )

    await expect(
      harness.control.get(created.job.id, {
        subject: "user-2",
        ip: requester.ip,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
    await expect(
      harness.control.markPhase(created.job.id, "building"),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })

  it("exposes stable sanitized runner failures", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )
    const runner = new FakePreviewRunner(harness.queue, harness.control)

    await runner.runNext({ status: "failed", errorCode: "BUILD_FAILED" })

    await expect(
      harness.control.get(created.job.id, requester),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "BUILD_FAILED",
      errorMessage: "The static build did not complete successfully.",
    })
  })

  it("times out active jobs and expires terminal jobs", async () => {
    const harness = createHarness({ jobTimeoutMs: 1_000 })
    const created = await harness.control.create(
      request,
      "request-0000000001",
      requester,
    )
    harness.advance(1_001)

    await expect(
      harness.control.get(created.job.id, requester),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "RUNNER_TIMEOUT",
    })
    await expect(
      harness.control.get(created.job.id, requester),
    ).resolves.toMatchObject({ status: "expired", artifact: null })
  })

  it("enforces requester, IP, and repository quotas", async () => {
    const harness = createHarness({ perUserRepository: 1 })
    await harness.control.create(request, "request-0000000001", requester)

    await expect(
      harness.control.create(request, "request-0000000002", requester),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryAfterSeconds: 60,
    })
  })

  it("rejects a resolver that returns another repository identity", async () => {
    const harness = createHarness({
      resolvedPlan: {
        ...plan,
        repository: { ...repository, repositoryId: 2 },
      },
    })

    await expect(
      harness.control.create(request, "request-0000000001", requester),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("atomically collapses concurrent idempotent creates", async () => {
    const harness = createHarness()
    const [first, second] = await Promise.all([
      harness.control.create(request, "request-0000000001", requester),
      harness.control.create(request, "request-0000000001", requester),
    ])

    expect(first.job.id).toBe(second.job.id)
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(harness.queue.size).toBe(1)
  })
})

interface HarnessOptions {
  jobTimeoutMs?: number
  perUserRepository?: number
  resolvedPlan?: BuildPlan | null
}

function createHarness(options: HarnessOptions = {}) {
  let now = new Date("2026-09-01T00:00:00.000Z")
  let sequence = 0
  const resolve = vi
    .fn<PreviewPlanResolver["resolve"]>()
    .mockResolvedValue(
      options.resolvedPlan === undefined ? plan : options.resolvedPlan,
    )
  const queue = new InMemoryPreviewQueue()
  const control = new PreviewControlPlane(
    { resolve },
    new InMemoryPreviewJobStore(),
    queue,
    new InMemoryPreviewArtifactCache(),
    new HmacPreviewArtifactSigner(
      "peephole.run",
      "test-signing-secret-with-at-least-32-bytes",
    ),
    new FixedWindowPreviewQuota({
      perUserRepository: options.perUserRepository,
    }),
    {
      runnerVersion: "runner-v1",
      jobTimeoutMs: options.jobTimeoutMs,
      now: () => new Date(now),
      createId: () => `job-${String(++sequence).padStart(8, "0")}`,
    },
  )

  return {
    control,
    queue,
    resolve,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}
