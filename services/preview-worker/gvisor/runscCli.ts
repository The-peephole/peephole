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

/**
 * Defaults to `SIGKILL` -- the right choice for every existing caller here
 * (RunscCommandRunner's own timeout cancellation, GVisorSandboxProvisioner's
 * workspace teardown, GVisorOrphanReaper's abandoned-container reclaim): none
 * of them run a persistent server whose graceful shutdown matters, and an
 * uncatchable signal guarantees the container dies before the caller moves
 * on. `GVisorBackendRuntimeProcess.stop()` is the one caller that passes
 * `SIGTERM` explicitly, since the trusted secret-bootstrap PID 1
 * (`scripts/gvisor/secret-bootstrap.mjs`) can only forward a signal it is
 * actually able to catch.
 */
export function runscKillArgs(
  global: RunscGlobalOptions,
  containerId: string,
  signal: "SIGKILL" | "SIGTERM" = "SIGKILL",
): string[] {
  return ["--root", global.runscRootDir, "kill", containerId, signal]
}

export function runscDeleteArgs(
  global: RunscGlobalOptions,
  containerId: string,
): string[] {
  return ["--root", global.runscRootDir, "delete", "--force", containerId]
}
