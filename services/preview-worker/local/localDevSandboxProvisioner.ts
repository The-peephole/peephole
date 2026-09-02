import { randomBytes } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { DEFAULT_RUNNER_TIMEOUTS } from "../../../core/runner/runnerLimits"
import type { SandboxProvisioner } from "../ports"
import type { LocalPreviewWorkspace } from "./localWorkspace"

export interface LocalDevSandboxProvisionerOptions {
  baseDir?: string
  jobTimeoutMs?: number
  now?: () => Date
}

/**
 * NOT A SECURITY BOUNDARY. This runs install/build commands directly on the
 * host process with no namespace, resource, or network isolation. It exists
 * only to prove the fetch/extract/install/build/publish pipeline end to end
 * on hosts without a real sandbox runtime (e.g. this development machine,
 * which has no Linux kernel and therefore cannot run gVisor). It must never
 * be wired into anything that builds untrusted, arbitrary repository content
 * in production. Use `GVisorSandboxProvisioner` for that.
 */
export class LocalDevSandboxProvisioner implements SandboxProvisioner {
  private readonly baseDir: string
  private readonly jobTimeoutMs: number
  private readonly now: () => Date

  constructor(options: LocalDevSandboxProvisionerOptions = {}) {
    this.baseDir = options.baseDir ?? os.tmpdir()
    this.jobTimeoutMs =
      options.jobTimeoutMs ?? DEFAULT_RUNNER_TIMEOUTS.totalJobTimeoutMs
    this.now = options.now ?? (() => new Date())
  }

  async allocate(jobId: string): Promise<LocalPreviewWorkspace> {
    const rootDir = path.join(
      this.baseDir,
      "peephole-dev-sandbox",
      `${jobId}-${randomBytes(4).toString("hex")}`,
    )
    await mkdir(rootDir, { recursive: true })

    const deadline = this.now().getTime() + this.jobTimeoutMs
    let destroyed = false

    return {
      id: jobId,
      rootDir,
      remainingMs: () => deadline - this.now().getTime(),
      destroy: async () => {
        if (destroyed) {
          return
        }

        destroyed = true
        await rm(rootDir, { recursive: true, force: true })
      },
    }
  }
}
