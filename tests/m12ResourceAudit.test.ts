import { describe, expect, it } from "vitest"

import {
  auditResources,
  combineResourceAudit,
  snapshotResources,
  type ResourceAuditOperations,
  type ResourceAuditScope,
} from "./support/m12ResourceAudit"

const unit = `peephole-m12-${"a".repeat(32)}.service`
const cgroup = `/sys/fs/cgroup/system.slice/${unit}`
const scope: ResourceAuditScope = {
  roots: [
    "/srv/m12/workspace",
    "/srv/m12/runsc",
    "/srv/m12/tmpfs",
    "/srv/m12/rootfs",
  ],
  unit,
  pid: 123,
}

function enoent(): never {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
}

/** Synthetic Linux view; every field is mutable per test. NO native access. */
function host() {
  const state = {
    mounts: [
      ["/", "ext4"],
      ["/sys/fs/cgroup", "cgroup2"],
      ["/srv/m12/tmpfs", "tmpfs"],
    ] as Array<[string, string]>,
    selfCgroup: `0::/system.slice/${unit}\n`,
    cgroups: {
      [cgroup]: { procs: "123\n", children: [] as string[] },
    } as Record<string, { procs: string; children: string[] }>,
    processes: {
      "1": { ppid: 0, argv: "/sbin/init\0" },
      "123": {
        ppid: 1,
        argv: "node\0--import\0tsx\0runM12JournalVerification.ts\0",
      },
      "200": { ppid: 1, argv: "/usr/sbin/sshd\0-D\0" },
    } as Record<string, { ppid: number; argv: string; start?: number }>,
    netns: null as string[] | null,
    links: ["lo", "eth0"],
    rules: "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n",
    netnsIds: { self: "net:[4026531840]", init: "net:[4026531840]" },
    unreadable: new Set<string>(),
    failingCommands: new Set<string>(),
  }
  const operations: ResourceAuditOperations = {
    readFile: async (candidate) => {
      if (state.unreadable.has(candidate))
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      if (candidate === "/proc/self/mountinfo")
        return state.mounts
          .map(
            ([point, type], i) =>
              `${String(i + 20)} 1 0:${String(i)} / ${point} rw - ${type} src rw\n`,
          )
          .join("")
      if (candidate === "/proc/self/cgroup") return state.selfCgroup
      if (candidate.endsWith("/cgroup.procs")) {
        const group = state.cgroups[candidate.slice(0, -"/cgroup.procs".length)]
        return group ? group.procs : enoent()
      }
      const proc = /^\/proc\/([0-9]+)\/(stat|cmdline)$/.exec(candidate)
      const entry = proc?.[1] ? state.processes[proc[1]] : undefined
      if (!proc || !entry) return enoent()
      return proc[2] === "stat"
        ? `${proc[1]} (some (odd) comm) S ${String(entry.ppid)} ${"0 ".repeat(17)}${String(entry.start ?? 5000)} 0 0`
        : entry.argv
    },
    readdir: async (candidate) => {
      if (state.unreadable.has(candidate))
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      if (candidate === "/proc")
        return [...Object.keys(state.processes), "self", "meminfo"].map(
          (name) => ({
            name,
            directory: true,
          }),
        )
      if (candidate === "/run/netns")
        return state.netns
          ? state.netns.map((name) => ({ name, directory: false }))
          : enoent()
      const group = state.cgroups[candidate]
      if (!group) return enoent()
      return [
        { name: "cgroup.procs", directory: false },
        ...group.children.map((name) => ({ name, directory: true })),
      ]
    },
    readlink: async (candidate) =>
      candidate === "/proc/self/ns/net"
        ? state.netnsIds.self
        : state.netnsIds.init,
    command: async (binary) => {
      if (state.failingCommands.has(binary))
        throw new Error("COMMAND_INCOMPLETE")
      if (binary === "ip")
        return JSON.stringify(state.links.map((ifname) => ({ ifname })))
      return state.rules
    },
  }
  return { state, operations }
}

async function audit(
  mutate: (state: ReturnType<typeof host>["state"]) => void,
) {
  const { state, operations } = host()
  const before = await snapshotResources(scope, operations)
  mutate(state)
  return auditResources(scope, before, operations)
}

const clean = { mounts: "PASS", processes: "PASS", network: "PASS" }

