import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import type {
  BackendRuntimeDialTarget,
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "../services/backend-runtime-worker/ports"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
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
  /** Observation hook, fired synchronously as the first thing `destroy()`
   * does -- lets a test prove ordering (e.g. that a live route was already
   * unregistered by the time namespace/workspace teardown begins). */
  onDestroy?: (jobId: string) => void

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
        this.onDestroy?.(jobId)
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

const FAKE_DIAL_TARGET: BackendRuntimeDialTarget = {
  host: "10.90.0.2",
  port: plan.internalPort,
}

class FakeRuntimeProcessHandle implements RuntimeProcessHandle {
  readonly dialTarget: BackendRuntimeDialTarget = FAKE_DIAL_TARGET
  stopCalls = 0
  readyError: Error | null = null
  /** If set, `waitUntilReady()` awaits this before resolving/throwing --
   * lets a test hold the supervisor inside "starting" indefinitely to
   * observe registry state before readiness ever succeeds. */
  readyGate: Promise<void> | null = null
  stopOverride: (() => Promise<void>) | null = null
  private resolveExit!: (result: { exitCode: number | null }) => void
  private readonly exitPromise = new Promise<{ exitCode: number | null }>(
    (resolve) => {
      this.resolveExit = resolve
    },
  )

  async waitUntilReady(): Promise<void> {
    if (this.readyGate) await this.readyGate
    if (this.readyError) throw this.readyError
  }

  waitForExit(): Promise<{ exitCode: number | null }> {
    return this.exitPromise
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    if (this.stopOverride) {
      await this.stopOverride()
      return
    }
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
  nextReadyGate: Promise<void> | null = null
  lastHandle: FakeRuntimeProcessHandle | null = null

  async start(): Promise<RuntimeProcessHandle> {
    if (this.startError) throw this.startError
    this.lastHandle = new FakeRuntimeProcessHandle()
    this.lastHandle.readyError = this.nextReadyError
    this.lastHandle.readyGate = this.nextReadyGate
    return this.lastHandle
  }
}

function compose(
  runtimeTtlMs = 10 * 60_000,
  entrypoint: "file" | "missing" | "symlink" | "directory" = "file",
) {
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
    const entrypointPath = path.join(
      options.destinationDir,
      "backend",
      "src",
      "server.js",
    )
    if (entrypoint === "file") {
      await mkdir(path.dirname(entrypointPath), { recursive: true })
      await writeFile(entrypointPath, "module.exports = {}")
    } else if (entrypoint === "directory") {
      await mkdir(entrypointPath, { recursive: true })
    } else if (entrypoint === "symlink") {
      await mkdir(path.dirname(entrypointPath), { recursive: true })
      const target = path.join(options.destinationDir, "outside")
      await mkdir(target)
      await symlink(target, entrypointPath, "junction")
    }
  })
  const sandbox = new FakeSandboxProvisioner()
  const installRunner = new FakeCommandRunner()
  const starter = new FakeRuntimeProcessStarter()
  const liveRuntimeRegistry = new LiveBackendRuntimeRegistry()
  const supervisor = new BackendRuntimeSupervisor(
    controlPlane,
    fetcher,
    byteStore,
    extraction,
    sandbox,
    installRunner,
    starter,
    liveRuntimeRegistry,
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
    liveRuntimeRegistry,
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
    const {
      controlPlane,
      queue,
      sandbox,
      installRunner,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose()
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
    // Registered by the time the control plane reports "running".
    expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

    await controlPlane.cancel(runtimeId, requester)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("stopped")
    expect(starter.lastHandle?.stopCalls).toBe(1)
    expect(sandbox.destroyed).toEqual([runtimeId])
    // Cancel unregisters: no live route survives a normal stop.
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("fails with FETCH_FAILED and still destroys the workspace", async () => {
    const {
      controlPlane,
      queue,
      sandbox,
      fetcher,
      liveRuntimeRegistry,
      supervisor,
    } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    fetcher.fetchError = new Error("network down")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("FETCH_FAILED")
    expect(sandbox.destroyed).toEqual([runtimeId])
    // A failure this early never even reached the register() call.
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
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

  it.each(["missing", "symlink", "directory"] as const)(
    "fails before runtime start when the extracted entrypoint is %s",
    async (entrypoint) => {
      const { controlPlane, queue, sandbox, starter, supervisor } = compose(
        10 * 60_000,
        entrypoint,
      )
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)

      await supervisor.run(job)

      const final = await controlPlane.get(runtimeId, requester)
      expect(final.status).toBe("failed")
      expect(final.errorCode).toBe("RUNTIME_START_FAILED")
      expect(starter.lastHandle).toBeNull()
    },
  )

  it("fails with RUNTIME_START_FAILED when the runtime process cannot start", async () => {
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.startError = new Error("runsc run failed")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_START_FAILED")
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("fails with RUNTIME_READINESS_TIMEOUT and stops the half-started process", async () => {
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.nextReadyError = new BackendRuntimeReadinessTimeoutError()

    const runPromise = supervisor.run(job)

    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_READINESS_TIMEOUT")
    expect(starter.lastHandle?.stopCalls).toBeGreaterThanOrEqual(1)
    // A readiness failure never resolves before register() would run, so
    // no route was ever registered to begin with.
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("fails with RUNTIME_EXITED when the process crashes while running, and unregisters strictly before workspace destruction", async () => {
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose()
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    let registeredAtDestroyTime:
      ReturnType<typeof liveRuntimeRegistry.resolve> | "destroy-not-called" =
      "destroy-not-called"
    sandbox.onDestroy = (id) => {
      registeredAtDestroyTime = liveRuntimeRegistry.resolve(id)
    }

    const runPromise = supervisor.run(job)
    await vi.waitFor(async () => {
      const runtime = await controlPlane.get(runtimeId, requester)
      expect(runtime.status).toBe("running")
    })
    expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

    starter.lastHandle!.crash(1)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_EXITED")
    expect(sandbox.destroyed).toEqual([runtimeId])
    // The registry must already be clear by the time workspace/network
    // teardown begins -- proven directly, not just after the fact.
    expect(registeredAtDestroyTime).toBeUndefined()
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("stops cleanly once the control plane's own TTL expires", async () => {
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
      setNow,
    } = compose(1_000)
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)

    const runPromise = supervisor.run(job)
    await vi.waitFor(async () => {
      const runtime = await controlPlane.get(runtimeId, requester)
      expect(runtime.status).toBe("running")
    })
    expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

    setNow(new Date(Date.now() + 2_000))
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("expired")
    expect(starter.lastHandle?.stopCalls).toBe(1)
    expect(sandbox.destroyed).toEqual([runtimeId])
    // Expiry unregisters just like an explicit stop.
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
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

  describe("live runtime route registration", () => {
    it("never registers a route until after waitUntilReady() has actually succeeded", async () => {
      const {
        controlPlane,
        queue,
        sandbox,
        starter,
        liveRuntimeRegistry,
        supervisor,
      } = compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)
      let releaseReady!: () => void
      starter.nextReadyGate = new Promise((resolve) => {
        releaseReady = resolve
      })

      const runPromise = supervisor.run(job)
      // Wait until the process has actually started (fetch/install/start
      // have all completed) but is held inside waitUntilReady().
      await vi.waitFor(() => {
        expect(starter.lastHandle).not.toBeNull()
      })
      const runtimeDuringStarting = await controlPlane.get(runtimeId, requester)
      expect(runtimeDuringStarting.status).toBe("starting")
      // Not registered during fetch/install/start, and not registered
      // before waitUntilReady() resolves.
      expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()

      releaseReady()
      await vi.waitFor(async () => {
        const runtime = await controlPlane.get(runtimeId, requester)
        expect(runtime.status).toBe("running")
      })
      expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

      await controlPlane.cancel(runtimeId, requester)
      await runPromise
    })

    it('registers the route before the control plane is ever told the runtime is "running"', async () => {
      const { controlPlane, queue, sandbox, liveRuntimeRegistry, supervisor } =
        compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)
      const originalMarkPhase = controlPlane.markPhase.bind(controlPlane)
      let resolvedWhenMarkedRunning:
        ReturnType<typeof liveRuntimeRegistry.resolve> | "never-called" =
        "never-called"
      vi.spyOn(controlPlane, "markPhase").mockImplementation(
        async (id, phase) => {
          if (phase === "running") {
            resolvedWhenMarkedRunning = liveRuntimeRegistry.resolve(id)
          }
          return originalMarkPhase(id, phase)
        },
      )

      const runPromise = supervisor.run(job)
      await vi.waitFor(async () => {
        const runtime = await controlPlane.get(runtimeId, requester)
        expect(runtime.status).toBe("running")
      })

      expect(resolvedWhenMarkedRunning).toEqual(FAKE_DIAL_TARGET)

      await controlPlane.cancel(runtimeId, requester)
      await runPromise
    })

    it("fails the runtime closed and leaves no live route when registration itself conflicts", async () => {
      const { controlPlane, queue, sandbox, liveRuntimeRegistry, supervisor } =
        compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)
      // Simulate an already-broken precondition: some other owner already
      // holds a *different* live route under this exact runtimeId.
      liveRuntimeRegistry.register(runtimeId, {
        host: "10.0.0.1",
        port: 9_999,
      })

      await supervisor.run(job)

      const final = await controlPlane.get(runtimeId, requester)
      expect(final.status).toBe("failed")
      expect(final.status).not.toBe("running")
      // Whatever the outcome, this runtimeId must not be left resolvable
      // once run() has finished.
      expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
    })

    it('cleans up the registration when markPhase("running") itself fails immediately after a successful register', async () => {
      const { controlPlane, queue, sandbox, liveRuntimeRegistry, supervisor } =
        compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)
      const originalMarkPhase = controlPlane.markPhase.bind(controlPlane)
      vi.spyOn(controlPlane, "markPhase").mockImplementation(
        async (id, phase) => {
          if (phase === "running") {
            throw new Error("control plane unavailable")
          }
          return originalMarkPhase(id, phase)
        },
      )

      await supervisor.run(job)

      const final = await controlPlane.get(runtimeId, requester)
      expect(final.status).toBe("failed")
      expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
    })

    it("never preserves a live route even when stop()/cleanup itself fails", async () => {
      const {
        controlPlane,
        queue,
        sandbox,
        starter,
        liveRuntimeRegistry,
        supervisor,
      } = compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)

      const runPromise = supervisor.run(job)
      await vi.waitFor(async () => {
        const runtime = await controlPlane.get(runtimeId, requester)
        expect(runtime.status).toBe("running")
      })
      expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

      starter.lastHandle!.stopOverride = async () => {
        throw new Error("runsc kill failed")
      }
      await controlPlane.cancel(runtimeId, requester)
      // run() may itself reject if stop() throws inside the teardown
      // finally block -- what matters here is the registry's own state,
      // not whether the promise resolves or rejects.
      await runPromise.catch(() => undefined)

      expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
    })
  })
})
