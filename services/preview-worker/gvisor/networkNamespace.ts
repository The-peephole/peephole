import type { ProcessRunner } from "./processRunner"
import { NodeProcessRunner } from "./nodeProcessRunner"
import { SubnetAllocator, type AllocatedSubnet } from "./subnetAllocator"

const SETUP_TIMEOUT_MS = 10_000

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
  subnetAllocator?: SubnetAllocator
}

/**
 * Gives a sandbox real outbound network access by replicating, for a
 * single job, exactly what `runsc do` does for its (single-use,
 * documented "testing only") sandbox: a veth pair with one end moved into
 * a fresh network namespace, addressed as a /30 point-to-point link,
 * NAT'd through the host's own default interface. Unlike `runsc do`,
 * every job gets its own non-conflicting subnet (SubnetAllocator) so
 * concurrent jobs don't collide, and cloud metadata/link-local
 * (169.254.0.0/16, which includes 169.254.169.254 on every major cloud)
 * is blocked outright -- npm has no legitimate reason to reach it, and
 * it's the single highest-value SSRF target once a sandbox has any
 * network access at all.
 *
 * Broader egress restriction (allowlisting only the npm registry, or
 * blocking the rest of RFC1918) is deliberately not done here: the
 * registry's IPs aren't stable enough to allowlist directly, and which
 * private ranges are safe to block depends on the deployment's own
 * network topology (this host's default route may itself be a private
 * address, as it is under WSL2) -- see IMPLEMENTATION_CHECKLIST.md.
 */
export class VethNatNetworkProvisioner {
  private readonly processRunner: ProcessRunner
  private readonly ip: string
  private readonly iptables: string
  private readonly subnets: SubnetAllocator

  constructor(options: NetworkNamespaceProvisionerOptions = {}) {
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.ip = options.ipBinaryPath ?? "ip"
    this.iptables = options.iptablesBinaryPath ?? "iptables"
    this.subnets = options.subnetAllocator ?? new SubnetAllocator()
  }

  async create(id: string): Promise<NetworkNamespaceHandle> {
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
      await this.iptablesRun([
        "-A",
        "FORWARD",
        "-i",
        uplink,
        "-o",
        names.hostVeth,
        "-j",
        "ACCEPT",
      ])
      await this.iptablesRun([
        "-A",
        "FORWARD",
        "-o",
        uplink,
        "-i",
        names.hostVeth,
        "-j",
        "ACCEPT",
      ])
      // Inserted ahead of the ACCEPT rule above so it's evaluated first:
      // cloud metadata services (AWS/GCP/Azure/... all use
      // 169.254.169.254) and the rest of link-local are unreachable from
      // inside the sandbox no matter what.
      await this.iptablesRun([
        "-I",
        "FORWARD",
        "1",
        "-i",
        names.hostVeth,
        "-d",
        "169.254.0.0/16",
        "-j",
        "DROP",
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
    // Best-effort: deleting the host-side veth also deletes its peer, so
    // the namespace's own interface is already gone by the time we get to
    // it, and each step tolerates the previous one never having
    // succeeded (partial setup on the throw path above).
    await this.iptablesRun([
      "-D",
      "FORWARD",
      "-i",
      names.hostVeth,
      "-d",
      "169.254.0.0/16",
      "-j",
      "DROP",
    ]).catch(() => undefined)
    await this.iptablesRun([
      "-D",
      "FORWARD",
      "-o",
      uplink,
      "-i",
      names.hostVeth,
      "-j",
      "ACCEPT",
    ]).catch(() => undefined)
    await this.iptablesRun([
      "-D",
      "FORWARD",
      "-i",
      uplink,
      "-o",
      names.hostVeth,
      "-j",
      "ACCEPT",
    ]).catch(() => undefined)
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
    await this.run(["link", "delete", names.hostVeth]).catch(() => undefined)
    await this.run(["netns", "delete", names.namespace]).catch(() => undefined)
    await this.subnets.release(subnet.index)
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
    return this.exec(this.iptables, args)
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
  }
}
