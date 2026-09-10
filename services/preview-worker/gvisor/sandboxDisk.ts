import { randomBytes } from "node:crypto"
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import type { ProcessRunner, ProcessRunResult } from "./processRunner"
import { NodeProcessRunner } from "./nodeProcessRunner"
import { SANDBOX_GID, SANDBOX_UID } from "./sandboxIdentity"

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const COMMAND_TIMEOUT_MS = 30_000
const ALLOCATION_LOCK_TIMEOUT_MS = 10_000
const UNKNOWN_LOCK_STALE_MS = 5 * 60_000
const BUNDLE_NAME_PATTERN = /^peephole-([a-f\d]{32})$/
const LOOP_DEVICE_PATTERN = /^\/dev\/loop\d+$/
const MARKER_NAME = ".peephole-sandbox.json"
const IMAGE_NAME = "workspace.img"
const MOUNTPOINT_NAME = "workspace"
const ALLOCATION_LOCK_NAME = ".peephole-disk-allocation.lock"
const LOCK_OWNER_NAME = "owner.json"

export const DEFAULT_SANDBOX_DISK_LIMIT_BYTES = GIB
export const DEFAULT_HOST_DISK_RESERVE_BYTES = 2 * GIB
export const MIN_SANDBOX_DISK_LIMIT_BYTES = 32 * MIB
export const MAX_SANDBOX_DISK_LIMIT_BYTES = 16 * GIB

interface SandboxAllocationMarker {
  version: 1
  allocationId: string
  bundlePath: string
  imagePath: string
  mountpoint: string
  reservedOutsideBytes: number
}

interface AllocationLockOwner {
  version: 1
  pid: number
  bootId: string | null
  createdAt: string
}

export interface SandboxDiskAllocation {
  readonly allocationId: string
  readonly bundleDir: string
  readonly imagePath: string
  readonly mountpoint: string
}

export interface SandboxDiskHandle {
  readonly rootDir: string
  readonly hardLimitBytes: number
  isExhausted(): Promise<boolean>
}

export interface CreateSandboxDiskAllocationOptions {
  /** Predictable bytes outside workspace.img that must fit before the base
   * rootfs copy begins (base rootfs + archive staging + artifact copy). */
  expectedOutsideBytes: number
}

export interface MountSandboxDiskOptions {
  /** Predictable future bytes outside workspace.img after the base rootfs
   * has already been copied (archive staging + artifact copy). */
  remainingOutsideBytes: number
}

export interface SandboxDiskManager {
  getBundlesRootDir(): Promise<string>
  createAllocation(
    options: CreateSandboxDiskAllocationOptions,
  ): Promise<SandboxDiskAllocation>
  mountWorkspace(
    allocation: SandboxDiskAllocation,
    options: MountSandboxDiskOptions,
  ): Promise<SandboxDiskHandle>
  updateReservedOutsideBytes(
    allocation: SandboxDiskAllocation,
    remainingOutsideBytes: number,
  ): Promise<void>
  readOwnedAllocation(bundleDir: string): Promise<SandboxDiskAllocation | null>
  listOwnedAllocations(): Promise<SandboxDiskAllocation[]>
  destroyAllocation(allocation: SandboxDiskAllocation): Promise<void>
  recoverAllocationLock(): Promise<void>
}

export interface LoopbackSandboxDiskManagerOptions {
  bundlesRootDir?: string
  hardLimitBytes?: number
  minimumHostReserveBytes?: number
  processRunner?: ProcessRunner
  fallocateBinaryPath?: string
  mkfsExt4BinaryPath?: string
  mountBinaryPath?: string
  umountBinaryPath?: string
  losetupBinaryPath?: string
  findmntBinaryPath?: string
  now?: () => Date
  bootId?: () => Promise<string | null>
  processExists?: (pid: number) => boolean
  statFilesystem?: (candidate: string) => Promise<FilesystemCapacity>
}

export interface FilesystemCapacity {
  bavail: number
  bsize: number
  ffree: number
}

