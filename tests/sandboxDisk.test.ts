import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
} from "../services/preview-worker/gvisor/sandboxDisk"

class LoopTools implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[] }> = []
  loop: { name: string; backingFile: string } | null = null
  mounted: { source: string; target: string; fstype: string } | null = null
  failCommand: string | null = null
  failDetach = false
  wrongMountSource = false
  findmntError = false

  async run(command: string, args: string[]): Promise<ProcessRunResult> {
    this.calls.push({ command, args })
    if (command === this.failCommand) return failed(`${command} failed`)
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

  beforeEach(async () => {
    bundlesRootDir = await mkdtemp(path.join(os.tmpdir(), "peephole-disks-"))
    tools = new LoopTools()
  })

  afterEach(async () => {
    await rm(bundlesRootDir, { recursive: true, force: true })
  })

  function manager(availableBytes = Number.MAX_SAFE_INTEGER) {
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
    })
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
})
