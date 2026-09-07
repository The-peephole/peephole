import { describe, expect, it, vi } from "vitest"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import {
  FakeArtifactPublisher,
  FakeBuildExecutor,
  FakeDependencyInstaller,
  FakeOutputResolver,
  FakeSandboxProvisioner,
} from "../services/preview-worker/fakeAdapters"
import { PreviewJobWorker } from "../services/preview-worker/worker"
import type { DependencyInstaller } from "../services/preview-worker/ports"
import type { BuildPlan } from "../types/preview"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "app",
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
const requester = { subject: "test-user", ip: "127.0.0.1" }

async function harness(
  installer: DependencyInstaller = new FakeDependencyInstaller(),
  totalJobTimeoutMs = 5000,
) {
  const store = new InMemoryPreviewJobStore()
  const queue = new InMemoryPreviewQueue()
  const control = new PreviewControlPlane(
    { resolve: async () => plan },
    store,
    queue,
    new InMemoryPreviewArtifactCache(),
    new HmacPreviewArtifactSigner(
      "peephole.run",
      "a-test-secret-at-least-thirty-two-bytes-long",
    ),
    new FixedWindowPreviewQuota(),
    { runnerVersion: "test" },
  )
  const sandbox = new FakeSandboxProvisioner()
  const publisher = new FakeArtifactPublisher()
  const fetch = vi.fn(async () => ({
    compressedBytes: 1,
    entries: [{ path: "index.html", bytes: 1, isSymlink: false }],
  }))
  const cleanup = vi.fn()
  const worker = new PreviewJobWorker(
    control,
    { fetch },
    sandbox,
    installer,
    new FakeBuildExecutor(),
    new FakeOutputResolver({
      entries: [{ path: "index.html", bytes: 1, isSymlink: false }],
    }),
    publisher,
    { cancellationPollMs: 10, totalJobTimeoutMs, cleanup },
  )
  await control.create(
    { repository, contractVersion: "static-v1" },
    "lifecycle-test-request",
    requester,
  )
  const queued = queue.dequeue()!
  return { store, control, worker, queued, sandbox, publisher, fetch, cleanup }
}

describe("worker lifecycle", () => {
  it("interrupts installation on persistent cancellation and cleans up before returning", async () => {
    let runningSignal: AbortSignal | undefined
    const h = await harness({
      install: async (_workspace, _archive, _plan, signal) => {
        runningSignal = signal
        await new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        )
      },
    })
    const done = h.worker.run(h.queued)
    await vi.waitFor(() => expect(runningSignal).toBeDefined())
    await h.control.cancel(h.queued.jobId, requester)
    await done
    expect(runningSignal?.aborted).toBe(true)
    expect((await h.control.get(h.queued.jobId, requester)).status).toBe(
      "cancelled",
    )
    expect(h.publisher.calls).toHaveLength(0)
    expect(h.sandbox.activeCount).toBe(0)
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it("stops a hanging phase when the total job deadline expires", async () => {
    const h = await harness(
      {
        install: async (_workspace, _archive, _plan, signal) => {
          await new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            }),
          )
        },
      },
      30,
    )
    await h.worker.run(h.queued)
    expect(await h.control.get(h.queued.jobId, requester)).toMatchObject({
      status: "failed",
      errorCode: "RUNNER_TIMEOUT",
    })
    expect(h.sandbox.activeCount).toBe(0)
  })

  it("does not replay a recovered partial build or overwrite a completed delivery", async () => {
    const h = await harness()
    await h.control.markPhase(h.queued.jobId, "fetching")
    await h.control.markPhase(h.queued.jobId, "installing")
    await h.worker.run(h.queued, { recovered: true })
    expect(await h.control.get(h.queued.jobId, requester)).toMatchObject({
      status: "failed",
      errorCode: "RUNNER_UNAVAILABLE",
    })
    expect(h.fetch).not.toHaveBeenCalled()
    const completed = await harness()
    await completed.worker.run(completed.queued)
    await completed.worker.run(completed.queued, { recovered: true })
    expect(
      (await completed.control.get(completed.queued.jobId, requester)).status,
    ).toBe("ready")
    expect(completed.fetch).toHaveBeenCalledOnce()
  })

  it("propagates a failure to save job failure so the queue cannot acknowledge lost state", async () => {
    const h = await harness({
      install: async () => {
        throw new Error("install failed")
      },
    })
    vi.spyOn(h.control, "failWorkerJob").mockRejectedValue(
      new Error("database unavailable"),
    )
    await expect(h.worker.run(h.queued)).rejects.toThrow("database unavailable")
    expect(h.sandbox.activeCount).toBe(0)
    expect(h.cleanup).toHaveBeenCalledOnce()
  })
})
