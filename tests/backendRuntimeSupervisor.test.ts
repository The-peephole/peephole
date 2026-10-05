import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BackendRuntimeSupervisor } from "../services/backend-runtime-worker/backendRuntimeSupervisor"
import { BackendRuntimeWorkerLoop } from "../services/backend-runtime-worker/backendRuntimeWorkerLoop"
import type {
  BackendRuntimeDialTarget,
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "../services/backend-runtime-worker/ports"
import { LiveBackendRuntimeRegistry } from "../services/backend-runtime-worker/liveRuntimeRegistry"
import {
  InMemoryBackendRuntimeSecretBroker,
  type BackendRuntimeSecretBroker,
} from "../services/backend-runtime-worker/secretBroker"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeQueue,
  InMemoryBackendRuntimeStore,
} from "../services/backend-runtime-api/inMemoryAdapters"
import { BackendRuntimeReadinessTimeoutError } from "../services/preview-worker/gvisor/backendRuntimeProcess"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import {
  deriveTemporaryDatabaseObjectName,
  validateTemporaryDatabaseResourceId,
} from "../core/backendDatabase/resourceIdentity"
import { ArchiveByteStore } from "../services/preview-worker/local/archiveByteStore"
import type { CommandRunner } from "../services/preview-worker/local/commandRunner"
import { ExtractionState } from "../services/preview-worker/local/extractionState"
import type {
  PreviewWorkspace,
  SandboxProvisioner,
  SourceArchiveFetcher,
} from "../services/preview-worker/ports"
import type { BackendRuntimePlan } from "../types/backendRuntime"
import type { TemporaryDatabaseLifecycleProvisioner } from "../services/backend-runtime-worker/backendRuntimeSupervisor"

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
  generatedSecretNames: [],
  databaseRequirement: null,
}

const secretPlan: BackendRuntimePlan = {
  ...plan,
  generatedSecretNames: ["SESSION_SECRET"],
}

const databasePlan: BackendRuntimePlan = {
  ...plan,
  databaseRequirement: { name: "DATABASE_URL" },
}

const secretDatabasePlan: BackendRuntimePlan = {
  ...databasePlan,
  generatedSecretNames: ["SESSION_SECRET"],
}

const databaseResourceId = validateTemporaryDatabaseResourceId(
  `r${"1".repeat(28)}`,
)

class FakeTemporaryDatabaseProvisioner implements TemporaryDatabaseLifecycleProvisioner {
  provisionError: Error | null = null
  revokeError: Error | null = null
  provisionGate: Promise<void> | null = null
  calls: Array<{ previewId: string; backendRuntimeId: string }> = []
  revoked: string[] = []
  events: string[] = []
  onRevoke?: () => void | Promise<void>

  async provision(input: { previewId: string; backendRuntimeId: string }) {
    this.calls.push(input)
    this.events.push("provision")
    if (this.provisionGate) await this.provisionGate
    if (this.provisionError) throw this.provisionError
    const objectName = deriveTemporaryDatabaseObjectName(databaseResourceId)
    return {
      resourceId: databaseResourceId,
      databaseName: objectName,
      roleName: objectName,
      password: createOpaqueSecretValue("database-password-marker"),
    }
  }

  async revoke(resourceId: typeof databaseResourceId) {
    this.events.push("revoke")
    this.revoked.push(resourceId)
    await this.onRevoke?.()
    if (this.revokeError) throw this.revokeError
  }
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
  lastSecrets: Parameters<BackendRuntimeProcessStarter["start"]>[2] | undefined
  lastDatabase: Parameters<BackendRuntimeProcessStarter["start"]>[3] | undefined

