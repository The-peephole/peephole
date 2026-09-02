import { randomBytes } from "node:crypto"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { SandboxProvisioner } from "../ports"
import type { GVisorPreviewWorkspace } from "./gvisorWorkspace"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { runscDeleteArgs, runscKillArgs } from "./runscCli"

export interface GVisorSandboxProvisionerOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  bundlesRootDir?: string
  /**
   * A prepared, read-only Node 24 + npm rootfs tree (no secrets, no host
   * config) copied fresh into every job's bundle. Building and maintaining
   * this image is a release blocker tracked separately from this adapter.
   */
  baseRootfsImage: string
  jobTimeoutMs?: number
  processRunner?: ProcessRunner
  now?: () => Date
}

/**
 * Prepares a fresh OCI bundle per job by copying the base rootfs image; the
 * actual `runsc run` invocation happens per-command in `RunscCommandRunner`.
 * `destroy()` sweeps every container this workspace ever started (defense
 * against a job cancelled mid-command) before removing the bundle
 * directory, and is idempotent.
 *
 * UNTESTED IN THIS REPOSITORY: no Linux kernel or `runsc` binary is
 * available in this development environment. Written against documented
 * runsc/OCI runtime-spec behavior; verify on a real gVisor host before
 * production use.
 */
export class GVisorSandboxProvisioner implements SandboxProvisioner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly bundlesRootDir: string
  private readonly jobTimeoutMs: number
  private readonly processRunner: ProcessRunner
  private readonly now: () => Date

  constructor(private readonly options: GVisorSandboxProvisionerOptions) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.bundlesRootDir = options.bundlesRootDir ?? "/var/lib/peephole/jobs"
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.totalJobTimeoutMs
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.now = options.now ?? (() => new Date())
  }

  async allocate(jobId: string): Promise<GVisorPreviewWorkspace> {
    const bundleDir = path.join(
      this.bundlesRootDir,
      `${jobId}-${randomBytes(4).toString("hex")}`,
    )
    const containerRoot = path.join(bundleDir, "rootfs")
    const rootDir = path.join(containerRoot, "workspace")

    await mkdir(bundleDir, { recursive: true })
    await cp(this.options.baseRootfsImage, containerRoot, { recursive: true })
    await mkdir(rootDir, { recursive: true })

    const deadline = this.now().getTime() + this.jobTimeoutMs
    const containers = new Set<string>()
    let destroyed = false
    const runscRootDir = this.runscRootDir
    const runscBinaryPath = this.runscBinaryPath
    const processRunner = this.processRunner
    const now = this.now

    return {
      id: jobId,
      rootDir,
      bundleDir,
      remainingMs: () => deadline - now().getTime(),
      registerContainer: (containerId) => containers.add(containerId),
      listContainers: () => Array.from(containers),
      destroy: async () => {
        if (destroyed) {
          return
        }

        destroyed = true

        for (const containerId of containers) {
          await processRunner
            .run(
              runscBinaryPath,
              runscKillArgs({ runscRootDir }, containerId),
              { timeoutMs: 10_000 },
            )
            .catch(() => undefined)
          await processRunner
            .run(
              runscBinaryPath,
              runscDeleteArgs({ runscRootDir }, containerId),
              { timeoutMs: 10_000 },
            )
            .catch(() => undefined)
        }

        await rm(bundleDir, { recursive: true, force: true })
      },
    }
  }
}
