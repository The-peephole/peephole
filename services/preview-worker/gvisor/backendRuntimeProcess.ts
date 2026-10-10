import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import path from "node:path"

import type { SandboxResourceLimits } from "../../../core/runner/runnerLimits"
import { DEFAULT_SANDBOX_RESOURCE_LIMITS } from "../../../core/runner/runnerLimits"
import { isSafePreviewSourceRoot } from "../../../core/preview/sourceRoot"
import { BACKEND_RUNTIME_DATABASE_ENV_NAME } from "../../../types/backendRuntimeDatabase"
import type { BackendRuntimePlan } from "../../../types/backendRuntime"
import type { GeneratedSecretMaterial } from "../../../types/backendRuntimeSecrets"
import type { TemporaryDatabaseRuntimeCredentialMaterial } from "../../../types/temporaryDatabase"
import type { UserEnvironmentMaterial } from "../../../types/userEnvironment"
import type {
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "../../backend-runtime-worker/ports"
import type { LocalPreviewWorkspace } from "../local/localWorkspace"
import { resolveDnsConfig } from "./dnsConfig"
import { asGVisorWorkspace } from "./gvisorWorkspace"
import {
  DATABASE_CREDENTIAL_FILE_NAME,
  type DatabaseCredentialFilesystem,
} from "./databaseCredentialFilesystem"
import {
  GENERATED_SECRET_FILE_NAME,
  type GeneratedSecretFilesystem,
} from "./generatedSecretFilesystem"
import { buildOciRuntimeSpec } from "./ociConfig"
import {
  USER_ENVIRONMENT_FILE_NAME,
  type UserEnvironmentFilesystem,
} from "./userEnvironmentFilesystem"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner, ProcessRunResult } from "./processRunner"
import { runscDeleteArgs, runscKillArgs, runscRunArgs } from "./runscCli"
import {
  SANDBOX_GID,
  SANDBOX_NODE_BINARY,
  SANDBOX_SECRET_BOOTSTRAP,
  SANDBOX_UID,
  SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG,
} from "./sandboxIdentity"

/** Thrown by `waitUntilReady` when the process exits before ever accepting
 * a connection -- a distinct, callers-can-distinguish failure from a bare
 * timeout so the control plane can report RUNTIME_START_FAILED instead of
 * RUNTIME_READINESS_TIMEOUT. */
export class BackendRuntimeExitedBeforeReadyError extends Error {
  constructor(public readonly exitCode: number | null) {
    super(
      `Backend runtime process exited before becoming ready (exit code ${String(exitCode)}).`,
    )
    this.name = "BackendRuntimeExitedBeforeReadyError"
  }
}

/** Thrown by `waitUntilReady` when the readiness deadline elapses while the
 * process is still running. */
export class BackendRuntimeReadinessTimeoutError extends Error {
  constructor() {
    super("Backend runtime did not become ready before the readiness timeout.")
    this.name = "BackendRuntimeReadinessTimeoutError"
  }
}

export interface GVisorBackendRuntimeProcessOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  resourceLimits?: SandboxResourceLimits
  processRunner?: ProcessRunner
  resolveDnsConfig?: typeof resolveDnsConfig
  /** Hard ceiling passed to the OS process runner as its own `timeoutMs`,
   * independent of and in addition to the control plane's own TTL
   * bookkeeping -- a second, host-process-level backstop in case the
   * control plane's own timer never fires (e.g. a worker crash). */
  maxRuntimeMs?: number
  /** Fixed polling interval used once the exponential backoff below has
   * grown past it. */
  maxProbeIntervalMs?: number
  /** Required only when `start()` receives generated material. Production
   * M10-B callers pass null and do not activate this path yet. */
  generatedSecretFilesystem?: GeneratedSecretFilesystem
  /** Required only when `start()` receives temporary-database credential
   * material (M11-C3). Not yet activated by any production composition --
   * see `BackendRuntimeProcessStarter.start()`'s own doc comment. */
  databaseCredentialFilesystem?: DatabaseCredentialFilesystem
  /** Required only when `start()` receives M12 user-provided configuration. */
  userEnvironmentFilesystem?: UserEnvironmentFilesystem
  /** Bounded window `stop()` gives the sandboxed process to exit on its own
   * after a polite `SIGTERM` before the unconditional `runsc delete --force`
   * backstop below proceeds regardless. Only a well-behaved process (or the
   * trusted secret bootstrap forwarding the signal to one) benefits; a
   * process that ignores or outlives it is still force-terminated by that
   * backstop, so this can never turn into an unbounded hang. */
  stopGraceMs?: number
}

