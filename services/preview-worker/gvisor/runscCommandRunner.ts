import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_ARCHIVE_LIMITS } from "../../../core/runner/archivePolicy"
import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  type SandboxResourceLimits,
} from "../../../core/runner/runnerLimits"
import {
  CommandExecutionError,
  RunnerDiskLimitError,
  type CommandRunner,
  type CommandRunOptions,
} from "../local/commandRunner"
import { directorySizeExceeds } from "../local/directorySize"
import type { LocalPreviewWorkspace } from "../local/localWorkspace"
import { resolveDnsConfig } from "./dnsConfig"
import { asGVisorWorkspace } from "./gvisorWorkspace"
import { buildOciRuntimeSpec } from "./ociConfig"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import {
  runscDeleteArgs,
  runscKillArgs,
  runscRunArgs,
  type RunscNetworkMode,
} from "./runscCli"
import {
  SANDBOX_GID,
  SANDBOX_HOME,
  SANDBOX_NPM_CACHE,
  SANDBOX_UID,
} from "./sandboxIdentity"

export interface RunscCommandRunnerOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  resourceLimits?: SandboxResourceLimits
  network?: RunscNetworkMode
  processRunner?: ProcessRunner
  /** Live workspace-size cap enforced while the command runs (not just
   * after it exits) -- see run()'s disk-quota watcher. */
  maxWorkspaceBytes?: number
  diskQuotaPollMs?: number
  /** Overridable for tests; defaults to the real resolveDnsConfig()
   * (reads the actual host's resolv.conf files). */
  resolveDnsConfig?: typeof resolveDnsConfig
}

/**
 * Runs a command inside a fresh `runsc` container chrooted to the
 * workspace's rootfs. runsc containers are single-process, so `npm ci` and
 * `npm run build` each get their own container sharing the same on-disk
 * loop-backed workspace; each container is deleted immediately after it exits.
 *
 * `network` defaults to "none" (no network stack at all). Passing
 * "sandbox" gives the process a real, routable network namespace (via
 * `workspace.ensureNetworkNamespace()`, see gvisorSandboxProvisioner.ts)
 * with outbound NAT, DNS-only private resolver exceptions, and non-public
 * destination ranges blocked. Registry-only egress is not implemented (the
 * registry's IPs aren't stable enough to allowlist directly); see
 * VethNatNetworkProvisioner's doc comment.
 *
 * Command execution itself (non-root uid, on-disk persistence across
 * containers, resource limits) is verified against a real gVisor host --
 * see tests/realGvisorSandbox.test.ts. CLI/OCI argument construction also
 * has fake-`ProcessRunner` unit coverage in tests/gvisorAdapter.test.ts.
 *
 * The workspace is a capacity-bounded ext4 mount. The directory poll remains
 * as an earlier soft stop, but the filesystem is the non-bypassable hard cap.
 */
