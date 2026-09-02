import { describe, expect, it, vi } from "vitest"

import { PreviewWorkerLoop } from "../services/preview-worker/workerLoop"
import type {
  PreviewQueueConsumer,
  PreviewQueueLease,
} from "../services/preview-api/ports"
import type { BuildPlan, QueuedPreviewJob } from "../types/preview"

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
  packageManager: "none",
  installCommand: null,
  buildCommand: null,
  outputDirectory: ".",
}

const queuedJob: QueuedPreviewJob = {
  jobId: "job-1",
  repository,
  plan,
  cacheKey: "cache-1",
}

class FakeQueue implements PreviewQueueConsumer {
  leases: Array<PreviewQueueLease | null> = []
  leaseCalls: Array<{ workerId: string; now: Date; leaseMs: number }> = []
  acknowledgements: Array<{ jobId: string; workerId: string }> = []
  releases: Array<{
    jobId: string
    workerId: string
    availableAt: Date
  }> = []

  async lease(workerId: string, now: Date, leaseMs: number) {
    this.leaseCalls.push({ workerId, now, leaseMs })
    return this.leases.shift() ?? null
  }

  async acknowledge(jobId: string, workerId: string) {
    this.acknowledgements.push({ jobId, workerId })
    return true
  }

  async release(jobId: string, workerId: string, availableAt: Date) {
    this.releases.push({ jobId, workerId, availableAt })
    return true
  }
}

describe("PreviewWorkerLoop", () => {
  it("leases, runs, and acknowledges one job", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ job: queuedJob, attempts: 1 })
    const run = vi.fn(async () => undefined)
    const now = new Date("2026-09-02T00:00:00.000Z")
    const loop = new PreviewWorkerLoop(
      queue,
      { run },
      {
        workerId: "worker-1",
        now: () => now,
      },
    )

    await expect(loop.runOnce()).resolves.toBe(true)

    expect(queue.leaseCalls).toEqual([
      { workerId: "worker-1", now, leaseMs: 210_000 },
    ])
    expect(run).toHaveBeenCalledWith(queuedJob)
    expect(queue.acknowledgements).toEqual([
      { jobId: "job-1", workerId: "worker-1" },
    ])
    expect(queue.releases).toEqual([])
  })

  it("returns false without invoking the worker when the queue is empty", async () => {
    const queue = new FakeQueue()
    const run = vi.fn(async () => undefined)
    const loop = new PreviewWorkerLoop(
      queue,
      { run },
      {
        workerId: "worker-1",
      },
    )

    await expect(loop.runOnce()).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(queue.acknowledgements).toEqual([])
  })

  it("releases an unexpected worker failure with a retry delay", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ job: queuedJob, attempts: 2 })
    const failure = new Error("worker process exited")
    const now = new Date("2026-09-02T00:00:00.000Z")
    const loop = new PreviewWorkerLoop(
      queue,
      { run: async () => Promise.reject(failure) },
      { workerId: "worker-1", retryDelayMs: 7_000, now: () => now },
    )

    await expect(loop.runOnce()).rejects.toBe(failure)
    expect(queue.acknowledgements).toEqual([])
    expect(queue.releases).toEqual([
      {
        jobId: "job-1",
        workerId: "worker-1",
        availableAt: new Date("2026-09-02T00:00:07.000Z"),
      },
    ])
  })

  it("polls until aborted and reports queue errors", async () => {
    const controller = new AbortController()
    const queue = new FakeQueue()
    const error = new Error("database unavailable")
    queue.lease = vi.fn(async () => Promise.reject(error))
    const onError = vi.fn()
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      controller.abort()
      expect(signal).toBe(controller.signal)
    })
    const loop = new PreviewWorkerLoop(
      queue,
      { run: async () => undefined },
      {
        workerId: "worker-1",
        pollIntervalMs: 25,
        wait,
        onError,
      },
    )

    await loop.runUntilStopped(controller.signal)

    expect(onError).toHaveBeenCalledWith(error)
    expect(wait).toHaveBeenCalledWith(25, controller.signal)
  })
})
