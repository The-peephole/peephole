import { lstat } from "node:fs/promises"
import path from "node:path"

import { assertTmpfsFilesystem } from "./generatedSecretFilesystem"
import type { ProcessRunner } from "./processRunner"
import {
  DEFAULT_USER_ENVIRONMENT_ROOT,
  TmpfsUserEnvironmentFilesystem,
  listOwnedUserEnvironmentRuntimeIds,
  type UserEnvironmentFilesystem,
} from "./userEnvironmentFilesystem"

export interface UserEnvironmentOrphanReaperOptions {
  rootDir?: string
  filesystem?: UserEnvironmentFilesystem
  maxAgeMs?: number
  maxEntriesPerSweep?: number
  now?: () => Date
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
}

/**
 * Mirrors `DatabaseCredentialOrphanReaper`, scoped only to
 * `/run/peephole/user-env`. Runs at every production startup (also while
 * user configuration is disabled, so a rollback still clears leftovers)
 * and in periodic maintenance while it is enabled. Never recursively
 * removes an arbitrary path.
 */
export class UserEnvironmentOrphanReaper {
  private readonly rootDir: string
  private readonly filesystem: UserEnvironmentFilesystem
  private readonly maxAgeMs: number
  private readonly maxEntriesPerSweep: number
  private readonly now: () => Date
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>

  constructor(options: UserEnvironmentOrphanReaperOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_USER_ENVIRONMENT_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("User environment root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    this.filesystem =
      options.filesystem ??
      new TmpfsUserEnvironmentFilesystem({ rootDir: this.rootDir })
    if (path.resolve(this.filesystem.rootDir) !== this.rootDir) {
      throw new Error(
        "User environment reaper and filesystem roots must match.",
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

  /** Startup: removes every owned entry within the fixed sweep bound. */
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
    const runtimeIds = await listOwnedUserEnvironmentRuntimeIds(
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
