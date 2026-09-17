import type { BackendRuntimePlan } from "../../types/backendRuntime"
import type { LocalPreviewWorkspace } from "../preview-worker/local/localWorkspace"

/**
 * A single supervised backend process inside its sandbox. Deliberately not
 * `CommandRunner`-shaped: that interface is "one command, wait for exit,
 * delete" (see RunscCommandRunner); this is "start, watch readiness, watch
 * for a crash, stop on demand" -- a different lifecycle that a one-shot
 * command runner cannot express.
 */
export interface RuntimeProcessHandle {
  /**
   * Polls until the backend accepts a TCP connection on its assigned
   * internal port, or throws once the process exits first (a startup
   * crash) or once `timeoutMs` elapses (a readiness timeout). Never treats
   * an application-level response (e.g. a `/health` route) as required --
   * only a bare TCP accept, since `express-node-npm-v1` is the only
   * supported adapter and nothing about this contract may depend on
   * fixture-specific routes.
   */
  waitUntilReady(timeoutMs: number): Promise<void>
  /** Resolves once the process has exited on its own (a crash) or after
   * `stop()` has fully torn it down. Also performs this handle's runsc
   * container deletion exactly once, whichever path reaches it first. */
  waitForExit(): Promise<{ exitCode: number | null }>
  /** Idempotent: signals the process to stop, waits for it to exit, then
   * deletes its runsc container. Safe to call after the process has
   * already exited on its own. */
  stop(): Promise<void>
}

export interface BackendRuntimeProcessStarter {
  /**
   * Starts exactly one backend process for `plan` inside `workspace`'s own
   * ingress-only network namespace. Must never be called with a plan whose
   * `contractVersion`/`adapterId` this starter does not recognize -- that
   * revalidation is the caller's (the control plane's) responsibility, not
   * this primitive's.
   */
  start(
    workspace: LocalPreviewWorkspace,
    plan: BackendRuntimePlan,
  ): Promise<RuntimeProcessHandle>
}
