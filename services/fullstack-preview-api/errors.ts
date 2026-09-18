import type { FullStackPreviewApiErrorCode } from "../../types/fullstackPreview"

export class FullStackPreviewControlError extends Error {
  constructor(
    readonly code: FullStackPreviewApiErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "FullStackPreviewControlError"
  }
}