/**
 * The persistent-server counterpart to RunscCommandRunner's "one command,
 * wait for exit, delete" primitive. `runsc run` is itself a foreground,
 * blocking CLI invocation (confirmed against runscCli.ts/runscCommandRunner.ts)
 * -- there is no "start in the background" runsc flag -- so this fires that
 * same call and deliberately never awaits its completion inline. Readiness
 * is observed independently, from the host's own root network namespace, by
 * dialing the sandbox's directly-connected veth-peer address
 * (`ensureIngressOnlyNetworkNamespace()`'s `peerIp`): that connection is
 * host-locally-generated OUTPUT traffic delivered straight over the veth
 * link, so it reaches the sandbox regardless of the ingress-only egress
 * policy configured inside it (see networkNamespace.ts's
 * `configureIngressOnlyFirewall`) -- no firewall exception is needed for the
 * probe itself, only for the reply, which the ingress-only inputChain
 * already allows for ESTABLISHED/RELATED traffic.
 *
 * Stopping never relies on OS-level signal delivery to the local `runsc
 * run` CLI process (that primitive is reserved for RunscCommandRunner's own
 * short-lived containers). Instead this always goes through runsc's own
 * container lifecycle commands -- `runsc kill` then `runsc delete` -- the
 * same pair GVisorSandboxProvisioner.destroy() and RunscCommandRunner.run()
 * already use, so a leftover container is always cleaned up the same,
 * already-hardened way regardless of which code path created it.
 */
export class GVisorBackendRuntimeProcess implements BackendRuntimeProcessStarter {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly resourceLimits: SandboxResourceLimits
  private readonly processRunner: ProcessRunner
  private readonly resolveDnsConfig: typeof resolveDnsConfig
  private readonly maxRuntimeMs: number
  private readonly maxProbeIntervalMs: number
  private readonly generatedSecretFilesystem?: GeneratedSecretFilesystem
  private readonly databaseCredentialFilesystem?: DatabaseCredentialFilesystem
  private readonly userEnvironmentFilesystem?: UserEnvironmentFilesystem
  private readonly stopGraceMs: number

  constructor(options: GVisorBackendRuntimeProcessOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.resourceLimits =
      options.resourceLimits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.resolveDnsConfig = options.resolveDnsConfig ?? resolveDnsConfig
    this.maxRuntimeMs = options.maxRuntimeMs ?? 15 * 60_000
    this.maxProbeIntervalMs = options.maxProbeIntervalMs ?? 1_000
    this.generatedSecretFilesystem = options.generatedSecretFilesystem
    this.databaseCredentialFilesystem = options.databaseCredentialFilesystem
    this.userEnvironmentFilesystem = options.userEnvironmentFilesystem
    this.stopGraceMs = options.stopGraceMs ?? 5_000

    // Both filesystem roots are independently injectable (test/config seams),
    // so neither one can know the other's actual configured root on its own.
    // This constructor is the lowest trusted boundary that owns both
    // instances -- fail closed here, before any credential is ever created,
    // if the two configured roots are the same or nested either direction
    // (M11-C3 review correction; see docs/TEMPORARY_DATABASES.md section 15).
    if (
      this.generatedSecretFilesystem &&
      this.databaseCredentialFilesystem &&
      pathsOverlap(
        path.resolve(this.generatedSecretFilesystem.rootDir),
        path.resolve(this.databaseCredentialFilesystem.rootDir),
      )
    ) {
      throw new Error(
        "Generated-secret and database credential filesystem roots must be disjoint.",
      )
    }
    const credentialRoots = [
      this.generatedSecretFilesystem?.rootDir,
      this.databaseCredentialFilesystem?.rootDir,
    ].filter((root): root is string => root !== undefined)
    if (
      this.userEnvironmentFilesystem &&
      credentialRoots.some((root) =>
        pathsOverlap(
          path.resolve(root),
          path.resolve(this.userEnvironmentFilesystem!.rootDir),
        ),
      )
    ) {
      throw new Error(
        "User environment and credential filesystem roots must be disjoint.",
      )
    }
  }

