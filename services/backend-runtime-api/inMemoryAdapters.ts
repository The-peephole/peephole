import type { QueuedBackendRuntime } from "../../types/backendRuntime"
import type {
  BackendRuntimeQueue,
  BackendRuntimeQueueConsumer,
  BackendRuntimeQueueLease,
  BackendRuntimeStore,
  StoredBackendRuntime,
} from "./ports"

const ACTIVE_STATUSES = new Set([
  "queued",
  "fetching",
  "installing",
  "starting",
  "running",
  "stopping",
])

/** Test/local-dev only -- no durability across a process restart. */
export class InMemoryBackendRuntimeStore implements BackendRuntimeStore {
  private readonly runtimes = new Map<string, StoredBackendRuntime>()

  async get(runtimeId: string): Promise<StoredBackendRuntime | null> {
    return this.runtimes.get(runtimeId) ?? null
  }

  async getActiveByFingerprint(
    requesterId: string,
    fingerprint: string,
  ): Promise<StoredBackendRuntime | null> {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.requesterId === requesterId &&
        runtime.fingerprint === fingerprint &&
        runtime.orchestrationKey === null &&
        ACTIVE_STATUSES.has(runtime.status)
      ) {
        return runtime
      }
    }
    return null
  }

  async countActiveByRequester(requesterId: string): Promise<number> {
    let count = 0
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.requesterId === requesterId &&
        ACTIVE_STATUSES.has(runtime.status)
      ) {
        count += 1
      }
    }
    return count
  }

  async getActiveByOrchestrationKey(
    requesterId: string,
    orchestrationKey: string,
  ): Promise<StoredBackendRuntime | null> {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.requesterId === requesterId &&
        runtime.orchestrationKey === orchestrationKey &&
        ACTIVE_STATUSES.has(runtime.status)
      ) {
        return runtime
      }
    }
    return null
  }

  async create(runtime: StoredBackendRuntime): Promise<StoredBackendRuntime> {
    this.runtimes.set(runtime.id, runtime)
    return runtime
  }

  async update(
    runtimeId: string,
    update: (current: StoredBackendRuntime) => StoredBackendRuntime,
  ): Promise<StoredBackendRuntime> {
    const current = this.runtimes.get(runtimeId)
    if (!current) {
      throw new Error(`Backend runtime ${runtimeId} does not exist.`)
    }
    const next = update(current)
    this.runtimes.set(runtimeId, next)
    return next
  }
}

/** Test/local-dev only -- single-process FIFO, no cross-process leasing. */
export class InMemoryBackendRuntimeQueue
  implements BackendRuntimeQueue, BackendRuntimeQueueConsumer
{
  private readonly pending: QueuedBackendRuntime[] = []
  private readonly leased = new Map<
    string,
    { job: QueuedBackendRuntime; workerId: string; attempts: number }
  >()
  private readonly cancelled = new Set<string>()

  async enqueue(job: QueuedBackendRuntime): Promise<void> {
    this.pending.push(job)
  }

  async cancel(runtimeId: string): Promise<void> {
    this.cancelled.add(runtimeId)
  }

  async lease(workerId: string): Promise<BackendRuntimeQueueLease | null> {
    let next = this.pending.shift()
    while (next && this.cancelled.has(next.runtimeId)) {
      this.cancelled.delete(next.runtimeId)
      next = this.pending.shift()
    }
    if (!next) return null
    this.leased.set(next.runtimeId, { job: next, workerId, attempts: 1 })
    return { job: next, attempts: 1 }
  }

  async acknowledge(
    runtimeId: string,
    workerId: string,
    attempt: number,
  ): Promise<boolean> {
    const current = this.leased.get(runtimeId)
    if (
      !current ||
      current.workerId !== workerId ||
      current.attempts !== attempt
    ) {
      return false
    }
    this.leased.delete(runtimeId)
    return true
  }

  async release(
    runtimeId: string,
    workerId: string,
    _availableAt: Date,
    attempt: number,
  ): Promise<boolean> {
    const current = this.leased.get(runtimeId)
    if (
      !current ||
      current.workerId !== workerId ||
      current.attempts !== attempt
    ) {
      return false
    }
    this.leased.delete(runtimeId)
    this.pending.push(current.job)
    return true
  }

  async renew(
    runtimeId: string,
    workerId: string,
    attempt: number,
  ): Promise<boolean> {
    const current = this.leased.get(runtimeId)
    return Boolean(
      current && current.workerId === workerId && current.attempts === attempt,
    )
  }
}
