import type { ProcessRunner, ProcessRunResult } from "./processRunner"
import { NodeProcessRunner } from "./nodeProcessRunner"
import { NetworkAllocationRegistry } from "./networkAllocationRegistry"
import { NetworkLeaseManager, type NetworkLease } from "./subnetAllocator"

const COMMAND_TIMEOUT_MS = 10_000
const IPTABLES_LOCK_WAIT_SECONDS = "5"

export const BLOCKED_IPV4_DESTINATIONS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const

interface HostSnapshot {
  namespaces: Set<string>
  links: Set<string>
  ipv4: string[][]
  nat: string[][]
  ipv6: string[][]
}

export interface NetworkOrphanReaperOptions {
  leaseManager?: NetworkLeaseManager
  processRunner?: ProcessRunner
  ipBinaryPath?: string
  iptablesBinaryPath?: string
  ip6tablesBinaryPath?: string
  activityRegistry?: NetworkAllocationRegistry
}

/**
 * Reconciles only resources whose complete identity is proven by a durable
 * lease. Peephole-shaped resources without a valid lease, or same-name
 * resources with unexpected properties/rules, abort reconciliation.
 */
export class NetworkOrphanReaper {
  private readonly leases: NetworkLeaseManager
  private readonly runner: ProcessRunner
  private readonly ip: string
  private readonly iptables: string
  private readonly ip6tables: string
  private readonly activity: NetworkAllocationRegistry

  constructor(options: NetworkOrphanReaperOptions = {}) {
    this.leases = options.leaseManager ?? new NetworkLeaseManager()
    this.runner = options.processRunner ?? new NodeProcessRunner()
    this.ip = options.ipBinaryPath ?? "ip"
    this.iptables = options.iptablesBinaryPath ?? "iptables"
    this.ip6tables = options.ip6tablesBinaryPath ?? "ip6tables"
    this.activity = options.activityRegistry ?? new NetworkAllocationRegistry()
  }

  async reapAll(): Promise<void> {
    await this.reconcile(true)
  }

  /** Maintenance reconciliation preserves leases proven to belong to a live
   * allocator; stale leases are retried after failed normal teardown. */
  async reap(): Promise<void> {
    await this.reconcile(false)
  }

  private async reconcile(failOnLiveOwner: boolean): Promise<void> {
    await this.leases.recoverAllocationLock()
    const leases = await this.leases.listOwnedLeases()
    const snapshot = await this.inspectHost()
    await this.validateSnapshot(snapshot, leases)
    for (const lease of leases) {
      await this.activity.runExclusive(lease.allocationId, async () => {
        const liveness = await this.leases.ownerLiveness(lease)
        if (liveness.state === "UNKNOWN") {
          throw new Error(
            `Network lease ${String(lease.index)} owner liveness is unknown; refusing reconciliation.`,
          )
        }
        if (liveness.state === "LIVE") {
          if (failOnLiveOwner) {
            throw new Error(
              `Network lease ${String(lease.index)} still has a live owner; refusing startup reconciliation.`,
            )
          }
          if (!liveness.isCurrentProcess) return
          if (this.activity.isActive(lease.allocationId)) return
          // A same-process owner with no active job is a failed normal
          // teardown. Maintenance owns the retry path for that state.
          await this.cleanupLeaseUnlocked(lease, { allowLiveOwner: true })
          return
        }
        await this.cleanupLeaseUnlocked(lease, { allowLiveOwner: false })
      })
    }
  }

  /** Normal teardown uses the same proof and verification path, but may clean
   * the calling process's own live lease. */
  async cleanupLease(
    lease: NetworkLease,
    options: { allowLiveOwner: boolean },
  ): Promise<void> {
    await this.activity.runExclusive(lease.allocationId, () =>
      this.cleanupLeaseUnlocked(lease, options),
    )
  }

