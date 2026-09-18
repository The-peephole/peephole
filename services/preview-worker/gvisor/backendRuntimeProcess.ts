import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import path from "node:path"

import type { SandboxResourceLimits } from "../../../core/runner/runnerLimits"
import { DEFAULT_SANDBOX_RESOURCE_LIMITS } from "../../../core/runner/runnerLimits"
import { isSafePreviewSourceRoot } from "../../../core/preview/sourceRoot"
import type { BackendRuntimePlan } from "../../../types/backendRuntime"
import type {
  BackendRuntimeProcessStarter,
  RuntimeProcessHandle,
} from "../../backend-runtime-worker/ports"
import type { LocalPreviewWorkspace } from "../local/localWorkspace"
import { resolveDnsConfig } from "./dnsConfig"
import { asGVisorWorkspace } from "./gvisorWorkspace"
import { buildOciRuntimeSpec } from "./ociConfig"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner, ProcessRunResult } from "./processRunner"
import { runscDeleteArgs, runscKillArgs, runscRunArgs } from "./runscCli"
import {
  SANDBOX_GID,
  SANDBOX_NODE_BINARY,
  SANDBOX_UID,
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

  constructor(options: GVisorBackendRuntimeProcessOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.resourceLimits =
      options.resourceLimits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.resolveDnsConfig = options.resolveDnsConfig ?? resolveDnsConfig
    this.maxRuntimeMs = options.maxRuntimeMs ?? 15 * 60_000
    this.maxProbeIntervalMs = options.maxProbeIntervalMs ?? 1_000
  }

  async start(
    workspace: LocalPreviewWorkspace,
    plan: BackendRuntimePlan,
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
    const sandbox = asGVisorWorkspace(workspace)
    const { path: namespacePath, peerIp } =
      await sandbox.ensureIngressOnlyNetworkNamespace()

    const dnsConfig = this.resolveDnsConfig()
    const spec = buildOciRuntimeSpec({
      command: [SANDBOX_NODE_BINARY, ...plan.start.args],
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
    })

    const containerId = `${sandbox.id}-backend-${randomBytes(4).toString("hex")}`
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
    const cleanupAfterExit = async (): Promise<void> => {
      await runPromise
      await deleteContainer()
    }
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        let killError: Error | undefined
        try {
          const killed = await this.processRunner.run(
            this.runscBinaryPath,
            runscKillArgs({ runscRootDir: this.runscRootDir }, containerId),
            { timeoutMs: 10_000 },
          )
          if (killed.exitCode !== 0 || killed.timedOut) {
            killError = new Error("Backend runtime stop command failed.")
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

    return {
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
