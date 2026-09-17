import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import type {
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "../services/backend-runtime-worker/ports"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { BackendRuntimeReadinessTimeoutError } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import type { CommandRunner } from "../services/preview-worker/local/commandRunner"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import type {
  PreviewWorkspace,
  SandboxProvisioner,
  SourceArchiveFetcher,
} from "../services/preview-worker/ports"
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

class FakeArchiveFetcher implements SourceArchiveFetcher {
  fetchError: Error | null = null

  constructor(private readonly byteStore: ArchiveByteStore) {}

  async fetch(repository: { commitSha: string }) {
    if (this.fetchError) throw this.fetchError
    this.byteStore.put(repository.commitSha, new Uint8Array())
    return {
      compressedBytes: 10,
      entries: [{ path: "package.json", bytes: 10, isSymlink: false }],
    }
  }
}

class FakeSandboxProvisioner implements SandboxProvisioner {
  roots: string[] = []
  destroyed: string[] = []

  async allocate(
    jobId: string,
  ): Promise<PreviewWorkspace & { rootDir: string; remainingMs(): number }> {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-backend-supervisor-"),
    )
    this.roots.push(rootDir)
    return {
      id: jobId,
      rootDir,
      remainingMs: () => 60_000,
      destroy: async () => {
        this.destroyed.push(jobId)
      },
    }
  }
}

class FakeCommandRunner implements CommandRunner {
  installError: Error | null = null
  calls: Array<{ command: string; args: string[] }> = []

  async run(
    _workspace: unknown,
    command: string,
    args: string[],
  ): Promise<void> {
    this.calls.push({ command, args })
    if (this.installError) throw this.installError
  }
}

class FakeRuntimeProcessHandle implements RuntimeProcessHandle {
  stopCalls = 0
  readyError: Error | null = null
  private resolveExit!: (result: { exitCode: number | null }) => void
  private readonly exitPromise = new Promise<{ exitCode: number | null }>(
    (resolve) => {
      this.resolveExit = resolve
    },
  )

  async waitUntilReady(): Promise<void> {
    if (this.readyError) throw this.readyError
  }

  waitForExit(): Promise<{ exitCode: number | null }> {
    return this.exitPromise
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    this.resolveExit({ exitCode: 0 })
  }

  crash(exitCode: number): void {
    this.resolveExit({ exitCode })
  }
}

class FakeRuntimeProcessStarter implements BackendRuntimeProcessStarter {
  startError: Error | null = null
  /** Applied to the handle `start()` is about to create -- set this before
   * calling `supervisor.run()` so it takes effect before the supervisor's
   * own `waitUntilReady()` call, instead of racing to mutate the handle
   * after the fact. */
  nextReadyError: Error | null = null
  lastHandle: FakeRuntimeProcessHandle | null = null

  async start(): Promise<RuntimeProcessHandle> {
    if (this.startError) throw this.startError
    this.lastHandle = new FakeRuntimeProcessHandle()
    this.lastHandle.readyError = this.nextReadyError
    return this.lastHandle
  }
}

function compose(runtimeTtlMs = 10 * 60_000) {
  const store = new InMemoryBackendRuntimeStore()
  const queue = new InMemoryBackendRuntimeQueue()
  const resolver = { resolve: vi.fn().mockResolvedValue(plan) }
  let now = new Date("2026-01-01T00:00:00.000Z")
  const controlPlane = new BackendRuntimeControlPlane(resolver, store, queue, {
    now: () => now,
    runtimeTtlMs,
  })
  const byteStore = new ArchiveByteStore()
  const fetcher = new FakeArchiveFetcher(byteStore)
  const extraction = new ExtractionState(async (_data, options) => {
    await mkdir(path.join(options.destinationDir, "backend"), {
      recursive: true,
    })
    await writeFile(
      path.join(options.destinationDir, "backend", "package-lock.json"),
      "{}",
    )
  })
  const sandbox = new FakeSandboxProvisioner()
  const installRunner = new FakeCommandRunner()
  const starter = new FakeRuntimeProcessStarter()
  const supervisor = new BackendRuntimeSupervisor(
    controlPlane,
    fetcher,
    byteStore,
    extraction,
    sandbox,
    installRunner,
    starter,
    { cancellationPollMs: 20, monitorPollMs: 20, readinessTimeoutMs: 200 },
  )
  return {
    controlPlane,
    store,
    queue,
    fetcher,
    sandbox,
    installRunner,
    starter,
    supervisor,
    setNow: (value: Date) => {
      now = value
    },
  }
}

