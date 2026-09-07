export interface RunscGlobalOptions {
  runscRootDir: string
}

/**
 * "host" shares the runner's own network namespace directly, defeating
 * network isolation entirely -- it exists only as a diagnostic escape
 * hatch for environments where gVisor's own isolated "sandbox" network
 * mode isn't reachable (e.g. nested NAT under WSL2; see
 * tests/realGvisorGoldenPath.test.ts), and must never be used for an
 * untrusted install/build in production.
 */
export type RunscNetworkMode = "none" | "sandbox" | "host"

export function runscRunArgs(
  global: RunscGlobalOptions,
  options: {
    bundleDir: string
    containerId: string
    network: RunscNetworkMode
  },
): string[] {
  return [
    "--root",
    global.runscRootDir,
    `--network=${options.network}`,
    // Without this, runsc wraps the root mount in a copy-on-write overlay
    // (default: root:self) whose upper layer is discarded when the
    // container exits, so writes never reach the bundle's rootfs directory
    // on disk. NpmDependencyInstaller and NpmBuildExecutor each run in
    // their own single-command container but expect to share one on-disk
    // rootfs (install writes node_modules, a later container builds
    // against it), and the host-side worker needs to read the output back
    // afterward -- both require real writes to actually land on disk.
    "--overlay2=none",
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
