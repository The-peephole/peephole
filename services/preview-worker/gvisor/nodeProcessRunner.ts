import { spawn } from "node:child_process"

import { MAX_CAPTURED_LOG_BYTES } from "../../../core/runner/runnerLimits"
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "./processRunner"

/**
 * Real `runsc` invocation for a Linux host with gVisor installed. Untested
 * in this repository's environment (Windows, no Linux kernel, no runsc
 * binary) -- see `RunscCommandRunner`'s tests, which verify the CLI/OCI
 * wiring via a fake `ProcessRunner` instead.
 */
export class NodeProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env })

      let stdout = ""
      let stderr = ""
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref()
      }, options.timeoutMs)
      timer.unref()

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk)
      })

      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code, timedOut, stdout, stderr })
      })
    })
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_CAPTURED_LOG_BYTES) {
    return current
  }

  return (current + chunk.toString("utf8")).slice(0, MAX_CAPTURED_LOG_BYTES)
}