  async start(
    workspace: LocalPreviewWorkspace,
    plan: BackendRuntimePlan,
    secrets: GeneratedSecretMaterial | null = null,
    databaseCredential: TemporaryDatabaseRuntimeCredentialMaterial | null = null,
    userEnvironment: UserEnvironmentMaterial | null = null,
  ): Promise<RuntimeProcessHandle> {
    if (!isSafePreviewSourceRoot(plan.sourceRoot)) {
      throw new Error("Backend runtime plan sourceRoot is unsafe.")
    }
    // The plan's `start.command` is the logical, allowlist-validated value
    // "node" (validateBackendRuntimePlan). The OCI container has no shell
    // and no PATH, so a bare "node" cannot be resolved by executable-name
    // lookup -- translate it here, at the trusted runtime boundary, to the
    // base rootfs's fixed absolute Node path.
    if (plan.start.command !== "node") {
      throw new Error('Backend runtime plan start command must be "node".')
    }
    assertSecretMaterialMatchesPlan(workspace.id, plan, secrets)
    assertDatabaseCredentialMatchesPlan(workspace.id, plan, databaseCredential)
    assertUserEnvironmentMatchesPlan(workspace.id, plan, userEnvironment)
    const sandbox = asGVisorWorkspace(workspace)

    const dnsConfig = this.resolveDnsConfig()
    const containerId = `${sandbox.id}-backend-${randomBytes(4).toString("hex")}`
    let secretMountSource: string | undefined
    let secretCreated = false
    let secretCleanupPromise: Promise<void> | null = null
    const cleanupSecrets = (): Promise<void> => {
      if (!secretCreated || !secrets || !this.generatedSecretFilesystem) {
        return Promise.resolve()
      }
      secretCleanupPromise ??= this.generatedSecretFilesystem
        .remove(secrets.runtimeId)
        .then(() => {
          secretCreated = false
        })
        .catch((error: unknown) => {
          secretCleanupPromise = null
          throw error
        })
      return secretCleanupPromise
    }

    let databaseCredentialMountSource: string | undefined
    let databaseCredentialCreated = false
    let databaseCredentialCleanupPromise: Promise<void> | null = null
    const cleanupDatabaseCredential = (): Promise<void> => {
      if (
        !databaseCredentialCreated ||
        !databaseCredential ||
        !this.databaseCredentialFilesystem
      ) {
        return Promise.resolve()
      }
      databaseCredentialCleanupPromise ??= this.databaseCredentialFilesystem
        .remove(databaseCredential.runtimeId)
        .then(() => {
          databaseCredentialCreated = false
        })
        .catch((error: unknown) => {
          databaseCredentialCleanupPromise = null
          throw error
        })
      return databaseCredentialCleanupPromise
    }

    let userEnvironmentMountSource: string | undefined
    let userEnvironmentCreated = false
    let userEnvironmentCleanupPromise: Promise<void> | null = null
    const cleanupUserEnvironment = (): Promise<void> => {
      if (
        !userEnvironmentCreated ||
        !userEnvironment ||
        !this.userEnvironmentFilesystem
      ) {
        return Promise.resolve()
      }
      userEnvironmentCleanupPromise ??= this.userEnvironmentFilesystem
        .remove(userEnvironment.runtimeId)
        .then(() => {
          userEnvironmentCreated = false
        })
        .catch((error: unknown) => {
          userEnvironmentCleanupPromise = null
          throw error
        })
      return userEnvironmentCleanupPromise
    }

    // Every material cleanup is always attempted, independently -- one
    // failing must never silently skip another (docs/TEMPORARY_DATABASES.md
    // section 15 / M11-C3 lifecycle requirements; M12 adds a third).
    const cleanupCredentials = async (): Promise<void> => {
      const results = await Promise.allSettled([
        cleanupSecrets(),
        cleanupDatabaseCredential(),
        cleanupUserEnvironment(),
      ])
      const errors = results
        .filter(
          (settled): settled is PromiseRejectedResult =>
            settled.status === "rejected",
        )
        .map((settled) => settled.reason as unknown)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Backend runtime credential cleanup failed.",
        )
      }
    }

    let namespacePath: string | undefined
    let peerIp: string | undefined

    try {
      if (secrets) {
        if (!this.generatedSecretFilesystem) {
          throw new Error(
            "Generated-secret filesystem is unavailable for this runtime.",
          )
        }
        if (
          pathsOverlap(
            path.resolve(this.generatedSecretFilesystem.rootDir),
            path.resolve(sandbox.bundleDir),
          )
        ) {
          throw new Error(
            "Generated-secret root overlaps persistent runtime storage.",
          )
        }
        const runtimeDir = await this.generatedSecretFilesystem.create(secrets)
        secretCreated = true
        const expectedRuntimeDir = path.join(
          path.resolve(this.generatedSecretFilesystem.rootDir),
          secrets.runtimeId,
        )
        if (path.resolve(runtimeDir) !== expectedRuntimeDir) {
          throw new Error("Generated-secret mount source is invalid.")
        }
        secretMountSource = path.join(runtimeDir, GENERATED_SECRET_FILE_NAME)
      }

      if (databaseCredential) {
        if (!this.databaseCredentialFilesystem) {
          throw new Error(
            "Database credential filesystem is unavailable for this runtime.",
          )
        }
        if (
          pathsOverlap(
            path.resolve(this.databaseCredentialFilesystem.rootDir),
            path.resolve(sandbox.bundleDir),
          )
        ) {
          throw new Error(
            "Database credential root overlaps persistent runtime storage.",
          )
        }
        const credentialFile =
          await this.databaseCredentialFilesystem.create(databaseCredential)
        databaseCredentialCreated = true
        const expectedCredentialFile = path.join(
          path.resolve(this.databaseCredentialFilesystem.rootDir),
          databaseCredential.runtimeId,
          DATABASE_CREDENTIAL_FILE_NAME,
        )
        if (path.resolve(credentialFile) !== expectedCredentialFile) {
          throw new Error("Database credential mount source is invalid.")
        }
        databaseCredentialMountSource = credentialFile
      }

      if (userEnvironment) {
        if (!this.userEnvironmentFilesystem) {
          throw new Error(
            "User environment filesystem is unavailable for this runtime.",
          )
        }
        if (
          pathsOverlap(
            path.resolve(this.userEnvironmentFilesystem.rootDir),
            path.resolve(sandbox.bundleDir),
          )
        ) {
          throw new Error(
            "User environment root overlaps persistent runtime storage.",
          )
        }
        const environmentFile =
          await this.userEnvironmentFilesystem.create(userEnvironment)
        userEnvironmentCreated = true
        const expectedEnvironmentFile = path.join(
          path.resolve(this.userEnvironmentFilesystem.rootDir),
          userEnvironment.runtimeId,
          USER_ENVIRONMENT_FILE_NAME,
        )
        if (path.resolve(environmentFile) !== expectedEnvironmentFile) {
          throw new Error("User environment mount source is invalid.")
        }
        userEnvironmentMountSource = environmentFile
      }

      const namespace = await sandbox.ensureIngressOnlyNetworkNamespace({
        temporaryDatabaseAccess: databaseCredential !== null,
      })
      namespacePath = namespace.path
      peerIp = namespace.peerIp

      const usesBootstrap =
        Boolean(secrets) ||
        Boolean(databaseCredential) ||
        Boolean(userEnvironment)
      const spec = buildOciRuntimeSpec({
        command: usesBootstrap
          ? [
              SANDBOX_NODE_BINARY,
              SANDBOX_SECRET_BOOTSTRAP,
              ...(userEnvironment
                ? [SANDBOX_USER_ENVIRONMENT_BOOTSTRAP_FLAG]
                : []),
              ...plan.start.args,
            ]
          : [SANDBOX_NODE_BINARY, ...plan.start.args],
        cwd:
          plan.sourceRoot === "."
            ? "/workspace"
            : `/workspace/${plan.sourceRoot}`,
        env: Object.entries(plan.platformEnvironment).map(
          ([key, value]) => `${key}=${value}`,
        ),
        uid: SANDBOX_UID,
        gid: SANDBOX_GID,
        hostname: "peephole-backend",
        resourceLimits: this.resourceLimits,
        networkNamespacePath: namespacePath,
        dnsConfigSource: dnsConfig.source,
        workspaceSource: sandbox.rootDir,
        generatedSecretsSource: secretMountSource,
        databaseCredentialSource: databaseCredentialMountSource,
        userEnvironmentSource: userEnvironmentMountSource,
      })

      // `runsc run --bundle <dir>` always reads `<dir>/config.json` specifically
      // (the OCI bundle format, same as RunscCommandRunner's install/build
      // containers) -- safe to overwrite here because the supervisor never
      // runs the install step and the backend process concurrently in the
      // same workspace.
      await writeFile(
        path.join(sandbox.bundleDir, "config.json"),
        JSON.stringify(spec, null, 2),
      )
      sandbox.registerContainer(containerId)
    } catch (error) {
      try {
        await cleanupCredentials()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Backend runtime start failed and credential cleanup was incomplete.",
          { cause: cleanupError },
        )
      }
      throw error
    }

    if (namespacePath === undefined || peerIp === undefined) {
      throw new Error("Backend runtime network namespace was not established.")
    }

    // Deliberately not awaited: `runsc run` blocks until the sandboxed
    // process exits, which for a backend server is "until stopped."
    const runPromise: Promise<ProcessRunResult> = this.processRunner
      .run(
        this.runscBinaryPath,
        runscRunArgs(
          { runscRootDir: this.runscRootDir },
          { bundleDir: sandbox.bundleDir, containerId, network: "sandbox" },
        ),
        { timeoutMs: this.maxRuntimeMs },
      )
      .catch((error: unknown): ProcessRunResult => ({
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }))

    let deletePromise: Promise<void> | null = null
    let stopPromise: Promise<void> | null = null
    const deleteContainer = (): Promise<void> => {
      deletePromise ??= (async () => {
        const deleted = await this.processRunner.run(
          this.runscBinaryPath,
          runscDeleteArgs({ runscRootDir: this.runscRootDir }, containerId),
          { timeoutMs: 10_000 },
        )
        if (deleted.exitCode !== 0 || deleted.timedOut) {
          throw new Error("Backend runtime container cleanup failed.")
        }
        sandbox.unregisterContainer(containerId)
      })()
      return deletePromise
    }
    let cleanupAfterExitPromise: Promise<void> | null = null
    const cleanupAfterExit = (): Promise<void> => {
      cleanupAfterExitPromise ??= (async () => {
        await runPromise
        try {
          await deleteContainer()
        } finally {
          await cleanupCredentials()
        }
      })()
      return cleanupAfterExitPromise
    }
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        let killError: Error | undefined
        try {
          const killed = await this.processRunner.run(
            this.runscBinaryPath,
            runscKillArgs(
              { runscRootDir: this.runscRootDir },
              containerId,
              "SIGTERM",
            ),
            { timeoutMs: 10_000 },
          )
          if (killed.exitCode !== 0 || killed.timedOut) {
            killError = new Error("Backend runtime stop command failed.")
          } else {
            // A bounded chance for the trusted secret bootstrap (or a plain
            // Node process) to catch SIGTERM and exit on its own. Racing
            // against runPromise means a process that exits sooner does not
            // pay the full grace window; one that never exits still hits the
            // unconditional `delete --force` backstop below.
            await Promise.race([runPromise, sleep(this.stopGraceMs)])
          }
        } catch {
          killError = new Error("Backend runtime stop command failed.")
        }

        // `runsc delete --force` is the independent cleanup attempt. Do not
        // wait for the foreground `runsc run` promise here: if kill failed or
        // timed out, that wait could consume the full runtime backstop and
        // block workspace/network teardown.
        let deleteError: unknown
        try {
          await deleteContainer()
        } catch {
          deleteError = new Error("Backend runtime container cleanup failed.")
        } finally {
          try {
            await cleanupCredentials()
          } catch {
            deleteError = new Error(
              "Backend runtime credential cleanup failed.",
            )
          }
        }
        if (killError && deleteError) {
          throw new AggregateError(
            [killError, deleteError],
            "Backend runtime stop and cleanup failed.",
          )
        }
        if (killError) throw killError
        if (deleteError) throw deleteError
      })()
      return stopPromise
    }

    // Natural/bootstrap/runsc failure cleanup must not depend on a caller
    // reaching the happy-path monitor. Keep the rejection available through
    // waitForExit(), while preventing an unhandled background rejection.
    void cleanupAfterExit().catch(() => undefined)

    return {
      // Internal-only: `peerIp` comes from the actual provisioned
      // ingress-only namespace above, `internalPort` from the validated
      // plan -- never from any client/host/header/query/env value, never
      // persisted. See BackendRuntimeDialTarget's doc comment.
      dialTarget: { host: peerIp, port: plan.internalPort },
      waitUntilReady: (timeoutMs) =>
        this.probeReady(peerIp, plan.internalPort, timeoutMs, runPromise),
      waitForExit: async () => {
        const result = await runPromise
        await cleanupAfterExit()
        return { exitCode: result.exitCode }
      },
      stop,
    }
  }

  private async probeReady(
    host: string,
    port: number,
    timeoutMs: number,
    runPromise: Promise<ProcessRunResult>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let exited: ProcessRunResult | null = null
    runPromise
      .then((result) => {
        exited = result
      })
      .catch(() => undefined)

    let delayMs = 100
    for (;;) {
      if (exited) {
        throw new BackendRuntimeExitedBeforeReadyError(
          (exited as ProcessRunResult).exitCode,
        )
      }
      if (await this.canConnect(host, port)) return
      if (Date.now() >= deadline) {
        throw new BackendRuntimeReadinessTimeoutError()
      }
      await sleep(Math.min(delayMs, this.maxProbeIntervalMs))
      delayMs = Math.min(delayMs * 2, this.maxProbeIntervalMs)
    }
  }

  private canConnect(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port })
      const finish = (connected: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(connected)
      }
      socket.setTimeout(1_000, () => finish(false))
      socket.once("error", () => finish(false))
      socket.once("connect", () => finish(true))
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertSecretMaterialMatchesPlan(
  runtimeId: string,
  plan: BackendRuntimePlan,
  secrets: GeneratedSecretMaterial | null,
): void {
  if (plan.generatedSecretNames.length === 0) {
    if (secrets) {
      throw new Error(
        "Generated-secret material does not match the backend runtime plan.",
      )
    }
    return
  }

  if (
    !secrets ||
    secrets.runtimeId !== runtimeId ||
    secrets.values.size !== plan.generatedSecretNames.length ||
    plan.generatedSecretNames.some((name) => !secrets.values.has(name))
  ) {
    throw new Error(
      "Generated-secret material does not match the backend runtime plan.",
    )
  }
}

