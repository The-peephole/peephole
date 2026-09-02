import type {
  BuildPlan,
  CreatePreviewJobRequest,
  PreviewApiErrorCode,
  PreviewArtifactReference,
  PreviewJob,
  PreviewJobStatus,
  PreviewRepositoryRef,
} from "../../types/preview"
import { validateBuildPlan } from "./buildPlan"

const JOB_ID_PATTERN = /^[a-z\d-]{8,64}$/i
const MAX_RESPONSE_BYTES = 256 * 1024
const PREVIEW_STATUSES = new Set<PreviewJobStatus>([
  "queued",
  "fetching",
  "installing",
  "building",
  "publishing",
  "ready",
  "failed",
  "cancelled",
  "expired",
])
const API_ERROR_CODES = new Set<PreviewApiErrorCode>([
  "INVALID_REQUEST",
  "UNSUPPORTED_REPOSITORY",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "INVALID_TRANSITION",
  "INTERNAL_ERROR",
])

type PreviewClientErrorCode =
  PreviewApiErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE"

export class PreviewApiError extends Error {
  constructor(
    readonly code: PreviewClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "PreviewApiError"
  }
}

export interface PreviewRequestOptions {
  signal?: AbortSignal
}

export interface CreatePreviewRequestOptions extends PreviewRequestOptions {
  idempotencyKey?: string
}

export interface PreviewApi {
  create(
    request: CreatePreviewJobRequest,
    options?: CreatePreviewRequestOptions,
  ): Promise<PreviewJob>
  get(jobId: string, options?: PreviewRequestOptions): Promise<PreviewJob>
  cancel(jobId: string, options?: PreviewRequestOptions): Promise<PreviewJob>
}

export interface PreviewApiClientOptions {
  fetch?: typeof globalThis.fetch
  createIdempotencyKey?: () => string
}

export class PreviewApiClient implements PreviewApi {
  private readonly fetch: typeof globalThis.fetch
  private readonly createIdempotencyKey: () => string

  constructor(
    private readonly baseUrl: string,
    options: PreviewApiClientOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.createIdempotencyKey =
      options.createIdempotencyKey ?? (() => `preview-${crypto.randomUUID()}`)
  }

  async create(
    request: CreatePreviewJobRequest,
    options: CreatePreviewRequestOptions = {},
  ): Promise<PreviewJob> {
    const body = await this.request("v1/preview-jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key":
          options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    })

    if (!isObject(body) || typeof body.created !== "boolean") {
      throw invalidResponse()
    }

    return parsePreviewJob(body.job)
  }

  async get(
    jobId: string,
    options: PreviewRequestOptions = {},
  ): Promise<PreviewJob> {
    return parsePreviewJob(
      await this.request(`v1/preview-jobs/${validateJobId(jobId)}`, {
        method: "GET",
        signal: options.signal,
      }),
    )
  }

  async cancel(
    jobId: string,
    options: PreviewRequestOptions = {},
  ): Promise<PreviewJob> {
    return parsePreviewJob(
      await this.request(`v1/preview-jobs/${validateJobId(jobId)}`, {
        method: "DELETE",
        signal: options.signal,
      }),
    )
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response

    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        ...init,
        credentials: "omit",
        cache: "no-store",
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      throw new PreviewApiError(
        "NETWORK_ERROR",
        "The Peephole preview service could not be reached.",
      )
    }

    const body = await readJson(response)

    if (!response.ok) {
      throw parseErrorResponse(response, body)
    }

    return body
  }
}

function validateJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new PreviewApiError(
      "INVALID_RESPONSE",
      "The preview job id is invalid.",
    )
  }
  return jobId
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()

  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw invalidResponse()
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw invalidResponse()
  }
}

function parseErrorResponse(
  response: Response,
  body: unknown,
): PreviewApiError {
  const error = isObject(body) && isObject(body.error) ? body.error : null
  const retryAfter = response.headers.get("retry-after")
  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null

  return new PreviewApiError(
    error &&
      typeof error.code === "string" &&
      API_ERROR_CODES.has(error.code as PreviewApiErrorCode)
      ? (error.code as PreviewApiErrorCode)
      : "INTERNAL_ERROR",
    error && typeof error.message === "string"
      ? error.message
      : "The preview service could not complete the request.",
    response.status,
    Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : null,
  )
}

function parsePreviewJob(value: unknown): PreviewJob {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !JOB_ID_PATTERN.test(value.id) ||
    !isRepositoryRef(value.repository) ||
    !isBuildPlan(value.plan) ||
    !sameRepository(value.repository, value.plan.repository) ||
    typeof value.cacheKey !== "string" ||
    (value.cacheStatus !== "hit" && value.cacheStatus !== "miss") ||
    typeof value.status !== "string" ||
    !PREVIEW_STATUSES.has(value.status as PreviewJobStatus) ||
    !isArtifact(value.artifact) ||
    (typeof value.errorCode !== "string" && value.errorCode !== null) ||
    (typeof value.errorMessage !== "string" && value.errorMessage !== null) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw invalidResponse()
  }

  return value as unknown as PreviewJob
}

function isRepositoryRef(value: unknown): value is PreviewRepositoryRef {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.repositoryId) &&
    typeof value.owner === "string" &&
    typeof value.name === "string" &&
    typeof value.commitSha === "string"
  )
}

function isBuildPlan(value: unknown): value is BuildPlan {
  const hasShape =
    isObject(value) &&
    typeof value.contractVersion === "string" &&
    isRepositoryRef(value.repository) &&
    value.sourceRoot === "." &&
    typeof value.packageManager === "string" &&
    (typeof value.installCommand === "string" ||
      value.installCommand === null) &&
    (typeof value.buildCommand === "string" || value.buildCommand === null) &&
    typeof value.outputDirectory === "string"

  if (!hasShape) {
    return false
  }

  try {
    validateBuildPlan(value as unknown as BuildPlan)
    return true
  } catch {
    return false
  }
}

function sameRepository(
  left: PreviewRepositoryRef,
  right: PreviewRepositoryRef,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.commitSha.toLowerCase() === right.commitSha.toLowerCase()
  )
}

function isArtifact(value: unknown): value is PreviewArtifactReference | null {
  return (
    value === null ||
    (isObject(value) &&
      typeof value.url === "string" &&
      typeof value.expiresAt === "string")
  )
}

function invalidResponse(): PreviewApiError {
  return new PreviewApiError(
    "INVALID_RESPONSE",
    "The preview service returned an invalid response.",
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
