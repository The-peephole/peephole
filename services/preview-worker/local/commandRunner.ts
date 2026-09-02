import type { LocalPreviewWorkspace } from "./localWorkspace"

export interface CommandRunOptions {
  timeoutMs: number
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
