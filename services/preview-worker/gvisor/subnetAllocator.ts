import { randomBytes } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import { isIPv4 } from "node:net"
import path from "node:path"

export const NETWORK_POOL_SIZE = 16_384
const BASE_OCTET_2 = 200
const MARKER_NAME = "lease.json"
const LOCK_NAME = ".peephole-network-allocation.lock"
const LOCK_OWNER_NAME = "owner.json"
const LOCK_TEMP_PATTERN = /^\.peephole-network-lock-allocating-([a-f\d]{32})$/
const LOCK_RELEASING_PATTERN =
  /^\.peephole-network-lock-releasing-([a-f\d]{32})$/
const LEASE_NAME_PATTERN = /^(0|[1-9]\d{0,4})$/
const TEMP_NAME_PATTERN =
  /^\.peephole-net-allocating-(0|[1-9]\d{0,4})-([a-f\d]{32})$/
const RELEASING_NAME_PATTERN =
  /^\.peephole-net-releasing-(0|[1-9]\d{0,4})-([a-f\d]{32})$/
const ALLOCATION_ID_PATTERN = /^[a-f\d]{32}$/
const INTERFACE_PATTERN = /^[A-Za-z0-9_.-]{1,15}$/
const LOCK_TIMEOUT_MS = 10_000
const MAX_MARKER_BYTES = 16 * 1024
const MAX_LOCK_MARKER_BYTES = 4 * 1024

export type OwnerLiveness = "LIVE" | "STALE" | "UNKNOWN"
export type ProcessState = "EXISTS" | "MISSING" | "UNKNOWN"

export interface OwnerLivenessResult {
  readonly state: OwnerLiveness
  readonly isCurrentProcess: boolean
  readonly reason: string
}

export interface AllocatedSubnet {
  readonly index: number
  readonly hostIp: string
  readonly peerIp: string
  readonly prefixLength: number
}

export interface NetworkNames {
  readonly namespace: string
  readonly hostVeth: string
  readonly peerVeth: string
  readonly egressChain: string
  readonly inputChain: string
  readonly returnChain: string
  readonly iptablesComment: string
}

export interface NetworkLease extends AllocatedSubnet, NetworkNames {
  readonly version: 1
  readonly allocationId: string
  readonly uplink: string
  readonly dnsServers: readonly string[]
  readonly creatorPid: number
  readonly creatorProcessStartTime: string | null
  readonly bootId: string | null
  readonly createdAt: string
  readonly leaseDir: string
}

interface NetworkLeaseMarker {
  version: 1
  subnetIndex: number
  allocationId: string
  namespace: string
  hostVeth: string
  peerVeth: string
  hostIp: string
  peerIp: string
  prefixLength: number
  uplink: string
  egressChain: string
  inputChain: string
  returnChain: string
  iptablesComment: string
  dnsServers: readonly string[]
  creatorPid: number
  creatorProcessStartTime: string | null
  bootId: string | null
  createdAt: string
}

interface LockOwner {
  version: 1
  pid: number
  processStartTime: string
  bootId: string
  createdAt: string
}

export interface NetworkLeaseManagerOptions {
  leaseDir?: string
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  bootId?: () => Promise<string | null>
  processStartTime?: (pid: number) => Promise<string | null>
  processState?: (pid: number) => ProcessState
  /** Compatibility seam for older tests. Prefer processState. */
  processExists?: (pid: number) => boolean
  syncDirectory?: (candidate: string) => Promise<void>
  /** Test seam for the atomic temporary-to-final lock publication only. */
  publishLockDirectory?: (
    temporaryDir: string,
    lockDir: string,
  ) => Promise<void>
  lockTimeoutMs?: number
}

/** Crash-consistent ownership registry and IPAM. A durable marker is
 * atomically published before any host network resource may be created. */
export class NetworkLeaseManager {
  private readonly leaseDir: string
  private readonly now: () => Date
  private readonly random: (size: number) => Buffer
  private readonly readBootId: () => Promise<string | null>
  private readonly readProcessStartTime: (pid: number) => Promise<string | null>
  private readonly readProcessState: (pid: number) => ProcessState
  private readonly syncDirectory: (candidate: string) => Promise<void>
  private readonly publishLockDirectory: (
    temporaryDir: string,
    lockDir: string,
  ) => Promise<void>
  private readonly lockTimeoutMs: number

