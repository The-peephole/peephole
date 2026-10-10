import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  NetworkOrphanReaper,
  expectedRules,
  sameRule,
} from "../services/preview-worker/gvisor/networkOrphanReaper"
import { NetworkAllocationRegistry } from "../services/preview-worker/gvisor/networkAllocationRegistry"
import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import {
  NetworkLeaseManager,
  deriveNetworkNames,
  toSubnet,
  type NetworkLease,
} from "../services/preview-worker/gvisor/subnetAllocator"

class FakeNetworkHost implements ProcessRunner {
  namespaces = new Set<string>()
  links = new Set<string>()
  ipv4: string[][] = []
  nat: string[][] = []
  ipv6: string[][] = []
  addresses = new Map<string, unknown[]>()
  namespaceAddresses = new Map<string, unknown[]>()
  namespaceRoutes = new Map<string, unknown[]>()
  fail: ((command: string, args: string[]) => boolean) | undefined
  ignoreDeletes = false
  /** Deterministic interleaving points: before a command reads host state,
   * and after it has read state but before its caller resumes. */
  beforeCommand:
    ((command: string, args: string[]) => Promise<void> | void) | undefined
  afterCommand:
    ((command: string, args: string[]) => Promise<void> | void) | undefined
  onNamespaceDeleted: ((namespace: string) => void) | undefined

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    await this.beforeCommand?.(command, args)
    const output = this.dispatch(command, args)
    await this.afterCommand?.(command, args)
    return output
  }

  private dispatch(command: string, args: string[]): ProcessRunResult {
    if (this.fail?.(command, args)) return result(1, "", "injected")
    if (command === "ip") return this.runIp(args)
    if (command === "iptables") return this.runTable(args, false)
    if (command === "ip6tables") return this.runTable(args, true)
    return result(1, "", "unexpected command")
  }

  install(
    lease: NetworkLease,
    state: "marker" | "veth" | "partial" | "full",
    options: { withDefaultRoute?: boolean } = {},
  ) {
    if (state === "marker") return
    this.links.add(lease.hostVeth)
    this.links.add(lease.peerVeth)
    this.addresses.set(lease.hostVeth, [address(lease.hostVeth, lease.hostIp)])
    this.addresses.set(lease.peerVeth, [
      { ifname: lease.peerVeth, addr_info: [] },
    ])
    if (state === "veth") return
    this.links.delete(lease.peerVeth)
    this.namespaces.add(lease.namespace)
    this.namespaceAddresses.set(lease.namespace, [
      address(lease.peerVeth, lease.peerIp),
    ])
    const routes: unknown[] =
      options.withDefaultRoute === false
        ? []
        : [{ dst: "default", gateway: lease.hostIp, dev: lease.peerVeth }]
    if (lease.temporaryDatabaseAccess) {
      routes.push({
        dst: "192.168.253.1/32",
        gateway: lease.hostIp,
        dev: lease.peerVeth,
      })
    }
    this.namespaceRoutes.set(lease.namespace, routes)
    const rules = expectedRules(lease)
    this.ipv4 = state === "partial" ? rules.ipv4.slice(0, 5) : rules.ipv4
    if (state === "full") {
      this.nat = rules.nat ? [rules.nat] : []
      this.ipv6 = rules.ipv6Hooks
    }
  }

  private runIp(args: string[]): ProcessRunResult {
    if (same(args, ["route", "list", "default"])) {
      return result(0, "default via 172.31.0.1 dev eth0\n")
    }
    if (same(args, ["netns", "list"])) {
      return result(0, [...this.namespaces].map((name) => `${name}\n`).join(""))
    }
    if (same(args, ["-o", "link", "show"])) {
      return result(
        0,
        [...this.links]
          .map((name, index) => `${index + 1}: ${name}: <UP>\n`)
          .join(""),
      )
    }
    if (
      ((args[0] === "-j" && args[1] === "addr") ||
        (args[0] === "-d" && args[1] === "-j" && args[2] === "link")) &&
      !this.links.has(args.at(-1) ?? "")
    ) {
      return result(1, "", `Device "${args.at(-1) ?? ""}" does not exist.`)
    }
    if (
      args[0] === "netns" &&
      args[1] === "exec" &&
      !this.namespaces.has(args[2] ?? "")
    ) {
      return result(
        255,
        "",
        `Cannot open network namespace "${args[2] ?? ""}": No such file or directory`,
      )
    }
    if (args[0] === "-j" && args[1] === "addr") {
      return result(
        0,
        JSON.stringify(this.addresses.get(args.at(-1) ?? "") ?? []),
      )
    }
    if (args[0] === "-d" && args[1] === "-j" && args[2] === "link") {
      const ifname = args.at(-1) ?? ""
      return result(
        0,
        JSON.stringify([
          { ifname, mtu: 1500, linkinfo: { info_kind: "veth" } },
        ]),
      )
    }
    if (args[0] === "netns" && args[1] === "exec") {
      const namespace = args[2] ?? ""
      if (args.includes("-d") && args.includes("link")) {
        const ifname = args.at(-1) ?? ""
        return result(
          0,
          JSON.stringify([
            { ifname, mtu: 1500, linkinfo: { info_kind: "veth" } },
          ]),
        )
      }
      if (args.includes("-j") && args.includes("addr"))
        return result(
          0,
          JSON.stringify(this.namespaceAddresses.get(namespace) ?? []),
        )
      if (args.includes("-j") && args.includes("route"))
        return result(
          0,
          JSON.stringify(this.namespaceRoutes.get(namespace) ?? []),
        )
      const inner = args.slice(4)
      if (inner[0] === "addr" && inner[1] === "add") {
        const [local, prefixlen] = (inner[2] ?? "").split("/")
        const ifname = inner[4] ?? ""
        this.namespaceAddresses.set(namespace, [
          address(ifname, local ?? "", Number(prefixlen)),
        ])
        return result(0)
      }
      if (inner[0] === "route" && inner[1] === "add") {
        this.namespaceRoutes.set(namespace, [
          {
            dst: "default",
            gateway: inner[4],
            dev: `vpph${namespace.slice(9)}`,
          },
        ])
        return result(0)
      }
      return result(0)
    }
    if (args[0] === "link" && args[1] === "add") {
      const host = args[2] ?? ""
      const peer = args.at(-1) ?? ""
      this.links.add(host)
      this.links.add(peer)
      this.addresses.set(host, [{ ifname: host, addr_info: [] }])
      this.addresses.set(peer, [{ ifname: peer, addr_info: [] }])
      return result(0)
    }
    if (args[0] === "addr" && args[1] === "add") {
      const [local, prefixlen] = (args[2] ?? "").split("/")
      const ifname = args[4] ?? ""
      this.addresses.set(ifname, [
        address(ifname, local ?? "", Number(prefixlen)),
      ])
      return result(0)
    }
    if (args[0] === "netns" && args[1] === "add") {
      this.namespaces.add(args[2] ?? "")
      return result(0)
    }
    if (args[0] === "link" && args[1] === "set" && args[3] === "netns") {
      this.links.delete(args[2] ?? "")
      return result(0)
    }
    if (args[0] === "link" && args[1] === "set") {
      return result(0)
    }
    if (args[0] === "link" && args[1] === "delete") {
      if (!this.ignoreDeletes) {
        this.links.delete(args[2] ?? "")
        if ((args[2] ?? "").startsWith("veph")) {
          this.links.delete(`vpph${(args[2] ?? "").slice(4)}`)
        }
      }
      return result(0)
    }
    if (args[0] === "netns" && args[1] === "delete") {
      if (!this.ignoreDeletes) {
        this.namespaces.delete(args[2] ?? "")
        this.onNamespaceDeleted?.(args[2] ?? "")
      }
      return result(0)
    }
    return result(1, "", "unexpected ip command")
  }

  private runTable(args: string[], ipv6: boolean): ProcessRunResult {
    const stripped =
      args.slice(0, 2).join(" ") === "-w 5" ? args.slice(2) : args
    const isNat = stripped[0] === "-t" && stripped[1] === "nat"
    const operation = isNat ? stripped.slice(2) : stripped
    const rules = ipv6 ? this.ipv6 : isNat ? this.nat : this.ipv4
    if (operation[0] === "-S") return result(0, rules.map(render).join("\n"))
    if (operation[0] === "-N") {
      rules.push(["-N", operation[1] ?? ""])
      return result(0)
    }
    if (operation[0] === "-A") {
      rules.push(operation)
      return result(0)
    }
    if (operation[0] === "-I") {
      rules.push(["-A", operation[1] ?? "", ...operation.slice(3)])
      return result(0)
    }
    if (operation[0] === "-D") {
      const expected = ["-A", ...operation.slice(1)]
      if (!this.ignoreDeletes) removeRule(rules, expected)
      return result(0)
    }
    if (operation[0] === "-F") {
      if (!this.ignoreDeletes) {
        const chain = operation[1]
        for (let index = rules.length - 1; index >= 0; index--) {
          if (rules[index]?.[0] === "-A" && rules[index]?.[1] === chain)
            rules.splice(index, 1)
        }
      }
      return result(0)
    }
    if (operation[0] === "-X") {
      if (!this.ignoreDeletes) removeRule(rules, ["-N", operation[1] ?? ""])
      return result(0)
    }
    return result(1, "", "unexpected table command")
  }
}

