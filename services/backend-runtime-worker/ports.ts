import type { BackendRuntimePlan } from "../../types/backendRuntime"
import type { LocalPreviewWorkspace } from "../preview-worker/local/localWorkspace"

/**
 * Internal-only network coordinates for dialing a *running* backend
 * runtime's sandbox from the host's own root network namespace -- never a
 * public backend URL/hostname (see D-030/D-031). `host` is always the
 * sandbox's `peerIp` on its ingress-only point-to-point veth link, `port`
 * is always the plan's own fixed, server-validated `internalPort`. This
 * type must never reach `types/backendRuntime.ts`'s public `BackendRuntime`
 * DTO, any backend-runtime HTTP response, or the extension's API client --
 * it is consumed only by trusted, same-process routing infrastructure.
 */
export interface BackendRuntimeDialTarget {
  readonly host: string
  readonly port: number
}

/**
 * A single supervised backend process inside its sandbox. Deliberately not
 * `CommandRunner`-shaped: that interface is "one command, wait for exit,
 * delete" (see RunscCommandRunner); this is "start, watch readiness, watch
 * for a crash, stop on demand" -- a different lifecycle that a one-shot
 * command runner cannot express.
 */
export interface RuntimeProcessHandle {
  /** Internal-only dial target for this specific running process -- see
   * `BackendRuntimeDialTarget`. Known as soon as the handle exists (the
   * sandbox's ingress-only namespace is already provisioned by then); it is
   * the caller's responsibility to only register it in a live-routing
   * registry once `waitUntilReady()` has actually succeeded. */
  readonly dialTarget: BackendRuntimeDialTarget
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