  private async cleanupLeaseUnlocked(
    lease: NetworkLease,
    options: { allowLiveOwner: boolean },
  ): Promise<void> {
    const owned = await this.leases.requireOwnedLease(lease.leaseDir)
    if (!options.allowLiveOwner) {
      const liveness = await this.leases.ownerLiveness(owned)
      if (liveness.state !== "STALE") {
        throw new Error(
          `Refusing to clean a network lease whose owner is ${liveness.state.toLowerCase()}.`,
        )
      }
    }
    const before = await this.inspectHost()
    await this.validateSnapshot(before, [owned], false)

    const expected = expectedRules(owned)
    const cleanupErrors: unknown[] = []
    const attempt = async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (containsRule(before.nat, expected.nat)) {
      await attempt(() =>
        this.iptablesRun(["-t", "nat", "-D", ...expected.nat.slice(1)]),
      )
    }
    for (const rule of expected.ipv6Hooks) {
      if (containsRule(before.ipv6, rule)) {
        await attempt(() => this.ip6tablesRun(["-D", ...rule.slice(1)]))
      }
    }
    for (const rule of expected.ipv4Hooks) {
      if (containsRule(before.ipv4, rule)) {
        await attempt(() => this.iptablesRun(["-D", ...rule.slice(1)]))
      }
    }
    for (const chain of [
      owned.inputChain,
      owned.returnChain,
      owned.egressChain,
    ]) {
      if (chainExists(before.ipv4, chain)) {
        await attempt(() => this.iptablesRun(["-F", chain]))
        await attempt(() => this.iptablesRun(["-X", chain]))
      }
    }
    if (before.links.has(owned.hostVeth)) {
      await attempt(() =>
        this.exec(this.ip, ["link", "delete", owned.hostVeth]),
      )
    }
    if (before.namespaces.has(owned.namespace)) {
      await attempt(() =>
        this.exec(this.ip, ["netns", "delete", owned.namespace]),
      )
    }

    try {
      const after = await this.inspectHost()
      this.assertLeaseAbsent(after, owned)
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Network lease ${String(owned.index)} cleanup failed; its ownership marker was preserved.`,
      )
    }
    await this.leases.release(owned)
  }

  private async validateSnapshot(
    snapshot: HostSnapshot,
    leases: readonly NetworkLease[],
    auditUnowned = true,
  ): Promise<void> {
    const namespaceOwners = new Map(
      leases.map((lease) => [lease.namespace, lease]),
    )
    const linkOwners = new Map(
      leases.flatMap((lease) => [
        [lease.hostVeth, lease] as const,
        [lease.peerVeth, lease] as const,
      ]),
    )
    const chainOwners = new Map(
      leases.flatMap((lease) => [
        [lease.egressChain, lease] as const,
        [lease.inputChain, lease] as const,
        [lease.returnChain, lease] as const,
      ]),
    )
    const commentOwners = new Map(
      leases.map((lease) => [lease.iptablesComment, lease]),
    )

    if (auditUnowned) {
      for (const name of snapshot.namespaces) {
        if (/^peephole-\d+$/.test(name) && !namespaceOwners.has(name)) {
          throw new Error(`Unowned Peephole-shaped network namespace: ${name}`)
        }
      }
      for (const name of snapshot.links) {
        if (/^v[ep]ph\d+$/.test(name) && !linkOwners.has(name)) {
          throw new Error(`Unowned Peephole-shaped veth: ${name}`)
        }
      }
      for (const rule of snapshot.ipv4) {
        for (const token of rule) {
          if (/^pp[rei]\d+$/.test(token) && !chainOwners.has(token)) {
            throw new Error(`Unowned Peephole-shaped iptables chain: ${token}`)
          }
          if (/^v[ep]ph\d+$/.test(token) && !linkOwners.has(token)) {
            throw new Error(`Unowned Peephole-shaped iptables hook: ${token}`)
          }
        }
      }
      for (const rule of snapshot.ipv6) {
        for (const token of rule) {
          if (/^v[ep]ph\d+$/.test(token) && !linkOwners.has(token)) {
            throw new Error(`Unowned Peephole-shaped ip6tables hook: ${token}`)
          }
        }
      }
      for (const rule of snapshot.nat) {
        const comment = valueAfter(rule, "--comment")
        if (comment?.startsWith("peephole-") && !commentOwners.has(comment)) {
          throw new Error(`Unowned Peephole NAT rule: ${comment}`)
        }
      }
    }

    for (const lease of leases) {
      await this.validateLinkAndRouteIdentity(snapshot, lease)
      const expected = expectedRules(lease)
      const relevantIpv4 = snapshot.ipv4.filter((rule) =>
        rule.some(
          (token) =>
            token === lease.hostVeth ||
            token === lease.egressChain ||
            token === lease.inputChain ||
            token === lease.returnChain,
        ),
      )
      for (const rule of relevantIpv4) {
        if (!expected.ipv4.some((candidate) => sameRule(rule, candidate))) {
          throw new Error(
            `Network lease ${String(lease.index)} has an unexpected IPv4 rule.`,
          )
        }
      }
      const relevantIpv6 = snapshot.ipv6.filter((rule) =>
        rule.includes(lease.hostVeth),
      )
      for (const rule of relevantIpv6) {
        if (
          !expected.ipv6Hooks.some((candidate) => sameRule(rule, candidate))
        ) {
          throw new Error(
            `Network lease ${String(lease.index)} has an unexpected IPv6 rule.`,
          )
        }
      }
      const relevantNat = snapshot.nat.filter(
        (rule) =>
          valueAfter(rule, "--comment") === lease.iptablesComment ||
          valueAfter(rule, "-s") === `${lease.peerIp}/32`,
      )
      for (const rule of relevantNat) {
        if (!sameRule(rule, expected.nat)) {
          throw new Error(
            `Network lease ${String(lease.index)} has an unexpected NAT rule.`,
          )
        }
      }
    }
  }

  private async validateLinkAndRouteIdentity(
    snapshot: HostSnapshot,
    lease: NetworkLease,
  ): Promise<void> {
    if (snapshot.links.has(lease.hostVeth)) {
      await this.assertVethIdentity(
        ["-d", "-j", "link", "show", "dev", lease.hostVeth],
        lease.hostVeth,
      )
      const addresses = parseJsonArray(
        (
          await this.exec(this.ip, [
            "-j",
            "addr",
            "show",
            "dev",
            lease.hostVeth,
          ])
        ).stdout,
        "host veth addresses",
      )
      const hostAddresses = ipv4Addresses(addresses, lease.hostVeth)
      if (
        hostAddresses.length > 0 &&
        (hostAddresses.length !== 1 ||
          hostAddresses[0]?.local !== lease.hostIp ||
          hostAddresses[0]?.prefixlen !== lease.prefixLength)
      ) {
        throw new Error(`Host veth ${lease.hostVeth} does not match its lease.`)
      }
    }
    if (snapshot.links.has(lease.peerVeth)) {
      await this.assertVethIdentity(
        ["-d", "-j", "link", "show", "dev", lease.peerVeth],
        lease.peerVeth,
      )
      const peerAddresses = parseJsonArray(
        (
          await this.exec(this.ip, [
            "-j",
            "addr",
            "show",
            "dev",
            lease.peerVeth,
          ])
        ).stdout,
        "root-namespace peer veth addresses",
      )
      if (ipv4Addresses(peerAddresses, lease.peerVeth).length > 0) {
        throw new Error(
          `Peer veth ${lease.peerVeth} has unexpected host-namespace addressing.`,
        )
      }
    }
    if (snapshot.namespaces.has(lease.namespace)) {
      const addresses = parseJsonArray(
        (
          await this.exec(this.ip, [
            "netns",
            "exec",
            lease.namespace,
            this.ip,
            "-j",
            "addr",
            "show",
          ])
        ).stdout,
        "peer veth addresses",
      )
      const hasPeer = addresses.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { ifname?: unknown }).ifname === lease.peerVeth,
      )
      if (
        addresses.some(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as { ifname?: unknown }).ifname === "string" &&
            !["lo", lease.peerVeth].includes(
              (entry as { ifname: string }).ifname,
            ),
        )
      ) {
        throw new Error(
          `Namespace ${lease.namespace} contains an unexpected interface.`,
        )
      }
      const peerIpv4 = ipv4Addresses(addresses, lease.peerVeth)
      if (
        hasPeer &&
        peerIpv4.length > 0 &&
        (peerIpv4.length !== 1 ||
          peerIpv4[0]?.local !== lease.peerIp ||
          peerIpv4[0]?.prefixlen !== lease.prefixLength)
      ) {
        throw new Error(`Peer veth ${lease.peerVeth} does not match its lease.`)
      }
      if (hasPeer) {
        await this.assertVethIdentity(
          [
            "netns",
            "exec",
            lease.namespace,
            this.ip,
            "-d",
            "-j",
            "link",
            "show",
            "dev",
            lease.peerVeth,
          ],
          lease.peerVeth,
        )
      }
      const routes = parseJsonArray(
        (
          await this.exec(this.ip, [
            "netns",
            "exec",
            lease.namespace,
            this.ip,
            "-j",
            "route",
            "show",
          ])
        ).stdout,
        "network namespace routes",
      )
      const defaults = routes.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { dst?: unknown }).dst === "default",
      ) as Array<{ gateway?: unknown; dev?: unknown }>
      const subnetDestination = `${lease.hostIp.split(".").slice(0, 3).join(".")}.${String(Number(lease.hostIp.split(".").at(-1)) - 1)}/${String(lease.prefixLength)}`
      if (
        defaults.length > 1 ||
        defaults.some(
          (route) =>
            route.gateway !== lease.hostIp || route.dev !== lease.peerVeth,
        ) ||
        routes.some((entry) => {
          if (entry === null || typeof entry !== "object") return true
          const route = entry as {
            dst?: unknown
            gateway?: unknown
            dev?: unknown
          }
          if (route.dst === "default") return false
          return (
            route.dst !== subnetDestination ||
            route.dev !== lease.peerVeth ||
            route.gateway !== undefined
          )
        })
      ) {
        throw new Error(
          `Namespace ${lease.namespace} has an unexpected default route.`,
        )
      }
    }
  }

  private async assertVethIdentity(
    args: string[],
    expectedName: string,
  ): Promise<void> {
    const entries = parseJsonArray(
      (await this.exec(this.ip, args)).stdout,
      `veth identity for ${expectedName}`,
    )
    if (
      entries.length !== 1 ||
      entries[0] === null ||
      typeof entries[0] !== "object" ||
      (entries[0] as { ifname?: unknown }).ifname !== expectedName ||
      (entries[0] as { mtu?: unknown }).mtu !== 1500 ||
      (entries[0] as { linkinfo?: { info_kind?: unknown } }).linkinfo
        ?.info_kind !== "veth"
    ) {
      throw new Error(`Interface ${expectedName} is not the expected veth.`)
    }
  }

  private assertLeaseAbsent(snapshot: HostSnapshot, lease: NetworkLease): void {
    if (
      snapshot.namespaces.has(lease.namespace) ||
      snapshot.links.has(lease.hostVeth) ||
      snapshot.links.has(lease.peerVeth) ||
      snapshot.ipv4.some((rule) =>
        rule.some((token) =>
          [
            lease.hostVeth,
            lease.egressChain,
            lease.inputChain,
            lease.returnChain,
          ].includes(token),
        ),
      ) ||
      snapshot.ipv6.some((rule) => rule.includes(lease.hostVeth)) ||
      snapshot.nat.some(
        (rule) => valueAfter(rule, "--comment") === lease.iptablesComment,
      )
    ) {
      throw new Error(
        `Network resources for lease ${String(lease.index)} remain after cleanup.`,
      )
    }
  }

  private async inspectHost(): Promise<HostSnapshot> {
    const [namespaces, links, ipv4, nat, ipv6] = await Promise.all([
      this.exec(this.ip, ["netns", "list"]),
      this.exec(this.ip, ["-o", "link", "show"]),
      this.iptablesRun(["-S"]),
      this.iptablesRun(["-t", "nat", "-S"]),
      this.ip6tablesRun(["-S"]),
    ])
    return {
      namespaces: new Set(
        namespaces.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim().split(/\s+/u)[0])
          .filter((value): value is string => Boolean(value)),
      ),
      links: new Set(
        links.stdout
          .split(/\r?\n/u)
          .map((line) => /^\d+:\s+([^:@]+)(?:@[^:]+)?:/u.exec(line)?.[1])
          .filter((value): value is string => Boolean(value)),
      ),
      ipv4: parseRules(ipv4.stdout),
      nat: parseRules(nat.stdout),
      ipv6: parseRules(ipv6.stdout),
    }
  }

  private iptablesRun(args: string[]): Promise<ProcessRunResult> {
    return this.exec(this.iptables, ["-w", IPTABLES_LOCK_WAIT_SECONDS, ...args])
  }

  private ip6tablesRun(args: string[]): Promise<ProcessRunResult> {
    return this.exec(this.ip6tables, [
      "-w",
      IPTABLES_LOCK_WAIT_SECONDS,
      ...args,
    ])
  }

  private async exec(
    command: string,
    args: string[],
  ): Promise<ProcessRunResult> {
    const result = await this.runner.run(command, args, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${command} ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr || result.stdout}`,
      )
    }
    return result
  }
}