/**
 * Owns the complete lifecycle of a per-job, preallocated loop-backed ext4
 * filesystem. Only this class may unmount, detach, or recursively remove a
 * production bundle. Cleanup first proves marker ownership, exact canonical
 * paths, mount source/target/fstype, and loop backing-file identity.
 */
export class LoopbackSandboxDiskManager implements SandboxDiskManager {
  readonly hardLimitBytes: number
  readonly minimumHostReserveBytes: number
  private readonly bundlesRootDir: string
  private readonly processRunner: ProcessRunner
  private readonly fallocate: string
  private readonly mkfsExt4: string
  private readonly mount: string
  private readonly umount: string
  private readonly losetup: string
  private readonly findmnt: string
  private readonly now: () => Date
  private readonly readBootId: () => Promise<string | null>
  private readonly processExists: (pid: number) => boolean
  private readonly statFilesystem: (
    candidate: string,
  ) => Promise<FilesystemCapacity>

  constructor(options: LoopbackSandboxDiskManagerOptions = {}) {
    this.bundlesRootDir = options.bundlesRootDir ?? "/var/lib/peephole/jobs"
    this.hardLimitBytes =
      options.hardLimitBytes ?? DEFAULT_SANDBOX_DISK_LIMIT_BYTES
    this.minimumHostReserveBytes =
      options.minimumHostReserveBytes ?? DEFAULT_HOST_DISK_RESERVE_BYTES
    assertByteLimit(
      "sandbox hard disk limit",
      this.hardLimitBytes,
      MIN_SANDBOX_DISK_LIMIT_BYTES,
      MAX_SANDBOX_DISK_LIMIT_BYTES,
    )
    assertByteLimit(
      "minimum host disk reserve",
      this.minimumHostReserveBytes,
      0,
      Number.MAX_SAFE_INTEGER,
    )
    this.processRunner = options.processRunner ?? new NodeProcessRunner()
    this.fallocate = options.fallocateBinaryPath ?? "fallocate"
    this.mkfsExt4 = options.mkfsExt4BinaryPath ?? "mkfs.ext4"
    this.mount = options.mountBinaryPath ?? "mount"
    this.umount = options.umountBinaryPath ?? "umount"
    this.losetup = options.losetupBinaryPath ?? "losetup"
    this.findmnt = options.findmntBinaryPath ?? "findmnt"
    this.now = options.now ?? (() => new Date())
    this.readBootId = options.bootId ?? defaultBootId
    this.processExists = options.processExists ?? defaultProcessExists
    this.statFilesystem = options.statFilesystem ?? statfs
  }

