import { lstat } from "node:fs/promises"
import path from "node:path"

import { assertTmpfsFilesystem } from "./generatedSecretFilesystem"
import {
  DEFAULT_DATABASE_CREDENTIAL_ROOT,
  TmpfsDatabaseCredentialFilesystem,
  listOwnedDatabaseCredentialRuntimeIds,
  type DatabaseCredentialFilesystem,
} from "./databaseCredentialFilesystem"
import type { ProcessRunner } from "./processRunner"

export interface DatabaseCredentialOrphanReaperOptions {
  rootDir?: string
  filesystem?: DatabaseCredentialFilesystem
  maxAgeMs?: number
  maxEntriesPerSweep?: number
  now?: () => Date
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
}

/**
 * A narrow C3 primitive mirroring `GeneratedSecretOrphanReaper`'s lifecycle
 * discipline, scoped only to `/run/peephole/db-credentials`. It never
 * recursively removes an arbitrary caller path, and -- like its M10
 * counterpart -- is not wired into `services/production/server.ts` by this
 * change; production startup/maintenance composition is later work (M11-C4+).
 */
export class DatabaseCredentialOrphanReaper {
  private readonly rootDir: string
  private readonly filesystem: DatabaseCredentialFilesystem
  private readonly maxAgeMs: number
  private readonly maxEntriesPerSweep: number
  private readonly now: () => Date
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>

  constructor(options: DatabaseCredentialOrphanReaperOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_DATABASE_CREDENTIAL_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("Database credential root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    this.filesystem =
      options.filesystem ??
      new TmpfsDatabaseCredentialFilesystem({ rootDir: this.rootDir })
    if (path.resolve(this.filesystem.rootDir) !== this.rootDir) {
      throw new Error(
        "Database credential reaper and filesystem roots must match.",
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
    const runtimeIds = await listOwnedDatabaseCredentialRuntimeIds(
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
