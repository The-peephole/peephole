import type { LocalPreviewWorkspace } from "./localWorkspace"

export interface CommandRunOptions {
  timeoutMs: number
  signal?: AbortSignal
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * Abstracts *where* a command actually runs so `NpmDependencyInstaller` and
 * `NpmBuildExecutor` never need to know whether they are talking to the host
 * process directly or to a gVisor sandbox. Only the concrete runner differs
 * between the dev and production wiring.
 */
export interface CommandRunner {
  run(
    workspace: LocalPreviewWorkspace,
    command: string,
    args: string[],
    options: CommandRunOptions,
  ): Promise<void>
}

export class CommandExecutionError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = "CommandExecutionError"
  }
}

/** Emitted only when Peephole directly observes its workspace watcher trip.
 * The fixed filesystem capacity remains the security boundary even when an
 * ENOSPC command failure cannot be classified this specifically. */
export class RunnerDiskLimitError extends CommandExecutionError {
  constructor(message: string, stdout: string, stderr: string) {
    super(message, stdout, stderr)
    this.name = "RunnerDiskLimitError"
  }
}
