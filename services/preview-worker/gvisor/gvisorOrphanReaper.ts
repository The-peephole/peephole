import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"

import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { runscDeleteArgs, runscKillArgs } from "./runscCli"

export interface GVisorOrphanReaperOptions {
  runscBinaryPath?: string
  runscRootDir?: string
  bundlesRootDir?: string
  maxAgeMs?: number
  processRunner?: ProcessRunner
  now?: () => Date
}

interface RunscListEntry {
  id: string
  bundle: string
}

/**
 * Sweeps bundle directories under `bundlesRootDir` that are older than
 * `maxAgeMs` -- left behind by a worker process that crashed before its
 * `GVisorSandboxProvisioner.destroy()` ran (a host crash, not a normal
 * success/failure/cancellation). Container ids are tracked only in the
 * allocating process's memory, so after a restart the only durable source
 * of truth is `runsc list` itself; this cross-references its bundle paths
 * against stale directories rather than assuming any in-memory state.
 *
 * UNTESTED AGAINST A REAL `runsc` BINARY. `runsc list --format json` is
 * assumed to follow runc's conventional `{id, bundle, ...}` shape (gVisor
 * targets OCI/runc CLI compatibility), but this has not been verified on a
 * real gVisor host -- confirm the actual output shape before relying on
 * this in production.
 */
export class GVisorOrphanReaper {
  private readonly runscBinaryPath: string
  private readonly runscRootDir: string
  private readonly bundlesRootDir: string
  private readonly maxAgeMs: number
  private readonly processRunner: ProcessRunner
  private readonly now: () => Date

  constructor(options: GVisorOrphanReaperOptions = {}) {
    this.runscBinaryPath = options.runscBinaryPath ?? "runsc"
    this.runscRootDir = options.runscRootDir ?? "/var/run/peephole/runsc"
    this.bundlesRootDir = options.bundlesRootDir ?? "/var/lib/peephole/jobs"
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60_000
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.now = options.now ?? (() => new Date())
  }

  /** Returns the bundle directory names it removed. */
  async reap(): Promise<string[]> {
    const staleDirs = await this.findStaleBundleDirs()

    if (staleDirs.length === 0) {
      return []
    }

    const containers = await this.listContainers()

    for (const staleDir of staleDirs) {
      const bundleDir = path.join(this.bundlesRootDir, staleDir)
      const orphanedContainers = containers.filter((container) =>
        isWithin(bundleDir, container.bundle),
      )

      for (const container of orphanedContainers) {
        await this.processRunner
          .run(
            this.runscBinaryPath,
            runscKillArgs({ runscRootDir: this.runscRootDir }, container.id),
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined)
        await this.processRunner
          .run(
            this.runscBinaryPath,
            runscDeleteArgs({ runscRootDir: this.runscRootDir }, container.id),
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined)
      }

      await rm(bundleDir, { recursive: true, force: true })
    }

    return staleDirs
  }

  private async findStaleBundleDirs(): Promise<string[]> {
    let entries: string[]

    try {
      entries = await readdir(this.bundlesRootDir)
    } catch {
      return []
    }

    const nowMs = this.now().getTime()
    const stale: string[] = []

    for (const entry of entries) {
      const stats = await stat(path.join(this.bundlesRootDir, entry)).catch(
        () => null,
      )

      if (stats?.isDirectory() && nowMs - stats.mtimeMs > this.maxAgeMs) {
        stale.push(entry)
      }
    }

    return stale
  }

  private async listContainers(): Promise<RunscListEntry[]> {
    const result = await this.processRunner
      .run(
        this.runscBinaryPath,
        ["--root", this.runscRootDir, "list", "--format", "json"],
        { timeoutMs: 10_000 },
      )
      .catch(() => null)

    if (!result || result.exitCode !== 0) {
      return []
    }

    try {
      const parsed: unknown = JSON.parse(result.stdout)
      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed.filter(
        (entry): entry is RunscListEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RunscListEntry).id === "string" &&
          typeof (entry as RunscListEntry).bundle === "string",
      )
    } catch {
      return []
    }
  }
}

function isWithin(dir: string, candidate: string): boolean {
  const relative = path.relative(dir, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
