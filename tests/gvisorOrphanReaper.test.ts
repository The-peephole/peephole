import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"

class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []

  constructor(private readonly listResult: ProcessRunResult) {}

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })

    if (args.includes("list")) {
      return this.listResult
    }

    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
  }
}

describe("GVisorOrphanReaper", () => {
  let bundlesRootDir: string

  beforeEach(async () => {
    bundlesRootDir = await mkdtemp(path.join(os.tmpdir(), "peephole-bundles-"))
  })

  afterEach(async () => {
    await rm(bundlesRootDir, { recursive: true, force: true })
  })

  it("kills and deletes containers whose bundle is under a stale directory, then removes it", async () => {
    const staleBundle = path.join(bundlesRootDir, "job-1-abcd")
    const freshBundle = path.join(bundlesRootDir, "job-2-efgh")
    await mkdir(staleBundle, { recursive: true })
    await mkdir(freshBundle, { recursive: true })

    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(staleBundle, old, old)

    const processRunner = new ScriptedProcessRunner({
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify([
        { id: "job-1-abcd-c1", bundle: staleBundle },
        { id: "job-2-efgh-c1", bundle: freshBundle },
      ]),
      stderr: "",
    })

    const reaper = new GVisorOrphanReaper({
      bundlesRootDir,
      maxAgeMs: 30 * 60_000,
      processRunner,
    })

    const reaped = await reaper.reap()

    expect(reaped).toEqual(["job-1-abcd"])

    const killAndDeleteCalls = processRunner.calls.filter(
      (call) => call.args.includes("kill") || call.args.includes("delete"),
    )
    expect(killAndDeleteCalls).toHaveLength(2)
    expect(killAndDeleteCalls[0]?.args).toContain("job-1-abcd-c1")
    expect(
      killAndDeleteCalls.some((call) => call.args.includes("job-2-efgh-c1")),
    ).toBe(false)
  })

  it("still removes a stale bundle directory when runsc list fails or is unparsable", async () => {
    const staleBundle = path.join(bundlesRootDir, "job-3-orphan")
    await mkdir(staleBundle, { recursive: true })
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(staleBundle, old, old)

    const processRunner = new ScriptedProcessRunner({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "not a real runsc binary",
    })

    const reaper = new GVisorOrphanReaper({
      bundlesRootDir,
      maxAgeMs: 30 * 60_000,
      processRunner,
    })

    await expect(reaper.reap()).resolves.toEqual(["job-3-orphan"])
  })

  it("returns an empty list when nothing is stale and never calls runsc list", async () => {
    await mkdir(path.join(bundlesRootDir, "job-fresh"), { recursive: true })
    const processRunner = new ScriptedProcessRunner({
      exitCode: 0,
      timedOut: false,
      stdout: "[]",
      stderr: "",
    })

    const reaper = new GVisorOrphanReaper({
      bundlesRootDir,
      maxAgeMs: 30 * 60_000,
      processRunner,
    })

    await expect(reaper.reap()).resolves.toEqual([])
    expect(processRunner.calls).toHaveLength(0)
  })
})