  async start(
    ...args: Parameters<BackendRuntimeProcessStarter["start"]>
  ): Promise<RuntimeProcessHandle> {
    this.lastSecrets = args[2]
    this.lastDatabase = args[3]
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
  secretBroker?: BackendRuntimeSecretBroker,
  resolvedPlan: BackendRuntimePlan = plan,
  temporaryDatabaseProvisioner?: TemporaryDatabaseLifecycleProvisioner,
) {
  const store = new InMemoryBackendRuntimeStore()
  const queue = new InMemoryBackendRuntimeQueue()
  const resolver = { resolve: vi.fn().mockResolvedValue(resolvedPlan) }
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
    {
      cancellationPollMs: 20,
      monitorPollMs: 20,
      readinessTimeoutMs: 200,
      secretBroker,
      temporaryDatabaseProvisioner,
    },
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
    temporaryDatabaseProvisioner,
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

async function createAndLeaseForOrchestration(
  controlPlane: BackendRuntimeControlPlane,
  queue: InMemoryBackendRuntimeQueue,
) {
  const created = await controlPlane.createForOrchestration(
    { repository, contractVersion: "backend-v1" },
    requester.subject,
    "fullstack-00000000-0000-0000-0000-000000000001",
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

  it("fails a corrupt database job without orchestration identity before any execution boundary", async () => {
    const {
      controlPlane,
      queue,
      fetcher,
      sandbox,
      installRunner,
      starter,
      supervisor,
    } = compose(10 * 60_000, "file", undefined, databasePlan)
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const fetch = vi.spyOn(fetcher, "fetch")
    const allocate = vi.spyOn(sandbox, "allocate")

    await supervisor.run({ ...job, orchestrationKey: null })

    const final = await controlPlane.get(runtimeId, requester)
    expect(final).toMatchObject({
      status: "failed",
      errorCode: "RUNTIME_UNAVAILABLE",
    })
    expect(allocate).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(installRunner.calls).toEqual([])
    expect(starter.lastHandle).toBeNull()
  })

  it("fails an owned database job with DATABASE_UNAVAILABLE before any execution boundary", async () => {
    const {
      controlPlane,
      queue,
      fetcher,
      sandbox,
      installRunner,
      starter,
      supervisor,
    } = compose(10 * 60_000, "file", undefined, databasePlan)
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const fetch = vi.spyOn(fetcher, "fetch")
    const allocate = vi.spyOn(sandbox, "allocate")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final).toMatchObject({
      status: "failed",
      errorCode: "DATABASE_UNAVAILABLE",
      errorMessage:
        "The backend runtime's temporary database is unavailable. Start a new preview.",
    })
    expect(allocate).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(installRunner.calls).toEqual([])
    expect(starter.lastHandle).toBeNull()
  })

  it("keeps non-database runtimes on the zero-cost path when a provisioner is available", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      plan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)

    expect(provisioner.calls).toEqual([])
    expect(starter.lastDatabase).toBeNull()
    await controlPlane.cancel(runtimeId, requester)
    await run
    expect(provisioner.revoked).toEqual([])
  })