  async createAllocation(
    options: CreateSandboxDiskAllocationOptions,
  ): Promise<SandboxDiskAllocation> {
    assertNonNegativeBytes(
      "expected outside allocation",
      options.expectedOutsideBytes,
    )
    await mkdir(this.bundlesRootDir, { recursive: true, mode: 0o700 })
    const bundlesRoot = await realpath(this.bundlesRootDir)

    return this.withAllocationLock(async () => {
      const existingReservations = await this.sumReservedOutsideBytes()
      await assertFreeSpace(
        bundlesRoot,
        this.hardLimitBytes +
          this.minimumHostReserveBytes +
          options.expectedOutsideBytes +
          existingReservations,
        this.statFilesystem,
      )

      const allocationId = randomBytes(16).toString("hex")
      const bundleDir = path.join(bundlesRoot, `peephole-${allocationId}`)
      const allocation = allocationFor(bundleDir, allocationId)
      await mkdir(bundleDir, { mode: 0o700 })

      try {
        await writeFile(
          path.join(bundleDir, MARKER_NAME),
          `${JSON.stringify(toMarker(allocation, options.expectedOutsideBytes), null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        )
        const image = await open(allocation.imagePath, "wx", 0o600)
        await image.close()
        await this.run(this.fallocate, [
          "--length",
          String(this.hardLimitBytes),
          allocation.imagePath,
        ])
        await assertFreeSpace(
          bundlesRoot,
          this.minimumHostReserveBytes +
            options.expectedOutsideBytes +
            existingReservations,
          this.statFilesystem,
        )
      } catch (error) {
        try {
          await rm(bundleDir, { recursive: true, force: true })
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Sandbox disk allocation failed and its new bundle could not be removed.",
            { cause: cleanupError },
          )
        }
        throw error
      }

      return allocation
    })
  }

  async getBundlesRootDir(): Promise<string> {
    await mkdir(this.bundlesRootDir, { recursive: true, mode: 0o700 })
    return realpath(this.bundlesRootDir)
  }

  async mountWorkspace(
    allocation: SandboxDiskAllocation,
    options: MountSandboxDiskOptions,
  ): Promise<SandboxDiskHandle> {
    assertNonNegativeBytes(
      "remaining outside allocation",
      options.remainingOutsideBytes,
    )
    const owned = await this.requireOwnedAllocation(allocation.bundleDir)
    assertSameAllocation(owned, allocation)

    let loopDevice: string | undefined

    try {
      await mkdir(owned.mountpoint, { mode: 0o700 })
      await assertOrdinaryPath(owned.imagePath, "file")
      await assertOrdinaryPath(owned.mountpoint, "directory")

      loopDevice = await this.withAllocationLock(async () => {
        const marker = await this.readMarker(owned)
        if (marker.reservedOutsideBytes !== options.remainingOutsideBytes) {
          throw new Error(
            "Sandbox outside-byte reservation was not updated before mounting.",
          )
        }
        await assertFreeSpace(
          owned.bundleDir,
          this.minimumHostReserveBytes + (await this.sumReservedOutsideBytes()),
          this.statFilesystem,
        )

        const result = await this.run(this.losetup, [
          "--find",
          "--show",
          "--nooverlap",
          owned.imagePath,
        ])
        const selected = result.stdout.trim()
        if (!LOOP_DEVICE_PATTERN.test(selected)) {
          throw new Error(`losetup returned an unsafe loop device: ${selected}`)
        }
        return selected
      })

      await this.run(this.mkfsExt4, [
        "-F",
        "-m",
        "0",
        "-E",
        "nodiscard",
        "-L",
        `peephole-${owned.allocationId.slice(0, 8)}`,
        loopDevice,
      ])
      await this.run(this.mount, [
        "-t",
        "ext4",
        "-o",
        "rw,nodev,nosuid,noatime,nodiscard",
        loopDevice,
        owned.mountpoint,
      ])

      const mounted = await this.readExactMount(owned.mountpoint)
      if (
        !mounted ||
        mounted.source !== loopDevice ||
        mounted.fstype !== "ext4"
      ) {
        throw new Error(
          "The sandbox workspace ext4 mount could not be verified.",
        )
      }

      await chown(owned.mountpoint, SANDBOX_UID, SANDBOX_GID)
      await chmod(owned.mountpoint, 0o700)
      const home = path.join(owned.mountpoint, ".home")
      const npmCache = path.join(home, ".npm")
      await mkdir(npmCache, { recursive: true, mode: 0o700 })
      await chown(home, SANDBOX_UID, SANDBOX_GID)
      await chown(npmCache, SANDBOX_UID, SANDBOX_GID)
      await chmod(home, 0o700)
      await chmod(npmCache, 0o700)

      return {
        rootDir: owned.mountpoint,
        hardLimitBytes: this.hardLimitBytes,
        isExhausted: () =>
          isFilesystemExhausted(owned.mountpoint, this.statFilesystem),
      }
    } catch (error) {
      try {
        await this.cleanupWorkspace(owned)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Sandbox disk setup failed and its partial resources could not be cleaned safely.",
          { cause: cleanupError },
        )
      }
      throw error
    }
  }

  async updateReservedOutsideBytes(
    allocation: SandboxDiskAllocation,
    remainingOutsideBytes: number,
  ): Promise<void> {
    assertNonNegativeBytes(
      "remaining outside allocation",
      remainingOutsideBytes,
    )
    const owned = await this.requireOwnedAllocation(allocation.bundleDir)
    assertSameAllocation(owned, allocation)
    await this.withAllocationLock(async () => {
      const current = await this.readMarker(owned)
      const allReservations = await this.sumReservedOutsideBytes()
      await assertFreeSpace(
        owned.bundleDir,
        this.minimumHostReserveBytes +
          allReservations -
          current.reservedOutsideBytes +
          remainingOutsideBytes,
        this.statFilesystem,
      )
      const temporary = path.join(
        owned.bundleDir,
        `.peephole-marker-${randomBytes(8).toString("hex")}`,
      )
      await writeFile(
        temporary,
        `${JSON.stringify(toMarker(owned, remainingOutsideBytes), null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      )
      await rename(temporary, path.join(owned.bundleDir, MARKER_NAME))
    })
  }

  async readOwnedAllocation(
    bundleDir: string,
  ): Promise<SandboxDiskAllocation | null> {
    try {
      return await this.requireOwnedAllocation(bundleDir)
    } catch {
      return null
    }
  }

  async listOwnedAllocations(): Promise<SandboxDiskAllocation[]> {
    await mkdir(this.bundlesRootDir, { recursive: true, mode: 0o700 })
    const root = await realpath(this.bundlesRootDir)
    const entries = await readdir(root, { withFileTypes: true })
    const allocations: SandboxDiskAllocation[] = []

    for (const entry of entries) {
      if (!BUNDLE_NAME_PATTERN.test(entry.name)) continue
      if (!entry.isDirectory()) {
        throw new Error(
          `Peephole-shaped allocation path is not an ordinary directory: ${entry.name}`,
        )
      }
      // A directory with Peephole's unguessable allocation shape but a
      // missing/corrupt marker may be a partially mounted crash remnant. Do
      // not silently skip it and start new work; preserve it and fail closed.
      allocations.push(
        await this.requireOwnedAllocation(path.join(root, entry.name)),
      )
    }

    return allocations
  }

  async destroyAllocation(allocation: SandboxDiskAllocation): Promise<void> {
    const owned = await this.requireOwnedAllocation(allocation.bundleDir)
    assertSameAllocation(owned, allocation)
    await this.cleanupWorkspace(owned)
    await rm(owned.bundleDir, { recursive: true, force: false })
  }

  async recoverAllocationLock(): Promise<void> {
    const root = await realpath(this.bundlesRootDir).catch(() => null)
    if (!root) return
    const lockDir = path.join(root, ALLOCATION_LOCK_NAME)
    const state = await this.lockState(lockDir)
    if (state === "absent") return
    if (state === "live") {
      throw new Error("A live Peephole disk allocation lock already exists.")
    }
    await this.removeKnownLock(lockDir)
  }

  private async cleanupWorkspace(
    allocation: SandboxDiskAllocation,
  ): Promise<void> {
    const mount = await this.readExactMount(allocation.mountpoint)
    const loopMappings = await this.listLoopMappings()
    const backingMappings = await this.mappingsForImage(
      loopMappings,
      allocation.imagePath,
    )

    if (backingMappings.length > 1) {
      throw new Error("Multiple loop devices reference one Peephole image.")
    }

    if (mount) {
      if (
        mount.fstype !== "ext4" ||
        !LOOP_DEVICE_PATTERN.test(mount.source) ||
        backingMappings.length !== 1 ||
        backingMappings[0]?.name !== mount.source
      ) {
        throw new Error(
          "Refusing to unmount a workspace whose source, target, fstype, and backing file do not all match.",
        )
      }
      await this.run(this.umount, ["--", allocation.mountpoint])
      if (await this.readExactMount(allocation.mountpoint)) {
        throw new Error("Sandbox workspace remained mounted after umount.")
      }
    }

    const afterUnmount = await this.mappingsForImage(
      await this.listLoopMappings(),
      allocation.imagePath,
    )
    if (afterUnmount.length > 1) {
      throw new Error("Multiple loop devices reference one Peephole image.")
    }
    const loop = afterUnmount[0]
    if (loop) {
      await this.run(this.losetup, ["--detach", loop.name])
    }

    const remaining = await this.mappingsForImage(
      await this.listLoopMappings(),
      allocation.imagePath,
    )
    if (remaining.length > 0) {
      throw new Error("Sandbox loop device remained attached after detach.")
    }
    if (await this.readExactMount(allocation.mountpoint)) {
      throw new Error("Refusing to remove a still-mounted sandbox bundle.")
    }

    await rm(allocation.imagePath, { force: true })
    await rmdir(allocation.mountpoint).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  private async requireOwnedAllocation(
    candidateBundle: string,
  ): Promise<SandboxDiskAllocation> {
    const root = await realpath(this.bundlesRootDir)
    const bundle = await realpath(candidateBundle)
    if (path.dirname(bundle) !== root) {
      throw new Error("Sandbox bundle is not a direct child of its owned root.")
    }
    const match = BUNDLE_NAME_PATTERN.exec(path.basename(bundle))
    if (!match?.[1])
      throw new Error("Sandbox bundle name is not owned by Peephole.")
    await assertOrdinaryPath(bundle, "directory")

    const markerPath = path.join(bundle, MARKER_NAME)
    await assertOrdinaryPath(markerPath, "file")
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"))
    const allocation = allocationFor(bundle, match[1])
    if (!isExpectedMarker(parsed, allocation)) {
      throw new Error(
        "Sandbox ownership marker does not match canonical paths.",
      )
    }

    await assertOptionalOrdinaryPath(allocation.imagePath, "file")
    await assertOptionalOrdinaryPath(allocation.mountpoint, "directory")
    return allocation
  }

  private async readMarker(
    allocation: SandboxDiskAllocation,
  ): Promise<SandboxAllocationMarker> {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(allocation.bundleDir, MARKER_NAME), "utf8"),
    )
    if (!isExpectedMarker(parsed, allocation)) {
      throw new Error(
        "Sandbox ownership marker does not match canonical paths.",
      )
    }
    return parsed
  }

  private async sumReservedOutsideBytes(): Promise<number> {
    const allocations = await this.listOwnedAllocations()
    let total = 0
    for (const allocation of allocations) {
      total += (await this.readMarker(allocation)).reservedOutsideBytes
      if (!Number.isSafeInteger(total)) {
        throw new Error("Sandbox outside-byte reservations overflowed.")
      }
    }
    return total
  }

  private async readExactMount(
    mountpoint: string,
  ): Promise<MountRecord | null> {
    const result = await this.processRunner.run(
      this.findmnt,
      [
        "--json",
        "--mountpoint",
        mountpoint,
        "--output",
        "SOURCE,TARGET,FSTYPE",
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    )
    if (
      result.exitCode === 1 &&
      !result.timedOut &&
      result.stdout.trim() === "" &&
      result.stderr.trim() === ""
    )
      return null
    if (result.exitCode !== 0 || result.timedOut) {
      throw commandError(this.findmnt, result)
    }

    const parsed: unknown = JSON.parse(result.stdout)
    const filesystems = isRecord(parsed) ? parsed.filesystems : undefined
    if (!Array.isArray(filesystems) || filesystems.length !== 1) {
      throw new Error("findmnt returned an ambiguous workspace mount result.")
    }
    const entry = filesystems[0]
    if (
      !isRecord(entry) ||
      typeof entry.source !== "string" ||
      typeof entry.target !== "string" ||
      typeof entry.fstype !== "string" ||
      path.resolve(entry.target) !== path.resolve(mountpoint)
    ) {
      throw new Error("findmnt returned an unsafe workspace mount result.")
    }
    return { source: entry.source, target: entry.target, fstype: entry.fstype }
  }

  private async listLoopMappings(): Promise<LoopMapping[]> {
    const result = await this.run(this.losetup, [
      "--json",
      "--list",
      "--output",
      "NAME,BACK-FILE",
    ])
    const parsed: unknown = JSON.parse(result.stdout)
    const devices = isRecord(parsed) ? parsed.loopdevices : undefined
    if (!Array.isArray(devices)) {
      throw new Error("losetup returned an invalid loop-device list.")
    }
    return devices.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        typeof entry["back-file"] !== "string" ||
        !LOOP_DEVICE_PATTERN.test(entry.name)
      ) {
        throw new Error("losetup returned an unsafe loop-device record.")
      }
      return { name: entry.name, backingFile: entry["back-file"] }
    })
  }