describe("M12 live resource audit (synthetic inputs, NO native commands)", () => {
  it("passes a completely cleaned run and emits statuses only", async () => {
    const result = await audit(() => undefined)
    expect(result).toEqual(clean)
    expect(combineResourceAudit(result)).toBe("PASS")
  })

  it("tolerates ip's own /run/netns self-bind mount created by the run", async () => {
    expect(
      await audit((s) => {
        s.mounts.push(["/run/netns", "tmpfs"])
        s.netns = []
      }),
    ).toEqual(clean)
  })

  it.each([
    [
      "a loop workspace mount",
      "/srv/m12/workspace/run-1/bundles/x/rootfs",
      "ext4",
    ],
    ["a material tmpfs", "/srv/m12/tmpfs/run-1/secrets/x", "tmpfs"],
    [
      "a runsc null-netns bind",
      "/srv/m12/runsc/run-1/state/null-netns",
      "nsfs",
    ],
    ["a stacked mount on a baseline mount point", "/srv/m12/tmpfs", "tmpfs"],
    ["a netns bind", "/run/netns/peephole-7", "nsfs"],
  ])("fails a residual %s", async (_kind, point, type) => {
    const result = await audit((s) => s.mounts.push([point, type]))
    expect(result).toEqual({ ...clean, mounts: "FAIL" })
  })

  it("fails a baseline test-root mount that disappeared", async () => {
    expect(await audit((s) => s.mounts.splice(2, 1))).toEqual({
      ...clean,
      mounts: "FAIL",
    })
  })

  it("fails a residual process in the unit cgroup", async () => {
    expect(
      await audit((s) => {
        const group = s.cgroups[cgroup]
        if (group) group.procs = "123\n456\n"
        s.processes["456"] = { ppid: 1, argv: "orphan\0" }
      }),
    ).toEqual({ ...clean, processes: "FAIL" })
  })

  it("fails a residual process in a nested descendant cgroup", async () => {
    expect(
      await audit((s) => {
        s.cgroups[cgroup]?.children.push("runsc")
        s.cgroups[`${cgroup}/runsc`] = { procs: "", children: ["sandbox"] }
        s.cgroups[`${cgroup}/runsc/sandbox`] = { procs: "789\n", children: [] }
        s.processes["789"] = { ppid: 1, argv: "sandbox\0" }
      }),
    ).toEqual({ ...clean, processes: "FAIL" })
  })

  it("fails a process that left the unit cgroup but still names a test root", async () => {
    expect(
      await audit((s) => {
        s.processes["900"] = {
          ppid: 1,
          argv: "runsc\0--root\0/srv/m12/runsc/run-1/state\0boot\0",
        }
      }),
    ).toEqual({ ...clean, processes: "FAIL" })
  })

  it("tolerates the controller's pre-existing direct child (tsx's esbuild service)", async () => {
    const { state, operations } = host()
    state.processes["130"] = {
      ppid: 123,
      argv: "esbuild\0--service=0.25\0--ping\0",
    }
    const group = state.cgroups[cgroup]
    if (group) group.procs = "123\n130\n"
    const before = await snapshotResources(scope, operations)
    expect(await auditResources(scope, before, operations)).toEqual(clean)
  })

  it("fails a reused PID with a different start time", async () => {
    const { state, operations } = host()
    state.processes["130"] = { ppid: 123, argv: "esbuild\0" }
    const group = state.cgroups[cgroup]
    if (group) group.procs = "123\n130\n"
    const before = await snapshotResources(scope, operations)
    state.processes["130"] = { ppid: 1, argv: "leaked\0", start: 9000 }
    expect(await auditResources(scope, before, operations)).toEqual({
      ...clean,
      processes: "FAIL",
    })
  })

  it("fails a new child of the controller that did not exist at the baseline", async () => {
    expect(
      await audit((s) => {
        s.processes["140"] = { ppid: 123, argv: "sleep\0" }
        const group = s.cgroups[cgroup]
        if (group) group.procs = "123\n140\n"
      }),
    ).toEqual({ ...clean, processes: "FAIL" })
  })

  it("is incomplete when the controller is absent from its unit cgroup", async () => {
    expect(
      await audit((s) => {
        const group = s.cgroups[cgroup]
        if (group) group.procs = ""
      }),
    ).toEqual({ ...clean, processes: "INCOMPLETE" })
  })

  it.each([
    [
      "a netns name",
      (s: ReturnType<typeof host>["state"]) => (s.netns = ["peephole-3"]),
    ],
    [
      "a host veth",
      (s: ReturnType<typeof host>["state"]) => s.links.push("veph3"),
    ],
    [
      "a peer veth in the host netns",
      (s: ReturnType<typeof host>["state"]) => s.links.push("vpph3"),
    ],
    [
      "an iptables chain",
      (s: ReturnType<typeof host>["state"]) =>
        (s.rules = "*filter\n:ppe3 - [0:0]\nCOMMIT\n"),
    ],
    [
      "an iptables comment",
      (s: ReturnType<typeof host>["state"]) =>
        (s.rules =
          '*nat\n-A POSTROUTING -m comment --comment "peephole-x-3" -j MASQUERADE\nCOMMIT\n'),
    ],
  ])("fails residual network state: %s", async (_kind, mutate) => {
    expect(await audit(mutate)).toEqual({ ...clean, network: "FAIL" })
  })

  it.each([
    [
      "unreadable mountinfo",
      { mounts: "INCOMPLETE", processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        s.unreadable.add("/proc/self/mountinfo"),
    ],
    [
      "a hybrid cgroup v1 view",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        (s.selfCgroup = `1:name=systemd:/x/${unit}\n0::/x/${unit}\n`),
    ],
    [
      "another unit's cgroup",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        (s.selfCgroup = "0::/system.slice/ssh.service\n"),
    ],
    [
      "no cgroup2 mount",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        (s.mounts = s.mounts.filter(([p]) => p !== "/sys/fs/cgroup")),
    ],
    [
      "an unreadable child cgroup",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => {
        s.cgroups[cgroup]?.children.push("hidden")
        s.unreadable.add(`${cgroup}/hidden/cgroup.procs`)
      },
    ],
    [
      "an unreadable process argv",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        s.unreadable.add("/proc/200/cmdline"),
    ],
    [
      "an unreadable process table",
      { processes: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => s.unreadable.add("/proc"),
    ],
    [
      "a private network namespace",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        (s.netnsIds.self = "net:[4026532000]"),
    ],
    [
      "an unlistable netns directory",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => s.unreadable.add("/run/netns"),
    ],
    [
      "a failed link inventory",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => s.failingCommands.add("ip"),
    ],
    [
      "an empty link inventory",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => (s.links = []),
    ],
    [
      "a failed ip6tables inventory",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) =>
        s.failingCommands.add("ip6tables-save"),
    ],
    [
      "a truncated rules dump",
      { network: "INCOMPLETE" },
      (s: ReturnType<typeof host>["state"]) => (s.rules = "*filter\n"),
    ],
  ])("never treats %s as clean", async (_kind, expected, mutate) => {
    expect(await audit(mutate)).toEqual({ ...clean, ...expected })
  })

  it("rejects an oversized cgroup tree as incomplete", async () => {
    expect(
      await audit((s) => {
        const children = Array.from({ length: 300 }, (_, i) => `c${String(i)}`)
        s.cgroups[cgroup] = { procs: "123\n", children }
        for (const child of children)
          s.cgroups[`${cgroup}/${child}`] = { procs: "", children: [] }
      }),
    ).toEqual({ ...clean, processes: "INCOMPLETE" })
  })

  it("keeps a FAIL in one area when another area is unreadable", async () => {
    const result = await audit((s) => {
      s.links.push("veph9")
      s.unreadable.add("/proc/self/mountinfo")
    })
    expect(result).toEqual({
      mounts: "INCOMPLETE",
      processes: "INCOMPLETE",
      network: "FAIL",
    })
    expect(combineResourceAudit(result)).toBe("FAIL")
  })

  it.each([
    [
      "a pre-existing netns",
      (s: ReturnType<typeof host>["state"]) => (s.netns = ["peephole-1"]),
    ],
    [
      "a pre-existing veth",
      (s: ReturnType<typeof host>["state"]) => s.links.push("veph1"),
    ],
    [
      "pre-existing rules",
      (s: ReturnType<typeof host>["state"]) =>
        (s.rules = "*filter\n:ppi1 - [0:0]\nCOMMIT\n"),
    ],
    [
      "a pre-existing netns bind",
      (s: ReturnType<typeof host>["state"]) =>
        s.mounts.push(["/run/netns/peephole-1", "nsfs"]),
    ],
    [
      "a foreign process in the unit cgroup",
      (s: ReturnType<typeof host>["state"]) => {
        s.processes["150"] = { ppid: 1, argv: "other\0" }
        const group = s.cgroups[cgroup]
        if (group) group.procs = "123\n150\n"
      },
    ],
    [
      "an unreadable baseline",
      (s: ReturnType<typeof host>["state"]) =>
        s.unreadable.add("/proc/self/mountinfo"),
    ],
  ])("refuses a non-attributable baseline: %s", async (_kind, mutate) => {
    const { state, operations } = host()
    mutate(state)
    await expect(snapshotResources(scope, operations)).rejects.toThrow()
  })
})
