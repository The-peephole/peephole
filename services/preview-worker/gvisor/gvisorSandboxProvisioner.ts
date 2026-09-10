import { cp, mkdir } from "node:fs/promises"
import path from "node:path"

import {
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_OUTPUT_LIMITS,
} from "../../../core/runner/archivePolicy"
import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { SandboxProvisioner } from "../ports"
import type { GVisorPreviewWorkspace } from "./gvisorWorkspace"
import type { NetworkNamespaceHandle } from "./networkNamespace"
import { VethNatNetworkProvisioner } from "./networkNamespace"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { runscDeleteArgs, runscKillArgs } from "./runscCli"
import {
  directoryLogicalBytes,
  LoopbackSandboxDiskManager,
  type SandboxDiskManager,
} from "./sandboxDisk"

export interface GVisorSandboxProvisionerOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  bundlesRootDir?: string
  baseRootfsImage: string
  jobTimeoutMs?: number
  processRunner?: ProcessRunner
  networkProvisioner?: VethNatNetworkProvisioner
  diskManager?: SandboxDiskManager
  now?: () => Date
}

/**
 * Allocates a trusted read-only base-rootfs copy and a separate, fixed-size
 * loop-backed ext4 workspace. HOME and npm's cache live on that workspace.
 * Admission also accounts for the rootfs copy and bounded publication bytes.
 */
export class GVisorSandboxProvisioner implements SandboxProvisioner {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly jobTimeoutMs: number
  private readonly processRunner: ProcessRunner
  private readonly networkProvisioner: VethNatNetworkProvisioner
  private readonly diskManager: SandboxDiskManager
  private readonly now: () => Date

  constructor(private readonly options: GVisorSandboxProvisionerOptions) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.totalJobTimeoutMs
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.networkProvisioner =
      options.networkProvisioner ??
      new VethNatNetworkProvisioner({ processRunner: this.processRunner })
    this.diskManager =
      options.diskManager ??
      new LoopbackSandboxDiskManager({
        bundlesRootDir: options.bundlesRootDir,
        processRunner: this.processRunner,
      })
    this.now = options.now ?? (() => new Date())
  }

  async allocate(jobId: string): Promise<GVisorPreviewWorkspace> {
    const baseRootfsBytes = await directoryLogicalBytes(
      this.options.baseRootfsImage,
    )
    // ArchiveByteStore is currently in-memory. Keeping the compressed archive
    // budget in this reservation makes a future disk staging change fail safe.
    const futureOutsideBytes =
      DEFAULT_ARCHIVE_LIMITS.maxCompressedBytes +
      DEFAULT_OUTPUT_LIMITS.maxTotalBytes
    const allocation = await this.diskManager.createAllocation({
      expectedOutsideBytes: baseRootfsBytes + futureOutsideBytes,
    })
    const containerRoot = path.join(allocation.bundleDir, "rootfs")

    try {
      await cp(this.options.baseRootfsImage, containerRoot, {
        recursive: true,
        filter: (source) =>
          !isBaseRootfsDevPath(this.options.baseRootfsImage, source),
        verbatimSymlinks: true,
      })
      // The destination must exist in the OCI rootfs for runtimes that do not
      // create bind targets. It remains 0755 and hidden by the uid-owned ext4
      // mount; the old world-writable rootfs workspace is gone.
      await mkdir(path.join(containerRoot, "workspace"), {
        recursive: true,
        mode: 0o755,
      })
      const archiveStagingRoot = path.join(allocation.bundleDir, "staging")
      await mkdir(archiveStagingRoot, { mode: 0o700 })
      await this.diskManager.updateReservedOutsideBytes(
        allocation,
        futureOutsideBytes,
      )
      const disk = await this.diskManager.mountWorkspace(allocation, {
        remainingOutsideBytes: futureOutsideBytes,
      })

      const deadline = this.now().getTime() + this.jobTimeoutMs
      const containers = new Set<string>()
      let networkNamespace: Promise<NetworkNamespaceHandle> | null = null
      let destroyPromise: Promise<void> | null = null

      const destroy = async (): Promise<void> => {
        if (destroyPromise) return destroyPromise
        destroyPromise = (async () => {
          const containerErrors: unknown[] = []
          for (const containerId of containers) {
            await this.processRunner
              .run(
                this.runscBinaryPath,
                runscKillArgs({ runscRootDir: this.runscRootDir }, containerId),
                { timeoutMs: 10_000 },
              )
              .catch(() => undefined)
            try {
              const deleted = await this.processRunner.run(
                this.runscBinaryPath,
                runscDeleteArgs(
                  { runscRootDir: this.runscRootDir },
                  containerId,
                ),
                { timeoutMs: 10_000 },
              )
              if (deleted.exitCode !== 0 || deleted.timedOut) {
                throw new Error(
                  `runsc could not delete container ${containerId}.`,
                )
              }
              containers.delete(containerId)
            } catch (error) {
              containerErrors.push(error)
            }
          }
          if (containerErrors.length > 0) {
            throw new AggregateError(
              containerErrors,
              "Container cleanup failed; the mounted sandbox allocation was preserved for reconciliation.",
            )
          }

          const cleanupErrors: unknown[] = []
          if (networkNamespace) {
            try {
              await (await networkNamespace).teardown()
            } catch (error) {
              cleanupErrors.push(error)
            }
          }
          try {
            await this.diskManager.destroyAllocation(allocation)
          } catch (error) {
            cleanupErrors.push(error)
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              cleanupErrors,
              "Sandbox cleanup was incomplete; owned resources were preserved for reconciliation.",
            )
          }
        })()

        try {
          await destroyPromise
        } catch (error) {
          destroyPromise = null
          throw error
        }
      }

      return {
        id: jobId,
        rootDir: disk.rootDir,
        archiveStagingRoot,
        bundleDir: allocation.bundleDir,
        remainingMs: () => deadline - this.now().getTime(),
        registerContainer: (containerId) => containers.add(containerId),
        unregisterContainer: (containerId) => containers.delete(containerId),
        listContainers: () => Array.from(containers),
        ensureNetworkNamespace: async (dnsServers) => {
          networkNamespace ??= this.networkProvisioner.create(
            allocation.allocationId,
            dnsServers,
          )
          return (await networkNamespace).path
        },
        destroy,
      }
    } catch (error) {
      try {
        await this.diskManager.destroyAllocation(allocation)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Sandbox allocation failed and its resources could not be cleaned safely.",
          { cause: cleanupError },
        )
      }
      throw error
    }
  }
}

function isBaseRootfsDevPath(baseRootfsImage: string, source: string): boolean {
  const relative = path.relative(baseRootfsImage, source)
  return relative === "dev" || relative.startsWith(`dev${path.sep}`)
}
