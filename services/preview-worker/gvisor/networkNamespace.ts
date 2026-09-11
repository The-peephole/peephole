import { isIPv4 } from "node:net"

import type { ProcessRunner } from "./processRunner"
import { NodeProcessRunner } from "./nodeProcessRunner"
import { NetworkOrphanReaper } from "./networkOrphanReaper"
import { NetworkAllocationRegistry } from "./networkAllocationRegistry"
import { NetworkLeaseManager, type NetworkLease } from "./subnetAllocator"

export { BLOCKED_IPV4_DESTINATIONS } from "./networkOrphanReaper"
import { BLOCKED_IPV4_DESTINATIONS } from "./networkOrphanReaper"

const SETUP_TIMEOUT_MS = 10_000
const IPTABLES_LOCK_WAIT_SECONDS = "5"

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
  subnetAllocator?: NetworkLeaseManager
  activityRegistry?: NetworkAllocationRegistry
  leaseManager?: NetworkLeaseManager
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
  private readonly leases: NetworkLeaseManager
  private readonly reaper: NetworkOrphanReaper
  private readonly activity: NetworkAllocationRegistry

  constructor(options: NetworkNamespaceProvisionerOptions = {}) {
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.ip = options.ipBinaryPath ?? "ip"
    this.iptables = options.iptablesBinaryPath ?? "iptables"
    this.ip6tables = options.ip6tablesBinaryPath ?? "ip6tables"
    this.leases =
      options.leaseManager ??
      options.subnetAllocator ??
      new NetworkLeaseManager()
    this.activity = options.activityRegistry ?? new NetworkAllocationRegistry()
    this.reaper = new NetworkOrphanReaper({
      leaseManager: this.leases,
      processRunner: this.processRunner,
      ipBinaryPath: this.ip,
      iptablesBinaryPath: this.iptables,
      ip6tablesBinaryPath: this.ip6tables,
      activityRegistry: this.activity,
    })
  }

  async create(
    id: string,
    configuredDnsServers: readonly string[],
  ): Promise<NetworkNamespaceHandle> {
    const dnsServers = normalizeDnsServers(configuredDnsServers)
    const uplink = await this.defaultUplinkInterface()
    this.activity.activate(id)
    let lease: NetworkLease | undefined

    try {
      lease = await this.leases.allocate({
        allocationId: id,
        uplink,
        dnsServers,
      })
      await this.run([
        "link",
        "add",
        lease.hostVeth,
        "mtu",
        "1500",
        "type",
        "veth",
        "peer",
        "name",
        lease.peerVeth,
      ])
      await this.run([
        "addr",
        "add",
        `${lease.hostIp}/${lease.prefixLength}`,
        "dev",
        lease.hostVeth,
      ])
      await this.run(["link", "set", lease.hostVeth, "up"])
      await this.run(["netns", "add", lease.namespace])
      await this.run(["link", "set", lease.peerVeth, "netns", lease.namespace])
      await this.runInNamespace(lease.namespace, [
        "addr",
        "add",
        `${lease.peerIp}/${lease.prefixLength}`,
        "dev",
        lease.peerVeth,
      ])
      await this.runInNamespace(lease.namespace, [
        "link",
        "set",
        lease.peerVeth,
        "up",
      ])
      await this.runInNamespace(lease.namespace, ["link", "set", "lo", "up"])
      await this.runInNamespace(lease.namespace, [
        "route",
        "add",
        "default",
        "via",
        lease.hostIp,
      ])

      await this.configureIpv4Firewall(lease, dnsServers)
      await this.configureIpv6Deny(lease)
      // NAT is deliberately last: a failure in any mandatory isolation rule
      // prevents the namespace from ever becoming usable by a sandbox.
      await this.iptablesRun([
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        `${lease.peerIp}/32`,
        "-o",
        uplink,
        "-m",
        "comment",
        "--comment",
        lease.iptablesComment,
        "-j",
        "MASQUERADE",
      ])
    } catch (error) {
      try {
        if (lease) {
          await this.reaper.cleanupLease(lease, { allowLiveOwner: true })
        }
      } catch (cleanupError) {
        this.activity.deactivate(id)
        throw new AggregateError(
          [error, cleanupError],
          "Sandbox network setup failed and its durable cleanup also failed.",
          { cause: cleanupError },
        )
      }
      this.activity.deactivate(id)
      throw error
    }

    let tornDown = false
    return {
      path: `/var/run/netns/${lease.namespace}`,
      teardown: async () => {
        if (tornDown) return
        try {
          await this.reaper.cleanupLease(lease, { allowLiveOwner: true })
          tornDown = true
        } finally {
          this.activity.deactivate(id)
        }
      },
    }
  }

  private async configureIpv4Firewall(
    names: NetworkLease,
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
          "-m",
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

  private async configureIpv6Deny(names: NetworkLease): Promise<void> {
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
