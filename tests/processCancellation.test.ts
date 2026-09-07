import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { NodeProcessRunner } from "../services/preview-worker/gvisor/nodeProcessRunner"

describe("real process termination", () => {
  it("kills the child process tree on cancellation", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "peephole-process-test-"),
    )
    const marker = path.join(directory, "pids.json")
    const controller = new AbortController()
    let pids: number[] = []
    const script = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
    const done = new NodeProcessRunner().run(
      process.execPath,
      ["-e", script, marker],
      { timeoutMs: 10000, signal: controller.signal },
    )
    const result = done.catch((error) => error)
    try {
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await readFile(marker, "utf8"))
          expect(pids).toHaveLength(2)
        },
        { timeout: 5000 },
      )
      const reason = new Error("cancelled by user")
      controller.abort(reason)
      expect(await result).toBe(reason)
      await vi.waitFor(
        () => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
        },
        { timeout: 5000 },
      )
    } finally {
      controller.abort()
      await result
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* Already stopped. */
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it("reports a real wall-clock timeout", async () => {
    const result = await new NodeProcessRunner().run(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeoutMs: 100 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })
})