export class RunscCommandRunner implements CommandRunner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly resourceLimits: SandboxResourceLimits
  private readonly network: RunscNetworkMode
  private readonly processRunner: ProcessRunner
  private readonly maxWorkspaceBytes: number
  private readonly diskQuotaPollMs: number
  private readonly resolveDnsConfig: typeof resolveDnsConfig

  constructor(options: RunscCommandRunnerOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.resourceLimits =
      options.resourceLimits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS
    this.network = options.network ?? "none"
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.maxWorkspaceBytes =
      options.maxWorkspaceBytes ?? DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes
    this.diskQuotaPollMs = options.diskQuotaPollMs ?? 1_000
    this.resolveDnsConfig = options.resolveDnsConfig ?? resolveDnsConfig
  }

  async run(
    workspace: LocalPreviewWorkspace,
    command: string,
    args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    options.signal?.throwIfAborted()
    const sandbox = asGVisorWorkspace(workspace)
    const containerId = `${workspace.id}-${randomBytes(4).toString("hex")}`
    sandbox.registerContainer(containerId)

    const dnsConfig = this.resolveDnsConfig()
    const networkNamespacePath =
      this.network === "sandbox"
        ? await sandbox.ensureNetworkNamespace(dnsConfig.nameservers)
        : undefined

    const spec = buildOciRuntimeSpec({
      command: [command, ...args],
      cwd: "/workspace",
      env: Object.entries({
        ...options.env,
        HOME: SANDBOX_HOME,
        npm_config_cache: SANDBOX_NPM_CACHE,
        TMPDIR: "/tmp",
        TMP: "/tmp",
        TEMP: "/tmp",
      })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      uid: SANDBOX_UID,
      gid: SANDBOX_GID,
      hostname: "peephole-preview",
      resourceLimits: this.resourceLimits,
      networkNamespacePath,
      dnsConfigSource: dnsConfig.source,
      workspaceSource: sandbox.rootDir,
    })

    await writeFile(
      path.join(sandbox.bundleDir, "config.json"),
      JSON.stringify(spec, null, 2),
    )

    let quotaExceeded = false
    const diskQuotaTimer = this.watchDiskQuota(
      sandbox.rootDir,
      containerId,
      () => {
        quotaExceeded = true
      },
    )

    let executionError: unknown
    try {
      const result = await this.processRunner.run(
        this.runscBinaryPath,
        runscRunArgs(
          { runscRootDir: this.runscRootDir },
          {
            bundleDir: sandbox.bundleDir,
            containerId,
            network: this.network,
          },
        ),
        { timeoutMs: options.timeoutMs, signal: options.signal },
      )

      if (quotaExceeded) {
        throw new RunnerDiskLimitError(
          `${command} ${args.join(" ")} exceeded the ${String(this.maxWorkspaceBytes)}-byte workspace size limit and was stopped.`,
          result.stdout,
          result.stderr,
        )
      }

      if (result.timedOut) {
        throw new CommandExecutionError(
          `${command} ${args.join(" ")} exceeded its ${options.timeoutMs}ms timeout inside the sandbox.`,
          result.stdout,
          result.stderr,
        )
      }

      if (result.exitCode !== 0) {
        const exhausted = await sandbox.isDiskExhausted().catch(() => false)
        if (exhausted) {
          throw new RunnerDiskLimitError(
            `${command} ${args.join(" ")} exhausted the hard workspace filesystem capacity.`,
            result.stdout,
            result.stderr,
          )
        }
        throw new CommandExecutionError(
          `${command} ${args.join(" ")} exited with code ${String(result.exitCode)} inside the sandbox.`,
          result.stdout,
          result.stderr,
        )
      }
    } catch (error) {
      executionError = error
    }

    clearInterval(diskQuotaTimer)
    let cleanupError: unknown
    try {
      const deleted = await this.processRunner.run(
        this.runscBinaryPath,
        runscDeleteArgs({ runscRootDir: this.runscRootDir }, containerId),
        { timeoutMs: 10_000 },
      )
      if (deleted.exitCode !== 0 || deleted.timedOut) {
        cleanupError = new Error(
          `runsc could not delete container ${containerId}.`,
        )
      } else {
        sandbox.unregisterContainer(containerId)
      }
    } catch (error) {
      cleanupError = error
    }
    if (executionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [executionError, cleanupError],
        "Sandbox command and container cleanup both failed.",
        { cause: executionError },
      )
    }
    if (cleanupError !== undefined) throw cleanupError
    if (executionError !== undefined) throw executionError
  }

  /** Polls the workspace's on-disk size while the container runs and kills
   * it the moment the size cap is crossed, instead of only finding out
   * after the command finishes on its own. */
  private watchDiskQuota(
    rootDir: string,
    containerId: string,
    onExceeded: () => void,
  ): ReturnType<typeof setInterval> {
    let checking = false
    let tripped = false
    const timer = setInterval(() => {
      if (checking || tripped) return
      checking = true
      void directorySizeExceeds(rootDir, this.maxWorkspaceBytes)
        .then((exceeded) => {
          if (!exceeded || tripped) return
          tripped = true
          onExceeded()
          return this.processRunner
            .run(
              this.runscBinaryPath,
              runscKillArgs({ runscRootDir: this.runscRootDir }, containerId),
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined)
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false
        })
    }, this.diskQuotaPollMs)
    timer.unref()
    return timer
  }
}
