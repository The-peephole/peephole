export interface HasRemainingBudget {
  remainingMs(): number
}

export function assertTimeRemaining(workspace: HasRemainingBudget): void {
  if (workspace.remainingMs() <= 0) {
    throw new Error("Preview job exceeded its total time budget.")
  }
}

/**
 * Never exceeds the job's remaining wall-clock budget, even if the
 * per-command cap would otherwise allow more time. This is what makes the
 * total job timeout something HostCommandRunner/RunscCommandRunner actually
 * enforce by killing the process, rather than something the control plane
 * only notices after the fact.
 */
export function effectiveTimeoutMs(
  workspace: HasRemainingBudget,
  configuredTimeoutMs: number,
): number {
  return Math.max(1, Math.min(configuredTimeoutMs, workspace.remainingMs()))
}