describe("NetworkOrphanReaper", () => {
  let root: string
  let manager: NetworkLeaseManager
  let host: FakeNetworkHost
  let reaper: NetworkOrphanReaper

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "peephole-network-reaper-"))
    manager = managerFor(root, false)
    host = new FakeNetworkHost()
    reaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each(["marker", "veth", "partial", "full"] as const)(
    "reconciles a valid %s crash state and releases the lease",
    async (state) => {
      const lease = await allocate(manager)
      host.install(lease, state)
      await reaper.reapAll()
      expect(host.namespaces).toEqual(new Set())
      expect(host.links).toEqual(new Set())
      expect(host.ipv4).toEqual([])
      expect(host.ipv6).toEqual([])
      expect(host.nat).toEqual([])
      expect(await readdir(root)).toEqual([])
    },
  )

  it("cleans a legacy policy-less v1 lease as egress-nat", async () => {
    const lease = await allocate(manager)
    const markerPath = path.join(lease.leaseDir, "lease.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
      string,
      unknown
    >
    // A marker from before `policy` existed could never have
    // `temporaryDatabaseAccess` either -- that field was added later still.
    delete marker.policy
    delete marker.temporaryDatabaseAccess
    await writeFile(markerPath, JSON.stringify(marker))
    host.install(lease, "full")

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.ipv4).toEqual([])
    expect(host.nat).toEqual([])
  })

  it("fails closed for unowned Peephole-shaped namespaces, veths, chains, and NAT comments", async () => {
    for (const install of [
      () => host.namespaces.add("peephole-9"),
      () => host.links.add("veph9"),
      () => host.ipv4.push(["-N", "ppe9"]),
      () =>
        host.nat.push([
          "-A",
          "POSTROUTING",
          "--comment",
          "peephole-deadbeef-9",
          "-j",
          "MASQUERADE",
        ]),
    ]) {
      install()
      await expect(reaper.reapAll()).rejects.toThrow(/Unowned Peephole/)
      host = new FakeNetworkHost()
      reaper = new NetworkOrphanReaper({
        leaseManager: manager,
        processRunner: host,
      })
    }
  })

  it("fails closed without deleting a same-name resource with the wrong identity", async () => {
    const lease = await allocate(manager)
    host.install(lease, "veth")
    host.addresses.set(lease.hostVeth, [address(lease.hostVeth, "10.1.2.3")])
    await expect(reaper.reapAll()).rejects.toThrow(/does not match its lease/)
    expect(host.links.has(lease.hostVeth)).toBe(true)
    expect(await readdir(lease.leaseDir)).toEqual(["lease.json"])
  })

  it("accepts iptables' reordered conntrack state output and cleans it", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    const conntrackRule = host.ipv4.find((rule) => rule.includes("--ctstate"))
    expect(conntrackRule).toBeDefined()
    const stateIndex = conntrackRule?.indexOf("--ctstate") ?? -1
    if (conntrackRule) conntrackRule[stateIndex + 1] = "RELATED,ESTABLISHED"

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.ipv4).toEqual([])
  })

  it("still fails closed for an unexpected extra IPv4 rule", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    host.ipv4.push(["-A", lease.egressChain, "-p", "tcp", "-j", "ACCEPT"])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
    expect(await manager.listOwnedLeases()).toHaveLength(1)
  })

  it("preserves a valid lease when its owner is still live", async () => {
    manager = managerFor(root, true)
    reaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
    })
    const lease = await allocate(manager)
    await expect(reaper.reapAll()).rejects.toThrow(/live owner/)
    expect(await readdir(lease.leaseDir)).toEqual(["lease.json"])
  })

  it("preserves the lease and propagates a cleanup command failure", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    host.fail = (command, args) => command === "iptables" && args.includes("-D")
    await expect(reaper.reapAll()).rejects.toThrow(/failed/)
    expect(await readdir(lease.leaseDir)).toEqual(["lease.json"])
  })

  it("preserves the lease when absence verification finds a remaining resource", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    host.ignoreDeletes = true
    const error = await reaper.reapAll().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect(
      (error as AggregateError).errors.some((failure) =>
        String(failure).includes("remain after cleanup"),
      ),
    ).toBe(true)
    expect(await readdir(lease.leaseDir)).toEqual(["lease.json"])
  })

  it("uses verified cleanup for normal teardown and makes it idempotent", async () => {
    manager = managerFor(root, true)
    const provisioner = new VethNatNetworkProvisioner({
      leaseManager: manager,
      processRunner: host,
    })
    const handle = await provisioner.create("b".repeat(32), ["172.31.0.2"])
    expect(await manager.listOwnedLeases()).toHaveLength(1)

    await handle.teardown()
    await expect(handle.teardown()).resolves.toBeUndefined()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.namespaces).toEqual(new Set())
    expect(host.links).toEqual(new Set())
  })

  it("keeps the durable lease when normal teardown partially fails", async () => {
    manager = managerFor(root, true)
    const provisioner = new VethNatNetworkProvisioner({
      leaseManager: manager,
      processRunner: host,
    })
    const handle = await provisioner.create("c".repeat(32), ["172.31.0.2"])
    host.fail = (command, args) => command === "iptables" && args.includes("-D")

    await expect(handle.teardown()).rejects.toThrow(/failed/)
    expect(await manager.listOwnedLeases()).toHaveLength(1)
  })

  it("protects an active allocation from periodic reap, then reclaims it once a failed teardown leaves it inactive", async () => {
    manager = managerFor(root, true)
    const activity = new NetworkAllocationRegistry()
    const allocationId = "d".repeat(32)
    const provisioner = new VethNatNetworkProvisioner({
      leaseManager: manager,
      processRunner: host,
      activityRegistry: activity,
    })
    const maintenanceReaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
      activityRegistry: activity,
    })

    const handle = await provisioner.create(allocationId, ["172.31.0.2"])
    expect(activity.isActive(allocationId)).toBe(true)

    // Still an active job: the periodic reaper must not touch it even though
    // its creator PID is (necessarily, in-process) live.
    await maintenanceReaper.reap()
    expect(await manager.listOwnedLeases()).toHaveLength(1)
    expect(host.namespaces.size).toBeGreaterThan(0)

    host.fail = (command, args) => command === "iptables" && args.includes("-D")
    await expect(handle.teardown()).rejects.toThrow(/failed/)
    expect(await manager.listOwnedLeases()).toHaveLength(1)
    expect(activity.isActive(allocationId)).toBe(false)

    host.fail = undefined
    await maintenanceReaper.reap()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.namespaces).toEqual(new Set())
    expect(host.links).toEqual(new Set())
    expect(host.ipv4).toEqual([])
    expect(host.ipv6).toEqual([])
    expect(host.nat).toEqual([])
  })

  it("preserves a lease whose live owner is a different, still-running process", async () => {
    const foreignPid = 999_999
    const foreignManager = new NetworkLeaseManager({
      leaseDir: root,
      bootId: async () => "boot",
      processStartTime: async (pid) =>
        pid === foreignPid ? "foreign-start" : "start",
      processState: (pid) => (pid === foreignPid ? "EXISTS" : "MISSING"),
      syncDirectory: async () => undefined,
    })
    const index = 3
    const subnet = toSubnet(index)
    const allocationId = "f".repeat(32)
    const {
      namespace,
      hostVeth,
      peerVeth,
      egressChain,
      inputChain,
      returnChain,
      iptablesComment,
    } = deriveNetworkNames(allocationId, index)
    const leaseDirPath = path.join(root, String(index))
    await mkdir(leaseDirPath)
    // Field order must exactly match subnetAllocator.ts's toMarker(): the
    // manager compares the derived marker against this one by serialized
    // identity, not a structural deep-equal.
    await writeFile(
      path.join(leaseDirPath, "lease.json"),
      JSON.stringify({
        version: 1,
        subnetIndex: index,
        allocationId,
        namespace,
        hostVeth,
        peerVeth,
        hostIp: subnet.hostIp,
        peerIp: subnet.peerIp,
        prefixLength: subnet.prefixLength,
        uplink: "eth0",
        policy: "egress-nat",
        egressChain,
        inputChain,
        returnChain,
        iptablesComment,
        dnsServers: ["172.31.0.2"],
        creatorPid: foreignPid,
        creatorProcessStartTime: "foreign-start",
        bootId: "boot",
        createdAt: new Date(0).toISOString(),
      }),
    )

    reaper = new NetworkOrphanReaper({
      leaseManager: foreignManager,
      processRunner: host,
    })
    await reaper.reap()
    expect(await readdir(leaseDirPath)).toEqual(["lease.json"])
  })
})

