import { lstat } from "node:fs/promises"
import path from "node:path"

import {
  assertTmpfsFilesystem,
  DEFAULT_GENERATED_SECRET_ROOT,
  TmpfsGeneratedSecretFilesystem,
  listOwnedSecretRuntimeIds,
  type GeneratedSecretFilesystem,
} from "./generatedSecretFilesystem"
import type { ProcessRunner } from "./processRunner"

export interface GeneratedSecretOrphanReaperOptions {
  rootDir?: string
  filesystem?: GeneratedSecretFilesystem
  maxAgeMs?: number
  maxEntriesPerSweep?: number
  now?: () => Date
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
}

/** A narrow, bounded reaper that only considers validated direct children of
 * the dedicated secret root. It never recursively removes caller paths. */
export class GeneratedSecretOrphanReaper {
  private readonly rootDir: string
  private readonly filesystem: GeneratedSecretFilesystem
  private readonly maxAgeMs: number
  private readonly maxEntriesPerSweep: number
  private readonly now: () => Date
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>

  constructor(options: GeneratedSecretOrphanReaperOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_GENERATED_SECRET_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("Generated-secret root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    this.filesystem =
      options.filesystem ??
      new TmpfsGeneratedSecretFilesystem({ rootDir: this.rootDir })
    if (path.resolve(this.filesystem.rootDir) !== this.rootDir) {
      throw new Error(
        "Generated-secret reaper and filesystem roots must match.",
      )
    }
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60_000
    this.maxEntriesPerSweep = options.maxEntriesPerSweep ?? 256
    this.now = options.now ?? (() => new Date())
    this.verifyMemoryBackedRoot =
      options.verifyMemoryBackedRoot ??
      ((rootDir) =>
        assertTmpfsFilesystem(
          rootDir,
          options.processRunner,
          options.findmntBinaryPath,
        ))
  }

  async reap(): Promise<string[]> {
    return this.reconcile(false)
  }

  /** Startup support: remove every owned entry encountered within the fixed
   * sweep bound. A subsequent sweep handles any entries beyond that bound. */
  async reapAll(): Promise<string[]> {
    return this.reconcile(true)
  }

  private async reconcile(allOwned: boolean): Promise<string[]> {
    try {
      await lstat(this.rootDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    await this.verifyMemoryBackedRoot(this.rootDir)
    const runtimeIds = await listOwnedSecretRuntimeIds(
      this.rootDir,
      this.maxEntriesPerSweep,
    )
    const removed: string[] = []
    for (const runtimeId of runtimeIds) {
      if (!allOwned) {
        const stats = await lstat(path.join(this.rootDir, runtimeId))
        if (this.now().getTime() - stats.mtimeMs <= this.maxAgeMs) continue
      }
      await this.filesystem.remove(runtimeId)
      removed.push(runtimeId)
    }
    return removed
  }
}
