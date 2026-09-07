import { mkdir, rmdir } from "node:fs/promises"
import path from "node:path"

const POOL_SIZE = 16_384 // 10.200.0.0/16, one /30 per slot
const BASE_OCTET_2 = 200

export interface AllocatedSubnet {
  readonly index: number
  /** The veth end left in the root namespace. */
  readonly hostIp: string
  /** The veth end moved into the job's namespace. */
  readonly peerIp: string
  readonly prefixLength: number
}

/**
 * A minimal file-based IPAM: each slot's reservation is a directory whose
 * atomic, non-recursive creation (EEXIST on conflict) is the lock, so
 * concurrent worker processes on the same host never hand out the same
 * /30 twice. Slots are only ever leaked by a crash between allocate() and
 * a job actually creating its namespace -- nothing here reclaims those
 * yet (see IMPLEMENTATION_CHECKLIST.md).
 */
export class SubnetAllocator {
  constructor(private readonly leaseDir = "/var/run/peephole/net-leases") {}

  async allocate(): Promise<AllocatedSubnet> {
    await mkdir(this.leaseDir, { recursive: true })
    const start = Math.floor(Math.random() * POOL_SIZE)

    for (let attempt = 0; attempt < POOL_SIZE; attempt++) {
      const index = (start + attempt) % POOL_SIZE
      try {
        await mkdir(path.join(this.leaseDir, String(index)))
        return toSubnet(index)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }

    throw new Error("No free sandbox network subnet available.")
  }

  async release(index: number): Promise<void> {
    await rmdir(path.join(this.leaseDir, String(index))).catch(() => undefined)
  }
}

function toSubnet(index: number): AllocatedSubnet {
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