/** Records when a lease mutex is requested while another holder runs. */
class ObservedAllocationRegistry extends NetworkAllocationRegistry {
  private readonly held = new Set<string>()
  readonly contended: string[] = []

  override runExclusive<T>(
    allocationId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.held.has(allocationId)) this.contended.push(allocationId)
    return super.runExclusive(allocationId, async () => {
      this.held.add(allocationId)
      try {
        return await action()
      } finally {
        this.held.delete(allocationId)
      }
    })
  }
}

describe("NetworkOrphanReaper maintenance vs. normal Stop", () => {
  const allocationId = "e".repeat(32)
  let root: string
  let manager: NetworkLeaseManager
  let host: FakeNetworkHost
  let activity: ObservedAllocationRegistry
  let provisioner: VethNatNetworkProvisioner
  let maintenanceReaper: NetworkOrphanReaper

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "peephole-network-race-"))
    manager = managerFor(root, true)
    host = new FakeNetworkHost()
    activity = new ObservedAllocationRegistry()
    provisioner = new VethNatNetworkProvisioner({
      leaseManager: manager,
      processRunner: host,
      activityRegistry: activity,
    })
    maintenanceReaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
      activityRegistry: activity,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function expectHostClean() {
    expect(host.namespaces).toEqual(new Set())
    expect(host.links).toEqual(new Set())
    expect(host.ipv4).toEqual([])
    expect(host.ipv6).toEqual([])
    expect(host.nat).toEqual([])
  }

  /** Runs `action` once, right after the reaper's first full host snapshot. */
  function afterFirstSnapshot(action: () => Promise<void>) {
    host.afterCommand = async (command, args) => {
      if (command !== "ip6tables" || !args.includes("-S")) return
      host.afterCommand = undefined
      await action()
    }
  }

  it("accepts a lease that a normal Stop fully released right after the snapshot", async () => {
    const handle = await provisioner.create(allocationId, ["172.31.0.2"])
    afterFirstSnapshot(() => handle.teardown())

    await expect(maintenanceReaper.reap()).resolves.toBeUndefined()

    expect(await manager.listOwnedLeases()).toEqual([])
    expectHostClean()
  })

  it("serializes a Stop that begins while the reaper inspects the namespace", async () => {
    const handle = await provisioner.create(allocationId, ["172.31.0.2"])
    let resolveDeleted!: () => void
    const namespaceDeleted = new Promise<void>((resolve) => {
      resolveDeleted = resolve
    })
    host.onNamespaceDeleted = () => resolveDeleted()
    let stop: Promise<void> | undefined
    host.beforeCommand = async (command, args) => {
      if (command !== "ip" || args[1] !== "exec" || !args.includes("addr")) {
        return
      }
      host.beforeCommand = undefined
      stop = handle.teardown()
      // Without the lease mutex the Stop runs to namespace deletion before
      // this inspection reads host state -- the production interleaving.
      if (activity.contended.length === 0) await namespaceDeleted
    }

    await expect(maintenanceReaper.reap()).resolves.toBeUndefined()
    await expect(stop).resolves.toBeUndefined()

    expect(activity.contended).toContain(allocationId)
    expect(await manager.listOwnedLeases()).toEqual([])
    expectHostClean()
  })

  it("fails closed when a released lease's namespace is gone but its other resources remain", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    afterFirstSnapshot(async () => {
      host.namespaces.delete(lease.namespace)
      await manager.release(lease)
    })

    await expect(maintenanceReaper.reap()).rejects.toThrow(
      /remain after cleanup/,
    )

    expect(host.links).toContain(lease.hostVeth)
    expect(host.ipv4).toContainEqual(["-N", lease.egressChain])
    expect(host.nat).toHaveLength(1)
  })

  it("refuses a lease path that a different allocation re-took after the snapshot", async () => {
    const old = await allocate(manager)
    host.install(old, "full")
    const replacementId = "9".repeat(32)
    afterFirstSnapshot(async () => {
      // A valid marker for a different, active allocation at the same path.
      const markerPath = path.join(old.leaseDir, "lease.json")
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >
      Object.assign(marker, {
        allocationId: replacementId,
        ...deriveNetworkNames(replacementId, old.index),
      })
      await writeFile(markerPath, JSON.stringify(marker))
      activity.activate(replacementId)
    })

    await expect(maintenanceReaper.reap()).rejects.toThrow(/changed identity/)

    const [replacement] = await manager.listOwnedLeases()
    expect(replacement?.allocationId).toBe(replacementId)
    expect(host.namespaces).toContain(old.namespace)
    expect(host.links).toContain(old.hostVeth)
    expect(host.nat).toHaveLength(1)
  })

  it("fails closed when a listed lease marker becomes unreadable", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    afterFirstSnapshot(() =>
      writeFile(path.join(lease.leaseDir, "lease.json"), "{"),
    )

    await expect(maintenanceReaper.reap()).rejects.toThrow(/malformed/)

    expect(host.namespaces).toContain(lease.namespace)
    expect(host.links).toContain(lease.hostVeth)
  })

  it("still reclaims a stale lease left by a failed teardown", async () => {
    const handle = await provisioner.create(allocationId, ["172.31.0.2"])
    host.fail = (command, args) => command === "iptables" && args.includes("-D")
    await expect(handle.teardown()).rejects.toThrow(/failed/)
    host.fail = undefined

    await expect(maintenanceReaper.reap()).resolves.toBeUndefined()

    expect(await manager.listOwnedLeases()).toEqual([])
    expectHostClean()
  })

  it("still fails closed when a namespace that exists cannot be inspected", async () => {
    const lease = await allocate(manager)
    host.install(lease, "full")
    host.fail = (command, args) =>
      command === "ip" && args[1] === "exec" && args.includes("route")

    await expect(maintenanceReaper.reap()).rejects.toThrow(/injected/)

    expect(await manager.listOwnedLeases()).toHaveLength(1)
    expect(host.namespaces).toContain(lease.namespace)
  })
})

