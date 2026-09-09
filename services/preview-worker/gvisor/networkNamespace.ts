import { isIPv4 } from "node:net"

import type { ProcessRunner } from "./processRunner"
import { NodeProcessRunner } from "./nodeProcessRunner"
import { SubnetAllocator, type AllocatedSubnet } from "./subnetAllocator"

const SETUP_TIMEOUT_MS = 10_000
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

export interface NetworkNamespaceHandle {
  /** Pass as the OCI spec's network namespace `path` so the sandbox joins
   * this pre-configured namespace instead of an empty one runsc would
   * otherwise create on its own. */
  readonly path: string
  teardown(): Promise<void>
}

export interface NetworkNamespaceProvisionerOptions {
  processRunner?: ProcessRunner
  ipBinaryPath?: string
  iptablesBinaryPath?: string
  ip6tablesBinaryPath?: string
  subnetAllocator?: SubnetAllocator
}

/**
 * Gives a sandbox real outbound network access by replicating, for a
 * single job, exactly what `runsc do` does for its (single-use,
 * documented "testing only") sandbox: a veth pair with one end moved into
 * a fresh network namespace, addressed as a /30 point-to-point link,
 * NAT'd through the host's own default interface. Every job gets its own
 * non-conflicting subnet and per-veth firewall chains. Only configured DNS
 * resolvers on UDP/TCP 53 may cross into private/link-local space; all other
 * local, private, shared, metadata, special-use, and inter-job destinations
 * are dropped before public IPv4 egress is accepted. IPv6 forwarding is
 * denied entirely because this namespace configures no IPv6 address, default
 * route, or NAT. See docs/SANDBOX_NETWORK_SECURITY.md.
 */
export class VethNatNetworkProvisioner {
  private readonly processRunner: ProcessRunner
  private readonly ip: string
  private readonly iptables: string
  private readonly ip6tables: string
  private readonly subnets: SubnetAllocator

  constructor(options: NetworkNamespaceProvisionerOptions = {}) {
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.ip = options.ipBinaryPath ?? "ip"
    this.iptables = options.iptablesBinaryPath ?? "iptables"
    this.ip6tables = options.ip6tablesBinaryPath ?? "ip6tables"
    this.subnets = options.subnetAllocator ?? new SubnetAllocator()
  }

  async create(
    id: string,
    configuredDnsServers: readonly string[],
  ): Promise<NetworkNamespaceHandle> {
    const dnsServers = normalizeDnsServers(configuredDnsServers)
    const uplink = await this.defaultUplinkInterface()
    const subnet = await this.subnets.allocate()
    const names = deriveNames(id, subnet.index)

    try {
      await this.run([
        "link",
        "add",
        names.hostVeth,
        "mtu",
        "1500",
        "type",
        "veth",
        "peer",
        "name",
        names.peerVeth,
      ])
      await this.run([
        "addr",
        "add",
        `${subnet.hostIp}/${subnet.prefixLength}`,
        "dev",
        names.hostVeth,
      ])
      await this.run(["link", "set", names.hostVeth, "up"])
      await this.run(["netns", "add", names.namespace])
      await this.run(["link", "set", names.peerVeth, "netns", names.namespace])
      await this.runInNamespace(names.namespace, [
        "addr",
        "add",
        `${subnet.peerIp}/${subnet.prefixLength}`,
        "dev",
        names.peerVeth,
      ])
      await this.runInNamespace(names.namespace, [
        "link",
        "set",
        names.peerVeth,
        "up",
      ])
      await this.runInNamespace(names.namespace, ["link", "set", "lo", "up"])
      await this.runInNamespace(names.namespace, [
        "route",
        "add",
        "default",
        "via",
        subnet.hostIp,
      ])

      await this.configureIpv4Firewall(names, dnsServers)
      await this.configureIpv6Deny(names)
      // NAT is deliberately last: a failure in any mandatory isolation rule
      // prevents the namespace from ever becoming usable by a sandbox.
      await this.iptablesRun([
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        subnet.peerIp,
        "-o",
        uplink,
        "-m",
        "comment",
        "--comment",
        names.comment,
        "-j",
        "MASQUERADE",
      ])
    } catch (error) {
      await this.teardown(names, uplink, subnet).catch(() => undefined)
      throw error
    }

    return {
      path: `/var/run/netns/${names.namespace}`,
      teardown: () => this.teardown(names, uplink, subnet),
    }
  }