async function createAndLease(
  controlPlane: BackendRuntimeControlPlane,
  queue: InMemoryBackendRuntimeQueue,
) {
  const created = await controlPlane.create(
    { repository, contractVersion: "backend-v1" },
    requester,
  )
  const leased = await queue.lease("worker-1")
  if (!leased) throw new Error("Expected a queued runtime.")
  return { runtimeId: created.runtime.id, job: leased.job }
}

describe("BackendRuntimeSupervisor", () => {
  const createdRoots: string[] = []

  afterEach(async () => {
    for (const root of createdRoots.splice(0)) {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("runs fetch -> install -> start -> running, then stays running until told to stop", async () => {
    const { controlPlane, queue, sandbox, installRunner, starter, supervisor } =
      compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)

    const controller = new AbortController()
    const runPromise = supervisor.run(job, { signal: controller.signal })

    // Give the supervisor time to reach "running" and start polling.
    await vi.waitFor(async () => {
      const runtime = await controlPlane.get(runtimeId, requester)
      expect(runtime.status).toBe("running")
    })

    expect(installRunner.calls[0]).toEqual({
      command: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
    })
    expect(starter.lastHandle).not.toBeNull()

    await controlPlane.cancel(runtimeId, requester)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("stopped")
    expect(starter.lastHandle?.stopCalls).toBe(1)
    expect(sandbox.destroyed).toEqual([runtimeId])
  })

  it("fails with FETCH_FAILED and still destroys the workspace", async () => {
    const { controlPlane, queue, sandbox, fetcher, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    fetcher.fetchError = new Error("network down")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("FETCH_FAILED")
    expect(sandbox.destroyed).toEqual([runtimeId])
  })

  it("fails with INSTALL_FAILED when npm ci fails", async () => {
    const { controlPlane, queue, sandbox, installRunner, supervisor } =
      compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    installRunner.installError = new Error("npm ci exited with code 1")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("INSTALL_FAILED")
  })

  it("fails with RUNTIME_START_FAILED when the runtime process cannot start", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.startError = new Error("runsc run failed")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_START_FAILED")
  })

  it("fails with RUNTIME_READINESS_TIMEOUT and stops the half-started process", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.nextReadyError = new BackendRuntimeReadinessTimeoutError()

    const runPromise = supervisor.run(job)

    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_READINESS_TIMEOUT")
    expect(starter.lastHandle?.stopCalls).toBeGreaterThanOrEqual(1)
  })

  it("fails with RUNTIME_EXITED when the process crashes while running", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)

    const runPromise = supervisor.run(job)
    await vi.waitFor(async () => {
      const runtime = await controlPlane.get(runtimeId, requester)
      expect(runtime.status).toBe("running")
    })

    starter.lastHandle!.crash(1)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_EXITED")
    expect(sandbox.destroyed).toEqual([runtimeId])
  })

  it("stops cleanly once the control plane's own TTL expires", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor, setNow } =
      compose(1_000)
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)

    const runPromise = supervisor.run(job)
    await vi.waitFor(async () => {
      const runtime = await controlPlane.get(runtimeId, requester)
      expect(runtime.status).toBe("running")
    })

    setNow(new Date(Date.now() + 2_000))
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("expired")
    expect(starter.lastHandle?.stopCalls).toBe(1)
    expect(sandbox.destroyed).toEqual([runtimeId])
  })

  it("cancelling before the process ever starts goes straight to cancelled, never stopped", async () => {
    const { controlPlane, queue, sandbox, fetcher, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    // Never resolves on its own -- only rejects once cancelled aborts the
    // supervisor's signal, exactly like a real in-flight fetch would.
    fetcher.fetch = (_repository: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        })
      })

    const runPromise = supervisor.run(job)
    await controlPlane.cancel(runtimeId, requester)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("cancelled")
  })

  it("never starts the runtime process twice for a recovered, already-started runtime", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose()
    const { job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    await controlPlane.startWorkerRuntime(job.runtimeId)

    await supervisor.run(job, { recovered: true })

    expect(starter.lastHandle).toBeNull()
  })

  it("rejects a queued runtime whose repository does not match its own plan", async () => {
    const { controlPlane, queue, sandbox, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    const tampered = {
      ...job,
      repository: { ...repository, commitSha: "b".repeat(40) },
    }

    await supervisor.run(tampered)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
  })

  it("rejects a queued plan carrying an unsafe start command before ever executing", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    const tampered = {
      ...job,
      plan: {
        ...plan,
        start: {
          command: "node" as const,
          args: ["; rm -rf /"] as readonly [string],
        },
      },
    }

    await supervisor.run(tampered)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(starter.lastHandle).toBeNull()
  })
})
