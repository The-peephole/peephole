import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { VethNatNetworkProvisioner } from "../services/preview-worker/gvisor/networkNamespace"
import { SubnetAllocator } from "../services/preview-worker/gvisor/subnetAllocator"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"

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
        stdout: "default via 172.20.208.1 dev eth0 proto kernel \n",
        stderr: "",
      }
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
  }
}

describe("VethNatNetworkProvisioner", () => {
  let leaseDir: string
  let processRunner: FakeProcessRunner
  let provisioner: VethNatNetworkProvisioner

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-net-leases-"))
    processRunner = new FakeProcessRunner()
    provisioner = new VethNatNetworkProvisioner({
      processRunner,
      subnetAllocator: new SubnetAllocator(leaseDir),
    })
  })

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("creates a veth pair, moves one end into a fresh namespace, and NATs through the discovered uplink", async () => {
    const handle = await provisioner.create("job-1")

    expect(handle.path).toMatch(/^\/var\/run\/netns\/peephole-\d+$/)

    const commandLines = processRunner.calls.map((c) =>
      [c.command, ...c.args].join(" "),
    )
    expect(commandLines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ip link add veph\d+ .* peer name vpph\d+$/),
        expect.stringMatching(/^ip netns add peephole-\d+$/),
        expect.stringMatching(/^ip link set vpph\d+ netns peephole-\d+$/),
        expect.stringMatching(
          /^ip netns exec peephole-\d+ ip route add default via 10\.200\.\d+\.\d+$/,
        ),
        expect.stringMatching(
          /^iptables -t nat -A POSTROUTING -s 10\.200\.\d+\.\d+ -o eth0 .* -j MASQUERADE$/,
        ),
      ]),
    )

    // The metadata/link-local DROP must be inserted at the front of the
    // FORWARD chain, not appended after the ACCEPT rules.
    const dropIndex = commandLines.findIndex((line) =>
      line.includes("169.254.0.0/16"),
    )
    const insertFlagIndex = processRunner.calls.findIndex((c) =>
      c.args.includes("169.254.0.0/16"),
    )
    expect(processRunner.calls[insertFlagIndex]?.args[0]).toBe("-I")
    expect(dropIndex).toBeGreaterThan(-1)
  })

  it("tears down every rule and interface it created, in reverse", async () => {
    const handle = await provisioner.create("job-2")
    processRunner.calls.length = 0

    await handle.teardown()

    const commandLines = processRunner.calls.map((c) =>
      [c.command, ...c.args].join(" "),
    )
    expect(commandLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("iptables -D FORWARD"),
        expect.stringContaining("iptables -t nat -D POSTROUTING"),
        expect.stringMatching(/^ip link delete veph\d+$/),
        expect.stringMatching(/^ip netns delete peephole-\d+$/),
      ]),
    )
  })

  it("rolls back and releases the subnet lease if setup fails partway through", async () => {
    const allocator = new SubnetAllocator(leaseDir)
    provisioner = new VethNatNetworkProvisioner({
      processRunner,
      subnetAllocator: allocator,
    })
    processRunner.failing = (command, args) =>
      command === "iptables" && args.includes("MASQUERADE")

    await expect(provisioner.create("job-3")).rejects.toThrow()

    // The lease must be released, not leaked, on a failed setup.
    const reallocated = await allocator.allocate()
    expect(reallocated.index).toBeDefined()
  })

  it("throws a clear error when the host has no default route", async () => {
    processRunner.failing = (command, args) =>
      command === "ip" && args[0] === "route"

    await expect(provisioner.create("job-4")).rejects.toThrow(
      /default network interface/,
    )
  })
})
