import { describe, expect, it, vi } from "vitest"

import type { ProcessRunner } from "../services/preview-worker/gvisor/processRunner"
import { runscKillArgs } from "../services/preview-worker/gvisor/runscCli"
import { PendingSignalProcessRunner } from "./support/pendingSignalProcessRunner"

const args = runscKillArgs({ runscRootDir: "/test/runsc" }, "owned", "SIGTERM")
const options = { timeoutMs: 10_000 }
const result = { exitCode: 1, timedOut: false, stdout: "", stderr: "" }

describe("PendingSignalProcessRunner (portable synchronization only)", () => {
  it("holds the exact signal call and delegates its unchanged result only after release", async () => {
    const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue(result)
    const boundary = new PendingSignalProcessRunner({ run }, "/test/runsc")
    boundary.arm("owned")
    const done = boundary.run("runsc", args, options)
    try {
      await boundary.waitUntilPending()
      expect(boundary.pending).toBe(true)
      expect(boundary.delegated).toBe(false)
      expect(run).not.toHaveBeenCalled()
    } finally {
      boundary.release()
    }
    expect(await done).toBe(result)
    expect(boundary.signalResult).toBe(result)
    expect(run).toHaveBeenCalledExactlyOnceWith("runsc", args, options)
    expect(boundary.pending).toBe(false)
  })

  it.each([
    ["other-binary", args],
    ["runsc", args.map((arg) => (arg === "/test/runsc" ? "/other" : arg))],
    ["runsc", args.map((arg) => (arg === "owned" ? "other" : arg))],
    ["runsc", args.map((arg) => (arg === "SIGTERM" ? "SIGKILL" : arg))],
    ["runsc", ["--root", "/test/runsc", "delete", "--force", "owned"]],
  ])("does not hold an unrelated call: %s %j", async (command, callArgs) => {
    const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue(result)
    const boundary = new PendingSignalProcessRunner({ run }, "/test/runsc")
    boundary.arm("owned")
    expect(await boundary.run(command, callArgs, options)).toBe(result)
    expect(run).toHaveBeenCalledExactlyOnceWith(command, callArgs, options)
    expect(boundary.pending).toBe(false)
  })

  it("fails a missing boundary by deadline instead of accepting elapsed time as evidence", async () => {
    vi.useFakeTimers()
    try {
      const boundary = new PendingSignalProcessRunner(
        { run: vi.fn<ProcessRunner["run"]>() },
        "/test/runsc",
      )
      const assertion = expect(boundary.waitUntilPending(100)).rejects.toThrow(
        "boundary was not reached",
      )
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("allows early release for cleanup but never reports it as a pending boundary", async () => {
    const boundary = new PendingSignalProcessRunner(
      { run: vi.fn<ProcessRunner["run"]>().mockResolvedValue(result) },
      "/test/runsc",
    )
    boundary.arm("owned")
    boundary.release()
    expect(await boundary.run("runsc", args, options)).toBe(result)
    await expect(boundary.waitUntilPending()).rejects.toThrow(
      "no longer pending",
    )
    expect(() => boundary.arm("another")).toThrow("already armed")
    await expect(boundary.run("runsc", args, options)).rejects.toThrow("twice")
  })

  it("preserves a delegated runner rejection", async () => {
    const failure = new Error("test runner failure")
    const boundary = new PendingSignalProcessRunner(
      { run: vi.fn<ProcessRunner["run"]>().mockRejectedValue(failure) },
      "/test/runsc",
    )
    boundary.arm("owned")
    const done = boundary.run("runsc", args, options)
    const assertion = expect(done).rejects.toBe(failure)
    try {
      await boundary.waitUntilPending()
    } finally {
      boundary.release()
    }
    await assertion
    expect(boundary.signalResult).toBeNull()
  })
})