describe("NetworkOrphanReaper ingress-only policy", () => {
  let root: string
  let manager: NetworkLeaseManager
  let host: FakeNetworkHost
  let reaper: NetworkOrphanReaper

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "peephole-network-reaper-"))
    manager = managerFor(root, false)
    host = new FakeNetworkHost()
    reaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each(["marker", "veth", "partial", "full"] as const)(
    "reconciles a valid %s crash state with no default route and releases the lease",
    async (state) => {
      const lease = await allocateIngressOnly(manager)
      host.install(lease, state, { withDefaultRoute: false })
      await reaper.reapAll()
      expect(host.namespaces).toEqual(new Set())
      expect(host.links).toEqual(new Set())
      expect(host.ipv4).toEqual([])
      expect(host.ipv6).toEqual([])
      expect(host.nat).toEqual([])
      expect(await readdir(root)).toEqual([])
    },
  )

  it("never expects or removes a NAT rule for an ingress-only lease", async () => {
    const lease = await allocateIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    expect(host.nat).toEqual([])

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
  })

  it("fails closed if an ingress-only lease somehow acquired a NAT rule", async () => {
    const lease = await allocateIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.nat.push([
      "-A",
      "POSTROUTING",
      "-s",
      `${lease.peerIp}/32`,
      "-o",
      "eth0",
      "-m",
      "comment",
      "--comment",
      lease.iptablesComment,
      "-j",
      "MASQUERADE",
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected NAT rule/)
  })

  it("fails closed if an ingress-only lease's egress chain allows anything", async () => {
    const lease = await allocateIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.ipv4.push(["-A", lease.egressChain, "-j", "ACCEPT"])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("does not confuse an egress-nat and an ingress-only lease coexisting", async () => {
    const egressLease = await allocate(manager)
    const ingressLease = await allocateIngressOnly(manager)
    host.install(egressLease, "full")
    host.install(ingressLease, "full", { withDefaultRoute: false })

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.ipv4).toEqual([])
    expect(host.nat).toEqual([])
  })
})