  constructor(options: NetworkLeaseManagerOptions | string = {}) {
    const normalized =
      typeof options === "string" ? { leaseDir: options } : options
    this.leaseDir = normalized.leaseDir ?? "/var/run/peephole/net-leases"
    this.now = normalized.now ?? (() => new Date())
    this.random = normalized.randomBytes ?? randomBytes
    this.readBootId = normalized.bootId ?? defaultBootId
    this.readProcessStartTime =
      normalized.processStartTime ?? defaultProcessStartTime
    this.readProcessState =
      normalized.processState ??
      (normalized.processExists
        ? (pid) => (normalized.processExists?.(pid) ? "EXISTS" : "MISSING")
        : defaultProcessState)
    this.syncDirectory = normalized.syncDirectory ?? fsyncDirectory
    this.publishLockDirectory = normalized.publishLockDirectory ?? rename
    this.lockTimeoutMs = normalized.lockTimeoutMs ?? LOCK_TIMEOUT_MS
  }

  async getLeaseRoot(): Promise<string> {
    await mkdir(this.leaseDir, { recursive: true, mode: 0o700 })
    return realpath(this.leaseDir)
  }

  async allocate(options: {
    allocationId: string
    uplink: string
    dnsServers: readonly string[]
  }): Promise<NetworkLease> {
    assertAllocationId(options.allocationId)
    if (!INTERFACE_PATTERN.test(options.uplink)) {
      throw new Error("Unsafe sandbox network uplink interface.")
    }
    if (
      options.dnsServers.length === 0 ||
      options.dnsServers.some((ip) => !isAllowedDnsServer(ip)) ||
      new Set(options.dnsServers).size !== options.dnsServers.length
    ) {
      throw new Error("Network lease requires valid IPv4 DNS servers.")
    }
    const root = await this.getLeaseRoot()
    return this.withAllocationLock(async () => {
      await this.recoverTemporaryDirectoriesUnlocked(root)
      const occupied = new Set(
        (await this.listOwnedLeasesUnlocked(root)).map((lease) => lease.index),
      )
      const start = Math.floor(Math.random() * NETWORK_POOL_SIZE)
      let index: number | undefined
      for (let attempt = 0; attempt < NETWORK_POOL_SIZE; attempt++) {
        const candidate = (start + attempt) % NETWORK_POOL_SIZE
        if (!occupied.has(candidate)) {
          index = candidate
          break
        }
      }
      if (index === undefined) {
        throw new Error("No free sandbox network subnet available.")
      }

      const finalDir = path.join(root, String(index))
      const temporaryDir = path.join(
        root,
        `.peephole-net-allocating-${String(index)}-${this.random(16).toString("hex")}`,
      )
      const lease = await this.buildLease(index, finalDir, options)
      let temporaryCreated = false
      let published = false
      try {
        await mkdir(temporaryDir, { mode: 0o700 })
        temporaryCreated = true
        await writeDurableFile(
          path.join(temporaryDir, MARKER_NAME),
          `${JSON.stringify(toMarker(lease), null, 2)}\n`,
        )
        await this.syncDirectory(temporaryDir)
        if (await pathExists(finalDir)) {
          throw new Error("Final network lease path already exists.")
        }
        await rename(temporaryDir, finalDir)
        published = true
        await this.syncDirectory(root)
        return lease
      } catch (error) {
        if (temporaryCreated && !published) {
          await this.removeTemporary(root, temporaryDir).catch(() => undefined)
        }
        throw error
      }
    })
  }

  async listOwnedLeases(): Promise<NetworkLease[]> {
    const root = await this.getLeaseRoot()
    return this.listOwnedLeasesUnlocked(root)
  }