  private async teardown(
    names: ReturnType<typeof deriveNames>,
    uplink: string,
    subnet: AllocatedSubnet,
  ): Promise<void> {
    // Best-effort and idempotent: deleting the host-side veth also deletes its peer, so
    // the namespace's own interface is already gone by the time we get to
    // it, and each step tolerates the previous one never having
    // succeeded (partial setup on the throw path above).
    await this.iptablesRun([
      "-t",
      "nat",
      "-D",
      "POSTROUTING",
      "-s",
      subnet.peerIp,
      "-o",
      uplink,
      "-m",
      "comment",
      "--comment",
      names.comment,
      "-j",
      "MASQUERADE",
    ]).catch(() => undefined)
    await this.ip6tablesRun([
      "-D",
      "FORWARD",
      "-o",
      names.hostVeth,
      "-j",
      "DROP",
    ]).catch(() => undefined)
    await this.ip6tablesRun([
      "-D",
      "FORWARD",
      "-i",
      names.hostVeth,
      "-j",
      "DROP",
    ]).catch(() => undefined)
    await this.ip6tablesRun([
      "-D",
      "INPUT",
      "-i",
      names.hostVeth,
      "-j",
      "DROP",
    ]).catch(() => undefined)
    await this.iptablesRun([
      "-D",
      "INPUT",
      "-i",
      names.hostVeth,
      "-j",
      names.inputChain,
    ]).catch(() => undefined)
    await this.iptablesRun([
      "-D",
      "FORWARD",
      "-o",
      names.hostVeth,
      "-j",
      names.returnChain,
    ]).catch(() => undefined)
    await this.iptablesRun([
      "-D",
      "FORWARD",
      "-i",
      names.hostVeth,
      "-j",
      names.egressChain,
    ]).catch(() => undefined)
    for (const chain of [
      names.inputChain,
      names.returnChain,
      names.egressChain,
    ]) {
      await this.iptablesRun(["-F", chain]).catch(() => undefined)
      await this.iptablesRun(["-X", chain]).catch(() => undefined)
    }
    await this.run(["link", "delete", names.hostVeth]).catch(() => undefined)
    await this.run(["netns", "delete", names.namespace]).catch(() => undefined)
    await this.subnets.release(subnet.index)
  }

  private async configureIpv4Firewall(
    names: ReturnType<typeof deriveNames>,
    dnsServers: readonly string[],
  ): Promise<void> {
    for (const chain of [
      names.egressChain,
      names.inputChain,
      names.returnChain,
    ]) {
      await this.iptablesRun(["-N", chain])
    }

    for (const dnsServer of dnsServers) {
      for (const protocol of ["udp", "tcp"]) {
        const dnsRule = [
          "-d",
          `${dnsServer}/32`,
          "-p",
          protocol,
          "--dport",
          "53",
          "-j",
          "ACCEPT",
        ]
        await this.iptablesRun(["-A", names.egressChain, ...dnsRule])
        await this.iptablesRun(["-A", names.inputChain, ...dnsRule])
      }
    }

    for (const destination of BLOCKED_IPV4_DESTINATIONS) {
      await this.iptablesRun([
        "-A",
        names.egressChain,
        "-d",
        destination,
        "-j",
        "DROP",
      ])
    }
    await this.iptablesRun(["-A", names.egressChain, "-j", "ACCEPT"])

    // Packets whose final destination is a host address use INPUT, not
    // FORWARD. Only a host-local resolver on port 53 is allowed.
    await this.iptablesRun(["-A", names.inputChain, "-j", "DROP"])

    await this.iptablesRun([
      "-A",
      names.returnChain,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ])
    await this.iptablesRun(["-A", names.returnChain, "-j", "DROP"])

    // Insert per-veth hooks ahead of any host-wide ACCEPT policy.
    await this.iptablesRun([
      "-I",
      "FORWARD",
      "1",
      "-i",
      names.hostVeth,
      "-j",
      names.egressChain,
    ])
    await this.iptablesRun([
      "-I",
      "FORWARD",
      "1",
      "-o",
      names.hostVeth,
      "-j",
      names.returnChain,
    ])
    await this.iptablesRun([
      "-I",
      "INPUT",
      "1",
      "-i",
      names.hostVeth,
      "-j",
      names.inputChain,
    ])
  }