  private async mappingsForImage(
    mappings: readonly LoopMapping[],
    expectedImage: string,
  ): Promise<LoopMapping[]> {
    const expected = await realpath(expectedImage).catch(() =>
      path.resolve(expectedImage),
    )
    const matches: LoopMapping[] = []
    for (const mapping of mappings) {
      const backing = await realpath(mapping.backingFile).catch(() => null)
      if (backing === expected) matches.push(mapping)
    }
    return matches
  }

  private async withAllocationLock<T>(action: () => Promise<T>): Promise<T> {
    const root = await realpath(this.bundlesRootDir)
    const lockDir = path.join(root, ALLOCATION_LOCK_NAME)
    const deadline = this.now().getTime() + ALLOCATION_LOCK_TIMEOUT_MS

    for (;;) {
      try {
        await mkdir(lockDir, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const state = await this.lockState(lockDir)
        if (state === "stale") {
          await this.removeKnownLock(lockDir)
          continue
        }
        if (this.now().getTime() >= deadline) {
          throw new Error(
            "Timed out waiting for the sandbox disk allocation lock.",
            {
              cause: error,
            },
          )
        }
        await delay(50)
        continue
      }
    }

    let result!: T
    let actionError: unknown
    try {
      const owner: AllocationLockOwner = {
        version: 1,
        pid: process.pid,
        bootId: await this.readBootId(),
        createdAt: this.now().toISOString(),
      }
      await writeFile(
        path.join(lockDir, LOCK_OWNER_NAME),
        JSON.stringify(owner),
        { flag: "wx", mode: 0o600 },
      )
      result = await action()
    } catch (error) {
      actionError = error
    }
    let cleanupError: unknown
    try {
      await this.removeKnownLock(lockDir)
    } catch (error) {
      cleanupError = error
    }
    if (actionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [actionError, cleanupError],
        "Sandbox allocation action failed and its lock could not be released.",
        { cause: actionError },
      )
    }
    if (cleanupError !== undefined) throw cleanupError
    if (actionError !== undefined) throw actionError
    return result
  }

