export interface RunscGlobalOptions {
  runscRootDir: string
}

export type RunscNetworkMode = "none" | "sandbox"

export function runscRunArgs(
  global: RunscGlobalOptions,
  options: { bundleDir: string; containerId: string; network: RunscNetworkMode },
): string[] {
  return [
    "--root",
    global.runscRootDir,
    `--network=${options.network}`,
    "run",
    "--bundle",
    options.bundleDir,
    options.containerId,
  ]
}

export function runscKillArgs(
  global: RunscGlobalOptions,
  containerId: string,
): string[] {
  return ["--root", global.runscRootDir, "kill", containerId, "SIGKILL"]
}

export function runscDeleteArgs(
  global: RunscGlobalOptions,
  containerId: string,
): string[] {
  return ["--root", global.runscRootDir, "delete", "--force", containerId]
}
