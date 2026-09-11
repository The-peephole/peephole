import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  BLOCKED_IPV4_DESTINATIONS,
  VethNatNetworkProvisioner,
} from "../services/preview-worker/gvisor/networkNamespace"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import { SubnetAllocator } from "../services/preview-worker/gvisor/subnetAllocator"

const DNS_SERVER = "172.31.0.2"

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  failing: ((command: string, args: string[]) => boolean) | null = null

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (this.failing?.(command, args)) {
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "boom" }
    }
    if (command === "ip" && args[0] === "route" && args[1] === "list") {
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "default via 172.31.0.1 dev eth0 proto dhcp\n",
        stderr: "",
      }
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
  }
}

describe("VethNatNetworkProvisioner", () => {
  let leaseDir: string
  let processRunner: FakeProcessRunner
  let allocator: SubnetAllocator
  let provisioner: VethNatNetworkProvisioner

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-net-leases-"))
    processRunner = new FakeProcessRunner()
    allocator = new SubnetAllocator({
      leaseDir,
      bootId: async () => "test-boot",
      processStartTime: async () => "test-start",
      syncDirectory: async () => undefined,
    })
    provisioner = new VethNatNetworkProvisioner({
      processRunner,
      subnetAllocator: allocator,
    })
  })

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("creates a /30 route and keeps public IPv4 egress through NAT", async () => {
    const handle = await provisioner.create("1".repeat(32), [DNS_SERVER])
    const lines = commandLines(processRunner)

    expect(handle.path).toMatch(/^\/var\/run\/netns\/peephole-\d+$/)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ip link add veph\d+ .* peer name vpph\d+$/),
        expect.stringMatching(/^ip netns add peephole-\d+$/),
        expect.stringMatching(/^ip link set vpph\d+ netns peephole-\d+$/),
        expect.stringMatching(
          /^ip netns exec peephole-\d+ ip route add default via 10\.200\.\d+\.\d+$/,
        ),
        expect.stringMatching(
          /^iptables -w 5 -t nat -A POSTROUTING -s 10\.200\.\d+\.\d+\/32 -o eth0 -m comment --comment peephole-1{32}-\d+ -j MASQUERADE$/,
        ),
        expect.stringMatching(/^iptables -w 5 -A ppe\d+ -j ACCEPT$/),
      ]),
    )

    const natIndex = lines.findIndex((line) => line.includes("MASQUERADE"))
    const forwardHookIndex = lines.findIndex((line) =>
      line.match(/^iptables -w 5 -I FORWARD 1 -i veph\d+ -j ppe\d+$/),
    )
    expect(natIndex).toBeGreaterThan(forwardHookIndex)
  })

  it("allows only exact DNS port 53 before blocking local and non-public destinations", async () => {
    await provisioner.create("2".repeat(32), [DNS_SERVER, "169.254.169.253"])
    const lines = commandLines(processRunner)
    const egressChain = createdChain(lines, "ppe")
    const chainLines = lines.filter((line) =>
      line.startsWith(`iptables -w 5 -A ${egressChain} `),
    )

    expect(chainLines.slice(0, 4)).toEqual([
      `iptables -w 5 -A ${egressChain} -d ${DNS_SERVER}/32 -p udp -m udp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d ${DNS_SERVER}/32 -p tcp -m tcp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d 169.254.169.253/32 -p udp -m udp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d 169.254.169.253/32 -p tcp -m tcp --dport 53 -j ACCEPT`,
    ])

    for (const cidr of BLOCKED_IPV4_DESTINATIONS) {
      expect(chainLines).toContain(
        `iptables -w 5 -A ${egressChain} -d ${cidr} -j DROP`,
      )
    }

    expect(chainLines.at(-1)).toBe(`iptables -w 5 -A ${egressChain} -j ACCEPT`)
    expect(
      chainLines.indexOf(
        `iptables -w 5 -A ${egressChain} -d 10.0.0.0/8 -j DROP`,
      ),
    ).toBeGreaterThan(3)
    expect(
      chainLines.indexOf(
        `iptables -w 5 -A ${egressChain} -d 169.254.0.0/16 -j DROP`,
      ),
    ).toBeGreaterThan(3)
    expect(chainLines).toContain(
      `iptables -w 5 -A ${egressChain} -d 127.0.0.0/8 -j DROP`,
    )
    expect(chainLines).toContain(
      `iptables -w 5 -A ${egressChain} -d 10.0.0.0/8 -j DROP`,
    )
    expect(chainLines).not.toContain(
      `iptables -w 5 -A ${egressChain} -d ${DNS_SERVER}/32 -j ACCEPT`,
    )
  })

  it("blocks host services, unsolicited replies, and all sandbox IPv6", async () => {
    await provisioner.create("3".repeat(32), [DNS_SERVER])
    const lines = commandLines(processRunner)
    const inputChain = createdChain(lines, "ppi")
    const returnChain = createdChain(lines, "ppr")

    expect(lines).toEqual(
      expect.arrayContaining([
        `iptables -w 5 -A ${inputChain} -d ${DNS_SERVER}/32 -p udp -m udp --dport 53 -j ACCEPT`,
        `iptables -w 5 -A ${inputChain} -d ${DNS_SERVER}/32 -p tcp -m tcp --dport 53 -j ACCEPT`,
        `iptables -w 5 -A ${inputChain} -j DROP`,
        `iptables -w 5 -A ${returnChain} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
        `iptables -w 5 -A ${returnChain} -j DROP`,
        expect.stringMatching(/^ip6tables -w 5 -I INPUT 1 -i veph\d+ -j DROP$/),
        expect.stringMatching(
          /^ip6tables -w 5 -I FORWARD 1 -i veph\d+ -j DROP$/,
        ),
        expect.stringMatching(
          /^ip6tables -w 5 -I FORWARD 1 -o veph\d+ -j DROP$/,
        ),
      ]),
    )
  })

  it("fails closed and cleans partial state when a required DROP rule fails", async () => {
    processRunner.failing = (command, args) =>
      command === "iptables" && args.includes("10.0.0.0/8")

    await expect(
      provisioner.create("4".repeat(32), [DNS_SERVER]),
    ).rejects.toThrow()

    const lines = commandLines(processRunner)
    expect(lines).not.toContain(expect.stringContaining("MASQUERADE"))
    const reallocated = await allocator.allocate({
      allocationId: "a".repeat(32),
      uplink: "eth0",
      dnsServers: [DNS_SERVER],
    })
    expect(reallocated.index).toBeDefined()
  })

  it("fails closed and cleans IPv4 state when IPv6 enforcement fails", async () => {
    processRunner.failing = (command) => command === "ip6tables"

    await expect(
      provisioner.create("5".repeat(32), [DNS_SERVER]),
    ).rejects.toThrow()

    const lines = commandLines(processRunner)
    expect(lines).not.toContain(expect.stringContaining("MASQUERADE"))
    expect(lines).toContain("iptables -w 5 -S")
  })

  it("tears down NAT, hooks, chains, IPv6 policy, interfaces, and namespace", async () => {
    const handle = await provisioner.create("6".repeat(32), [DNS_SERVER])
    processRunner.calls.length = 0

    await handle.teardown()

    const lines = commandLines(processRunner)
    expect(lines).toEqual(
      expect.arrayContaining([
        "ip netns list",
        "ip -o link show",
        "iptables -w 5 -S",
        "iptables -w 5 -t nat -S",
        "ip6tables -w 5 -S",
      ]),
    )

    processRunner.failing = () => true
    await expect(handle.teardown()).resolves.toBeUndefined()
  })

  it("rejects missing or invalid DNS policy before creating network state", async () => {
    await expect(provisioner.create("7".repeat(32), [])).rejects.toThrow(
      /IPv4 DNS resolver/,
    )
    await expect(
      provisioner.create("8".repeat(32), ["not-an-ip-address"]),
    ).rejects.toThrow(/Invalid DNS server/)
    expect(processRunner.calls).toHaveLength(0)
  })

  it("throws a clear error when the host has no default route", async () => {
    processRunner.failing = (command, args) =>
      command === "ip" && args[0] === "route"

    await expect(
      provisioner.create("9".repeat(32), [DNS_SERVER]),
    ).rejects.toThrow(/default network interface/)
  })
})

function commandLines(processRunner: FakeProcessRunner): string[] {
  return processRunner.calls.map((call) =>
    [call.command, ...call.args].join(" "),
  )
}

function createdChain(lines: readonly string[], prefix: string): string {
  const line = lines.find((candidate) =>
    candidate.match(new RegExp(`^iptables -w 5 -N ${prefix}\\d+$`)),
  )
  if (!line) {
    throw new Error(`Expected a ${prefix} chain to be created`)
  }
  return line.split(" ").at(-1)!
}
