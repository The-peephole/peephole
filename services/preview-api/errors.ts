import type { PreviewApiErrorCode } from "../../types/preview"

export type { PreviewApiErrorCode } from "../../types/preview"

export class PreviewControlError extends Error {
  constructor(
    readonly code: PreviewApiErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "PreviewControlError"
  }
}
