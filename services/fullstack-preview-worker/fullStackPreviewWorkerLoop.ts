import type { QueuedFullStackPreview } from "../../types/fullstackPreview"
import type {
  FullStackPreviewQueueConsumer,
  FullStackPreviewQueueLease,
} from "../fullstack-preview-api/ports"
import type { FullStackPreviewRunOptions } from "./fullStackPreviewSupervisor"

export interface FullStackPreviewExecutor {
  run(
    preview: QueuedFullStackPreview,
    options?: FullStackPreviewRunOptions,
  ): Promise<void>
}

export interface FullStackPreviewWorkerLoopOptions {
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

/** Durable, attempt-fenced lease owner for the orchestration supervisor. */
export class FullStackPreviewWorkerLoop {
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
    private readonly queue: FullStackPreviewQueueConsumer,
    private readonly worker: FullStackPreviewExecutor,
    options: FullStackPreviewWorkerLoopOptions,
  ) {
    this.workerId = validateWorkerId(options.workerId)
    this.leaseMs = validateInteger(
      "leaseMs",
      options.leaseMs ?? DEFAULT_LEASE_MS,
      1_000,
      900_000,
    )
    this.pollIntervalMs = validateInteger(
      "pollIntervalMs",
      options.pollIntervalMs ?? 1_000,
      10,
      60_000,
    )
    this.retryDelayMs = validateInteger(
      "retryDelayMs",
      options.retryDelayMs ?? 5_000,
      0,
      60_000,
    )
    this.maxAttempts = validateInteger(
      "maxAttempts",
      options.maxAttempts ?? 3,
      1,
      100,
    )
    this.now = options.now ?? (() => new Date())
    this.wait = options.wait ?? waitForAbortableDelay
    this.onError = options.onError ?? (() => undefined)
  }

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const lease = await this.queue.lease(
      this.workerId,
      this.now(),
      this.leaseMs,
    )
    if (!lease) return false
    await this.executeLease(lease, signal)
    return true
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (await this.runOnce(signal)) continue
      } catch (error) {
        this.onError(error)
      }
      if (!signal.aborted) await this.wait(this.pollIntervalMs, signal)
    }
  }

  private async executeLease(
    lease: FullStackPreviewQueueLease,
    shutdown?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    const signal = shutdown
      ? AbortSignal.any([shutdown, controller.signal])
      : controller.signal
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<void> | undefined
    const schedule = () => {
      timer = setTimeout(
        () => {
          renewal = renew()
        },
        Math.floor(this.leaseMs / 3),
      )
      timer.unref()
    }
    const renew = async () => {
      try {
        if (
          !(await this.queue.renew(
            lease.preview.previewId,
            this.workerId,
            lease.attempts,
            this.leaseMs,
          ))
        ) {
          controller.abort(new Error("Full-stack preview lease was lost."))
        }
      } catch (error) {
        this.onError(error)
        controller.abort(error)
      }
      if (!stopped && !signal.aborted) schedule()
    }
    schedule()
    try {
      await this.worker.run(lease.preview, {
        signal,
        recovered: lease.attempts > 1,
        abandon: lease.attempts > this.maxAttempts,
      })
      await this.queue.acknowledge(
        lease.preview.previewId,
        this.workerId,
        lease.attempts,
      )
    } catch (error) {
      await this.queue
        .release(
          lease.preview.previewId,
          this.workerId,
          new Date(this.now().getTime() + this.retryDelayMs),
          lease.attempts,
        )
        .catch(this.onError)
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
    throw new Error("Full-stack preview worker id is invalid.")
  }
  return workerId
}

function validateInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Full-stack preview worker ${name} must be between ${minimum} and ${maximum} milliseconds.`,
    )
  }
  return value
}

function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
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
