import type { SandboxResourceLimits } from "../../../core/runner/runnerLimits"

export interface OciConfigOptions {
  command: string[]
  cwd: string
  env: string[]
  uid: number
  gid: number
  hostname: string
  resourceLimits: SandboxResourceLimits
}

export interface OciRuntimeSpec {
  ociVersion: string
  process: {
    terminal: boolean
    user: { uid: number; gid: number }
    args: string[]
    env: string[]
    cwd: string
    capabilities: {
      bounding: string[]
      effective: string[]
      inheritable: string[]
      permitted: string[]
      ambient: string[]
    }
    noNewPrivileges: boolean
  }
  root: { path: string; readonly: boolean }
  hostname: string
  mounts: Array<{
    destination: string
    type: string
    source: string
    options?: string[]
  }>
  linux: {
    namespaces: Array<{ type: string }>
    resources: {
      cpu: { quota: number; period: number }
      memory: { limit: number }
      pids: { limit: number }
    }
    maskedPaths: string[]
    readonlyPaths: string[]
  }
}

const CPU_PERIOD_MICROSECONDS = 100_000

/**
 * A non-root, capability-stripped, resource-quota'd OCI bundle spec for
 * runsc. The uid/gid must belong to an unprivileged user baked into the
 * base rootfs image -- this never runs as uid 0.
 */
export function buildOciRuntimeSpec(options: OciConfigOptions): OciRuntimeSpec {
  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: { uid: options.uid, gid: options.gid },
      args: options.command,
      env: options.env,
      cwd: options.cwd,
      capabilities: {
        bounding: [],
        effective: [],
        inheritable: [],
        permitted: [],
        ambient: [],
      },
      noNewPrivileges: true,
    },
    root: { path: "rootfs", readonly: false },
    hostname: options.hostname,
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "noexec"],
      },
    ],
    linux: {
      namespaces: [
        { type: "pid" },
        { type: "network" },
        { type: "ipc" },
        { type: "uts" },
        { type: "mount" },
      ],
      resources: {
        cpu: {
          quota: options.resourceLimits.cpuCount * CPU_PERIOD_MICROSECONDS,
          period: CPU_PERIOD_MICROSECONDS,
        },
        memory: { limit: options.resourceLimits.memoryBytes },
        pids: { limit: options.resourceLimits.maxPids },
      },
      maskedPaths: ["/proc/kcore", "/proc/keys", "/sys/firmware"],
      readonlyPaths: [],
    },
  }
}
