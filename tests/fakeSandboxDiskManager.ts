import { randomBytes } from "node:crypto"
import { mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"

import type {
  CreateSandboxDiskAllocationOptions,
  MountSandboxDiskOptions,
  SandboxDiskAllocation,
  SandboxDiskHandle,
  SandboxDiskManager,
} from "../services/preview-worker/gvisor/sandboxDisk"

/** Directory-backed unit-test substitute. Real loop/ext4 behavior is covered
 * only by the opt-in Linux/gVisor suites. */
export class FakeSandboxDiskManager implements SandboxDiskManager {
  readonly allocations = new Map<string, SandboxDiskAllocation>()
  readonly destroyed: string[] = []
  readonly createOptions: CreateSandboxDiskAllocationOptions[] = []
  readonly reservationUpdates: number[] = []

  constructor(private readonly bundlesRootDir: string) {}

  async getBundlesRootDir(): Promise<string> {
    return realpath(this.bundlesRootDir)
  }

  async createAllocation(
    options: CreateSandboxDiskAllocationOptions,
  ): Promise<SandboxDiskAllocation> {
    this.createOptions.push(options)
    const allocationId = randomBytes(16).toString("hex")
    const bundleDir = path.join(this.bundlesRootDir, `peephole-${allocationId}`)
    const allocation = {
      allocationId,
      bundleDir,
      imagePath: path.join(bundleDir, "workspace.img"),
      mountpoint: path.join(bundleDir, "workspace"),
    }
    await mkdir(bundleDir, { recursive: true })
    this.allocations.set(bundleDir, allocation)
    return allocation
  }

  async mountWorkspace(
    allocation: SandboxDiskAllocation,
    options: MountSandboxDiskOptions,
  ): Promise<SandboxDiskHandle> {
    void options
    await mkdir(allocation.mountpoint, { recursive: true })
    return {
      rootDir: allocation.mountpoint,
      hardLimitBytes: 1024 * 1024 * 1024,
      isExhausted: async () => false,
    }
  }

  async updateReservedOutsideBytes(
    allocation: SandboxDiskAllocation,
    remainingOutsideBytes: number,
  ): Promise<void> {
    void allocation
    this.reservationUpdates.push(remainingOutsideBytes)
  }

  async readOwnedAllocation(
    bundleDir: string,
  ): Promise<SandboxDiskAllocation | null> {
    return this.allocations.get(bundleDir) ?? null
  }

  async listOwnedAllocations(): Promise<SandboxDiskAllocation[]> {
    return Array.from(this.allocations.values())
  }

  async destroyAllocation(allocation: SandboxDiskAllocation): Promise<void> {
    await rm(allocation.bundleDir, { recursive: true, force: true })
    this.allocations.delete(allocation.bundleDir)
    this.destroyed.push(allocation.bundleDir)
  }

  async recoverAllocationLock(): Promise<void> {}
}