describe("NetworkOrphanReaper temporaryDatabaseAccess", () => {
  let root: string
  let manager: NetworkLeaseManager
  let host: FakeNetworkHost
  let reaper: NetworkOrphanReaper

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "peephole-network-reaper-"))
    manager = managerFor(root, false)
    host = new FakeNetworkHost()
    reaper = new NetworkOrphanReaper({
      leaseManager: manager,
      processRunner: host,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("accepts and cleans the exact expected DB route/rule addition", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.namespaces).toEqual(new Set())
    expect(host.ipv4).toEqual([])
  })

  it("accepts and cleans the literal `iptables -S` output a real host reports for a DB lease", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    // Captured from a real Linux host (M11-D2 lease 15870), not derived from
    // expectedRules(): the kernel reports the implicit `-m tcp` match and
    // orders conntrack states as RELATED,ESTABLISHED.
    host.ipv4 = [
      ["-P", "INPUT", "ACCEPT"],
      ["-P", "FORWARD", "ACCEPT"],
      ["-P", "OUTPUT", "ACCEPT"],
      ["-N", lease.egressChain],
      ["-N", lease.inputChain],
      ["-N", lease.returnChain],
      ["-A", "INPUT", "-i", lease.hostVeth, "-j", lease.inputChain],
      ["-A", "FORWARD", "-o", lease.hostVeth, "-j", lease.returnChain],
      ["-A", "FORWARD", "-i", lease.hostVeth, "-j", lease.egressChain],
      ["-A", lease.egressChain, "-j", "DROP"],
      [
        "-A",
        lease.inputChain,
        "-m",
        "conntrack",
        "--ctstate",
        "RELATED,ESTABLISHED",
        "-j",
        "ACCEPT",
      ],
      [
        "-A",
        lease.inputChain,
        "-d",
        "192.168.253.1/32",
        "-p",
        "tcp",
        "-m",
        "tcp",
        "--dport",
        "5433",
        "-j",
        "ACCEPT",
      ],
      ["-A", lease.inputChain, "-j", "DROP"],
      ["-A", lease.returnChain, "-j", "DROP"],
    ]

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
    expect(host.namespaces).toEqual(new Set())
    expect(host.links).toEqual(new Set())
    expect(host.ipv4).toEqual([
      ["-P", "INPUT", "ACCEPT"],
      ["-P", "FORWARD", "ACCEPT"],
      ["-P", "OUTPUT", "ACCEPT"],
    ])
    expect(host.ipv6).toEqual([])
  })

  it("fails closed if the DB route/rule exists on a lease whose marker does not authorize it", async () => {
    const lease = await allocateIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.namespaceRoutes.set(lease.namespace, [
      { dst: "192.168.253.1/32", gateway: lease.hostIp, dev: lease.peerVeth },
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected default route/)
  })

  it("fails closed on a wrong destination IP", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.namespaceRoutes.set(lease.namespace, [
      { dst: "192.168.253.2/32", gateway: lease.hostIp, dev: lease.peerVeth },
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected default route/)
  })

  it("fails closed on a broader CIDR than /32", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.namespaceRoutes.set(lease.namespace, [
      { dst: "192.168.253.0/24", gateway: lease.hostIp, dev: lease.peerVeth },
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected default route/)
  })

  it("fails closed on an unexpected default route even when database access is enabled", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.namespaceRoutes.set(lease.namespace, [
      { dst: "default", gateway: lease.hostIp, dev: lease.peerVeth },
      {
        dst: "192.168.253.1/32",
        gateway: lease.hostIp,
        dev: lease.peerVeth,
      },
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected default route/)
  })

  it("fails closed on a wrong port for the INPUT accept rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    replaceDatabaseRule(host.ipv4, lease.inputChain, {
      destination: "192.168.253.1/32",
      protocol: "tcp",
      port: "5432",
    })

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("fails closed on UDP instead of TCP for the INPUT accept rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    replaceDatabaseRule(host.ipv4, lease.inputChain, {
      destination: "192.168.253.1/32",
      protocol: "udp",
      port: "5433",
    })

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("fails closed on a wrong destination for the INPUT accept rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    replaceDatabaseRule(host.ipv4, lease.inputChain, {
      destination: "192.168.253.2/32",
      protocol: "tcp",
      port: "5433",
    })

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("fails closed on a broader destination CIDR for the INPUT accept rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    replaceDatabaseRule(host.ipv4, lease.inputChain, {
      destination: "192.168.253.0/24",
      protocol: "tcp",
      port: "5433",
    })

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("fails closed if the DB accept rule exists on a lease whose marker does not authorize it", async () => {
    const lease = await allocateIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    const dropIndex = host.ipv4.findIndex((rule) =>
      sameRule(rule, ["-A", lease.inputChain, "-j", "DROP"]),
    )
    host.ipv4.splice(
      dropIndex,
      0,
      databaseRule(lease.inputChain, {
        destination: "192.168.253.1/32",
        protocol: "tcp",
        port: "5433",
      }),
    )

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("fails closed if an unexpected extra rule accompanies the DB accept rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.ipv4.push(["-A", lease.inputChain, "-j", "ACCEPT"])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected IPv4 rule/)
  })

  it("never expects or removes a NAT rule for a DB-enabled ingress-only lease", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    expect(host.nat).toEqual([])

    await reaper.reapAll()

    expect(await manager.listOwnedLeases()).toEqual([])
  })

  it("fails closed if a DB-enabled ingress-only lease somehow acquired a NAT rule", async () => {
    const lease = await allocateDatabaseIngressOnly(manager)
    host.install(lease, "full", { withDefaultRoute: false })
    host.nat.push([
      "-A",
      "POSTROUTING",
      "-s",
      `${lease.peerIp}/32`,
      "-o",
      "eth0",
      "-m",
      "comment",
      "--comment",
      lease.iptablesComment,
      "-j",
      "MASQUERADE",
    ])

    await expect(reaper.reapAll()).rejects.toThrow(/unexpected NAT rule/)
  })
})