export function expectedRules(lease: NetworkLease): {
  ipv4: string[][]
  ipv4Hooks: string[][]
  ipv6Hooks: string[][]
  nat: string[]
} {
  const egressRules: string[][] = []
  const inputRules: string[][] = []
  for (const dns of lease.dnsServers) {
    for (const protocol of ["udp", "tcp"]) {
      const suffix = [
        "-d",
        `${dns}/32`,
        "-p",
        protocol,
        "-m",
        protocol,
        "--dport",
        "53",
        "-j",
        "ACCEPT",
      ]
      egressRules.push(["-A", lease.egressChain, ...suffix])
      inputRules.push(["-A", lease.inputChain, ...suffix])
    }
  }
  for (const destination of BLOCKED_IPV4_DESTINATIONS) {
    egressRules.push(["-A", lease.egressChain, "-d", destination, "-j", "DROP"])
  }
  egressRules.push(["-A", lease.egressChain, "-j", "ACCEPT"])
  inputRules.push(["-A", lease.inputChain, "-j", "DROP"])
  const returnRules = [
    [
      "-A",
      lease.returnChain,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ],
    ["-A", lease.returnChain, "-j", "DROP"],
  ]
  const ipv4Hooks = [
    ["-A", "FORWARD", "-i", lease.hostVeth, "-j", lease.egressChain],
    ["-A", "FORWARD", "-o", lease.hostVeth, "-j", lease.returnChain],
    ["-A", "INPUT", "-i", lease.hostVeth, "-j", lease.inputChain],
  ]
  const ipv6Hooks = [
    ["-A", "INPUT", "-i", lease.hostVeth, "-j", "DROP"],
    ["-A", "FORWARD", "-i", lease.hostVeth, "-j", "DROP"],
    ["-A", "FORWARD", "-o", lease.hostVeth, "-j", "DROP"],
  ]
  return {
    ipv4: [
      ["-N", lease.egressChain],
      ["-N", lease.inputChain],
      ["-N", lease.returnChain],
      ...egressRules,
      ...inputRules,
      ...returnRules,
      ...ipv4Hooks,
    ],
    ipv4Hooks,
    ipv6Hooks,
    nat: [
      "-A",
      "POSTROUTING",
      "-s",
      `${lease.peerIp}/32`,
      "-o",
      lease.uplink,
      "-m",
      "comment",
      "--comment",
      lease.iptablesComment,
      "-j",
      "MASQUERADE",
    ],
  }
}

