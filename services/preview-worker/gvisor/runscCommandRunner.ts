import { randomBytes } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"

import {
  DEFAULT_SANDBOX_RESOURCE_LIMITS,
  type SandboxResourceLimits,
} from "../../../core/runner/runnerLimits"
import {
  CommandExecutionError,
  type CommandRunner,
  type CommandRunOptions,
} from "../local/commandRunner"
import type { LocalPreviewWorkspace } from "../local/localWorkspace"
import { asGVisorWorkspace } from "./gvisorWorkspace"
import { buildOciRuntimeSpec } from "./ociConfig"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { runscDeleteArgs, runscRunArgs, type RunscNetworkMode } from "./runscCli"

const SANDBOX_UID = 65534
const SANDBOX_GID = 65534

export interface RunscCommandRunnerOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  resourceLimits?: SandboxResourceLimits
  network?: RunscNetworkMode
  processRunner?: ProcessRunner
}

/**
 * Runs a command inside a fresh `runsc` container chrooted to the
 * workspace's rootfs. runsc containers are single-process, so `npm ci` and
 * `npm run build` each get their own container sharing the same on-disk
 * rootfs; each container is deleted immediately after it exits.
 *
 * `network` defaults to "none" (no network stack at all). Passing
 * "sandbox" for the install phase gives the process a network namespace,
 * but restricting *that* to npm-registry-only egress is a host-side
 * firewall/veth concern this class does not implement -- see the
 * Milestone 5 report's network-policy section.
 *
 * UNTESTED IN THIS REPOSITORY (no Linux/runsc available); CLI and OCI
 * wiring is verified via a fake `ProcessRunner` instead.
 */
export class RunscCommandRunner implements CommandRunner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly resourceLimits: SandboxResourceLimits
  private readonly network: RunscNetworkMode
  private readonly processRunner: ProcessRunner

  constructor(options: RunscCommandRunnerOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.resourceLimits =
      options.resourceLimits ?? DEFAULT_SANDBOX_RESOURCE_LIMITS
    this.network = options.network ?? "none"
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
  }

  async run(
    workspace: LocalPreviewWorkspace,
    command: string,
    args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    const sandbox = asGVisorWorkspace(workspace)
    const containerId = `${workspace.id}-${randomBytes(4).toString("hex")}`
    sandbox.registerContainer(containerId)

    const spec = buildOciRuntimeSpec({
      command: [command, ...args],
      cwd: "/workspace",
      env: Object.entries(options.env ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`),
      uid: SANDBOX_UID,
      gid: SANDBOX_GID,
      hostname: "peephole-preview",
      resourceLimits: this.resourceLimits,
    })

    await writeFile(
      path.join(sandbox.bundleDir, "config.json"),
      JSON.stringify(spec, null, 2),
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
        { timeoutMs: options.timeoutMs },
      )

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
      await this.processRunner
        .run(
          this.runscBinaryPath,
          runscDeleteArgs({ runscRootDir: this.runscRootDir }, containerId),
          { timeoutMs: 10_000 },
        )
        .catch(() => undefined)
    }
  }
}
