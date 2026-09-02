import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { LocalDevSandboxReaper } from "../services/preview-worker/local/localDevSandboxReaper"

describe("LocalDevSandboxReaper", () => {
  let baseDir: string
  let sandboxDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-reaper-"))
    sandboxDir = path.join(baseDir, "peephole-dev-sandbox")
    await mkdir(sandboxDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it("removes only workspace directories older than maxAgeMs", async () => {
    const staleDir = path.join(sandboxDir, "job-old-1234")
    const freshDir = path.join(sandboxDir, "job-new-5678")
    await mkdir(staleDir)
    await mkdir(freshDir)
    await writeFile(path.join(staleDir, "index.html"), "<html></html>")

    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(staleDir, old, old)

    const reaper = new LocalDevSandboxReaper({ baseDir, maxAgeMs: 30 * 60_000 })
    const reaped = await reaper.reap()

    expect(reaped).toEqual(["job-old-1234"])

    await expect(
      rm(staleDir, { recursive: true }).then(() => "gone"),
    ).rejects.toThrow() // already removed by reap(); rm() with no force errors on ENOENT
    await expect(
      writeFile(path.join(freshDir, "still-here.txt"), "ok"),
    ).resolves.toBeUndefined()
  })

  it("returns an empty list and does not throw when the sandbox base directory does not exist yet", async () => {
    const reaper = new LocalDevSandboxReaper({
      baseDir: path.join(baseDir, "never-created"),
    })

    await expect(reaper.reap()).resolves.toEqual([])
  })

  it("is safe to call when nothing is stale", async () => {
    await mkdir(path.join(sandboxDir, "job-fresh"))
    const reaper = new LocalDevSandboxReaper({ baseDir, maxAgeMs: 30 * 60_000 })

    await expect(reaper.reap()).resolves.toEqual([])
  })
})
