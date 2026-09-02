export interface ProcessRunOptions {
  cwd?: string
  timeoutMs: number
  env?: Readonly<Record<string, string | undefined>>
}

export interface ProcessRunResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Abstracts invoking a binary on the host so `runsc` CLI argument
 * construction can be verified with a fake in tests, independent of
 * whether `runsc` is actually installed.
 */
export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>
}
