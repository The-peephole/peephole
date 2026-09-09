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
    allocator = new SubnetAllocator(leaseDir)
    provisioner = new VethNatNetworkProvisioner({
      processRunner,
      subnetAllocator: allocator,
    })
  })

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("creates a /30 route and keeps public IPv4 egress through NAT", async () => {
    const handle = await provisioner.create("job-1", [DNS_SERVER])
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
          /^iptables -w 5 -t nat -A POSTROUTING -s 10\.200\.\d+\.\d+ -o eth0 -m comment --comment peephole-job-\d+-\d+ -j MASQUERADE$/,
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
    await provisioner.create("job-2", [DNS_SERVER, "169.254.169.253"])
    const lines = commandLines(processRunner)
    const egressChain = createdChain(lines, "ppe")
    const chainLines = lines.filter((line) =>
      line.startsWith(`iptables -w 5 -A ${egressChain} `),
    )

    expect(chainLines.slice(0, 4)).toEqual([
      `iptables -w 5 -A ${egressChain} -d ${DNS_SERVER}/32 -p udp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d ${DNS_SERVER}/32 -p tcp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d 169.254.169.253/32 -p udp --dport 53 -j ACCEPT`,
      `iptables -w 5 -A ${egressChain} -d 169.254.169.253/32 -p tcp --dport 53 -j ACCEPT`,
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
    await provisioner.create("job-3", [DNS_SERVER])
    const lines = commandLines(processRunner)
    const inputChain = createdChain(lines, "ppi")
    const returnChain = createdChain(lines, "ppr")

    expect(lines).toEqual(
      expect.arrayContaining([
        `iptables -w 5 -A ${inputChain} -d ${DNS_SERVER}/32 -p udp --dport 53 -j ACCEPT`,
        `iptables -w 5 -A ${inputChain} -d ${DNS_SERVER}/32 -p tcp --dport 53 -j ACCEPT`,
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

    await expect(provisioner.create("job-4", [DNS_SERVER])).rejects.toThrow()

    const lines = commandLines(processRunner)
    expect(lines).not.toContain(expect.stringContaining("MASQUERADE"))
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^iptables -w 5 -F pp[ier]\d+$/),
        expect.stringMatching(/^iptables -w 5 -X pp[ier]\d+$/),
        expect.stringMatching(/^ip link delete veph\d+$/),
        expect.stringMatching(/^ip netns delete peephole-\d+$/),
      ]),
    )

    const reallocated = await allocator.allocate()
    expect(reallocated.index).toBeDefined()
  })

  it("fails closed and cleans IPv4 state when IPv6 enforcement fails", async () => {
    processRunner.failing = (command) => command === "ip6tables"

    await expect(provisioner.create("job-5", [DNS_SERVER])).rejects.toThrow()

    const lines = commandLines(processRunner)
    expect(lines).not.toContain(expect.stringContaining("MASQUERADE"))
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^iptables -w 5 -D INPUT -i veph\d+ -j ppi\d+$/),
        expect.stringMatching(
          /^iptables -w 5 -D FORWARD -i veph\d+ -j ppe\d+$/,
        ),
        expect.stringMatching(/^iptables -w 5 -F pp[ier]\d+$/),
        expect.stringMatching(/^iptables -w 5 -X pp[ier]\d+$/),
      ]),
    )
  })

  it("tears down NAT, hooks, chains, IPv6 policy, interfaces, and namespace", async () => {
    const handle = await provisioner.create("job-6", [DNS_SERVER])
    processRunner.calls.length = 0

    await handle.teardown()

    const lines = commandLines(processRunner)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("iptables -w 5 -t nat -D POSTROUTING"),
        expect.stringMatching(/^ip6tables -w 5 -D FORWARD -o veph\d+ -j DROP$/),
        expect.stringMatching(/^ip6tables -w 5 -D FORWARD -i veph\d+ -j DROP$/),
        expect.stringMatching(/^ip6tables -w 5 -D INPUT -i veph\d+ -j DROP$/),
        expect.stringMatching(/^iptables -w 5 -D INPUT -i veph\d+ -j ppi\d+$/),
        expect.stringMatching(
          /^iptables -w 5 -D FORWARD -o veph\d+ -j ppr\d+$/,
        ),
        expect.stringMatching(
          /^iptables -w 5 -D FORWARD -i veph\d+ -j ppe\d+$/,
        ),
        expect.stringMatching(/^iptables -w 5 -F pp[ier]\d+$/),
        expect.stringMatching(/^iptables -w 5 -X pp[ier]\d+$/),
        expect.stringMatching(/^ip link delete veph\d+$/),
        expect.stringMatching(/^ip netns delete peephole-\d+$/),
      ]),
    )

    processRunner.failing = () => true
    await expect(handle.teardown()).resolves.toBeUndefined()
  })

  it("rejects missing or invalid DNS policy before creating network state", async () => {
    await expect(provisioner.create("job-7", [])).rejects.toThrow(
      /IPv4 DNS resolver/,
    )
    await expect(
      provisioner.create("job-8", ["not-an-ip-address"]),
    ).rejects.toThrow(/Invalid DNS server/)
    expect(processRunner.calls).toHaveLength(0)
  })

  it("throws a clear error when the host has no default route", async () => {
    processRunner.failing = (command, args) =>
      command === "ip" && args[0] === "route"

    await expect(provisioner.create("job-9", [DNS_SERVER])).rejects.toThrow(
      /default network interface/,
    )
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
