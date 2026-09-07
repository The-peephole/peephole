import { spawn } from "node:child_process"
import path from "node:path"

import { MAX_CAPTURED_LOG_BYTES } from "../../../core/runner/runnerLimits"
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "./processRunner"

/** Host binary execution with bounded logs and process-tree termination. */
export class NodeProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    options.signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell ?? false,
        windowsHide: true,
        detached: process.platform !== "win32",
      })
      let stdout: Buffer = Buffer.alloc(0)
      let stderr: Buffer = Buffer.alloc(0)
      let timedOut = false
      let termination: Promise<void> | undefined
      const stop = () => {
        if (child.pid && !termination) termination = killProcessTree(child.pid)
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, options.timeoutMs)
      timer.unref()
      const abort = () => stop()
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) stop()

      const cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk)
      })
      child.once("error", (error) => {
        cleanup()
        reject(error)
      })
      child.once("close", (exitCode) => {
        cleanup()
        void (termination ?? Promise.resolve()).then(() => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
          } else {
            resolve({
              exitCode,
              timedOut,
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
            })
          }
        }, reject)
      })
    })
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        path.join(
          process.env.SYSTEMROOT ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      )
      killer.once("error", () => {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* Already gone. */
        }
        resolve()
      })
      killer.once("close", () => resolve())
    })
  } else {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  const remaining = MAX_CAPTURED_LOG_BYTES - current.byteLength
  return remaining > 0
    ? Buffer.concat([current, chunk.subarray(0, remaining)])
    : current
}