  private async lockState(
    lockDir: string,
  ): Promise<"absent" | "live" | "stale"> {
    const stats = await lstat(lockDir).catch(() => null)
    if (!stats) return "absent"
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Sandbox disk allocation lock path is not a directory.")
    }

    try {
      const owner: unknown = JSON.parse(
        await readFile(path.join(lockDir, LOCK_OWNER_NAME), "utf8"),
      )
      if (!isLockOwner(owner)) throw new Error("invalid owner")
      const currentBootId = await this.readBootId()
      if (
        owner.bootId !== null &&
        currentBootId !== null &&
        owner.bootId !== currentBootId
      ) {
        return "stale"
      }
      return this.processExists(owner.pid) ? "live" : "stale"
    } catch {
      return this.now().getTime() - stats.mtimeMs > UNKNOWN_LOCK_STALE_MS
        ? "stale"
        : "live"
    }
  }

  private async removeKnownLock(lockDir: string): Promise<void> {
    const root = await realpath(this.bundlesRootDir)
    if (
      path.dirname(lockDir) !== root ||
      path.basename(lockDir) !== ALLOCATION_LOCK_NAME
    ) {
      throw new Error("Refusing to remove an unexpected disk allocation lock.")
    }
    const quarantine = path.join(
      root,
      `.peephole-disk-lock-stale-${randomBytes(8).toString("hex")}`,
    )
    try {
      await rename(lockDir, quarantine)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    await rm(quarantine, { recursive: true, force: false })
  }

  private async run(
    command: string,
    args: string[],
  ): Promise<ProcessRunResult> {
    const result = await this.processRunner.run(command, args, {
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    if (result.exitCode !== 0 || result.timedOut) {
      throw commandError(command, result)
    }
    return result
  }
}

interface MountRecord {
  source: string
  target: string
  fstype: string
}

interface LoopMapping {
  name: string
  backingFile: string
}

function allocationFor(
  bundleDir: string,
  allocationId: string,
): SandboxDiskAllocation {
  return {
    allocationId,
    bundleDir,
    imagePath: path.join(bundleDir, IMAGE_NAME),
    mountpoint: path.join(bundleDir, MOUNTPOINT_NAME),
  }
}

function toMarker(
  allocation: SandboxDiskAllocation,
  reservedOutsideBytes: number,
): SandboxAllocationMarker {
  return {
    version: 1,
    allocationId: allocation.allocationId,
    bundlePath: allocation.bundleDir,
    imagePath: allocation.imagePath,
    mountpoint: allocation.mountpoint,
    reservedOutsideBytes,
  }
}

function isExpectedMarker(
  value: unknown,
  allocation: SandboxDiskAllocation,
): value is SandboxAllocationMarker {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    value.allocationId === allocation.allocationId &&
    value.bundlePath === allocation.bundleDir &&
    value.imagePath === allocation.imagePath &&
    value.mountpoint === allocation.mountpoint &&
    Number.isSafeInteger(value.reservedOutsideBytes) &&
    Number(value.reservedOutsideBytes) >= 0
  )
}

function isLockOwner(value: unknown): value is AllocationLockOwner {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    (value.bootId === null || typeof value.bootId === "string") &&
    typeof value.createdAt === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function assertOrdinaryPath(
  candidate: string,
  expected: "file" | "directory",
): Promise<void> {
  const stats = await lstat(candidate)
  const matches = expected === "file" ? stats.isFile() : stats.isDirectory()
  if (!matches || stats.isSymbolicLink()) {
    throw new Error(`Expected ordinary ${expected}: ${candidate}`)
  }
}

async function assertOptionalOrdinaryPath(
  candidate: string,
  expected: "file" | "directory",
): Promise<void> {
  try {
    await assertOrdinaryPath(candidate, expected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function assertSameAllocation(
  expected: SandboxDiskAllocation,
  actual: SandboxDiskAllocation,
): void {
  if (
    expected.allocationId !== actual.allocationId ||
    expected.bundleDir !== actual.bundleDir ||
    expected.imagePath !== actual.imagePath ||
    expected.mountpoint !== actual.mountpoint
  ) {
    throw new Error("Sandbox allocation does not match its ownership marker.")
  }
}

function assertByteLimit(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} bytes.`)
  }
}

function assertNonNegativeBytes(name: string, value: number): void {
  assertByteLimit(name, value, 0, Number.MAX_SAFE_INTEGER)
}

async function assertFreeSpace(
  candidate: string,
  requiredBytes: number,
  getFilesystem: (candidate: string) => Promise<FilesystemCapacity>,
) {
  const filesystem = await getFilesystem(candidate)
  const availableBytes = filesystem.bavail * filesystem.bsize
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient host disk space for a sandbox: ${String(availableBytes)} bytes available, ${String(requiredBytes)} required.`,
    )
  }
}

async function isFilesystemExhausted(
  mountpoint: string,
  getFilesystem: (candidate: string) => Promise<FilesystemCapacity>,
): Promise<boolean> {
  const filesystem = await getFilesystem(mountpoint)
  return filesystem.bavail === 0 || filesystem.ffree === 0
}

function commandError(command: string, result: ProcessRunResult): Error {
  return new Error(
    `${command} failed (exit ${String(result.exitCode)}, timedOut=${String(result.timedOut)}): ${result.stderr || result.stdout}`,
  )
}

async function defaultBootId(): Promise<string | null> {
  try {
    return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
  } catch {
    return null
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Conservative logical byte count used only for pre-copy admission. A second
 * free-space check after the real copy accounts for actual allocation. */
export async function directoryLogicalBytes(root: string): Promise<number> {
  const rootStats = await stat(root)
  if (!rootStats.isDirectory()) throw new Error(`Not a directory: ${root}`)
  let total = rootStats.size
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) {
      total += await directoryLogicalBytes(candidate)
    } else {
      total += (await lstat(candidate)).size
    }
  }
  return total
}
