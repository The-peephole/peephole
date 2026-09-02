import { describe, expect, it, vi } from "vitest"

import {
  FakeArtifactPublisher,
  FakeBuildExecutor,
  FakeDependencyInstaller,
  FakeOutputResolver,
  FakeSandboxProvisioner,
  FakeSourceArchiveFetcher,
} from "../services/preview-worker/fakeAdapters"
import { PreviewJobWorker } from "../services/preview-worker/worker"
import { PreviewControlPlane } from "../services/preview-api/controlPlane"
import {
  FixedWindowPreviewQuota,
  HmacPreviewArtifactSigner,
  InMemoryPreviewArtifactCache,
  InMemoryPreviewJobStore,
  InMemoryPreviewQueue,
} from "../services/preview-api/inMemoryAdapters"
import type { BuildPlan, PreviewRequester } from "../types/preview"
import type { ResolvedOutput } from "../types/runner"

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

const staticPlan: BuildPlan = {
  ...plan,
  packageManager: "none",
  installCommand: null,
  buildCommand: null,
  outputDirectory: ".",
}

const requester: PreviewRequester = {
  subject: "user-1",
  ip: "203.0.113.10",
}

const okOutput: ResolvedOutput = {
  entries: [{ path: "index.html", bytes: 100, isSymlink: false }],
}