describe("expectedRules for the ingress-only policy", () => {
  it("produces a DROP-only egress chain, no DNS rules, and no NAT", () => {
    const lease = ingressOnlyLeaseFixture()

    const rules = expectedRules(lease)

    expect(rules.nat).toBeNull()
    expect(
      rules.ipv4.filter(
        (rule) => rule[1] === lease.egressChain && rule[0] === "-A",
      ),
    ).toEqual([["-A", lease.egressChain, "-j", "DROP"]])
  })

  it("allows only established/related traffic into the host and drops the rest", () => {
    const lease = ingressOnlyLeaseFixture()

    const rules = expectedRules(lease)

    expect(
      rules.ipv4.filter(
        (rule) => rule[1] === lease.inputChain && rule[0] === "-A",
      ),
    ).toEqual([
      [
        "-A",
        lease.inputChain,
        "-m",
        "conntrack",
        "--ctstate",
        "ESTABLISHED,RELATED",
        "-j",
        "ACCEPT",
      ],
      ["-A", lease.inputChain, "-j", "DROP"],
    ])
  })

  it("makes the return chain an unconditional DROP", () => {
    const lease = ingressOnlyLeaseFixture()

    const rules = expectedRules(lease)

    expect(
      rules.ipv4.filter(
        (rule) => rule[1] === lease.returnChain && rule[0] === "-A",
      ),
    ).toEqual([["-A", lease.returnChain, "-j", "DROP"]])
  })

  it("keeps the same FORWARD/INPUT hook shape as the egress-nat policy", () => {
    const lease = ingressOnlyLeaseFixture()

    const rules = expectedRules(lease)

    expect(rules.ipv4Hooks).toEqual([
      ["-A", "FORWARD", "-i", lease.hostVeth, "-j", lease.egressChain],
      ["-A", "FORWARD", "-o", lease.hostVeth, "-j", lease.returnChain],
      ["-A", "INPUT", "-i", lease.hostVeth, "-j", lease.inputChain],
    ])
  })

  it("adds exactly one tenant-database ACCEPT rule, before DROP, only when temporaryDatabaseAccess is set", () => {
    const lease = ingressOnlyLeaseFixture(true)

    const rules = expectedRules(lease)

    expect(
      rules.ipv4.filter(
        (rule) => rule[1] === lease.inputChain && rule[0] === "-A",
      ),
    ).toEqual([
      [
        "-A",
        lease.inputChain,
        "-m",
        "conntrack",
        "--ctstate",
        "ESTABLISHED,RELATED",
        "-j",
        "ACCEPT",
      ],
      [
        "-A",
        lease.inputChain,
        "-d",
        "192.168.253.1/32",
        "-p",
        "tcp",
        "-m",
        "tcp",
        "--dport",
        "5433",
        "-j",
        "ACCEPT",
      ],
      ["-A", lease.inputChain, "-j", "DROP"],
    ])
    expect(rules.nat).toBeNull()
  })

  it("omits the tenant-database rule when temporaryDatabaseAccess is false", () => {
    const lease = ingressOnlyLeaseFixture(false)

    const rules = expectedRules(lease)

    expect(rules.ipv4.some((rule) => rule.includes("192.168.253.1/32"))).toBe(
      false,
    )
  })
})