  async requireOwnedLease(candidate: string): Promise<NetworkLease> {
    const root = await this.getLeaseRoot()
    const resolved = path.resolve(candidate)
    if (
      path.dirname(resolved) !== root ||
      !LEASE_NAME_PATTERN.test(path.basename(resolved))
    ) {
      throw new Error(
        "Network lease is not a direct numeric child of its owned root.",
      )
    }
    const stats = await lstat(resolved)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Network lease path is not an ordinary directory.")
    }
    if ((await realpath(resolved)) !== resolved) {
      throw new Error("Network lease canonical path is unsafe.")
    }
    const entries = await readdir(resolved, { withFileTypes: true })
    if (
      entries.length !== 1 ||
      entries[0]?.name !== MARKER_NAME ||
      !entries[0].isFile()
    ) {
      throw new Error("Network lease contains missing or unexpected content.")
    }
    const markerPath = path.join(resolved, MARKER_NAME)
    const markerStats = await lstat(markerPath)
    if (
      !markerStats.isFile() ||
      markerStats.isSymbolicLink() ||
      markerStats.size > MAX_MARKER_BYTES
    ) {
      throw new Error("Network lease marker is not a bounded ordinary file.")
    }
    let value: unknown
    try {
      value = JSON.parse(await readFile(markerPath, "utf8"))
    } catch (error) {
      throw new Error("Network lease marker is malformed.", { cause: error })
    }
    if (!isMarker(value)) {
      throw new Error("Network lease marker schema is invalid.")
    }
    const index = Number(path.basename(resolved))
    if (
      index !== value.subnetIndex ||
      index < 0 ||
      index >= NETWORK_POOL_SIZE
    ) {
      throw new Error("Network lease subnet index does not match its path.")
    }
    const expected = await this.buildLease(
      index,
      resolved,
      {
        allocationId: value.allocationId,
        uplink: value.uplink,
        dnsServers: value.dnsServers,
      },
      value,
    )
    if (JSON.stringify(toMarker(expected)) !== JSON.stringify(value)) {
      throw new Error(
        "Network lease marker does not match derived resource identity.",
      )
    }
    return expected
  }

  async release(lease: NetworkLease): Promise<void> {
    await this.withAllocationLock(async () => {
      const owned = await this.requireOwnedLease(lease.leaseDir)
      if (JSON.stringify(toMarker(owned)) !== JSON.stringify(toMarker(lease))) {
        throw new Error("Refusing to release a different network lease.")
      }
      const root = await this.getLeaseRoot()
      const releasing = path.join(
        root,
        `.peephole-net-releasing-${String(owned.index)}-${this.random(16).toString("hex")}`,
      )
      await rename(owned.leaseDir, releasing)
      await this.syncDirectory(root)
      await this.removePublishedMarkerDirectory(
        root,
        releasing,
        RELEASING_NAME_PATTERN,
      )
    })
  }

  async isLiveOwner(lease: NetworkLease): Promise<boolean> {
    return (await this.ownerLiveness(lease)).state === "LIVE"
  }

  async ownerLiveness(
    owner: Pick<
      NetworkLease,
      "creatorPid" | "creatorProcessStartTime" | "bootId"
    >,
  ): Promise<OwnerLivenessResult> {
    return this.classifyOwner({
      pid: owner.creatorPid,
      processStartTime: owner.creatorProcessStartTime,
      bootId: owner.bootId,
    })
  }

  async recoverAllocationLock(): Promise<void> {
    const root = await this.getLeaseRoot()
    await this.withAllocationLock(async () => {
      await this.recoverTemporaryDirectoriesUnlocked(root)
    })
  }

  private async recoverTemporaryDirectoriesUnlocked(
    root: string,
  ): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (TEMP_NAME_PATTERN.test(entry.name)) {
        await this.removeTemporary(root, path.join(root, entry.name))
      } else if (RELEASING_NAME_PATTERN.test(entry.name)) {
        await this.removePublishedMarkerDirectory(
          root,
          path.join(root, entry.name),
          RELEASING_NAME_PATTERN,
        )
      }
    }
  }

  private async listOwnedLeasesUnlocked(root: string): Promise<NetworkLease[]> {
    const leases: NetworkLease[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!LEASE_NAME_PATTERN.test(entry.name)) continue
      const index = Number(entry.name)
      if (index >= NETWORK_POOL_SIZE) {
        throw new Error(`Out-of-range Peephole network lease: ${entry.name}`)
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(
          `Peephole-shaped network lease is not an ordinary directory: ${entry.name}`,
        )
      }
      leases.push(await this.requireOwnedLease(path.join(root, entry.name)))
    }
    return leases
  }

  private async buildLease(
    index: number,
    leaseDir: string,
    options: {
      allocationId: string
      uplink: string
      dnsServers: readonly string[]
    },
    ownership?: Pick<
      NetworkLeaseMarker,
      "creatorPid" | "creatorProcessStartTime" | "bootId" | "createdAt"
    >,
  ): Promise<NetworkLease> {
    return {
      version: 1,
      ...toSubnet(index),
      ...deriveNetworkNames(options.allocationId, index),
      allocationId: options.allocationId,
      uplink: options.uplink,
      dnsServers: [...options.dnsServers],
      creatorPid: ownership?.creatorPid ?? process.pid,
      creatorProcessStartTime:
        ownership?.creatorProcessStartTime ??
        (await this.readProcessStartTime(process.pid)),
      bootId: ownership?.bootId ?? (await this.readBootId()),
      createdAt: ownership?.createdAt ?? this.now().toISOString(),
      leaseDir,
    }
  }

  private async removeTemporary(
    root: string,
    candidate: string,
  ): Promise<void> {
    if (
      path.dirname(path.resolve(candidate)) !== root ||
      !TEMP_NAME_PATTERN.test(path.basename(candidate))
    ) {
      throw new Error("Refusing to remove an unowned temporary network lease.")
    }
    const stats = await lstat(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      },
    )
    if (!stats) return
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (await realpath(candidate)) !== path.resolve(candidate)
    ) {
      throw new Error(
        "Temporary network lease is not an ordinary direct child.",
      )
    }
    const match = TEMP_NAME_PATTERN.exec(path.basename(candidate))
    const finalDir = path.join(root, match?.[1] ?? "")
    if (await pathExists(finalDir)) {
      throw new Error("Temporary and final network leases both exist.")
    }
    const entries = await readdir(candidate, { withFileTypes: true })
    if (
      entries.length > 1 ||
      (entries.length === 1 && entries[0]?.name !== MARKER_NAME)
    ) {
      throw new Error("Temporary network lease contains unexpected content.")
    }
    if (entries[0]) {
      const markerPath = path.join(candidate, MARKER_NAME)
      const marker = await lstat(markerPath)
      if (
        !marker.isFile() ||
        marker.isSymbolicLink() ||
        marker.size > MAX_MARKER_BYTES
      ) {
        throw new Error("Temporary network lease marker is unsafe.")
      }
      await rm(markerPath, { force: false })
    }
    await rmdir(candidate)
    await this.syncDirectory(root)
  }

  private async removePublishedMarkerDirectory(
    root: string,
    candidate: string,
    pattern: RegExp,
  ): Promise<void> {
    if (
      path.dirname(path.resolve(candidate)) !== root ||
      !pattern.test(path.basename(candidate))
    ) {
      throw new Error("Refusing to remove an unowned released network lease.")
    }
    const stats = await lstat(candidate)
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (await realpath(candidate)) !== path.resolve(candidate)
    ) {
      throw new Error("Released network lease path is unsafe.")
    }
    const entries = await readdir(candidate, { withFileTypes: true })
    if (
      entries.length !== 1 ||
      entries[0]?.name !== MARKER_NAME ||
      !entries[0].isFile()
    ) {
      throw new Error("Released network lease has unexpected content.")
    }
    const markerPath = path.join(candidate, MARKER_NAME)
    const marker = await lstat(markerPath)
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      marker.size > MAX_MARKER_BYTES
    ) {
      throw new Error("Released network lease marker is unsafe.")
    }
    let value: unknown
    try {
      value = JSON.parse(await readFile(markerPath, "utf8"))
    } catch (error) {
      throw new Error("Released network lease marker is malformed.", {
        cause: error,
      })
    }
    if (!isMarker(value)) {
      throw new Error("Released network lease marker schema is invalid.")
    }
    const match = pattern.exec(path.basename(candidate))
    const index = Number(match?.[1])
    const expected = await this.buildLease(
      index,
      path.join(root, String(index)),
      {
        allocationId: value.allocationId,
        uplink: value.uplink,
        dnsServers: value.dnsServers,
      },
      value,
    )
    if (JSON.stringify(toMarker(expected)) !== JSON.stringify(value)) {
      throw new Error("Released network lease marker identity is invalid.")
    }
    await rm(markerPath, { force: false })
    await rmdir(candidate)
    await this.syncDirectory(root)
  }

  private async withAllocationLock<T>(action: () => Promise<T>): Promise<T> {
    const root = await this.getLeaseRoot()
    const lockDir = path.join(root, LOCK_NAME)
    const deadline = this.now().getTime() + this.lockTimeoutMs
    const owner = await this.createLockOwner()
    let acquired = false
    let value!: T
    let actionError: unknown
    try {
      for (;;) {
        // Inspect a lock that was already present at the start of this
        // attempt before creating or publishing a candidate. The second
        // check below closes the normal contender race while the candidate
        // is being made durable.
        if (await pathExists(lockDir)) {
          await this.waitForOrRecoverPublishedLock(root, lockDir, deadline)
          continue
        }

        const temporaryDir = path.join(
          root,
          `.peephole-network-lock-allocating-${this.random(16).toString("hex")}`,
        )
        await this.createLockCandidate(temporaryDir, owner)

        // POSIX rename may replace an existing *empty* destination directory.
        // Inspect every already-present final lock before attempting publish,
        // so a legacy/corrupt markerless lock remains fail-closed instead of
        // being silently replaced by this complete candidate.
        if (await pathExists(lockDir)) {
          await this.removeExactLockDirectory(
            root,
            temporaryDir,
            owner,
            LOCK_TEMP_PATTERN,
          )
          await this.waitForOrRecoverPublishedLock(root, lockDir, deadline)
          continue
        }

        try {
          // With an absent destination, exactly one normal concurrent
          // candidate can publish. A loser inspects the winner below.
          await this.publishLockDirectory(temporaryDir, lockDir)
          acquired = true
          await this.syncDirectory(root)
          break
        } catch (error) {
          await this.removeExactLockDirectory(
            root,
            temporaryDir,
            owner,
            LOCK_TEMP_PATTERN,
          )
          if (!(await pathExists(lockDir))) {
            // The destination does not exist, yet the rename still failed --
            // e.g. Windows transiently refusing to complete a rename while a
            // directory that another candidate just vacated is still
            // settling. This is not real contention (no owner is published),
            // so retry within the same acquisition deadline instead of
            // failing the whole allocation outright.
            if (this.now().getTime() >= deadline) throw error
            await delay(10)
            continue
          }
          await this.waitForOrRecoverPublishedLock(
            root,
            lockDir,
            deadline,
            error,
          )
        }
      }
      await this.recoverLockResiduesUnlocked(root)
      value = await action()
    } catch (error) {
      actionError = error
    }
    let cleanupError: unknown
    if (acquired) {
      try {
        await this.quarantineFinalLock(root, lockDir, owner)
      } catch (error) {
        cleanupError = error
      }
    }
    if (actionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [actionError, cleanupError],
        "Network allocation and lock cleanup both failed.",
      )
    }
    if (cleanupError !== undefined) throw cleanupError
    if (actionError !== undefined) throw actionError
    return value
  }

  private async waitForOrRecoverPublishedLock(
    root: string,
    lockDir: string,
    deadline: number,
    cause?: unknown,
  ): Promise<void> {
    let currentOwner: LockOwner
    try {
      currentOwner = await this.readFinalLockOwner(root, lockDir)
    } catch (lockError) {
      if ((lockError as NodeJS.ErrnoException).code === "ENOENT") return
      throw lockError
    }
    const liveness = await this.classifyOwner(currentOwner)
    if (liveness.state === "STALE") {
      await this.quarantineFinalLock(root, lockDir, currentOwner)
      return
    }
    if (liveness.state === "UNKNOWN") {
      throw new Error(
        `Cannot determine network allocation lock liveness: ${liveness.reason}`,
        { cause },
      )
    }
    if (this.now().getTime() >= deadline) {
      throw new Error("Timed out waiting for live network allocation lock.", {
        cause,
      })
    }
    await delay(50)
  }

  private async createLockOwner(): Promise<LockOwner> {
    const bootId = await this.readBootId()
    const processStartTime = await this.readProcessStartTime(process.pid)
    if (bootId === null || processStartTime === null) {
      throw new Error(
        "Cannot publish network allocation lock without boot ID and process start time.",
      )
    }
    return {
      version: 1,
      pid: process.pid,
      processStartTime,
      bootId,
      createdAt: this.now().toISOString(),
    }
  }

  private async createLockCandidate(
    temporaryDir: string,
    owner: LockOwner,
  ): Promise<void> {
    await mkdir(temporaryDir, { mode: 0o700 })
    await writeDurableFile(
      path.join(temporaryDir, LOCK_OWNER_NAME),
      `${JSON.stringify(owner)}\n`,
    )
    await this.syncDirectory(temporaryDir)
  }

  private async readFinalLockOwner(
    root: string,
    lockDir: string,
  ): Promise<LockOwner> {
    if (
      path.dirname(lockDir) !== root ||
      path.basename(lockDir) !== LOCK_NAME
    ) {
      throw new Error("Network allocation lock path is outside its owned root.")
    }
    return this.readStrictLockOwner(root, lockDir, () => true)
  }

  private async readStrictLockOwner(
    root: string,
    candidate: string,
    nameMatches: (name: string) => boolean,
  ): Promise<LockOwner> {
    if (
      path.dirname(path.resolve(candidate)) !== root ||
      !nameMatches(path.basename(candidate))
    ) {
      throw new Error("Network allocation lock path is not strictly owned.")
    }
    try {
      return await this.readStrictLockOwnerUnlessVanished(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error
      // A losing acquisition candidate, or a holder releasing its lock, can
      // remove this exact directory at any point during a concurrent
      // reader's inspection. Depending on platform, that can surface here as
      // a shape-check failure rather than a clean ENOENT. Only treat it as a
      // vanish (safe to retry) if the path is now actually gone; a genuinely
      // malformed marker that is still there stays fail-closed.
      if (!(await pathExists(candidate))) {
        throw Object.assign(
          new Error("Network allocation lock vanished during inspection.", {
            cause: error,
          }),
          { code: "ENOENT" },
        )
      }
      throw error
    }
  }

  private async readStrictLockOwnerUnlessVanished(
    candidate: string,
  ): Promise<LockOwner> {
    const stats = await lstat(candidate)
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (await realpath(candidate)) !== path.resolve(candidate)
    ) {
      throw new Error("Network allocation lock is not an ordinary directory.")
    }
    const entries = await readdir(candidate, { withFileTypes: true })
    if (
      entries.length !== 1 ||
      entries[0]?.name !== LOCK_OWNER_NAME ||
      !entries[0].isFile()
    ) {
      throw new Error(
        "Network allocation lock must contain exactly one owner marker.",
      )
    }
    const markerPath = path.join(candidate, LOCK_OWNER_NAME)
    const markerStats = await lstat(markerPath)
    if (
      !markerStats.isFile() ||
      markerStats.isSymbolicLink() ||
      markerStats.size > MAX_LOCK_MARKER_BYTES
    ) {
      throw new Error("Network allocation lock owner marker is unsafe.")
    }
    let value: unknown
    try {
      value = JSON.parse(await readFile(markerPath, "utf8"))
    } catch (error) {
      throw new Error("Network allocation lock owner marker is malformed.", {
        cause: error,
      })
    }
    if (!isLockOwner(value)) {
      throw new Error("Network allocation lock owner schema is invalid.")
    }
    return value
  }

  private async classifyOwner(owner: {
    pid: number
    processStartTime: string | null
    bootId: string | null
  }): Promise<OwnerLivenessResult> {
    let currentBootId: string | null
    try {
      currentBootId = await this.readBootId()
    } catch {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "boot ID read failed",
      }
    }
    if (currentBootId === null || owner.bootId === null) {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "boot ID is unavailable",
      }
    }
    if (owner.bootId !== currentBootId) {
      return {
        state: "STALE",
        isCurrentProcess: false,
        reason: "owner belongs to a different boot",
      }
    }
    let processState: ProcessState
    try {
      processState = this.readProcessState(owner.pid)
    } catch {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "process existence check failed",
      }
    }
    if (processState === "MISSING") {
      return {
        state: "STALE",
        isCurrentProcess: false,
        reason: "owner PID does not exist",
      }
    }
    if (processState === "UNKNOWN") {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "process existence is unknown",
      }
    }
    if (owner.processStartTime === null) {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "recorded process start time is unavailable",
      }
    }
    let observedStartTime: string | null
    try {
      observedStartTime = await this.readProcessStartTime(owner.pid)
    } catch {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "process start time read failed",
      }
    }
    if (observedStartTime === null) {
      return {
        state: "UNKNOWN",
        isCurrentProcess: false,
        reason: "process start time cannot be read",
      }
    }
    if (observedStartTime !== owner.processStartTime) {
      return {
        state: "STALE",
        isCurrentProcess: false,
        reason: "PID was reused by another process",
      }
    }
    let currentStartTime: string | null = null
    if (owner.pid === process.pid) {
      try {
        currentStartTime = await this.readProcessStartTime(process.pid)
      } catch {
        return {
          state: "UNKNOWN",
          isCurrentProcess: false,
          reason: "current process start time read failed",
        }
      }
    }
    return {
      state: "LIVE",
      isCurrentProcess:
        owner.pid === process.pid &&
        currentStartTime !== null &&
        currentStartTime === owner.processStartTime,
      reason: "owner PID and process start time match",
    }
  }

  private async quarantineFinalLock(
    root: string,
    lockDir: string,
    expectedOwner: LockOwner,
  ): Promise<void> {
    const observed = await this.readFinalLockOwner(root, lockDir)
    assertSameLockOwner(observed, expectedOwner)
    const quarantine = path.join(
      root,
      `.peephole-network-lock-releasing-${this.random(16).toString("hex")}`,
    )
    await renameWithWindowsRetry(lockDir, quarantine)
    await this.syncDirectory(root)
    await this.removeExactLockDirectory(
      root,
      quarantine,
      expectedOwner,
      LOCK_RELEASING_PATTERN,
    )
  }

  private async removeExactLockDirectory(
    root: string,
    candidate: string,
    expectedOwner: LockOwner,
    pattern: RegExp,
  ): Promise<void> {
    const observed = await this.readStrictLockOwner(root, candidate, (name) =>
      pattern.test(name),
    )
    assertSameLockOwner(observed, expectedOwner)
    await rm(path.join(candidate, LOCK_OWNER_NAME), { force: false })
    await rmdir(candidate)
    await this.syncDirectory(root)
  }

  private async recoverLockResiduesUnlocked(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name)
      if (LOCK_TEMP_PATTERN.test(entry.name)) {
        await this.recoverLockCandidate(root, candidate, LOCK_TEMP_PATTERN)
      } else if (LOCK_RELEASING_PATTERN.test(entry.name)) {
        await this.recoverLockCandidate(root, candidate, LOCK_RELEASING_PATTERN)
      }
    }
  }

  private async recoverLockCandidate(
    root: string,
    candidate: string,
    pattern: RegExp,
  ): Promise<void> {
    if (path.dirname(path.resolve(candidate)) !== root) {
      throw new Error("Temporary network lock is outside its owned root.")
    }
    try {
      await this.recoverLockCandidateUnlessVanished(root, candidate, pattern)
    } catch (error) {
      // A losing acquisition candidate cleans up its own uniquely-named
      // temporary lock directory concurrently with any other process's
      // residue scan. Any failure here -- an fs ENOENT, or a shape check we
      // raised ourselves after the directory vanished mid-inspection (which
      // can surface as a plain mismatch rather than a thrown ENOENT,
      // depending on platform) -- only reflects a real fail-closed condition
      // if the candidate is still actually there; otherwise its owner
      // already reclaimed it and there is nothing left to recover.
      if (!(await pathExists(candidate))) return
      throw error
    }
  }

  private async recoverLockCandidateUnlessVanished(
    root: string,
    candidate: string,
    pattern: RegExp,
  ): Promise<void> {
    const stats = await lstat(candidate)
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (await realpath(candidate)) !== path.resolve(candidate)
    ) {
      throw new Error("Temporary network lock is not an ordinary directory.")
    }
    const entries = await readdir(candidate, { withFileTypes: true })
    const isPrepublication = LOCK_TEMP_PATTERN.test(path.basename(candidate))
    if (entries.length === 0) {
      await rmdir(candidate)
      await this.syncDirectory(root)
      return
    }
    let owner: LockOwner
    try {
      owner = await this.readStrictLockOwner(root, candidate, (name) =>
        pattern.test(name),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The candidate (or its owner marker) vanished while we were
        // inspecting it: its own live owner is concurrently reclaiming it
        // (or already has, in the losing side of an acquisition race).
        // Nothing left here for us to recover.
        return
      }
      // A strictly named pre-publication candidate has never been the global
      // lock and cannot own a lease or host resource. A crash can interrupt
      // owner.json itself, so a lone bounded ordinary marker is safe to
      // discard while holding the published lock. Unexpected content and
      // symlinks remain fail-closed.
      if (
        isPrepublication &&
        entries.length === 1 &&
        entries[0]?.name === LOCK_OWNER_NAME &&
        entries[0].isFile()
      ) {
        let marker: Awaited<ReturnType<typeof lstat>>
        try {
          marker = await lstat(path.join(candidate, LOCK_OWNER_NAME))
        } catch (innerError) {
          if ((innerError as NodeJS.ErrnoException).code === "ENOENT") return
          throw innerError
        }
        if (
          marker.isFile() &&
          !marker.isSymbolicLink() &&
          marker.size <= MAX_LOCK_MARKER_BYTES
        ) {
          try {
            await rm(path.join(candidate, LOCK_OWNER_NAME), { force: false })
            await rmdir(candidate)
            await this.syncDirectory(root)
          } catch (innerError) {
            if ((innerError as NodeJS.ErrnoException).code === "ENOENT") return
            throw innerError
          }
          return
        }
      }
      throw error
    }
    const liveness = await this.classifyOwner(owner)
    if (liveness.state !== "STALE") return
    await this.removeExactLockDirectory(root, candidate, owner, pattern)
  }
}

