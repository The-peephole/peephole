export type PreviewApiErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_REPOSITORY"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_TRANSITION"
  | "INTERNAL_ERROR"

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