  it("does not provision when backend installation fails", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, installRunner, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    installRunner.installError = new Error("npm ci failed")
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    expect(provisioner.calls).toEqual([])
    expect(provisioner.revoked).toEqual([])
    expect(await controlPlane.get(runtimeId, requester)).toMatchObject({
      status: "failed",
      errorCode: "INSTALL_FAILED",
    })
  })

  it("provisions from the trusted queue identities and passes the canonical URL to the starter", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)

    expect(provisioner.calls).toEqual([
      {
        previewId: job.orchestrationKey,
        backendRuntimeId: runtimeId,
      },
    ])
    expect(starter.lastDatabase).toMatchObject({
      runtimeId,
      resourceId: databaseResourceId,
    })
    expect(starter.lastDatabase?.databaseUrl.reveal()).toBe(
      `postgresql://pv_${databaseResourceId}:database-password-marker@192.168.253.1:5433/pv_${databaseResourceId}`,
    )

    await controlPlane.cancelForOrchestration(runtimeId, requester.subject)
    await run
    expect(provisioner.revoked).toEqual([databaseResourceId])
  })

  it("orders route, process credential, workspace network, database, then terminal cleanup", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const events: string[] = []
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose(10 * 60_000, "file", undefined, databasePlan, provisioner)
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)
    starter.lastHandle!.stopOverride = async () => {
      events.push("process-and-credentials")
    }
    sandbox.onDestroy = () => {
      expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
      events.push("workspace-and-network")
    }
    provisioner.onRevoke = async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "stopping",
      )
      events.push("database")
    }

    await controlPlane.cancelForOrchestration(runtimeId, requester.subject)
    await run
    events.push(
      (await controlPlane.get(runtimeId, requester)).status === "stopped"
        ? "backend-stopped"
        : "unexpected-terminal",
    )

    expect(events).toEqual([
      "process-and-credentials",
      "workspace-and-network",
      "database",
      "backend-stopped",
    ])
  })

  it("delivers generated secrets and database material together exactly once", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take")
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretDatabasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)

    expect(issue).toHaveBeenCalledExactlyOnceWith(runtimeId, ["SESSION_SECRET"])
    expect(take).toHaveBeenCalledExactlyOnceWith(runtimeId)
    expect(starter.lastSecrets?.runtimeId).toBe(runtimeId)
    expect(starter.lastDatabase?.runtimeId).toBe(runtimeId)
    expect(provisioner.calls).toHaveLength(1)

    await controlPlane.cancelForOrchestration(runtimeId, requester.subject)
    await run
    expect(provisioner.revoked).toEqual([databaseResourceId])
  })

  it("keeps cancellation during database-owning starting in stopping until revoke completes", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    let releaseProvision!: () => void
    provisioner.provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve
    })
    const { controlPlane, queue, sandbox, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(() => expect(provisioner.calls).toHaveLength(1))
    createdRoots.push(...sandbox.roots)

    const cancelled = await controlPlane.cancelForOrchestration(
      runtimeId,
      requester.subject,
    )
    expect(cancelled.status).toBe("stopping")
    releaseProvision()
    await run

    expect(provisioner.revoked).toEqual([databaseResourceId])
    expect((await controlPlane.get(runtimeId, requester)).status).toBe(
      "stopped",
    )
  })

  it("revokes before publishing a process-start failure", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    starter.startError = new Error("start failed")
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    provisioner.onRevoke = async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "starting",
      )
    }

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    expect(provisioner.revoked).toEqual([databaseResourceId])
    expect(await controlPlane.get(runtimeId, requester)).toMatchObject({
      status: "failed",
      errorCode: "RUNTIME_START_FAILED",
    })
  })

  it("revokes after an unexpected runtime exit before publishing failure", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(() => expect(starter.lastHandle).not.toBeNull())
    createdRoots.push(...sandbox.roots)
    starter.lastHandle?.crash(1)
    await run

    expect(provisioner.revoked).toEqual([databaseResourceId])
    expect(await controlPlane.get(runtimeId, requester)).toMatchObject({
      status: "failed",
      errorCode: "RUNTIME_EXITED",
    })
  })

  it("attempts database cleanup on expiry and publishes stopped only afterward", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    const { controlPlane, queue, sandbox, supervisor, setNow } = compose(
      1_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)
    provisioner.onRevoke = async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "stopping",
      )
    }
    setNow(new Date("2026-01-01T00:00:02.000Z"))
    await run

    expect(provisioner.revoked).toEqual([databaseResourceId])
    expect((await controlPlane.get(runtimeId, requester)).status).toBe(
      "stopped",
    )
  })

  it("fails closed on revoke failure and a handled retry cannot provision database two", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    provisioner.revokeError = new Error("revoke failed")
    const { controlPlane, queue, sandbox, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    const { runtimeId, job } = await createAndLeaseForOrchestration(
      controlPlane,
      queue,
    )
    const run = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)
    await controlPlane.cancelForOrchestration(runtimeId, requester.subject)
    await run

    expect(await controlPlane.get(runtimeId, requester)).toMatchObject({
      status: "failed",
      errorCode: "DATABASE_UNAVAILABLE",
    })
    expect(
      JSON.stringify(await controlPlane.get(runtimeId, requester)),
    ).not.toContain("database-password-marker")
    expect(provisioner.calls).toHaveLength(1)
    await supervisor.run(job, { recovered: true })
    expect(provisioner.calls).toHaveLength(1)
    expect(provisioner.revoked).toEqual([databaseResourceId])
  })

  it("acknowledges a handled provisioned-runtime failure without a queue retry or database two", async () => {
    const provisioner = new FakeTemporaryDatabaseProvisioner()
    provisioner.revokeError = new Error("revoke failed")
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      databasePlan,
      provisioner,
    )
    starter.startError = new Error("process start failed")
    const created = await controlPlane.createForOrchestration(
      { repository, contractVersion: "backend-v1" },
      requester.subject,
      "fullstack-00000000-0000-0000-0000-000000000001",
    )
    const loop = new BackendRuntimeWorkerLoop(queue, supervisor, {
      workerId: "worker-1",
      leaseMs: 1_000,
    })

    await expect(loop.runOnce()).resolves.toBe(true)
    createdRoots.push(...sandbox.roots)
    await expect(loop.runOnce()).resolves.toBe(false)

    expect(provisioner.calls).toHaveLength(1)
    expect(provisioner.revoked).toEqual([databaseResourceId])
    expect(await controlPlane.get(created.runtime.id, requester)).toMatchObject(
      {
        status: "failed",
        errorCode: "DATABASE_UNAVAILABLE",
      },
    )
  })

  it("runs fetch -> install -> start -> running, then stays running until told to stop", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take")
    const discard = vi.spyOn(broker, "discard")
    const {
      controlPlane,
      queue,
      sandbox,
      installRunner,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose(10 * 60_000, "file", broker)
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
    expect(starter.lastSecrets).toBeNull()
    expect(issue).not.toHaveBeenCalled()
    expect(take).not.toHaveBeenCalled()
    // Registered by the time the control plane reports "running".
    expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

    await controlPlane.cancel(runtimeId, requester)
    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("stopped")
    expect(starter.lastHandle?.stopCalls).toBe(1)
    expect(sandbox.destroyed).toEqual([runtimeId])
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
    // Cancel unregisters: no live route survives a normal stop.
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("issues and destructively takes generated material exactly once before start", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take")
    const discard = vi.spyOn(broker, "discard")
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretPlan,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)

    const runPromise = supervisor.run(job)
    await vi.waitFor(async () => {
      expect((await controlPlane.get(runtimeId, requester)).status).toBe(
        "running",
      )
    })
    createdRoots.push(...sandbox.roots)

    expect(issue).toHaveBeenCalledExactlyOnceWith(runtimeId, ["SESSION_SECRET"])
    expect(take).toHaveBeenCalledExactlyOnceWith(runtimeId)
    expect(starter.lastSecrets).toBe(take.mock.results[0]?.value)
    expect(starter.lastSecrets?.runtimeId).toBe(runtimeId)
    expect([...(starter.lastSecrets?.values.keys() ?? [])]).toEqual([
      "SESSION_SECRET",
    ])
    expect(broker.take(runtimeId)).toBeNull()

    const publicRuntime = await controlPlane.get(runtimeId, requester)
    expect(JSON.stringify(publicRuntime)).not.toContain("generatedSecretNames")
    expect(JSON.stringify(publicRuntime)).not.toContain("values")

    await controlPlane.cancel(runtimeId, requester)
    await runPromise

    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
  })

  it("fails with SECRET_UNAVAILABLE without starting when a non-empty plan has no broker", async () => {
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      undefined,
      secretPlan,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final).toMatchObject({
      status: "failed",
      errorCode: "SECRET_UNAVAILABLE",
      errorMessage:
        "The backend runtime's secret material is no longer available. Start a new preview.",
    })
    expect(starter.lastHandle).toBeNull()
    expect(starter.lastSecrets).toBeUndefined()
  })

  it("fails with SECRET_UNAVAILABLE without fallback or retry when take returns null", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take").mockReturnValue(null)
    const discard = vi.spyOn(broker, "discard")
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretPlan,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.errorCode).toBe("SECRET_UNAVAILABLE")
    expect(issue).toHaveBeenCalledTimes(1)
    expect(take).toHaveBeenCalledTimes(1)
    expect(starter.lastHandle).toBeNull()
    expect(starter.lastSecrets).toBeUndefined()
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
  })

  it("fails closed on duplicate broker issuance and discards the stale entry", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretPlan,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    broker.issue(runtimeId, ["SESSION_SECRET"])
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take")
    const discard = vi.spyOn(broker, "discard")

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.errorCode).toBe("SECRET_UNAVAILABLE")
    expect(final.errorMessage).toBe(
      "The backend runtime's secret material is no longer available. Start a new preview.",
    )
    expect(issue).toHaveBeenCalledTimes(1)
    expect(take).not.toHaveBeenCalled()
    expect(starter.lastHandle).toBeNull()
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
    expect(broker.take(runtimeId)).toBeNull()
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
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const discard = vi.spyOn(broker, "discard")
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose(10 * 60_000, "file", broker, secretPlan)
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.startError = new Error("runsc run failed")

    await supervisor.run(job)

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_START_FAILED")
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
    expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
  })

  it("continues process and workspace teardown when broker discard fails", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    vi.spyOn(broker, "discard").mockImplementation(() => {
      throw new Error("broker cleanup failed")
    })
    const { controlPlane, queue, sandbox, starter, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretPlan,
    )
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    starter.startError = new Error("runsc run failed")

    await supervisor.run(job)
    createdRoots.push(...sandbox.roots)

    expect((await controlPlane.get(runtimeId, requester)).errorCode).toBe(
      "RUNTIME_START_FAILED",
    )
    expect(sandbox.destroyed).toEqual([runtimeId])
  })

  it("fails with RUNTIME_READINESS_TIMEOUT and stops the half-started process", async () => {
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const discard = vi.spyOn(broker, "discard")
    const {
      controlPlane,
      queue,
      sandbox,
      starter,
      liveRuntimeRegistry,
      supervisor,
    } = compose(10 * 60_000, "file", broker, secretPlan)
    const { runtimeId, job } = await createAndLease(controlPlane, queue)
    createdRoots.push(...sandbox.roots)
    starter.nextReadyError = new BackendRuntimeReadinessTimeoutError()

    const runPromise = supervisor.run(job)

    await runPromise

    const final = await controlPlane.get(runtimeId, requester)
    expect(final.status).toBe("failed")
    expect(final.errorCode).toBe("RUNTIME_READINESS_TIMEOUT")
    expect(starter.lastHandle?.stopCalls).toBeGreaterThanOrEqual(1)
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
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
    const broker = new InMemoryBackendRuntimeSecretBroker()
    const issue = vi.spyOn(broker, "issue")
    const take = vi.spyOn(broker, "take")
    const discard = vi.spyOn(broker, "discard")
    const { controlPlane, queue, sandbox, fetcher, supervisor } = compose(
      10 * 60_000,
      "file",
      broker,
      secretPlan,
    )
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
    expect(issue).not.toHaveBeenCalled()
    expect(take).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledExactlyOnceWith(runtimeId)
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

    it("unregisters synchronously, with no await first, even while a control-plane isWorkerRuntimeActive check is still in flight", async () => {
      const { controlPlane, queue, sandbox, liveRuntimeRegistry, supervisor } =
        compose()
      const { runtimeId, job } = await createAndLease(controlPlane, queue)
      createdRoots.push(...sandbox.roots)

      const runPromise = supervisor.run(job)
      await vi.waitFor(async () => {
        const runtime = await controlPlane.get(runtimeId, requester)
        expect(runtime.status).toBe("running")
      })
      expect(liveRuntimeRegistry.resolve(runtimeId)).toEqual(FAKE_DIAL_TARGET)

      // Stall the *separate* isWorkerRuntimeActive poller (the one behind
      // run()'s own `checking` variable, independent of
      // monitorWhileRunning's shouldContinueRunning poll) so a `checking`
      // promise is genuinely still pending when teardown begins.
      let releaseCheck!: (value: boolean) => void
      const stuckCheck = new Promise<boolean>((resolve) => {
        releaseCheck = resolve
      })
      const isWorkerRuntimeActiveSpy = vi
        .spyOn(controlPlane, "isWorkerRuntimeActive")
        .mockReturnValue(stuckCheck)
      await vi.waitFor(() => {
        expect(isWorkerRuntimeActiveSpy).toHaveBeenCalled()
      })

      let runSettled = false
      void runPromise.then(() => {
        runSettled = true
      })

      // Cancellation reaches run() through monitorWhileRunning's own
      // independent shouldContinueRunning poll, not through the stuck
      // isWorkerRuntimeActive call -- so this can proceed even though that
      // call never resolves.
      await controlPlane.cancel(runtimeId, requester)

      // The route must clear promptly -- proving unregister() ran as the
      // very first, synchronous statement in the finally block, without
      // waiting on `checking` -- while run() itself is still blocked on
      // that same still-pending `checking` promise a few lines later.
      await vi.waitFor(() => {
        expect(liveRuntimeRegistry.resolve(runtimeId)).toBeUndefined()
      })
      expect(runSettled).toBe(false)

      releaseCheck(true)
      await runPromise

      const final = await controlPlane.get(runtimeId, requester)
      expect(final.status).toBe("stopped")
      expect(runSettled).toBe(true)
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
