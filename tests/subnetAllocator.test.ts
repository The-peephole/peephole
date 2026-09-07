import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SubnetAllocator } from "../services/preview-worker/gvisor/subnetAllocator"

describe("SubnetAllocator", () => {
  let leaseDir: string
  let allocator: SubnetAllocator

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-net-leases-"))
    allocator = new SubnetAllocator(leaseDir)
  })

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("hands out distinct, non-overlapping /30 subnets", async () => {
    const first = await allocator.allocate()
    const second = await allocator.allocate()

    expect(first.index).not.toBe(second.index)
    expect(first.hostIp).not.toBe(second.hostIp)
    expect(first.peerIp).not.toBe(second.peerIp)
    expect(first.prefixLength).toBe(30)
    // host and peer are adjacent addresses within the same /30.
    expect(first.peerIp).toBe(bumpLastOctet(first.hostIp, 1))
  })

  it("releases a slot so it can be reused", async () => {
    const allocated = await allocator.allocate()
    await allocator.release(allocated.index)

    const entries = await readdir(leaseDir)
    expect(entries).toHaveLength(0)

    const reallocated = await allocator.allocate()
    expect(reallocated.index).toBeGreaterThanOrEqual(0)
  })

  it("never hands out an already-leased slot concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => allocator.allocate()),
    )
    const indices = new Set(results.map((r) => r.index))
    expect(indices.size).toBe(20)
  })
})

function bumpLastOctet(ip: string, by: number): string {
  const [a, b, c, d] = ip.split(".").map(Number)
  return [a, b, c, (d ?? 0) + by].join(".")
}