/** Backwards-compatible name; this is now a durable ownership manager. */
export { NetworkLeaseManager as SubnetAllocator }

export function toSubnet(index: number): AllocatedSubnet {
  if (!Number.isInteger(index) || index < 0 || index >= NETWORK_POOL_SIZE) {
    throw new Error("Invalid subnet index.")
  }
  const blockStart = index * 4
  const octet3 = Math.floor(blockStart / 256) % 256
  const octet4Base = blockStart % 256
  return {
    index,
    hostIp: `10.${BASE_OCTET_2}.${octet3}.${octet4Base + 1}`,
    peerIp: `10.${BASE_OCTET_2}.${octet3}.${octet4Base + 2}`,
    prefixLength: 30,
  }
}

export function deriveNetworkNames(
  allocationId: string,
  index: number,
): NetworkNames {
  assertAllocationId(allocationId)
  toSubnet(index)
  const suffix = String(index)
  return {
    namespace: `peephole-${suffix}`,
    hostVeth: `veph${suffix}`,
    peerVeth: `vpph${suffix}`,
    egressChain: `ppe${suffix}`,
    inputChain: `ppi${suffix}`,
    returnChain: `ppr${suffix}`,
    iptablesComment: `peephole-${allocationId}-${suffix}`,
  }
}

