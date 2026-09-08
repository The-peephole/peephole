import type { SandboxResourceLimits } from "../../../core/runner/runnerLimits"

export interface OciConfigOptions {
  command: string[]
  cwd: string
  env: string[]
  uid: number
  gid: number
  hostname: string
  resourceLimits: SandboxResourceLimits
  /**
   * Join this pre-existing network namespace (e.g.
   * `/var/run/netns/peephole-123`, from VethNatNetworkProvisioner)
   * instead of runsc creating a fresh, unconfigured one. A bare
   * `{ type: "network" }` namespace has no interface, address, or route
   * -- gVisor's --network=sandbox netstack then has nothing to attach to,
   * so every connection fails with ENETUNREACH.
   */
  networkNamespacePath?: string
  /**
   * Host path bind-mounted as the sandbox's own /etc/resolv.conf. Callers
   * should compute this via resolveDnsConfigSource() rather than always
   * passing "/etc/resolv.conf" directly -- see that function's doc
   * comment for why a systemd-resolved host's own resolv.conf is often
   * unusable as-is from inside a separate network namespace.
   */
  dnsConfigSource: string
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
    namespaces: Array<{ type: string; path?: string }>
    resources: {
      cpu: { quota: number; period: number }
      memory: { limit: number; swap: number }
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
      // CAP_NET_BIND_SERVICE matches gVisor's own default OCI spec
      // (`runsc spec`) and is otherwise low-risk (only lets a process bind
      // to a port below 1024, which nothing here needs to do to reach
      // out); it is included because omitting it is one of a few
      // differences between this spec and the one that's known to
      // successfully bring up gVisor's --network=sandbox netstack.
      capabilities: {
        bounding: ["CAP_NET_BIND_SERVICE"],
        effective: ["CAP_NET_BIND_SERVICE"],
        inheritable: ["CAP_NET_BIND_SERVICE"],
        permitted: ["CAP_NET_BIND_SERVICE"],
        ambient: [],
      },
      noNewPrivileges: true,
    },
    root: { path: "rootfs", readonly: false },
    hostname: options.hostname,
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      { destination: "/dev", type: "tmpfs", source: "tmpfs" },
      {
        destination: "/sys",
        type: "sysfs",
        source: "sysfs",
        options: ["nosuid", "noexec", "nodev", "ro"],
      },
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "noexec"],
      },
      // Harmless with network "none" (nothing can reach a resolver either
      // way); with network "sandbox", without this the container's stub
      // resolver has no nameserver at all and every DNS lookup (e.g. the
      // npm registry) fails with EAI_AGAIN before a single connection is
      // attempted. dnsConfigSource is not always literally
      // "/etc/resolv.conf" -- see resolveDnsConfigSource().
      {
        destination: "/etc/resolv.conf",
        type: "bind",
        source: options.dnsConfigSource,
        options: ["bind", "ro"],
      },
    ],
    linux: {
      namespaces: [
        { type: "pid" },
        options.networkNamespacePath
          ? { type: "network", path: options.networkNamespacePath }
          : { type: "network" },
        { type: "ipc" },
        { type: "uts" },
        { type: "mount" },
      ],
      resources: {
        cpu: {
          quota: options.resourceLimits.cpuCount * CPU_PERIOD_MICROSECONDS,
          period: CPU_PERIOD_MICROSECONDS,
        },
        // "swap" is the combined memory+swap ceiling (cgroup v2
        // memory.swap.max derives from limit and this); without it a
        // sandboxed process that hits the memory limit just gets pushed
        // into swap instead of OOM-killed -- confirmed on a real gVisor
        // host: memory.current held right at the configured limit while
        // memory.events' "max" counter climbed into the thousands, but
        // the process kept right on allocating well past it because swap
        // was available. Setting swap equal to limit removes that
        // headroom entirely.
        memory: {
          limit: options.resourceLimits.memoryBytes,
          swap: options.resourceLimits.memoryBytes,
        },
        pids: { limit: options.resourceLimits.maxPids },
      },
      maskedPaths: ["/proc/kcore", "/proc/keys", "/sys/firmware"],
      readonlyPaths: [],
    },
  }
}
