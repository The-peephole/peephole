import { describe, expect, it } from "vitest"

import {
  ensureProductionPreflight,
  ensureProductionDiskLayout,
  ensureSandboxDiskCapability,
  runProductionPreflightChecks,
} from "../services/production/preflight"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"

class FakeProcessRunner implements ProcessRunner {
  constructor(
    private readonly responses: Record<
      string,
      ProcessRunResult | "reject"
    > = {},
  ) {}

  async run(command: string): Promise<ProcessRunResult> {
    const response = this.responses[command]

    if (response === "reject" || response === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
      })
    }

    return response
  }
}

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, timedOut: false, stdout, stderr: "" }
}

const HEALTHY_FILES: Record<string, string> = {
  "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
  "/proc/sys/net/ipv4/ip_forward": "1\n",
  "/etc/resolv.conf": "nameserver 10.255.255.254\n",
}

const HEALTHY_EXISTS = new Set([
  "/sys/fs/cgroup/cgroup.controllers",
  "/var/lib/peephole/base-rootfs/usr/local/bin/node",
])

function healthyOptions() {
  return {
    baseRootfsImage: "/var/lib/peephole/base-rootfs",
    processRunner: new FakeProcessRunner({
      runsc: ok("runsc version release-20260817.0"),
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
      fallocate: ok("fallocate from util-linux"),
      "mkfs.ext4": ok("mke2fs 1.47"),
      mount: ok("mount from util-linux"),
      umount: ok("umount from util-linux"),
      losetup: ok("losetup from util-linux"),
      findmnt: ok("findmnt from util-linux"),
    }),
    readFile: (path: string) => HEALTHY_FILES[path] ?? null,
    pathExists: async (path: string) => HEALTHY_EXISTS.has(path),
  }
}

describe("runProductionPreflightChecks", () => {
  it("reports every check ok on a healthy host", async () => {
    const results = await runProductionPreflightChecks(healthyOptions())

    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => result.name)).toEqual([
      "runsc",
      "ip",
      "iptables",
      "ip6tables",
      "fallocate",
      "mkfs.ext4",
      "mount",
      "umount",
      "losetup",
      "findmnt",
      "cgroup v2",
      "net.ipv4.ip_forward",
      "base rootfs image",
      "DNS config source",
    ])
  })

  it("fails the runsc check when the binary is not on PATH", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
    })

    const results = await runProductionPreflightChecks(options)
    const runsc = results.find((result) => result.name === "runsc")

    expect(runsc?.ok).toBe(false)
    expect(runsc?.detail).toMatch(/not runnable on PATH/)
  })

  it("fails closed before accepting jobs when ip6tables is unavailable", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      runsc: ok("runsc version release-20260817.0"),
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
    })

    const results = await runProductionPreflightChecks(options)
    const ip6tables = results.find((result) => result.name === "ip6tables")

    expect(ip6tables?.ok).toBe(false)
    expect(ip6tables?.detail).toMatch(/not runnable on PATH/)
  })

  it("fails the ip_forward check when it reads 0", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) =>
      path === "/proc/sys/net/ipv4/ip_forward"
        ? "0\n"
        : (HEALTHY_FILES[path] ?? null)

    const results = await runProductionPreflightChecks(options)
    const ipForward = results.find(
      (result) => result.name === "net.ipv4.ip_forward",
    )

    expect(ipForward?.ok).toBe(false)
    expect(ipForward?.detail).toMatch(/sysctl -w net\.ipv4\.ip_forward=1/)
  })

  it("fails the cgroup v2 check when the unified hierarchy marker is missing", async () => {
    const options = healthyOptions()
    options.pathExists = async (path: string) =>
      path !== "/sys/fs/cgroup/cgroup.controllers" && HEALTHY_EXISTS.has(path)

    const results = await runProductionPreflightChecks(options)
    const cgroup = results.find((result) => result.name === "cgroup v2")

    expect(cgroup?.ok).toBe(false)
  })

  it("fails the base rootfs check when the image is missing node", async () => {
    const options = healthyOptions()
    options.pathExists = async (path: string) =>
      path === "/sys/fs/cgroup/cgroup.controllers"

    const results = await runProductionPreflightChecks(options)
    const rootfs = results.find((result) => result.name === "base rootfs image")

    expect(rootfs?.ok).toBe(false)
    expect(rootfs?.detail).toMatch(/base-rootfs\.sh/)
  })

  it("fails the DNS check when resolv.conf resolves to a loopback-only stub with no usable uplink", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) =>
      path === "/etc/resolv.conf"
        ? "nameserver 127.0.0.53\n"
        : (HEALTHY_FILES[path] ?? null)

    const results = await runProductionPreflightChecks(options)
    const dns = results.find((result) => result.name === "DNS config source")

    expect(dns?.ok).toBe(false)
    expect(dns?.detail).toMatch(/no usable/)
  })

  it("passes the DNS check when the systemd-resolved uplink file is usable", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) => {
      if (path === "/etc/resolv.conf") return "nameserver 127.0.0.53\n"
      if (path === "/run/systemd/resolve/resolv.conf")
        return "nameserver 172.31.0.2\n"
      return HEALTHY_FILES[path] ?? null
    }

    const results = await runProductionPreflightChecks(options)
    const dns = results.find((result) => result.name === "DNS config source")

    expect(dns?.ok).toBe(true)
    expect(dns?.detail).toMatch(/run\/systemd\/resolve\/resolv\.conf/)
  })
})

describe("ensureProductionPreflight", () => {
  it("resolves without throwing on a healthy host", async () => {
    await expect(
      ensureProductionPreflight(healthyOptions()),
    ).resolves.toBeUndefined()
  })

  it("throws one error listing every failed check", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
    })
    options.readFile = (path: string) =>
      path === "/proc/sys/net/ipv4/ip_forward" ? "0\n" : null

    await expect(ensureProductionPreflight(options)).rejects.toThrow(
      /runsc[\s\S]*ip[\s\S]*net\.ipv4\.ip_forward[\s\S]*DNS config source/,
    )
  })
})

describe("ensureSandboxDiskCapability", () => {
  it("fails closed when the post-reconciliation loop/ext4 probe fails", async () => {
    const unusedManager = {} as Parameters<
      typeof ensureSandboxDiskCapability
    >[0]
    await expect(
      ensureSandboxDiskCapability(unusedManager, async () => {
        throw new Error("mount denied")
      }),
    ).rejects.toThrow(/hard-quota capability probe failed.*mount denied/)
  })
})

describe("ensureProductionDiskLayout", () => {
  it("requires artifact publication to share the admission filesystem", async () => {
    const prepared: string[] = []
    await expect(
      ensureProductionDiskLayout({
        bundlesRootDir: "/jobs",
        artifactStorageDir: "/artifacts",
        prepareDirectory: async (candidate) => {
          prepared.push(candidate)
        },
        deviceFor: async (candidate) => (candidate === "/jobs" ? 1 : 2),
      }),
    ).rejects.toThrow(/must share a filesystem/)
    expect(prepared).toEqual(["/jobs", "/artifacts"])
  })

  it("accepts a shared bundles/artifact filesystem", async () => {
    await expect(
      ensureProductionDiskLayout({
        bundlesRootDir: "/jobs",
        artifactStorageDir: "/artifacts",
        prepareDirectory: async () => undefined,
        deviceFor: async () => 7,
      }),
    ).resolves.toBeUndefined()
  })
})