describe("sameRule", () => {
  const rule = (states: string) => [
    "-A",
    "ppr1",
    "-m",
    "conntrack",
    "--ctstate",
    states,
    "-j",
    "ACCEPT",
  ]

  it("treats only reordered equivalent conntrack state sets as equal", () => {
    expect(
      sameRule(rule("ESTABLISHED,RELATED"), rule("RELATED,ESTABLISHED")),
    ).toBe(true)
    expect(sameRule(rule("ESTABLISHED,RELATED"), rule("ESTABLISHED"))).toBe(
      false,
    )
    expect(sameRule(rule("ESTABLISHED,RELATED"), rule("NEW,ESTABLISHED"))).toBe(
      false,
    )
  })

  it("keeps every non-ctstate token position exact", () => {
    const reordered = rule("ESTABLISHED,RELATED")
    reordered[2] = "conntrack"
    reordered[3] = "-m"
    expect(sameRule(rule("ESTABLISHED,RELATED"), reordered)).toBe(false)
  })

  it.each([
    "ESTABLISHED,,RELATED",
    "ESTABLISHED,ESTABLISHED",
    "ESTABLISHED,ARBITRARY",
    "ESTABLISHED, RELATED",
  ])("rejects invalid conntrack state token %s", (states) => {
    expect(sameRule(rule(states), rule(states))).toBe(false)
  })
})

