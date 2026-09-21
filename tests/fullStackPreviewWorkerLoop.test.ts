import { afterEach, describe, expect, it, vi } from "vitest"

import { FullStackPreviewWorkerLoop } from "../services/fullstack-preview-worker/fullStackPreviewWorkerLoop"
import type {
  FullStackPreviewQueueConsumer,
  FullStackPreviewQueueLease,
} from "../services/fullstack-preview-api/ports"
import type { QueuedFullStackPreview } from "../types/fullstackPreview"

const queued: QueuedFullStackPreview = {
  previewId: "fullstack-00000000-0000-0000-0000-000000000001",
  repository: {
    repositoryId: 1,
    owner: "acme",
    name: "web",
    commitSha: "a".repeat(40),
  },
  frontendSourceRoot: "frontend",
  backendSourceRoot: "backend",
}

class FakeQueue implements FullStackPreviewQueueConsumer {
  leases: Array<FullStackPreviewQueueLease | null> = []
  lease = vi.fn(async () => this.leases.shift() ?? null)
  renew = vi.fn(async () => true)
  acknowledge = vi.fn(async () => true)
  release = vi.fn(async () => true)
}

afterEach(() => vi.useRealTimers())

describe("FullStackPreviewWorkerLoop", () => {
  it("leases the first delivery and acknowledges completed cleanup", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 1 })
    const run = vi.fn(async () => undefined)
    const now = new Date("2026-09-18T00:00:00.000Z")
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run },
      {
        workerId: "fullstack-worker-1",
        now: () => now,
      },
    )

    await expect(loop.runOnce()).resolves.toBe(true)
    expect(queue.lease).toHaveBeenCalledWith("fullstack-worker-1", now, 210_000)
    expect(run).toHaveBeenCalledWith(
      queued,
      expect.objectContaining({ recovered: false, abandon: false }),
    )
    expect(queue.acknowledge).toHaveBeenCalledWith(
      queued.previewId,
      "fullstack-worker-1",
      1,
    )
  })

  it("marks an expired-lease reclaim as recovered and fences by attempt", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 2 })
    const run = vi.fn(async () => undefined)
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run },
      {
        workerId: "fullstack-worker-1",
      },
    )

    await loop.runOnce()
    expect(run).toHaveBeenCalledWith(
      queued,
      expect.objectContaining({ recovered: true, abandon: false }),
    )
    expect(queue.acknowledge).toHaveBeenCalledWith(
      queued.previewId,
      "fullstack-worker-1",
      2,
    )
  })

  it("passes abandon after max attempts so recovered cleanup can finish", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 4 })
    const run = vi.fn(async () => undefined)
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run },
      {
        workerId: "fullstack-worker-1",
        maxAttempts: 3,
      },
    )
    await loop.runOnce()
    expect(run).toHaveBeenCalledWith(
      queued,
      expect.objectContaining({ recovered: true, abandon: true }),
    )
  })

  it("releases unexpected infrastructure failures with the retry delay", async () => {
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 2 })
    const failure = new Error("database unavailable")
    const now = new Date("2026-09-18T00:00:00.000Z")
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run: async () => Promise.reject(failure) },
      {
        workerId: "fullstack-worker-1",
        retryDelayMs: 7_000,
        now: () => now,
      },
    )

    await expect(loop.runOnce()).rejects.toBe(failure)
    expect(queue.release).toHaveBeenCalledWith(
      queued.previewId,
      "fullstack-worker-1",
      new Date("2026-09-18T00:00:07.000Z"),
      2,
    )
    expect(queue.acknowledge).not.toHaveBeenCalled()
  })

  it("renews a long-held awaiting_activation lease", async () => {
    vi.useFakeTimers()
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 1 })
    let finish!: () => void
    const running = new Promise<void>((resolve) => {
      finish = resolve
    })
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run: async () => running },
      { workerId: "fullstack-worker-1", leaseMs: 1_000 },
    )

    const execution = loop.runOnce()
    await vi.advanceTimersByTimeAsync(334)
    expect(queue.renew).toHaveBeenCalledWith(
      queued.previewId,
      "fullstack-worker-1",
      1,
      1_000,
    )
    finish()
    await execution
  })

  it("aborts on failed renewal and cannot acknowledge a fenced attempt", async () => {
    vi.useFakeTimers()
    const queue = new FakeQueue()
    queue.leases.push({ preview: queued, attempts: 3 })
    queue.renew.mockResolvedValue(false)
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      {
        run: async (_preview, options) => {
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          )
          options!.signal!.throwIfAborted()
        },
      },
      { workerId: "fullstack-worker-1", leaseMs: 1_000 },
    )

    const execution = loop.runOnce()
    const rejection = expect(execution).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(334)
    await rejection
    expect(queue.release).toHaveBeenCalledWith(
      queued.previewId,
      "fullstack-worker-1",
      expect.any(Date),
      3,
    )
    expect(queue.acknowledge).not.toHaveBeenCalled()
  })

  it("honors shutdown AbortSignal before leasing and while polling", async () => {
    const queue = new FakeQueue()
    const loop = new FullStackPreviewWorkerLoop(
      queue,
      { run: async () => undefined },
      {
        workerId: "fullstack-worker-1",
        wait: async (_milliseconds, signal) => {
          expect(signal.aborted).toBe(false)
        },
      },
    )
    const stopped = new AbortController()
    stopped.abort()
    await expect(loop.runOnce(stopped.signal)).rejects.toBeDefined()
    expect(queue.lease).not.toHaveBeenCalled()

    const controller = new AbortController()
    const polling = new FullStackPreviewWorkerLoop(
      queue,
      { run: async () => undefined },
      {
        workerId: "fullstack-worker-2",
        wait: async () => controller.abort(),
      },
    )
    await polling.runUntilStopped(controller.signal)
    expect(queue.lease).toHaveBeenCalledTimes(1)
  })
})