function toMarker(lease: NetworkLease): NetworkLeaseMarker {
  return {
    version: 1,
    subnetIndex: lease.index,
    allocationId: lease.allocationId,
    namespace: lease.namespace,
    hostVeth: lease.hostVeth,
    peerVeth: lease.peerVeth,
    hostIp: lease.hostIp,
    peerIp: lease.peerIp,
    prefixLength: lease.prefixLength,
    uplink: lease.uplink,
    egressChain: lease.egressChain,
    inputChain: lease.inputChain,
    returnChain: lease.returnChain,
    iptablesComment: lease.iptablesComment,
    dnsServers: [...lease.dnsServers],
    creatorPid: lease.creatorPid,
    creatorProcessStartTime: lease.creatorProcessStartTime,
    bootId: lease.bootId,
    createdAt: lease.createdAt,
  }
}

function isMarker(value: unknown): value is NetworkLeaseMarker {
  if (!value || typeof value !== "object") return false
  const marker = value as Record<string, unknown>
  const expectedKeys = [
    "allocationId",
    "bootId",
    "createdAt",
    "creatorPid",
    "creatorProcessStartTime",
    "dnsServers",
    "egressChain",
    "hostIp",
    "hostVeth",
    "inputChain",
    "iptablesComment",
    "namespace",
    "peerIp",
    "peerVeth",
    "prefixLength",
    "returnChain",
    "subnetIndex",
    "uplink",
    "version",
  ]
  return (
    Object.keys(marker).sort().join(",") === expectedKeys.sort().join(",") &&
    marker.version === 1 &&
    Number.isInteger(marker.subnetIndex) &&
    typeof marker.allocationId === "string" &&
    ALLOCATION_ID_PATTERN.test(marker.allocationId) &&
    typeof marker.namespace === "string" &&
    typeof marker.hostVeth === "string" &&
    typeof marker.peerVeth === "string" &&
    typeof marker.hostIp === "string" &&
    typeof marker.peerIp === "string" &&
    marker.prefixLength === 30 &&
    typeof marker.uplink === "string" &&
    INTERFACE_PATTERN.test(marker.uplink) &&
    typeof marker.egressChain === "string" &&
    typeof marker.inputChain === "string" &&
    typeof marker.returnChain === "string" &&
    typeof marker.iptablesComment === "string" &&
    Array.isArray(marker.dnsServers) &&
    marker.dnsServers.length > 0 &&
    marker.dnsServers.every(
      (ip) => typeof ip === "string" && isAllowedDnsServer(ip),
    ) &&
    new Set(marker.dnsServers).size === marker.dnsServers.length &&
    Number.isInteger(marker.creatorPid) &&
    Number(marker.creatorPid) > 0 &&
    (marker.creatorProcessStartTime === null ||
      typeof marker.creatorProcessStartTime === "string") &&
    (marker.bootId === null || typeof marker.bootId === "string") &&
    typeof marker.createdAt === "string"
  )
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false
  const owner = value as Record<string, unknown>
  return (
    owner.version === 1 &&
    Number.isInteger(owner.pid) &&
    Number(owner.pid) > 0 &&
    typeof owner.processStartTime === "string" &&
    owner.processStartTime.length > 0 &&
    typeof owner.bootId === "string" &&
    owner.bootId.length > 0 &&
    typeof owner.createdAt === "string"
  )
}