function parseRules(stdout: string): string[][] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => tokenizeRule(line.trim()))
    .filter((rule) => rule.length > 0)
}

function tokenizeRule(line: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (quote !== null) {
      if (character === quote) quote = null
      else current += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
    } else current += character
  }
  if (quote !== null || escaped)
    throw new Error("Malformed iptables rule output.")
  if (current) tokens.push(current)
  return tokens
}

function parseJsonArray(stdout: string, description: string): unknown[] {
  try {
    const value: unknown = JSON.parse(stdout)
    if (Array.isArray(value)) return value
  } catch (error) {
    throw new Error(`Could not parse ${description}.`, { cause: error })
  }
  throw new Error(`Could not validate ${description}.`)
}

function ipv4Addresses(
  values: unknown[],
  interfaceName: string,
): Array<{ local: unknown; prefixlen: unknown }> {
  const addresses: Array<{ local: unknown; prefixlen: unknown }> = []
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as { ifname?: unknown; addr_info?: unknown }
    if (item.ifname !== interfaceName || !Array.isArray(item.addr_info))
      continue
    for (const candidate of item.addr_info) {
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as { family?: unknown }).family === "inet"
      ) {
        addresses.push({
          local: (candidate as { local?: unknown }).local,
          prefixlen: (candidate as { prefixlen?: unknown }).prefixlen,
        })
      }
    }
  }
  return addresses
}