  private async configureIpv6Deny(
    names: ReturnType<typeof deriveNames>,
  ): Promise<void> {
    // No IPv6 address/default route/NAT is configured. These mandatory rules
    // also suppress any kernel-generated link-local forwarding path.
    await this.ip6tablesRun([
      "-I",
      "INPUT",
      "1",
      "-i",
      names.hostVeth,
      "-j",
      "DROP",
    ])
    await this.ip6tablesRun([
      "-I",
      "FORWARD",
      "1",
      "-i",
      names.hostVeth,
      "-j",
      "DROP",
    ])
    await this.ip6tablesRun([
      "-I",
      "FORWARD",
      "1",
      "-o",
      names.hostVeth,
      "-j",
      "DROP",
    ])
  }

  private async defaultUplinkInterface(): Promise<string> {
    const result = await this.processRunner.run(
      this.ip,
      ["route", "list", "default"],
      { timeoutMs: SETUP_TIMEOUT_MS },
    )
    const device =
      result.exitCode === 0
        ? /\bdev\s+(\S+)/.exec(result.stdout)?.[1]
        : undefined
    if (!device) {
      throw new Error(
        "Could not determine the host's default network interface for sandbox NAT.",
      )
    }
    return device
  }

  private run(args: string[]): Promise<ProcessRunResultOrThrow> {
    return this.exec(this.ip, args)
  }

  private runInNamespace(
    namespace: string,
    args: string[],
  ): Promise<ProcessRunResultOrThrow> {
    return this.exec(this.ip, ["netns", "exec", namespace, this.ip, ...args])
  }

  private iptablesRun(args: string[]): Promise<ProcessRunResultOrThrow> {
    return this.exec(this.iptables, ["-w", IPTABLES_LOCK_WAIT_SECONDS, ...args])
  }

  private ip6tablesRun(args: string[]): Promise<ProcessRunResultOrThrow> {
    return this.exec(this.ip6tables, [
      "-w",
      IPTABLES_LOCK_WAIT_SECONDS,
      ...args,
    ])
  }

  private async exec(
    command: string,
    args: string[],
  ): Promise<ProcessRunResultOrThrow> {
    const result = await this.processRunner.run(command, args, {
      timeoutMs: SETUP_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr || result.stdout}`,
      )
    }
    return result
  }
}

type ProcessRunResultOrThrow = Awaited<ReturnType<ProcessRunner["run"]>>

function deriveNames(id: string, subnetIndex: number) {
  // Interface names are capped at 15 characters (IFNAMSIZ - 1); the
  // subnet index (unique per lease) is what actually needs to be
  // collision-free, `id` is only for human debugging in the comment.
  const suffix = String(subnetIndex)
  return {
    hostVeth: `veph${suffix}`,
    peerVeth: `vpph${suffix}`,
    namespace: `peephole-${suffix}`,
    comment: `peephole-${id}-${suffix}`.slice(0, 255),
    egressChain: `ppe${suffix}`,
    inputChain: `ppi${suffix}`,
    returnChain: `ppr${suffix}`,
  }
}

function normalizeDnsServers(values: readonly string[]): string[] {
  const normalized = Array.from(new Set(values))
  if (normalized.length === 0) {
    throw new Error(
      "Sandbox network setup requires at least one valid non-loopback IPv4 DNS resolver.",
    )
  }

  for (const value of normalized) {
    const firstOctet = isIPv4(value) ? Number(value.split(".")[0]) : -1
    if (
      firstOctet === -1 ||
      firstOctet === 0 ||
      firstOctet === 127 ||
      firstOctet >= 224
    ) {
      throw new Error(`Invalid DNS server for sandbox network policy: ${value}`)
    }
  }
  return normalized
}
