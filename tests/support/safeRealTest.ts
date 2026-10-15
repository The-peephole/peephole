/** Fixed test-only failure boundary. Never inspect/retain a caught exception:
 * assertion actual/expected, pg errors and process output may carry secrets. */
const FAILURE_CODES = [
  "REAL_SCENARIO_FAILED",
  "REAL_CLEANUP_FAILED",
  "REAL_SCENARIO_AND_CLEANUP_FAILED",
] as const
type FailureCode = (typeof FAILURE_CODES)[number]

export class SafeRealTestError extends Error {
  readonly code: FailureCode
  constructor(code: FailureCode) {
    const safe = FAILURE_CODES.includes(code) ? code : "REAL_SCENARIO_FAILED"
    super(safe)
    this.name = "SafeRealTestError"
    this.code = safe
    this.stack = undefined
  }
}

export function realTestFailure(
  scenario: boolean,
  cleanup: boolean,
): SafeRealTestError {
  return new SafeRealTestError(
    scenario && cleanup
      ? "REAL_SCENARIO_AND_CLEANUP_FAILED"
      : cleanup
        ? "REAL_CLEANUP_FAILED"
        : "REAL_SCENARIO_FAILED",
  )
}

export function safeRealTest(
  body: (
    cleanup: (action: () => Promise<unknown>) => Promise<boolean>,
  ) => Promise<unknown>,
): () => Promise<void> {
  return async () => {
    let scenarioFailed = false
    let cleanupFailed = false
    try {
      await body(async (action) => {
        try {
          await action()
          return true
        } catch {
          cleanupFailed = true
          return false
        }
      })
    } catch (error) {
      // Reconstruct even our own error; never propagate extra fields/cause.
      if (error instanceof SafeRealTestError) {
        scenarioFailed = error.code !== "REAL_CLEANUP_FAILED"
        cleanupFailed ||= error.code !== "REAL_SCENARIO_FAILED"
      } else scenarioFailed = true
    }
    if (scenarioFailed || cleanupFailed)
      throw realTestFailure(scenarioFailed, cleanupFailed)
  }
}
