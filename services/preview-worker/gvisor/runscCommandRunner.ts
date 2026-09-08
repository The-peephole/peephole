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
  type CommandRunner,
  type CommandRunOptions,
} from "../local/commandRunner"
import { directorySizeExceeds } from "../local/directorySize"
import type { LocalPreviewWorkspace } from "../local/localWorkspace"
import { resolveDnsConfigSource } from "./dnsConfig"
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
import { SANDBOX_GID, SANDBOX_HOME, SANDBOX_UID } from "./sandboxIdentity"

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
  /** Overridable for tests; defaults to the real resolveDnsConfigSource()
   * (reads the actual host's resolv.conf files). */
  resolveDnsConfigSource?: typeof resolveDnsConfigSource
}

/**
 * Runs a command inside a fresh `runsc` container chrooted to the
 * workspace's rootfs. runsc containers are single-process, so `npm ci` and
 * `npm run build` each get their own container sharing the same on-disk
 * rootfs; each container is deleted immediately after it exits.
 *
 * `network` defaults to "none" (no network stack at all). Passing
 * "sandbox" gives the process a real, routable network namespace (via
 * `workspace.ensureNetworkNamespace()`, see gvisorSandboxProvisioner.ts)
 * with outbound NAT and cloud metadata/link-local blocked -- npm-registry-
 * only egress is not implemented (the registry's IPs aren't stable enough
 * to allowlist directly); see VethNatNetworkProvisioner's doc comment.
 *
 * Command execution itself (non-root uid, on-disk persistence across
 * containers, resource limits) is verified against a real gVisor host --
 * see tests/realGvisorSandbox.test.ts. CLI/OCI argument construction also
 * has fake-`ProcessRunner` unit coverage in tests/gvisorAdapter.test.ts.
 *
 * There is no filesystem-level disk quota (root.path is a real host
 * directory, not a size-bounded mount -- a tmpfs would lose exactly the
 * cross-container persistence RunscCommandRunner depends on, and a
 * loop-mounted, quota-enforcing image is a real project of its own, not
 * attempted here yet), so without the poll below a script that just keeps
 * writing runs unthrottled until it finishes, times out, or exhausts the
 * real disk. Confirmed on a real gVisor host: writing 500MB in an
 * ordinary `npm ci`-style script hit no resistance at all.
 *
 * The poll is a real, verified improvement, but it is best-effort, not a
 * hard bound: it is a userspace directory walk on a timer, so a script
 * that writes fast enough overshoots the configured limit by however much
 * it can write in one `diskQuotaPollMs` window plus kill latency --
 * confirmed on a real gVisor host at the default settings: a 20MB limit
 * against a script writing as fast as `fs.appendFileSync` allows let
 * ~330MB through before the kill landed. It meaningfully shortens the
 * window versus no live check at all (which let the same script write
 * unbounded until it chose to stop), and NpmDependencyInstaller/
 * NpmBuildExecutor's own post-command size checks still catch anything
 * that slips through -- but a determined, fast-writing script will still
 * get well past the configured number before this stops it.
 */
export class RunscCommandRunner implements CommandRunner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly resourceLimits: SandboxResourceLimits
  private readonly network: RunscNetworkMode
  private readonly processRunner: ProcessRunner
  private readonly maxWorkspaceBytes: number
  private readonly diskQuotaPollMs: number
  private readonly resolveDnsConfigSource: typeof resolveDnsConfigSource

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
    this.resolveDnsConfigSource =
      options.resolveDnsConfigSource ?? resolveDnsConfigSource
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

    const networkNamespacePath =
      this.network === "sandbox"
        ? await sandbox.ensureNetworkNamespace()
        : undefined

    const spec = buildOciRuntimeSpec({
      command: [command, ...args],
      cwd: "/workspace",
      // SANDBOX_UID has no passwd entry in the base rootfs beyond the
      // system-default "nobody", whose home is /nonexistent -- without an
      // explicit HOME, npm tries to write its cache/log files there and
      // fails. SANDBOX_HOME must be a writable directory owned by
      // SANDBOX_UID:SANDBOX_GID baked into the base rootfs image (see
      // scripts/gvisor/build-base-rootfs.sh).
      env: Object.entries({ HOME: SANDBOX_HOME, ...options.env })
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      uid: SANDBOX_UID,
      gid: SANDBOX_GID,
      hostname: "peephole-preview",
      resourceLimits: this.resourceLimits,
      networkNamespacePath,
      dnsConfigSource: this.resolveDnsConfigSource(),
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
        throw new CommandExecutionError(
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
        throw new CommandExecutionError(
          `${command} ${args.join(" ")} exited with code ${String(result.exitCode)} inside the sandbox.`,
          result.stdout,
          result.stderr,
        )
      }
    } finally {
      clearInterval(diskQuotaTimer)
      await this.processRunner
        .run(
          this.runscBinaryPath,
          runscDeleteArgs({ runscRootDir: this.runscRootDir }, containerId),
          { timeoutMs: 10_000 },
        )
        .catch(() => undefined)
    }
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