function managerFor(root: string, live: boolean): NetworkLeaseManager {
  return new NetworkLeaseManager({
    leaseDir: root,
    bootId: async () => "boot",
    processStartTime: async () => "start",
    processExists: () => live,
    syncDirectory: async () => undefined,
  })
}

function allocate(manager: NetworkLeaseManager) {
  return manager.allocate({
    allocationId: "a".repeat(32),
    uplink: "eth0",
    policy: "egress-nat",
    dnsServers: ["172.31.0.2"],
  })
}

function allocateIngressOnly(manager: NetworkLeaseManager) {
  return manager.allocate({
    allocationId: "b".repeat(32),
    uplink: "eth0",
    policy: "ingress-only",
    dnsServers: [],
  })
}

function allocateDatabaseIngressOnly(manager: NetworkLeaseManager) {
  return manager.allocate({
    allocationId: "d".repeat(32),
    uplink: "eth0",
    policy: "ingress-only",
    dnsServers: [],
    temporaryDatabaseAccess: true,
  })
}

function ingressOnlyLeaseFixture(
  temporaryDatabaseAccess = false,
): NetworkLease {
  const allocationId = "c".repeat(32)
  const index = 7
  return {
    version: 1,
    ...toSubnet(index),
    ...deriveNetworkNames(allocationId, index),
    allocationId,
    uplink: "eth0",
    policy: "ingress-only",
    temporaryDatabaseAccess,
    dnsServers: [],
    creatorPid: process.pid,
    creatorProcessStartTime: null,
    bootId: null,
    createdAt: new Date(0).toISOString(),
    leaseDir: "/tmp/unused",
  }
}

function address(ifname: string, local: string, prefixlen = 30) {
  return { ifname, addr_info: [{ family: "inet", local, prefixlen }] }
}

function result(exitCode: number, stdout = "", stderr = ""): ProcessRunResult {
  return { exitCode, timedOut: false, stdout, stderr }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function render(rule: readonly string[]): string {
  return rule
    .map((token) => (token.startsWith("peephole-") ? `"${token}"` : token))
    .join(" ")
}

function removeRule(rules: string[][], expected: string[]): void {
  const index = rules.findIndex((rule) => sameRule(rule, expected))
  if (index >= 0) rules.splice(index, 1)
}

/** A DB accept rule in the canonical form `iptables -S` reports. */
function databaseRule(
  chain: string,
  rule: { destination: string; protocol: string; port: string },
): string[] {
  return [
    "-A",
    chain,
    "-d",
    rule.destination,
    "-p",
    rule.protocol,
    "-m",
    rule.protocol,
    "--dport",
    rule.port,
    "-j",
    "ACCEPT",
  ]
}

/** Swaps the installed DB accept rule in place, failing if it is absent so a
 * fail-closed test can never pass merely because nothing was replaced. */
function replaceDatabaseRule(
  rules: string[][],
  chain: string,
  replacement: { destination: string; protocol: string; port: string },
): void {
  const original = databaseRule(chain, {
    destination: "192.168.253.1/32",
    protocol: "tcp",
    port: "5433",
  })
  const index = rules.findIndex((rule) => sameRule(rule, original))
  if (index < 0) throw new Error("The installed DB accept rule was not found.")
  rules.splice(index, 1, databaseRule(chain, replacement))
}