const CONNTRACK_STATES = new Set([
  "DNAT",
  "ESTABLISHED",
  "INVALID",
  "NEW",
  "RELATED",
  "SNAT",
  "UNTRACKED",
])

/** Exact rule comparison except for iptables' non-semantic reordering of the
 * comma-separated value immediately following --ctstate. */
export function sameRule(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index]
    const rightValue = right[index]
    const isCtstateValue =
      index > 0 &&
      left[index - 1] === "--ctstate" &&
      right[index - 1] === "--ctstate"
    if (isCtstateValue) {
      if (!sameConntrackStateSet(leftValue, rightValue)) return false
    } else if (leftValue !== rightValue) {
      return false
    }
  }
  return true
}

function sameConntrackStateSet(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) return false
  const leftStates = left.split(",")
  const rightStates = right.split(",")
  if (
    leftStates.length === 0 ||
    rightStates.length === 0 ||
    leftStates.some((state) => !CONNTRACK_STATES.has(state)) ||
    rightStates.some((state) => !CONNTRACK_STATES.has(state)) ||
    new Set(leftStates).size !== leftStates.length ||
    new Set(rightStates).size !== rightStates.length
  ) {
    return false
  }
  const sortedLeft = [...leftStates].sort()
  const sortedRight = [...rightStates].sort()
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((state, index) => state === sortedRight[index])
  )
}

function containsRule(
  rules: readonly string[][],
  rule: readonly string[],
): boolean {
  return rules.some((candidate) => sameRule(candidate, rule))
}

function chainExists(rules: readonly string[][], chain: string): boolean {
  return containsRule(rules, ["-N", chain])
}

function valueAfter(
  rule: readonly string[],
  option: string,
): string | undefined {
  const index = rule.indexOf(option)
  return index >= 0 ? rule[index + 1] : undefined
}
