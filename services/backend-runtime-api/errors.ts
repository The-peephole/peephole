import type { BackendRuntimeApiErrorCode } from "../../types/backendRuntime"

export class BackendRuntimeControlError extends Error {
  constructor(
    readonly code: BackendRuntimeApiErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "BackendRuntimeControlError"
  }
}
