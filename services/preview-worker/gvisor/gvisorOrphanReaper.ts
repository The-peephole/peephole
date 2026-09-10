import { stat } from "node:fs/promises"
import path from "node:path"

import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner, ProcessRunResult } from "./processRunner"
import { runscDeleteArgs, runscKillArgs } from "./runscCli"
import {
  LoopbackSandboxDiskManager,
  type SandboxDiskAllocation,
  type SandboxDiskManager,
} from "./sandboxDisk"

export interface GVisorOrphanReaperOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  bundlesRootDir?: string
  maxAgeMs?: number
  processRunner?: ProcessRunner
  diskManager?: SandboxDiskManager
  now?: () => Date
}

interface RunscListEntry {
  id: string
  bundle: string
}

/**
 * Reconciles only cryptographically named, marker-validated allocations
 * owned by SandboxDiskManager. `runsc list` is a mandatory source of truth:
 * failure or malformed JSON aborts before any mount, loop, image, or bundle
 * cleanup. Disk cleanup then applies its own source/target/fstype/backing-file
 * proofs, so neither component can independently delete an uncertain bundle.
 */
export class GVisorOrphanReaper {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly maxAgeMs: number
  private readonly processRunner: ProcessRunner
  private readonly diskManager: SandboxDiskManager
  private readonly now: () => Date

  constructor(options: GVisorOrphanReaperOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60_000
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.diskManager =
      options.diskManager ??
      new LoopbackSandboxDiskManager({
        bundlesRootDir: options.bundlesRootDir,
        processRunner: this.processRunner,
      })
    this.now = options.now ?? (() => new Date())
  }

  /** Periodic age-gated reconciliation. */
  async reap(): Promise<string[]> {
    return this.reconcile(false)
  }

  /** Startup gate: no new worker allocation may start until this completes. */
  async reapAll(): Promise<string[]> {
    await this.diskManager.recoverAllocationLock()
    return this.reconcile(true)
  }

  private async reconcile(allOwned: boolean): Promise<string[]> {
    const owned = await this.diskManager.listOwnedAllocations()
    const candidates = await this.findCandidates(owned, allOwned)
    const before = await this.listContainers()
    const bundlesRoot = await this.diskManager.getBundlesRootDir()
    const ownedBundles = new Set(
      owned.map((allocation) => path.resolve(allocation.bundleDir)),
    )
    const uncertain = before.filter(
      (container) =>
        isWithin(bundlesRoot, container.bundle) &&
        !ownedBundles.has(path.resolve(container.bundle)),
    )
    if (uncertain.length > 0) {
      throw new Error(
        "runsc reports a container under the Peephole bundles root without a valid allocation marker; refusing guessed cleanup.",
      )
    }
    if (candidates.length === 0) return []

    const cleanupErrors: unknown[] = []
    const containerCleanupErrors = new Map<string, unknown[]>()
    for (const allocation of candidates) {
      const containers = before.filter((container) =>
        sameBundle(allocation.bundleDir, container.bundle),
      )
      for (const container of containers) {
        await this.processRunner
          .run(
            this.runscBinaryPath,
            runscKillArgs({ runscRootDir: this.runscRootDir }, container.id),
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined)
        try {
          const deleted = await this.processRunner.run(
            this.runscBinaryPath,
            runscDeleteArgs({ runscRootDir: this.runscRootDir }, container.id),
            { timeoutMs: 10_000 },
          )
          assertCommandSucceeded("runsc delete", deleted)
        } catch (error) {
          const errors =
            containerCleanupErrors.get(allocation.allocationId) ?? []
          errors.push(error)
          containerCleanupErrors.set(allocation.allocationId, errors)
        }
      }
    }

    // Re-read runsc state after every attempted delete. A failed or malformed
    // result is a hard stop: mounted allocations stay in place for retry.
    const after = await this.listContainers()
    const removed: string[] = []
    for (const allocation of candidates) {
      if (
        after.some((container) =>
          sameBundle(allocation.bundleDir, container.bundle),
        )
      ) {
        cleanupErrors.push(
          ...(containerCleanupErrors.get(allocation.allocationId) ?? []),
        )
        cleanupErrors.push(
          new Error(
            `Container state still references ${allocation.bundleDir}; disk cleanup was skipped.`,
          ),
        )
        continue
      }
      try {
        await this.diskManager.destroyAllocation(allocation)
        removed.push(path.basename(allocation.bundleDir))
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "One or more stale gVisor allocations could not be reconciled safely.",
      )
    }
    return removed
  }

  private async findCandidates(
    allocations: SandboxDiskAllocation[],
    allOwned: boolean,
  ): Promise<SandboxDiskAllocation[]> {
    if (allOwned) return allocations
    const nowMs = this.now().getTime()
    const stale: SandboxDiskAllocation[] = []
    for (const allocation of allocations) {
      const stats = await stat(allocation.bundleDir)
      if (nowMs - stats.mtimeMs > this.maxAgeMs) stale.push(allocation)
    }
    return stale
  }

  private async listContainers(): Promise<RunscListEntry[]> {
    const result = await this.processRunner.run(
      this.runscBinaryPath,
      ["--root", this.runscRootDir, "list", "--format", "json"],
      { timeoutMs: 10_000 },
    )
    assertCommandSucceeded("runsc list", result)

    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      throw new Error("runsc list returned malformed JSON.", { cause: error })
    }
    if (!Array.isArray(parsed)) {
      throw new Error("runsc list did not return an array.")
    }
    return parsed.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as RunscListEntry).id !== "string" ||
        typeof (entry as RunscListEntry).bundle !== "string"
      ) {
        throw new Error("runsc list returned an invalid container record.")
      }
      return entry as RunscListEntry
    })
  }
}

function sameBundle(expected: string, candidate: string): boolean {
  return path.resolve(candidate) === path.resolve(expected)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function assertCommandSucceeded(
  command: string,
  result: ProcessRunResult,
): void {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(
      `${command} failed (exit ${String(result.exitCode)}, timedOut=${String(result.timedOut)}): ${result.stderr || result.stdout}`,
    )
  }
}
