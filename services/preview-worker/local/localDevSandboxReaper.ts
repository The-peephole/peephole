import { readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface LocalDevSandboxReaperOptions {
  baseDir?: string
  maxAgeMs?: number
  now?: () => Date
}

/**
 * Sweeps `LocalDevSandboxProvisioner` workspace directories left behind by a
 * job whose process died before its `finally { workspace.destroy() }` ran
 * (a host crash or `kill -9` of the worker process, not a normal
 * success/failure/cancellation, which are already covered by
 * `PreviewJobWorker`'s own cleanup guarantee). Safe to run on an interval
 * or at worker startup; removing a directory that is also mid-destroy is a
 * no-op race, not a correctness problem, since `rm(..., { force: true })`
 * tolerates a path that is already gone.
 */
export class LocalDevSandboxReaper {
  private readonly baseDir: string
  private readonly maxAgeMs: number
  private readonly now: () => Date

  constructor(options: LocalDevSandboxReaperOptions = {}) {
    this.baseDir = path.join(
      options.baseDir ?? os.tmpdir(),
      "peephole-dev-sandbox",
    )
    this.maxAgeMs = options.maxAgeMs ?? 30 * 60_000
    this.now = options.now ?? (() => new Date())
  }

  /** Returns the names of directories it removed. */
  async reap(): Promise<string[]> {
    let entries: string[]

    try {
      entries = await readdir(this.baseDir)
    } catch {
      return []
    }

    const nowMs = this.now().getTime()
    const reaped: string[] = []

    for (const entry of entries) {
      const entryPath = path.join(this.baseDir, entry)
      const stats = await stat(entryPath).catch(() => null)

      if (!stats?.isDirectory()) {
        continue
      }

      if (nowMs - stats.mtimeMs <= this.maxAgeMs) {
        continue
      }

      await rm(entryPath, { recursive: true, force: true })
      reaped.push(entry)
    }

    return reaped
  }
}