function assertSameLockOwner(actual: LockOwner, expected: LockOwner): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Network allocation lock owner changed unexpectedly.")
  }
}

function assertAllocationId(value: string): void {
  if (!ALLOCATION_ID_PATTERN.test(value)) {
    throw new Error(
      "Network allocation ID must be 32 lowercase hexadecimal characters.",
    )
  }
}

function isAllowedDnsServer(value: string): boolean {
  if (!isIPv4(value)) return false
  const firstOctet = Number(value.split(".")[0])
  return firstOctet !== 0 && firstOctet !== 127 && firstOctet < 224
}

async function writeDurableFile(
  candidate: string,
  contents: string,
): Promise<void> {
  const handle = await open(candidate, "wx", 0o600)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(candidate: string): Promise<void> {
  const handle = await open(candidate, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function defaultBootId(): Promise<string | null> {
  return readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then((value) => value.trim())
    .catch(() => null)
}

async function defaultProcessStartTime(pid: number): Promise<string | null> {
  return readFile(`/proc/${String(pid)}/stat`, "utf8")
    .then((value) => {
      const end = value.lastIndexOf(")")
      return end >= 0 ? (value.slice(end + 2).split(" ")[19] ?? null) : null
    })
    .catch(() => null)
}

function defaultProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0)
    return "EXISTS"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "MISSING"
    return "UNKNOWN"
  }
}

async function renameWithWindowsRetry(
  source: string,
  destination: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code === "EPERM" || code === "EACCES") && attempt < 20) {
        await delay(10)
        continue
      }
      throw error
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
