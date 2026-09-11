import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  NetworkLeaseManager,
  type NetworkLeaseManagerOptions,
  type ProcessState,
  deriveNetworkNames,
  toSubnet,
} from "../services/preview-worker/gvisor/subnetAllocator"

const ALLOCATION_ID = "a".repeat(32)

describe("NetworkLeaseManager", () => {
  let leaseDir: string
  let manager: NetworkLeaseManager

  beforeEach(async () => {
    leaseDir = await mkdtemp(path.join(os.tmpdir(), "peephole-net-leases-"))
    manager = makeManager(leaseDir)
  })

  afterEach(async () => {
    await rm(leaseDir, { recursive: true, force: true })
  })

  it("atomically publishes a complete derived ownership marker", async () => {
    const lease = await allocate(manager)
    const marker = JSON.parse(
      await readFile(path.join(lease.leaseDir, "lease.json"), "utf8"),
    ) as Record<string, unknown>

    expect(marker).toMatchObject({
      version: 1,
      subnetIndex: lease.index,
      allocationId: ALLOCATION_ID,
      hostIp: toSubnet(lease.index).hostIp,
      peerIp: toSubnet(lease.index).peerIp,
      prefixLength: toSubnet(lease.index).prefixLength,
      ...deriveNetworkNames(ALLOCATION_ID, lease.index),
      uplink: "eth0",
      dnsServers: ["172.31.0.2"],
      creatorPid: process.pid,
      creatorProcessStartTime: "test-start",
      bootId: "test-boot",
    })
    expect(await readdir(leaseDir)).toEqual([String(lease.index)])
  })

  it("hands out distinct, non-overlapping /30 subnets", async () => {
    const first = await allocate(manager, "a".repeat(32))
    const second = await allocate(manager, "b".repeat(32))
    expect(first.index).not.toBe(second.index)
    expect(first.hostIp).not.toBe(second.hostIp)
    expect(first.peerIp).toBe(bumpLastOctet(first.hostIp, 1))
    expect(first.prefixLength).toBe(30)
  })

  it("releases only a validated marker and makes its slot reusable", async () => {
    const lease = await allocate(manager)
    await manager.release(lease)
    expect(await readdir(leaseDir)).toEqual([])
    expect(
      (await allocate(manager, "b".repeat(32))).index,
    ).toBeGreaterThanOrEqual(0)
  })

  // 20 contenders fully serialize through a real, fsync'd disk critical
  // section; Windows filesystem I/O under contention can comfortably exceed
  // vitest's default 5s test timeout without indicating a correctness
  // problem.
  it("never hands out an already-leased slot concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        allocate(manager, index.toString(16).padStart(32, "0")),
      ),
    )
    expect(new Set(results.map((lease) => lease.index)).size).toBe(20)
  }, 20_000)

  it("recovers exact pre-publication crash directories and leaves unrelated hidden directories", async () => {
    const empty = path.join(
      leaseDir,
      `.peephole-net-allocating-4-${"1".repeat(32)}`,
    )
    const marked = path.join(
      leaseDir,
      `.peephole-net-allocating-5-${"2".repeat(32)}`,
    )
    const unrelated = path.join(leaseDir, ".operator-data")
    await mkdir(empty)
    await mkdir(marked)
    await writeFile(path.join(marked, "lease.json"), "partial")
    await mkdir(unrelated)
    await manager.recoverAllocationLock()
    expect((await readdir(leaseDir)).sort()).toEqual([".operator-data"])
  })

  it("recovers an atomically unpublished, marker-bearing released lease", async () => {
    const lease = await allocate(manager)
    const releasing = path.join(
      leaseDir,
      `.peephole-net-releasing-${String(lease.index)}-${"4".repeat(32)}`,
    )
    await rename(lease.leaseDir, releasing)
    await manager.recoverAllocationLock()
    expect(await readdir(leaseDir)).toEqual([])
  })

  it("fails closed on a temporary symlink", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "peephole-net-target-"))
    const candidate = path.join(
      leaseDir,
      `.peephole-net-allocating-7-${"3".repeat(32)}`,
    )
    try {
      await symlink(target, candidate, "junction")
      await expect(manager.recoverAllocationLock()).rejects.toThrow(
        /ordinary direct child/,
      )
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(candidate, { force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it("fails closed on a numeric lease-directory symlink", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "peephole-net-target-"))
    const candidate = path.join(leaseDir, "9")
    try {
      await symlink(target, candidate, "junction")
      await expect(manager.listOwnedLeases()).rejects.toThrow(
        /not an ordinary directory/,
      )
      expect(await readdir(target)).toEqual([])
    } finally {
      await rm(candidate, { force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it("fails closed on a marker symlink", async () => {
    const lease = await allocate(manager)
    const markerPath = path.join(lease.leaseDir, "lease.json")
    const target = path.join(leaseDir, "operator-marker-target")
    await rm(markerPath)
    await mkdir(target)
    await symlink(target, markerPath, "junction")
    await expect(manager.listOwnedLeases()).rejects.toThrow(
      /marker|unexpected content/,
    )
    expect(await readdir(target)).toEqual([])
  })

  it("fails closed on malformed, mismatched, or unexpected final lease content", async () => {
    const lease = await allocate(manager)
    const markerPath = path.join(lease.leaseDir, "lease.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
      string,
      unknown
    >
    marker.hostVeth = "veph999"
    await writeFile(markerPath, JSON.stringify(marker))
    await expect(manager.listOwnedLeases()).rejects.toThrow(
      /derived resource identity/,
    )
    await writeFile(markerPath, "not-json")
    await expect(manager.listOwnedLeases()).rejects.toThrow(/malformed/)
    await writeFile(markerPath, JSON.stringify(marker))
    await writeFile(path.join(lease.leaseDir, "unexpected"), "x")
    await expect(manager.listOwnedLeases()).rejects.toThrow(
      /unexpected content/,
    )
  })

  it("recognizes a same-boot, same-process-start owner as live", async () => {
    expect(await manager.isLiveOwner(await allocate(manager))).toBe(true)
  })

  describe("global allocation lock recovery", () => {
    const lockName = ".peephole-network-allocation.lock"

    it("reclaims a same-boot lock whose PID is confirmed missing", async () => {
      await writeLock(leaseDir, lockName, lockOwner({ pid: 42 }))
      const candidate = makeManager(leaseDir, {
        processState: (pid) => (pid === 42 ? "MISSING" : "EXISTS"),
      })
      await expect(allocate(candidate)).resolves.toBeDefined()
      expect(await readdir(leaseDir)).not.toContain(lockName)
    })

    it("reclaims a lock from a different boot even when its PID exists", async () => {
      await writeLock(
        leaseDir,
        lockName,
        lockOwner({ pid: 42, bootId: "previous-boot" }),
      )
      const candidate = makeManager(leaseDir, {
        processState: () => "EXISTS",
      })
      await expect(allocate(candidate)).resolves.toBeDefined()
    })

    it("reclaims a PID-reused lock only after start-time mismatch is proven", async () => {
      await writeLock(leaseDir, lockName, lockOwner({ pid: 42 }))
      const candidate = makeManager(leaseDir, {
        processState: () => "EXISTS",
        processStartTime: async (pid) =>
          pid === process.pid ? "test-start" : "reused-start",
      })
      await expect(allocate(candidate)).resolves.toBeDefined()
    })

    it("preserves a proven live final lock", async () => {
      await writeLock(leaseDir, lockName, lockOwner({ pid: 42 }))
      const candidate = makeManager(leaseDir, {
        processState: () => "EXISTS",
        processStartTime: async (pid) =>
          pid === process.pid ? "test-start" : "owner-start",
        lockTimeoutMs: 0,
      })
      await expect(allocate(candidate)).rejects.toThrow(
        /live network allocation lock/,
      )
      expect(
        await readFile(path.join(leaseDir, lockName, "owner.json"), "utf8"),
      ).toContain('"pid":42')
    })

    const unknownLivenessCases: Array<
      [string, Partial<NetworkLeaseManagerOptions>]
    > = [
      [
        "process state is unknown",
        { processState: (): ProcessState => "UNKNOWN" },
      ],
      [
        "process existence check throws",
        {
          processState: (): ProcessState => {
            throw new Error("EPERM")
          },
        },
      ],
      [
        "process start time cannot be read",
        {
          processState: (): ProcessState => "EXISTS",
          processStartTime: async (pid: number) => {
            if (pid === process.pid) return "test-start"
            throw new Error("proc unavailable")
          },
        },
      ],
    ]

    it.each(unknownLivenessCases)(
      "preserves the final lock when %s",
      async (_label, overrides) => {
        await writeLock(leaseDir, lockName, lockOwner({ pid: 42 }))
        const candidate = makeManager(leaseDir, overrides)
        await expect(allocate(candidate)).rejects.toThrow(
          /liveness|read failed/,
        )
        expect(await readdir(path.join(leaseDir, lockName))).toEqual([
          "owner.json",
        ])
      },
    )

    it("preserves the final lock when boot identity cannot be read", async () => {
      await writeLock(leaseDir, lockName, lockOwner({ pid: 42 }))
      const candidate = makeManager(leaseDir, { bootId: async () => null })
      await expect(allocate(candidate)).rejects.toThrow(/without boot ID/)
      expect(await readdir(path.join(leaseDir, lockName))).toEqual([
        "owner.json",
      ])
    })

    it.each([
      [
        "malformed",
        async (directory: string) =>
          writeFile(path.join(directory, "owner.json"), "{"),
      ],
      ["missing", async () => undefined],
      [
        "unexpected",
        async (directory: string) => {
          await writeFile(
            path.join(directory, "owner.json"),
            JSON.stringify(lockOwner({ pid: 42 })),
          )
          await writeFile(path.join(directory, "operator-data"), "keep")
        },
      ],
    ])("fails closed for a %s final lock marker", async (_label, prepare) => {
      const directory = path.join(leaseDir, lockName)
      await mkdir(directory)
      await prepare(directory)
      const candidate = makeManager(leaseDir)
      await expect(allocate(candidate)).rejects.toThrow(/lock|marker/)
      // A missing/malformed/unexpected final lock is never age-reclaimed: the
      // lock directory itself must still be exactly where it was, whether or
      // not it happens to contain any entries.
      expect(await readdir(leaseDir)).toContain(lockName)
    })

    it("fails closed without following a final-lock symlink", async () => {
      const target = await mkdtemp(
        path.join(os.tmpdir(), "peephole-lock-target-"),
      )
      await writeFile(path.join(target, "operator-data"), "keep")
      const candidatePath = path.join(leaseDir, lockName)
      try {
        await symlink(target, candidatePath, "junction")
        await expect(allocate(makeManager(leaseDir))).rejects.toThrow(
          /ordinary directory/,
        )
        expect(await readFile(path.join(target, "operator-data"), "utf8")).toBe(
          "keep",
        )
      } finally {
        await rm(candidatePath, { force: true })
        await rm(target, { recursive: true, force: true })
      }
    })

    it("recovers exact empty and interrupted-marker pre-publication candidates", async () => {
      const empty = `.peephole-network-lock-allocating-${"1".repeat(32)}`
      const interrupted = `.peephole-network-lock-allocating-${"2".repeat(32)}`
      await mkdir(path.join(leaseDir, empty))
      await mkdir(path.join(leaseDir, interrupted))
      await writeFile(path.join(leaseDir, interrupted, "owner.json"), "{")
      await manager.recoverAllocationLock()
      expect(await readdir(leaseDir)).toEqual([])
    })

    it("recovers a complete stale pre-publication candidate but preserves unrelated hidden data", async () => {
      const temporary = `.peephole-network-lock-allocating-${"3".repeat(32)}`
      await writeLock(leaseDir, temporary, lockOwner({ pid: 42 }))
      await mkdir(path.join(leaseDir, ".operator-hidden"))
      await makeManager(leaseDir, {
        processState: (pid) => (pid === 42 ? "MISSING" : "EXISTS"),
      }).recoverAllocationLock()
      expect((await readdir(leaseDir)).sort()).toEqual([".operator-hidden"])
    })

    it("recovers a crash immediately after atomic final publication", async () => {
      const temporary = path.join(
        leaseDir,
        `.peephole-network-lock-allocating-${"4".repeat(32)}`,
      )
      await writeLock(
        leaseDir,
        path.basename(temporary),
        lockOwner({ pid: 42 }),
      )
      await rename(temporary, path.join(leaseDir, lockName))
      expect(await readdir(path.join(leaseDir, lockName))).toEqual([
        "owner.json",
      ])
      await makeManager(leaseDir, {
        processState: (pid) => (pid === 42 ? "MISSING" : "EXISTS"),
      }).recoverAllocationLock()
      expect(await readdir(leaseDir)).toEqual([])
    })

    it("recovers a quarantined stale lock left by a cleanup crash", async () => {
      const releasing = `.peephole-network-lock-releasing-${"5".repeat(32)}`
      await writeLock(leaseDir, releasing, lockOwner({ pid: 42 }))
      await makeManager(leaseDir, {
        processState: (pid) => (pid === 42 ? "MISSING" : "EXISTS"),
      }).recoverAllocationLock()
      expect(await readdir(leaseDir)).toEqual([])
    })

    it("never publishes a markerless final lock during concurrent allocation", async () => {
      const observations: string[][] = []
      const candidate = makeManager(leaseDir, {
        syncDirectory: async (directory) => {
          const final = path.join(leaseDir, lockName)
          if (directory === leaseDir) {
            try {
              observations.push(await readdir(final))
            } catch {
              // The root is also synced after releasing the lock.
            }
          }
        },
      })
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          allocate(candidate, index.toString(16).padStart(32, "0")),
        ),
      )
      expect(observations.length).toBeGreaterThan(0)
      expect(
        observations.every(
          (entries) => entries.length === 1 && entries[0] === "owner.json",
        ),
      ).toBe(true)
    }, 20_000) // Same real-disk serialized-contention latency as the 20-way test above.
  })
})

function makeManager(
  leaseDir: string,
  overrides: NetworkLeaseManagerOptions = {},
): NetworkLeaseManager {
  return new NetworkLeaseManager({
    leaseDir,
    bootId: async () => "test-boot",
    processStartTime: async () => "test-start",
    processState: (pid) => (pid === process.pid ? "EXISTS" : "MISSING"),
    syncDirectory: async () => undefined,
    ...overrides,
  })
}

function allocate(manager: NetworkLeaseManager, allocationId = ALLOCATION_ID) {
  return manager.allocate({
    allocationId,
    uplink: "eth0",
    dnsServers: ["172.31.0.2"],
  })
}

function bumpLastOctet(ip: string, by: number): string {
  const [a, b, c, d] = ip.split(".").map(Number)
  return [a, b, c, (d ?? 0) + by].join(".")
}

function lockOwner(
  overrides: Partial<{
    pid: number
    processStartTime: string
    bootId: string
  }> = {},
) {
  return {
    version: 1,
    pid: overrides.pid ?? process.pid,
    processStartTime: overrides.processStartTime ?? "owner-start",
    bootId: overrides.bootId ?? "test-boot",
    createdAt: new Date(0).toISOString(),
  }
}

async function writeLock(
  root: string,
  name: string,
  owner: ReturnType<typeof lockOwner>,
): Promise<void> {
  const directory = path.join(root, name)
  await mkdir(directory)
  await writeFile(path.join(directory, "owner.json"), JSON.stringify(owner))
}