function assertDatabaseCredentialMatchesPlan(
  runtimeId: string,
  plan: BackendRuntimePlan,
  databaseCredential: TemporaryDatabaseRuntimeCredentialMaterial | null,
): void {
  if (plan.databaseRequirement === null) {
    if (databaseCredential) {
      throw new Error(
        "Database credential material does not match the backend runtime plan.",
      )
    }
    return
  }

  if (
    !databaseCredential ||
    databaseCredential.runtimeId !== runtimeId ||
    plan.databaseRequirement.name !== BACKEND_RUNTIME_DATABASE_ENV_NAME
  ) {
    throw new Error(
      "Database credential material does not match the backend runtime plan.",
    )
  }
}

function assertUserEnvironmentMatchesPlan(
  runtimeId: string,
  plan: BackendRuntimePlan,
  userEnvironment: UserEnvironmentMaterial | null,
): void {
  if (plan.userEnvironmentNames.length === 0) {
    if (userEnvironment) {
      throw new Error(
        "User environment material does not match the backend runtime plan.",
      )
    }
    return
  }
  if (
    !userEnvironment ||
    userEnvironment.runtimeId !== runtimeId ||
    userEnvironment.values.size !== plan.userEnvironmentNames.length ||
    plan.userEnvironmentNames.some((name) => !userEnvironment.values.has(name))
  ) {
    throw new Error(
      "User environment material does not match the backend runtime plan.",
    )
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}
