import type { ChildProcess } from "node:child_process"

export function parseSecretMaterial(contents: string): Record<string, string>

export function runSecretBootstrap(options?: {
  secretFile?: string
  nodeBinary?: string
  childArgs?: string[]
  baseEnvironment?: NodeJS.ProcessEnv
  spawnChild?: (
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv
      shell: false
      stdio: "inherit"
    },
  ) => ChildProcess
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
