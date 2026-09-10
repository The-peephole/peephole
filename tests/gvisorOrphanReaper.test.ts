import { mkdtemp, rm, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import { FakeSandboxDiskManager } from "./fakeSandboxDiskManager"

class StatefulRunsc implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  failList = false
  malformedList = false
  failDelete = false

  constructor(
    readonly containers: Array<{ id: string; bundle: string }> = [],
  ) {}

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (args.includes("list")) {
      if (this.failList) {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "boom" }
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdout: this.malformedList ? "{" : JSON.stringify(this.containers),
        stderr: "",
      }
    }
    if (args.includes("delete")) {
      if (this.failDelete) {
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "busy" }
      }
      const id = args.at(-1)
      const index = this.containers.findIndex((entry) => entry.id === id)
      if (index >= 0) this.containers.splice(index, 1)
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

  it("kills containers, verifies refreshed runsc state, then delegates owned disk cleanup", async () => {
    const disks = new FakeSandboxDiskManager(bundlesRootDir)
    const stale = await disks.createAllocation({ expectedOutsideBytes: 0 })
    const fresh = await disks.createAllocation({ expectedOutsideBytes: 0 })
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(stale.bundleDir, old, old)
    const runsc = new StatefulRunsc([
      { id: "stale-c1", bundle: stale.bundleDir },
      { id: "fresh-c1", bundle: fresh.bundleDir },
    ])
    const reaper = new GVisorOrphanReaper({
      maxAgeMs: 30 * 60_000,
      processRunner: runsc,
      diskManager: disks,
    })

    await expect(reaper.reap()).resolves.toEqual([
      path.basename(stale.bundleDir),
    ])
    expect(disks.destroyed).toEqual([stale.bundleDir])
    expect(runsc.containers).toEqual([
      { id: "fresh-c1", bundle: fresh.bundleDir },
    ])
    expect(
      runsc.calls.filter((call) => call.args.includes("list")),
    ).toHaveLength(2)
  })

  it.each(["failed", "malformed"])(
    "fails closed on a %s runsc list and preserves the allocation",
    async (mode) => {
      const disks = new FakeSandboxDiskManager(bundlesRootDir)
      const stale = await disks.createAllocation({ expectedOutsideBytes: 0 })
      const old = new Date(Date.now() - 60 * 60_000)
      await utimes(stale.bundleDir, old, old)
      const runsc = new StatefulRunsc()
      runsc.failList = mode === "failed"
      runsc.malformedList = mode === "malformed"
      const reaper = new GVisorOrphanReaper({
        maxAgeMs: 30 * 60_000,
        processRunner: runsc,
        diskManager: disks,
      })

      await expect(reaper.reap()).rejects.toThrow(/runsc list/)
      expect(disks.destroyed).toEqual([])
      expect(await disks.readOwnedAllocation(stale.bundleDir)).not.toBeNull()
    },
  )

  it("startup reapAll is not age-gated", async () => {
    const disks = new FakeSandboxDiskManager(bundlesRootDir)
    const fresh = await disks.createAllocation({ expectedOutsideBytes: 0 })
    const reaper = new GVisorOrphanReaper({
      processRunner: new StatefulRunsc(),
      diskManager: disks,
    })

    await expect(reaper.reapAll()).resolves.toEqual([
      path.basename(fresh.bundleDir),
    ])
    expect(disks.destroyed).toEqual([fresh.bundleDir])
  })

  it("preserves disk resources when runsc container deletion fails", async () => {
    const disks = new FakeSandboxDiskManager(bundlesRootDir)
    const stale = await disks.createAllocation({ expectedOutsideBytes: 0 })
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(stale.bundleDir, old, old)
    const runsc = new StatefulRunsc([{ id: "busy", bundle: stale.bundleDir }])
    runsc.failDelete = true
    const reaper = new GVisorOrphanReaper({
      maxAgeMs: 30 * 60_000,
      processRunner: runsc,
      diskManager: disks,
    })

    await expect(reaper.reap()).rejects.toThrow(
      /could not be reconciled safely/,
    )
    expect(disks.destroyed).toEqual([])
  })

  it("still verifies runsc state when no owned allocation is stale", async () => {
    const disks = new FakeSandboxDiskManager(bundlesRootDir)
    await disks.createAllocation({ expectedOutsideBytes: 0 })
    const runsc = new StatefulRunsc()
    const reaper = new GVisorOrphanReaper({
      maxAgeMs: 30 * 60_000,
      processRunner: runsc,
      diskManager: disks,
    })

    await expect(reaper.reap()).resolves.toEqual([])
    expect(
      runsc.calls.filter((call) => call.args.includes("list")),
    ).toHaveLength(1)
  })

  it("fails closed on a runsc container under the root with no marker-owned bundle", async () => {
    const disks = new FakeSandboxDiskManager(bundlesRootDir)
    const legacyBundle = path.join(bundlesRootDir, "legacy-job-bundle")
    const runsc = new StatefulRunsc([{ id: "legacy", bundle: legacyBundle }])
    const reaper = new GVisorOrphanReaper({
      processRunner: runsc,
      diskManager: disks,
    })

    await expect(reaper.reapAll()).rejects.toThrow(
      /without a valid allocation marker/,
    )
    expect(runsc.calls.some((call) => call.args.includes("delete"))).toBe(false)
  })
})