describe("PreviewJobWorker", () => {
  it("runs fetch, install, build, and publish in order and completes the job", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    })
    const sandbox = new FakeSandboxProvisioner()
    const installer = new FakeDependencyInstaller()
    const builder = new FakeBuildExecutor()
    const publisher = new FakeArtifactPublisher()
    const markPhase = vi.spyOn(harness.control, "markPhase")

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      installer,
      builder,
      new FakeOutputResolver(okOutput),
      publisher,
    )

    await worker.run(queued)

    expect(markPhase.mock.calls.map(([, status]) => status)).toEqual([
      "fetching",
      "installing",
      "building",
      "publishing",
    ])
    expect(installer.calls).toHaveLength(1)
    expect(builder.calls).toHaveLength(1)
    expect(publisher.calls).toHaveLength(1)
    expect(sandbox.destroyedIds).toEqual(sandbox.allocatedIds)
    expect(sandbox.activeCount).toBe(0)

    const job = await harness.control.get(created.job.id, requester)
    expect(job.status).toBe("ready")
    expect(job.artifact?.url).toContain(created.job.id)
  })

  it("skips install and build phases for package-free static plans", async () => {
    const harness = createHarness({ resolvedPlan: staticPlan })
    await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "index.html", bytes: 10, isSymlink: false }],
    })
    const installer = new FakeDependencyInstaller()
    const builder = new FakeBuildExecutor()
    const markPhase = vi.spyOn(harness.control, "markPhase")

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      new FakeSandboxProvisioner(),
      installer,
      builder,
      new FakeOutputResolver(okOutput),
      new FakeArtifactPublisher(),
    )

    await worker.run(queued)

    expect(markPhase.mock.calls.map(([, status]) => status)).toEqual([
      "fetching",
      "publishing",
    ])
    expect(installer.calls).toHaveLength(0)
    expect(builder.calls).toHaveLength(0)
  })

  it("fails as FETCH_FAILED and cleans up when the archive exceeds limits", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "../escape", bytes: 10, isSymlink: false }],
    })
    const sandbox = new FakeSandboxProvisioner()
    const installer = new FakeDependencyInstaller()
    const builder = new FakeBuildExecutor()
    const publisher = new FakeArtifactPublisher()

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      installer,
      builder,
      new FakeOutputResolver(okOutput),
      publisher,
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job).toMatchObject({ status: "failed", errorCode: "FETCH_FAILED" })
    expect(installer.calls).toHaveLength(0)
    expect(sandbox.activeCount).toBe(0)
  })

  it("maps an install failure to INSTALL_FAILED without running the build", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    })
    const builder = new FakeBuildExecutor()
    const sandbox = new FakeSandboxProvisioner()

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      new FakeDependencyInstaller(new Error("npm ci exited 1")),
      builder,
      new FakeOutputResolver(okOutput),
      new FakeArtifactPublisher(),
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job).toMatchObject({ status: "failed", errorCode: "INSTALL_FAILED" })
    expect(builder.calls).toHaveLength(0)
    expect(sandbox.activeCount).toBe(0)
  })

  it("maps a build failure to BUILD_FAILED", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    })
    const sandbox = new FakeSandboxProvisioner()
    const publisher = new FakeArtifactPublisher()

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      new FakeDependencyInstaller(),
      new FakeBuildExecutor(new Error("build script failed")),
      new FakeOutputResolver(okOutput),
      publisher,
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job).toMatchObject({ status: "failed", errorCode: "BUILD_FAILED" })
    expect(publisher.calls).toHaveLength(0)
    expect(sandbox.activeCount).toBe(0)
  })

  it("maps unsafe or oversized output and publisher failures to PUBLISH_FAILED", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    })
    const sandbox = new FakeSandboxProvisioner()
    const publisher = new FakeArtifactPublisher()

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      new FakeDependencyInstaller(),
      new FakeBuildExecutor(),
      new FakeOutputResolver({ entries: [] }),
      publisher,
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job).toMatchObject({ status: "failed", errorCode: "PUBLISH_FAILED" })
    expect(publisher.calls).toHaveLength(0)
    expect(sandbox.activeCount).toBe(0)
  })

  it("fails as RUNNER_UNAVAILABLE without a workspace when the sandbox cannot be allocated", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    const sandbox = new FakeSandboxProvisioner(new Error("no capacity"))
    const worker = new PreviewJobWorker(
      harness.control,
      new FakeSourceArchiveFetcher(),
      sandbox,
      new FakeDependencyInstaller(),
      new FakeBuildExecutor(),
      new FakeOutputResolver(okOutput),
      new FakeArtifactPublisher(),
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job).toMatchObject({
      status: "failed",
      errorCode: "RUNNER_UNAVAILABLE",
    })
    expect(sandbox.allocatedIds).toHaveLength(0)
  })

  it("leaves a concurrently cancelled job cancelled instead of overwriting it", async () => {
    const harness = createHarness()
    const created = await harness.control.create(
      { repository, contractVersion: "static-v1" },
      "request-0000000001",
      requester,
    )
    const queued = harness.queue.dequeue()
    if (!queued) throw new Error("expected a queued job")

    await harness.control.cancel(created.job.id, requester)

    const sandbox = new FakeSandboxProvisioner()
    const fetcher = new FakeSourceArchiveFetcher()
    fetcher.setArchive(repository.commitSha, {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    })

    const worker = new PreviewJobWorker(
      harness.control,
      fetcher,
      sandbox,
      new FakeDependencyInstaller(),
      new FakeBuildExecutor(),
      new FakeOutputResolver(okOutput),
      new FakeArtifactPublisher(),
    )

    await worker.run(queued)

    const job = await harness.control.get(created.job.id, requester)
    expect(job.status).toBe("cancelled")
    expect(sandbox.activeCount).toBe(0)
  })
})

interface HarnessOptions {
  resolvedPlan?: BuildPlan
}

function createHarness(options: HarnessOptions = {}) {
  const queue = new InMemoryPreviewQueue()
  const control = new PreviewControlPlane(
    { resolve: async () => options.resolvedPlan ?? plan },
    new InMemoryPreviewJobStore(),
    queue,
    new InMemoryPreviewArtifactCache(),
    new HmacPreviewArtifactSigner(
      "peephole.run",
      "test-signing-secret-with-at-least-32-bytes",
    ),
    new FixedWindowPreviewQuota(),
    {
      runnerVersion: "runner-v1",
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      createId: () => "job-00000001",
    },
  )

  return { control, queue }
}
