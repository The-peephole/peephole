import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../services/preview-worker/gvisor/processRunner"
import { runscKillArgs } from "../../services/preview-worker/gvisor/runscCli"

/** Test-only gate at the runtime's awaited ProcessRunner.run boundary.
 * The host kill command has NOT started while held. After release the real
 * runner receives the original arguments/options and supplies the result.
 * This does not claim a kernel signal syscall is suspended in flight. */
export class PendingSignalProcessRunner implements ProcessRunner {
  private readonly entered = Promise.withResolvers<void>()
  private readonly gate = Promise.withResolvers<void>()
  private expectedArgs: string[] | null = null
  private reached = false
  private released = false
  delegated = false
  signalResult: ProcessRunResult | null = null

  constructor(
    private readonly inner: ProcessRunner,
    private readonly runscRootDir: string,
  ) {}

  arm(containerId: string): void {
    if (this.expectedArgs) throw new Error("Signal boundary is already armed.")
    this.expectedArgs = runscKillArgs(
      { runscRootDir: this.runscRootDir },
      containerId,
      "SIGTERM",
    )
  }

  get pending(): boolean {
    return this.reached && !this.released
  }

  async waitUntilPending(timeoutMs = 10_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // A liveness deadline, never a sleep used to arrange the interleaving.
      await Promise.race([
        this.entered.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Pending signal boundary was not reached.")),
            timeoutMs,
          )
        }),
      ])
      if (!this.pending)
        throw new Error("Signal boundary is no longer pending.")
    } finally {
      clearTimeout(timer)
    }
  }

  /** Also safe before entry: failing scenarios must not deadlock cleanup. */
  release(): void {
    this.released = true
    this.gate.resolve()
  }

  async run(
    command: string,
    args: string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    if (
      command !== "runsc" ||
      !this.expectedArgs ||
      args.length !== this.expectedArgs.length ||
      args.some((arg, index) => arg !== this.expectedArgs![index])
    ) {
      return this.inner.run(command, args, options)
    }
    if (this.reached) throw new Error("Signal boundary was entered twice.")
    this.reached = true
    this.entered.resolve()
    await this.gate.promise
    this.delegated = true
    this.signalResult = await this.inner.run(command, args, options)
    return this.signalResult
  }
}
