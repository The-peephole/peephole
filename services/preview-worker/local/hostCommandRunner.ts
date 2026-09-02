import { spawn } from "node:child_process"

import { MAX_CAPTURED_LOG_BYTES } from "../../../core/runner/runnerLimits"
import {
  CommandExecutionError,
  type CommandRunner,
  type CommandRunOptions,
} from "./commandRunner"
import type { LocalPreviewWorkspace } from "./localWorkspace"

/**
 * NOT A SECURITY BOUNDARY. Runs the command directly on the host process
 * with the host's full filesystem and network access -- there is no gVisor,
 * no non-root user, and no resource quota here. This exists only to prove
 * the install/build pipeline end to end on a host with no sandbox runtime
 * available. Use `RunscCommandRunner` in any environment that builds
 * untrusted, arbitrary repository content.
 */
export class HostCommandRunner implements CommandRunner {
  async run(
    workspace: LocalPreviewWorkspace,
    command: string,
    args: string[],
    options: CommandRunOptions,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: workspace.rootDir,
        env: options.env,
        windowsHide: true,
        // Windows cannot exec .cmd/.bat files directly (spawn EINVAL); npm
        // ships as npm.cmd there, so this must go through a shell. The args
        // are always our own fixed literals (never repository content), so
        // this carries no injection risk.
        shell: process.platform === "win32",
      })

      let stdout = ""
      let stderr = ""
      let settled = false

      const timer = setTimeout(() => {
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
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.on("close", (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(
            new CommandExecutionError(
              `${command} ${args.join(" ")} exceeded its ${options.timeoutMs}ms timeout.`,
              stdout,
              stderr,
            ),
          )
          return
        }

        if (code !== 0) {
          reject(
            new CommandExecutionError(
              `${command} ${args.join(" ")} exited with code ${String(code)}.`,
              stdout,
              stderr,
            ),
          )
          return
        }

        resolve()
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
