import { describe, expect, it, vi } from "vitest"

import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import type { BackendRuntimePlan } from "../types/backendRuntime"

const repository = {
  repositoryId: 1,
  owner: "acme",
  name: "web",
  commitSha: "a".repeat(40),
}

const plan: BackendRuntimePlan = {
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

const requester = { subject: "user-1", ip: "203.0.113.10" }

function createRequest(overrides: { sourceRoot?: string } = {}) {
  return {
    repository,
    contractVersion: "backend-v1" as const,
    ...overrides,
  }
}

function compose(
  resolvePlan: BackendRuntimePlan | null = plan,
  maxActiveRuntimesPerRequester = 1,
) {
  const store = new InMemoryBackendRuntimeStore()
  const queue = new InMemoryBackendRuntimeQueue()
  const resolver = { resolve: vi.fn().mockResolvedValue(resolvePlan) }
  const controlPlane = new BackendRuntimeControlPlane(resolver, store, queue, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    maxActiveRuntimesPerRequester,
  })
  return { store, queue, resolver, controlPlane }
}

describe("BackendRuntimeControlPlane", () => {
  it("isolates internal runtimes per full-stack id while reusing the same retry", async () => {
    const { controlPlane, store } = compose(plan, 2)
    const firstKey = "fullstack-00000000-0000-0000-0000-000000000001"
    const secondKey = "fullstack-00000000-0000-0000-0000-000000000002"
    const first = await controlPlane.createForOrchestration(
      createRequest({ sourceRoot: "backend" }),
      requester.subject,
      firstKey,
    )
    const retry = await controlPlane.createForOrchestration(
      createRequest({ sourceRoot: "backend" }),
      requester.subject,
      firstKey,
    )
    const second = await controlPlane.createForOrchestration(
      createRequest({ sourceRoot: "backend" }),
      requester.subject,
      secondKey,
    )

    expect(retry.created).toBe(false)
    expect(retry.runtime.id).toBe(first.runtime.id)
    expect(second.runtime.id).not.toBe(first.runtime.id)
    expect((await store.get(first.runtime.id))?.orchestrationKey).toBe(firstKey)
    expect(first.runtime).not.toHaveProperty("orchestrationKey")
  })

  it("creates a queued runtime from an independently resolved plan", async () => {
    const { controlPlane, resolver } = compose()

    const result = await controlPlane.create(createRequest(), requester)

    expect(result.created).toBe(true)
    expect(result.runtime.status).toBe("queued")
    expect(result.runtime.sourceRoot).toBe("backend")
    expect(resolver.resolve).toHaveBeenCalledWith(repository, undefined)
  })

  it("passes the sourceRoot hint through to the resolver without treating it as authoritative", async () => {
    const { controlPlane, resolver } = compose()

    await controlPlane.create(
      createRequest({ sourceRoot: "backend" }),
      requester,
    )

    expect(resolver.resolve).toHaveBeenCalledWith(repository, "backend")
  })

  it("rejects an unsupported backend with UNSUPPORTED_BACKEND", async () => {
    const { controlPlane } = compose(null)

    await expect(
      controlPlane.create(createRequest(), requester),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BACKEND", status: 422 })
  })

  it("never includes a URL field on the public runtime resource", async () => {
    const { controlPlane } = compose()

    const result = await controlPlane.create(createRequest(), requester)

    expect(JSON.stringify(result.runtime).toLowerCase()).not.toContain("url")
  })

  it("never includes an internal dial target, peer IP, or internal port on the public runtime resource", async () => {
    const { controlPlane } = compose()

    const result = await controlPlane.create(createRequest(), requester)

    expect(result.runtime).not.toHaveProperty("dialTarget")
    expect(result.runtime).not.toHaveProperty("peerIp")
    expect(result.runtime).not.toHaveProperty("internalPort")
    expect(result.runtime).not.toHaveProperty("host")
    expect(result.runtime).not.toHaveProperty("port")
  })

  it("returns the existing active runtime for an identical request (idempotent)", async () => {
    const { controlPlane, resolver } = compose()

    const first = await controlPlane.create(createRequest(), requester)
    const second = await controlPlane.create(createRequest(), requester)

    expect(second.created).toBe(false)
    expect(second.runtime.id).toBe(first.runtime.id)
    expect(resolver.resolve).toHaveBeenCalledTimes(1)
  })

  it("enforces one active runtime per requester for a different request", async () => {
    const { controlPlane } = compose()

    await controlPlane.create(createRequest(), requester)

    await expect(
      controlPlane.create(createRequest({ sourceRoot: "other" }), requester),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 })
  })

  it("allows a second requester to create their own runtime concurrently", async () => {
    const { controlPlane } = compose()
    const otherRequester = { subject: "user-2", ip: "203.0.113.11" }

    await controlPlane.create(createRequest(), requester)
    const result = await controlPlane.create(createRequest(), otherRequester)

    expect(result.created).toBe(true)
  })

  it("does not let a different requester read another's runtime", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)

    await expect(
      controlPlane.get(created.runtime.id, {
        subject: "someone-else",
        ip: "203.0.113.12",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("does not let a different requester cancel another's runtime", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)

    await expect(
      controlPlane.cancel(created.runtime.id, {
        subject: "someone-else",
        ip: "203.0.113.12",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  })

  it("moves queued -> fetching -> installing -> starting -> running via markPhase", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    const id = created.runtime.id

    await controlPlane.startWorkerRuntime(id)
    for (const status of ["installing", "starting", "running"] as const) {
      const updated = await controlPlane.markPhase(id, status)
      expect(updated.status).toBe(status)
    }
  })

  it("rejects an out-of-order phase transition", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)

    await expect(
      controlPlane.markPhase(created.runtime.id, "running"),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" })
  })

  it("cancels a queued runtime directly to cancelled", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)

    const cancelled = await controlPlane.cancel(created.runtime.id, requester)

    expect(cancelled.status).toBe("cancelled")
  })

  it("cancels a running runtime to stopping, not directly to stopped", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    await controlPlane.startWorkerRuntime(created.runtime.id)
    await controlPlane.markPhase(created.runtime.id, "installing")
    await controlPlane.markPhase(created.runtime.id, "starting")
    await controlPlane.markPhase(created.runtime.id, "running")

    const cancelled = await controlPlane.cancel(created.runtime.id, requester)

    expect(cancelled.status).toBe("stopping")
  })

  it("markStopped only transitions from stopping, never overwriting a terminal status", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    await controlPlane.startWorkerRuntime(created.runtime.id)

    // Not yet stopping: markStopped is a no-op.
    await controlPlane.markStopped(created.runtime.id)
    const stillFetching = await controlPlane.get(created.runtime.id, requester)
    expect(stillFetching.status).toBe("fetching")
  })

  it("cancelling an already-terminal runtime is idempotent", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    await controlPlane.cancel(created.runtime.id, requester)

    const cancelledAgain = await controlPlane.cancel(
      created.runtime.id,
      requester,
    )
    expect(cancelledAgain.status).toBe("cancelled")
  })

  it("expires a runtime past its TTL instead of leaving it active forever", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z")
    const store = new InMemoryBackendRuntimeStore()
    const queue = new InMemoryBackendRuntimeQueue()
    const resolver = { resolve: vi.fn().mockResolvedValue(plan) }
    const controlPlane = new BackendRuntimeControlPlane(
      resolver,
      store,
      queue,
      {
        now: () => now,
        runtimeTtlMs: 1_000,
      },
    )
    const created = await controlPlane.create(createRequest(), requester)

    now = new Date(now.getTime() + 2_000)
    const refreshed = await controlPlane.get(created.runtime.id, requester)

    expect(refreshed.status).toBe("expired")
  })

  it("shouldContinueRunning is true only while status is running", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    const id = created.runtime.id

    expect(await controlPlane.shouldContinueRunning(id)).toBe(false)
    await controlPlane.startWorkerRuntime(id)
    await controlPlane.markPhase(id, "installing")
    await controlPlane.markPhase(id, "starting")
    await controlPlane.markPhase(id, "running")
    expect(await controlPlane.shouldContinueRunning(id)).toBe(true)

    await controlPlane.cancel(id, requester)
    expect(await controlPlane.shouldContinueRunning(id)).toBe(false)
  })

  it("isWorkerRuntimeActive reflects terminal status", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    const id = created.runtime.id

    expect(await controlPlane.isWorkerRuntimeActive(id)).toBe(true)
    await controlPlane.cancel(id, requester)
    expect(await controlPlane.isWorkerRuntimeActive(id)).toBe(false)
  })

  it("startWorkerRuntime fails a recovered non-queued runtime instead of resuming it", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)
    const id = created.runtime.id
    await controlPlane.startWorkerRuntime(id)

    const started = await controlPlane.startWorkerRuntime(id, true)

    expect(started).toBe(false)
    const runtime = await controlPlane.get(id, requester)
    expect(runtime.status).toBe("failed")
    expect(runtime.errorCode).toBe("RUNTIME_UNAVAILABLE")
  })

  it("fails a runtime with a specific, safe error code and message", async () => {
    const { controlPlane } = compose()
    const created = await controlPlane.create(createRequest(), requester)

    const failed = await controlPlane.fail(
      created.runtime.id,
      "RUNTIME_READINESS_TIMEOUT",
    )

    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("RUNTIME_READINESS_TIMEOUT")
    expect(failed.errorMessage).not.toContain("stdout")
    expect(failed.errorMessage).not.toContain("stderr")
  })

  it("rejects a request whose repository ref is malformed", async () => {
    const { controlPlane } = compose()

    await expect(
      controlPlane.create(
        {
          repository: { ...repository, commitSha: "not-a-sha" },
          contractVersion: "backend-v1",
        },
        requester,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 })
  })

  it("rejects an unsupported contract version", async () => {
    const { controlPlane } = compose()

    await expect(
      controlPlane.create(
        { repository, contractVersion: "backend-v2" as never },
        requester,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
})
