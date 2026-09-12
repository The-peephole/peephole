import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import {
  LoopbackSandboxDiskManager,
  MIN_SANDBOX_DISK_LIMIT_BYTES,
  type LoopbackSandboxDiskManagerOptions,
} from "../services/preview-worker/gvisor/sandboxDisk"
import { GVisorOrphanReaper } from "../services/preview-worker/gvisor/gvisorOrphanReaper"

class LoopTools implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  loop: { name: string; backingFile: string } | null = null
  mounted: { source: string; target: string; fstype: string } | null = null
  failCommand: string | null = null
  failDetach = false
  wrongMountSource = false
  findmntError = false
  onFallocate: ((imagePath: string) => Promise<void>) | null = null

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (command === this.failCommand) return failed(`${command} failed`)
    if (command === "fallocate" && this.onFallocate) {
      await this.onFallocate(args.at(-1) ?? "")
    }
    if (command === "runsc" && args.includes("list")) {
      return succeeded("[]")
    }
    if (command === "losetup" && args.includes("--find")) {
      this.loop = { name: "/dev/loop7", backingFile: args.at(-1) ?? "" }
      return succeeded(this.loop.name)
    }
    if (command === "losetup" && args.includes("--list")) {
      return succeeded(
        JSON.stringify({
          loopdevices: this.loop
            ? [{ name: this.loop.name, "back-file": this.loop.backingFile }]
            : [],
        }),
      )
    }
    if (command === "losetup" && args.includes("--detach")) {
      if (this.failDetach) return failed("detach failed")
      this.loop = null
      return succeeded()
    }
    if (command === "mount") {
      this.mounted = {
        source: args.at(-2) ?? "",
        target: args.at(-1) ?? "",
        fstype: "ext4",
      }
      return succeeded()
    }
    if (command === "umount") {
      if (this.mounted) {
        await rm(path.join(this.mounted.target, ".home"), {
          recursive: true,
          force: true,
        })
      }
      this.mounted = null
      return succeeded()
    }
    if (command === "findmnt") {
      if (this.findmntError) return failed("findmnt failed")
      if (!this.mounted) return { ...succeeded(), exitCode: 1 }
      return succeeded(
        JSON.stringify({
          filesystems: [
            {
              ...this.mounted,
              source: this.wrongMountSource
                ? "/dev/loop999"
                : this.mounted.source,
            },
          ],
        }),
      )
    }
    return succeeded()
  }
}

function succeeded(stdout = ""): ProcessRunResult {
  return { exitCode: 0, timedOut: false, stdout, stderr: "" }
}

function failed(stderr: string): ProcessRunResult {
  return { exitCode: 1, timedOut: false, stdout: "", stderr }
}

