import type { IncomingMessage } from "node:http"
import { describe, expect, it, vi } from "vitest"

import { GitHubApiError } from "../core/github/client"
import { FakePreviewRunner } from "../services/preview-api/fakeRunner"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import type {
  PreviewPlanResolver,
  PreviewQuota,
} from "../services/preview-api/ports"
import { resolveRequesterIp } from "../services/preview-api/requesterIp"
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
  it("accepts a canonical proxy-resolved IP as a requester quota key", async () => {
    const harness = createHarness()
    const ip = resolveRequesterIp({
      headers: { "x-forwarded-for": "2001:0db8:0:0:0:0:0:7" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage)

    await expect(
      harness.control.create(request, "request-0000000001", {
        subject: "github:42",
        ip,
      }),
    ).resolves.toMatchObject({ created: true })
    expect(ip).toBe("2001:db8::7")
  })

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

  it("skips a second quota charge only for trusted orchestration creation", async () => {
    const consume = vi.fn(async () => ({ allowed: true as const }))
    const harness = createHarness({ quota: { consume } })
    await harness.control.create(request, "request-public-000001", requester)
    const internal = await harness.control.createForOrchestration(
      request,
      "fullstack:preview-00000001:frontend",
      requester.subject,
    )

    expect(consume).toHaveBeenCalledTimes(1)
    await expect(
      harness.control.getForOrchestration(internal.job.id, "another-user"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
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

  it("includes the selected source root in idempotency identity", async () => {
    const nestedPlan: BuildPlan = {
      ...plan,
      contractVersion: "static-v2",
      sourceRoot: "apps/web",
    }
    const harness = createHarness({ resolvedPlan: nestedPlan })
    const nestedRequest: CreatePreviewJobRequest = {
      repository,
      contractVersion: "static-v2",
      target: { sourceRoot: "apps/web" },
    }
    await harness.control.create(nestedRequest, "request-0000000001", requester)

    await expect(
      harness.control.create(
        { ...nestedRequest, target: { sourceRoot: "apps/admin" } },
        "request-0000000001",
        requester,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
  })

  it("requires explicit static-v2 targets and keeps static-v1 root-only", async () => {
    const harness = createHarness()
    await expect(
      harness.control.create(
        { repository, contractVersion: "static-v2" },
        "request-0000000001",
        requester,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 })
    await expect(
      harness.control.create(
        {
          repository,
          contractVersion: "static-v1",
          target: { sourceRoot: "." },
        },
        "request-0000000002",
        requester,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 })
    await expect(
      harness.control.create(
        {
          repository,
          contractVersion: "static-v2",
          target: { sourceRoot: "../backend" },
        },
        "request-0000000003",
        requester,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 })
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

  it("rejects a resolver plan not accepted by a registered build adapter", async () => {
    const harness = createHarness({
      resolvedPlan: {
        ...plan,
        packageManager: "pnpm",
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm run build",
      },
    })

    await expect(
      harness.control.create(request, "request-0000000001", requester),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_REPOSITORY",
      status: 422,
    })
    expect(harness.queue.size).toBe(0)
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

  it("maps a GitHub rate-limit failure to a safe 503 with Retry-After preserved", async () => {
    const resolve = vi
      .fn<PreviewPlanResolver["resolve"]>()
      .mockRejectedValue(
        new GitHubApiError(
          "rate-limited",
          "GitHub API rate limit reached. Try again after it resets.",
          403,
          new Date("2026-09-01T00:00:45.000Z"),
        ),
      )
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const harness = createHarness({ resolve })

    await expect(
      harness.control.create(request, "request-0000000001", requester),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 503,
      retryAfterSeconds: 45,
    })
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("upstream GitHub failure"),
      expect.objectContaining({ code: "rate-limited" }),
    )
    errorLog.mockRestore()
  })

  it.each(["network", "unavailable"] as const)(
    "maps a GitHub %s failure to a safe 503 without a fabricated Retry-After",
    async (code) => {
      const resolve = vi
        .fn<PreviewPlanResolver["resolve"]>()
        .mockRejectedValue(new GitHubApiError(code, "GitHub is unreachable."))
      const harness = createHarness({ resolve })

      await expect(
        harness.control.create(request, "request-0000000001", requester),
      ).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        status: 503,
        retryAfterSeconds: null,
      })
    },
  )

  it("maps a GitHub not-found failure to the existing safe 404 without leaking repository existence", async () => {
    const resolve = vi
      .fn<PreviewPlanResolver["resolve"]>()
      .mockRejectedValue(
        new GitHubApiError(
          "not-found",
          "This repository is unavailable or is not public.",
          404,
        ),
      )
    const harness = createHarness({ resolve })

    await expect(
      harness.control.create(request, "request-0000000001", requester),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("does not reclassify an unexpected resolver exception as an upstream failure", async () => {
    const boom = new Error("resolver programming bug")
    const resolve = vi
      .fn<PreviewPlanResolver["resolve"]>()
      .mockRejectedValue(boom)
    const harness = createHarness({ resolve })

    await expect(
      harness.control.create(request, "request-0000000001", requester),
    ).rejects.toBe(boom)
  })
})

interface HarnessOptions {
  jobTimeoutMs?: number
  perUserRepository?: number
  resolvedPlan?: BuildPlan | null
  quota?: PreviewQuota
  resolve?: PreviewPlanResolver["resolve"]
}

function createHarness(options: HarnessOptions = {}) {
  let now = new Date("2026-09-01T00:00:00.000Z")
  let sequence = 0
  const resolve =
    options.resolve ??
    vi
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
    options.quota ??
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
