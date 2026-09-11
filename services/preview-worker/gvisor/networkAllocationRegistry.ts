/**
 * Process-local lifecycle registry for published network leases.
 *
 * A lease is marked active before publication can begin and remains active
 * until normal teardown succeeds or gives up. Reconciliation and teardown use
 * the same per-allocation mutex so they can never mutate one lease together.
 */
export class NetworkAllocationRegistry {
  private readonly active = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()

  activate(allocationId: string): void {
    if (this.active.has(allocationId)) {
      throw new Error(`Network allocation ${allocationId} is already active.`)
    }
    this.active.add(allocationId)
  }

  deactivate(allocationId: string): void {
    this.active.delete(allocationId)
  }

  isActive(allocationId: string): boolean {
    return this.active.has(allocationId)
  }

  async runExclusive<T>(
    allocationId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(allocationId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(allocationId, tail)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.tails.get(allocationId) === tail) {
        this.tails.delete(allocationId)
      }
    }
  }
}
