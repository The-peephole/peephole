import type {
  PreviewQueueConsumer,
  PreviewQueueLease,
} from "../preview-api/ports"
import type { QueuedPreviewJob } from "../../types/preview"
import type { PreviewJobRunOptions } from "./worker"

export interface PreviewJobExecutor {
  run(job: QueuedPreviewJob, options?: PreviewJobRunOptions): Promise<void>
}

export interface PreviewWorkerLoopOptions {
  workerId: string
  leaseMs?: number
  pollIntervalMs?: number
  retryDelayMs?: number
  maxAttempts?: number
  now?: () => Date
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  onError?: (error: unknown) => void
}

const DEFAULT_LEASE_MS = 210_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_RETRY_DELAY_MS = 5_000

/**
 * Bridges a durable queue to PreviewJobWorker without coupling either side to
 * PostgreSQL. PreviewJobWorker owns job-state failures; this loop only retries
 * unexpected process/infrastructure failures that escape the worker.
 */
export class PreviewWorkerLoop {
  private readonly workerId: string
  private readonly leaseMs: number
  private readonly pollIntervalMs: number
  private readonly retryDelayMs: number
  private readonly maxAttempts: number
  private readonly now: () => Date
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>
  private readonly onError: (error: unknown) => void

  constructor(
    private readonly queue: PreviewQueueConsumer,
    private readonly worker: PreviewJobExecutor,
    options: PreviewWorkerLoopOptions,
  ) {
    this.workerId = validateWorkerId(options.workerId)
    this.maxAttempts = validateDuration(
      "maxAttempts",
      options.maxAttempts ?? 3,
      1,
      100,
    )
    this.leaseMs = validateDuration(
      "leaseMs",
      options.leaseMs ?? DEFAULT_LEASE_MS,
      1_000,
      900_000,
    )
    this.pollIntervalMs = validateDuration(
      "pollIntervalMs",
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      10,
      60_000,
    )
    this.retryDelayMs = validateDuration(
      "retryDelayMs",
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      0,
      60_000,
    )
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitForAbortableDelay
    this.onError = options.onError ?? (() => undefined)
  }

  /** Returns true when a queue item was leased, including a released retry. */
  async runOnce(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const lease = await this.queue.lease(
      this.workerId,
      this.now(),
      this.leaseMs,
    )

    if (!lease) {
      return false
    }

    await this.executeLease(lease, signal)
    return true
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const processed = await this.runOnce(signal)

        if (processed) {
          continue
        }
      } catch (error) {
        this.onError(error)
      }

      if (!signal.aborted) {
        await this.wait(this.pollIntervalMs, signal)
      }
    }
  }

  private async executeLease(
    lease: PreviewQueueLease,
    shutdown?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    const signal = shutdown
      ? AbortSignal.any([shutdown, controller.signal])
      : controller.signal
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<void> | undefined
    const renew = async () => {
      try {
        if (
          !(await this.queue.renew(
            lease.job.jobId,
            this.workerId,
            lease.attempts,
            this.leaseMs,
          ))
        )
          controller.abort()
      } catch (error) {
        this.onError(error)
        controller.abort()
      }
      if (!stopped && !signal.aborted) schedule()
    }
    const schedule = () => {
      timer = setTimeout(
        () => {
          renewal = renew()
        },
        Math.floor(this.leaseMs / 3),
      )
      timer.unref()
    }
    schedule()
    try {
      await this.worker.run(lease.job, {
        signal,
        recovered: lease.attempts > 1,
        abandon: lease.attempts > this.maxAttempts,
      })
      await this.queue.acknowledge(
        lease.job.jobId,
        this.workerId,
        lease.attempts,
      )
    } catch (error) {
      const availableAt = new Date(this.now().getTime() + this.retryDelayMs)
      await this.queue
        .release(lease.job.jobId, this.workerId, availableAt, lease.attempts)
        .catch((releaseError) => {
          this.onError(releaseError)
        })
      throw error
    } finally {
      stopped = true
      clearTimeout(timer)
      await renewal
    }
  }
}

function validateWorkerId(workerId: string): string {
  if (!/^[a-z\d][a-z\d._-]{0,127}$/i.test(workerId)) {
    throw new Error("Preview worker id is invalid.")
  }

  return workerId
}

function validateDuration(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Preview worker ${name} must be between ${minimum} and ${maximum} milliseconds.`,
    )
  }

  return value
}

function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds)

    function finish() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }

    signal.addEventListener("abort", finish, { once: true })
  })
}