describe("LoopbackSandboxDiskManager", () => {
  let bundlesRootDir: string
  let tools: LoopTools
  let ownershipChanges: Array<{ candidate: string; uid: number; gid: number }>

  beforeEach(async () => {
    bundlesRootDir = await mkdtemp(path.join(os.tmpdir(), "peephole-disks-"))
    tools = new LoopTools()
    ownershipChanges = []
  })

  afterEach(async () => {
    await rm(bundlesRootDir, { recursive: true, force: true })
  })

  function manager(
    availableBytes = Number.MAX_SAFE_INTEGER,
    overrides: Partial<LoopbackSandboxDiskManagerOptions> = {},
  ) {
    return new LoopbackSandboxDiskManager({
      bundlesRootDir,
      hardLimitBytes: MIN_SANDBOX_DISK_LIMIT_BYTES,
      minimumHostReserveBytes: 2 * MIN_SANDBOX_DISK_LIMIT_BYTES,
      processRunner: tools,
      statFilesystem: async () => ({
        bavail: availableBytes,
        bsize: 1,
        ffree: 1000,
      }),
      bootId: async () => "boot-test",
      processExists: () => false,
      chownPath: async (candidate, uid, gid) => {
        ownershipChanges.push({ candidate, uid, gid })
      },
      syncDirectory: async () => undefined,
      ...overrides,
    })
  }

  function transactionPaths(
    allocationId = "a".repeat(32),
    transactionId = "b".repeat(32),
  ) {
    const bundleDir = path.join(bundlesRootDir, `peephole-${allocationId}`)
    return {
      allocationId,
      bundleDir,
      imagePath: path.join(bundleDir, "workspace.img"),
      mountpoint: path.join(bundleDir, "workspace"),
      temporaryDir: path.join(
        bundlesRootDir,
        `.peephole-allocating-${allocationId}-${transactionId}`,
      ),
    }
  }

  function markerFor(paths: ReturnType<typeof transactionPaths>) {
    return {
      version: 1,
      allocationId: paths.allocationId,
      bundlePath: paths.bundleDir,
      imagePath: paths.imagePath,
      mountpoint: paths.mountpoint,
      reservedOutsideBytes: 123,
    }
  }

  it("creates a random marker identity and orders preallocation, loop, ext4, mount, then verification", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({
      expectedOutsideBytes: 123,
    })
    expect(path.basename(allocation.bundleDir)).toMatch(
      /^peephole-[a-f\d]{32}$/,
    )
    const marker = JSON.parse(
      await readFile(
        path.join(allocation.bundleDir, ".peephole-sandbox.json"),
        "utf8",
      ),
    )
    expect(marker).toMatchObject({
      version: 1,
      allocationId: allocation.allocationId,
      bundlePath: allocation.bundleDir,
      imagePath: allocation.imagePath,
      mountpoint: allocation.mountpoint,
      reservedOutsideBytes: 123,
    })

    await disks.updateReservedOutsideBytes(allocation, 456)
    const handle = await disks.mountWorkspace(allocation, {
      remainingOutsideBytes: 456,
    })
    expect(handle.rootDir).toBe(allocation.mountpoint)
    expect(tools.calls.map((call) => call.command).slice(0, 5)).toEqual([
      "fallocate",
      "losetup",
      "mkfs.ext4",
      "mount",
      "findmnt",
    ])
    expect(
      tools.calls.find((call) => call.command === "fallocate")?.args,
    ).toEqual([
      "--length",
      String(MIN_SANDBOX_DISK_LIMIT_BYTES),
      allocation.imagePath,
    ])
    expect(
      tools.calls.find((call) => call.command === "mkfs.ext4")?.args,
    ).toEqual(
      expect.arrayContaining(["-F", "-m", "0", "nodiscard", "/dev/loop7"]),
    )
    expect(
      tools.calls.find((call) => call.command === "mount")?.args.join(" "),
    ).toContain("rw,nodev,nosuid,noatime,nodiscard")
    expect(ownershipChanges).toEqual([
      { candidate: allocation.mountpoint, uid: 65_534, gid: 65_534 },
      {
        candidate: path.join(allocation.mountpoint, ".home"),
        uid: 65_534,
        gid: 65_534,
      },
      {
        candidate: path.join(allocation.mountpoint, ".home", ".npm"),
        uid: 65_534,
        gid: 65_534,
      },
    ])

    await disks.destroyAllocation(allocation)
    expect(tools.calls.map((call) => call.command).slice(-8)).toEqual([
      "findmnt",
      "losetup",
      "umount",
      "findmnt",
      "losetup",
      "losetup",
      "losetup",
      "findmnt",
    ])
    await expect(lstat(allocation.bundleDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("fails admission before rootfs copy when hard cap, outside bytes, and reserve do not fit", async () => {
    const required = 3 * MIN_SANDBOX_DISK_LIMIT_BYTES + 10
    await expect(
      manager(required - 1).createAllocation({ expectedOutsideBytes: 10 }),
    ).rejects.toThrow(/Insufficient host disk space/)
    expect(await manager().listOwnedAllocations()).toEqual([])
  })

  it("counts existing marker reservations so concurrent jobs cannot reuse pending headroom", async () => {
    const outsideBytes = 10
    const available = 3 * MIN_SANDBOX_DISK_LIMIT_BYTES + outsideBytes
    const disks = manager(available)
    await disks.createAllocation({ expectedOutsideBytes: outsideBytes })

    await expect(
      disks.createAllocation({ expectedOutsideBytes: outsideBytes }),
    ).rejects.toThrow(/Insufficient host disk space/)
  })

  it("fails closed when mount source does not match the exact loop backing file", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    tools.wrongMountSource = true
    await expect(
      disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 }),
    ).rejects.toThrow(/partial resources could not be cleaned safely/)
    expect(tools.calls.some((call) => call.command === "umount")).toBe(false)
    expect(tools.calls.some((call) => call.args.includes("--detach"))).toBe(
      false,
    )
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("does not detach or remove when loop backing identity changes", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    await disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 })
    if (!tools.loop) throw new Error("expected loop")
    tools.loop.backingFile = path.join(bundlesRootDir, "unrelated.img")

    await expect(disks.destroyAllocation(allocation)).rejects.toThrow(
      /backing file/,
    )
    expect(tools.calls.some((call) => call.args.includes("--detach"))).toBe(
      false,
    )
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("treats a findmnt diagnostic failure as unknown state, not as no mount", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    await disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 })
    tools.findmntError = true

    await expect(disks.destroyAllocation(allocation)).rejects.toThrow(
      /findmnt failed/,
    )
    expect(tools.calls.some((call) => call.args.includes("--detach"))).toBe(
      false,
    )
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("stops cleanup after umount failure and preserves the bundle and loop", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    await disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 })
    tools.failCommand = "umount"

    await expect(disks.destroyAllocation(allocation)).rejects.toThrow(
      /umount failed/,
    )
    expect(tools.loop?.name).toBe("/dev/loop7")
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("stops before image or bundle removal when loop detach fails", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    await disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 })
    tools.failDetach = true

    await expect(disks.destroyAllocation(allocation)).rejects.toThrow(
      /detach failed/,
    )
    expect(tools.loop?.backingFile).toBe(allocation.imagePath)
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("cleans a partial setup after mkfs failure without deleting the owned bundle", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await disks.updateReservedOutsideBytes(allocation, 0)
    tools.failCommand = "mkfs.ext4"

    await expect(
      disks.mountWorkspace(allocation, { remainingOutsideBytes: 0 }),
    ).rejects.toThrow(/mkfs.ext4 failed/)
    expect(tools.loop).toBeNull()
    expect(await disks.readOwnedAllocation(allocation.bundleDir)).not.toBeNull()
  })

  it("ignores unrelated names but fails closed on a marker-corrupt Peephole-shaped bundle", async () => {
    const disks = manager()
    const unrelated = path.join(bundlesRootDir, "unrelated")
    await mkdir(unrelated)
    expect(await disks.listOwnedAllocations()).toEqual([])

    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    await rm(path.join(allocation.bundleDir, ".peephole-sandbox.json"))
    await expect(disks.listOwnedAllocations()).rejects.toThrow()
    expect(await lstat(allocation.bundleDir)).toMatchObject({})
  })

  it("never follows a marker path outside the canonical direct-child allocation", async () => {
    const disks = manager()
    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })
    const unrelated = path.join(bundlesRootDir, "do-not-remove")
    await writeFile(unrelated, "safe")
    const markerPath = path.join(allocation.bundleDir, ".peephole-sandbox.json")
    const marker = JSON.parse(await readFile(markerPath, "utf8"))
    marker.imagePath = unrelated
    await writeFile(markerPath, JSON.stringify(marker))

    await expect(disks.destroyAllocation(allocation)).rejects.toThrow(
      /marker does not match canonical paths/,
    )
    await expect(readFile(unrelated, "utf8")).resolves.toBe("safe")
  })

  it("recovers an empty transactional directory left after temporary mkdir", async () => {
    const paths = transactionPaths()
    const lockDir = path.join(bundlesRootDir, ".peephole-disk-allocation.lock")
    await mkdir(paths.temporaryDir)
    await mkdir(lockDir)
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: 4242,
        bootId: "boot-test",
        createdAt: new Date(0).toISOString(),
      }),
    )

    await manager().recoverAllocationLock()

    await expect(lstat(paths.temporaryDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(paths.bundleDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(tools.calls).toEqual([])
  })

  it("recovers a marker-complete transaction that crashed before final rename", async () => {
    const paths = transactionPaths()
    await mkdir(paths.temporaryDir)
    await writeFile(
      path.join(paths.temporaryDir, ".peephole-sandbox.json"),
      JSON.stringify(markerFor(paths)),
    )

    await manager().recoverAllocationLock()

    await expect(lstat(paths.temporaryDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(paths.bundleDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(tools.calls).toEqual([])
  })

  it("reaps a valid marker-bearing final bundle left after atomic rename", async () => {
    const paths = transactionPaths()
    await mkdir(paths.bundleDir)
    await writeFile(
      path.join(paths.bundleDir, ".peephole-sandbox.json"),
      JSON.stringify(markerFor(paths)),
    )
    const disks = manager()
    const reaper = new GVisorOrphanReaper({
      diskManager: disks,
      processRunner: tools,
    })

    await expect(reaper.reapAll()).resolves.toEqual([
      path.basename(paths.bundleDir),
    ])
    await expect(lstat(paths.bundleDir)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("does not remove unrelated hidden directories during transaction recovery", async () => {
    const unrelated = path.join(bundlesRootDir, ".operator-state")
    const nearMatch = path.join(
      bundlesRootDir,
      `.peephole-allocating-${"a".repeat(32)}-not-random`,
    )
    await mkdir(unrelated)
    await mkdir(nearMatch)

    await manager().recoverAllocationLock()

    await expect(lstat(unrelated)).resolves.toMatchObject({})
    await expect(lstat(nearMatch)).resolves.toMatchObject({})
  })

  it("fails closed without following or removing a temporary allocation symlink", async () => {
    const paths = transactionPaths()
    const target = path.join(bundlesRootDir, "operator-owned")
    await mkdir(target)
    await writeFile(path.join(target, "keep"), "safe")
    await symlink(target, paths.temporaryDir, "junction")

    await expect(manager().recoverAllocationLock()).rejects.toThrow(
      /not an ordinary directory/,
    )
    await expect(readFile(path.join(target, "keep"), "utf8")).resolves.toBe(
      "safe",
    )
    expect((await lstat(paths.temporaryDir)).isSymbolicLink()).toBe(true)
  })

  it("publishes a valid final marker atomically before image allocation", async () => {
    const syncedDirectories: string[] = []
    const disks = manager(Number.MAX_SAFE_INTEGER, {
      syncDirectory: async (candidate) => {
        syncedDirectories.push(candidate)
      },
    })
    tools.onFallocate = async (imagePath) => {
      const bundleDir = path.dirname(imagePath)
      const marker = JSON.parse(
        await readFile(path.join(bundleDir, ".peephole-sandbox.json"), "utf8"),
      )
      expect(marker.bundlePath).toBe(bundleDir)
      expect(marker.imagePath).toBe(imagePath)
      expect(
        (await readdirNames(bundlesRootDir)).filter((name) =>
          name.startsWith(".peephole-allocating-"),
        ),
      ).toEqual([])
      expect(path.basename(syncedDirectories[0] ?? "")).toMatch(
        /^\.peephole-allocating-[a-f\d]{32}-[a-f\d]{32}$/,
      )
      expect(syncedDirectories[1]).toBe(bundlesRootDir)
    }

    const allocation = await disks.createAllocation({ expectedOutsideBytes: 0 })

    expect(await disks.readOwnedAllocation(allocation.bundleDir)).toEqual(
      allocation,
    )
  })

  it("preserves a live allocator transaction instead of recovering it", async () => {
    const paths = transactionPaths()
    const lockDir = path.join(bundlesRootDir, ".peephole-disk-allocation.lock")
    await mkdir(paths.temporaryDir)
    await mkdir(lockDir)
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: 4242,
        bootId: "boot-test",
        createdAt: new Date(0).toISOString(),
      }),
    )
    let clockRead = 0

    await expect(
      manager(Number.MAX_SAFE_INTEGER, {
        processExists: () => true,
        now: () => new Date(clockRead++ === 0 ? 0 : 20_000),
      }).recoverAllocationLock(),
    ).rejects.toThrow(/Timed out waiting/)
    await expect(lstat(paths.temporaryDir)).resolves.toMatchObject({})
  })
})

async function readdirNames(candidate: string): Promise<string[]> {
  return readdir(candidate)
}
