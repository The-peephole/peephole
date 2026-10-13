import {
  FULLSTACK_PREVIEW_CONTRACT_VERSION,
  type CreateFullStackPreviewRequest,
  type FullStackPreview,
  type FullStackPreviewApiErrorCode,
  type FullStackPreviewErrorCode,
  type FullStackPreviewStatus,
} from "../../types/fullstackPreview"
import type { PreviewRepositoryRef } from "../../types/preview"
import type { UserEnvironmentEntry } from "../../types/userEnvironment"
import { isSafePreviewSourceRoot } from "../preview/sourceRoot"
import type { StoredPreviewSession } from "../preview/sessionStorage"

const FULLSTACK_ID_PATTERN =
  /^fullstack-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const MAX_RESPONSE_BYTES = 256 * 1024
const SESSION_EXPIRY_SKEW_MS = 5_000
const PREVIEW_STATUSES = new Set<FullStackPreviewStatus>([
  "queued",
  "building_frontend",
  "starting_backend",
  "awaiting_activation",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "cancelled",
  "expired",
])
const PREVIEW_ERROR_CODES = new Set<FullStackPreviewErrorCode>([
  "UNSUPPORTED_FRONTEND",
  "UNSUPPORTED_BACKEND",
  "FRONTEND_FAILED",
  "BACKEND_FAILED",
  "PROVISIONING_TIMEOUT",
  "ORCHESTRATION_UNAVAILABLE",
  "CONFIGURATION_UNAVAILABLE",
])
const API_ERROR_CODES = new Set<FullStackPreviewApiErrorCode>([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "UNSUPPORTED_FRONTEND",
  "UNSUPPORTED_BACKEND",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "INVALID_TRANSITION",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL_ERROR",
])

type FullStackPreviewClientErrorCode =
  FullStackPreviewApiErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE"

export class FullStackPreviewApiError extends Error {
  constructor(
    readonly code: FullStackPreviewClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "FullStackPreviewApiError"
  }
}

export interface FullStackPreviewRequestOptions {
  signal?: AbortSignal
}

export interface CreateFullStackPreviewRequestOptions extends FullStackPreviewRequestOptions {
  idempotencyKey?: string
}

export interface FullStackPreviewApi {
  create(
    request: CreateFullStackPreviewRequest,
    options?: CreateFullStackPreviewRequestOptions,
  ): Promise<FullStackPreview>
  get(
    previewId: string,
    options?: FullStackPreviewRequestOptions,
  ): Promise<FullStackPreview>
  stop(
    previewId: string,
    options?: FullStackPreviewRequestOptions,
  ): Promise<FullStackPreview>
}

export interface FullStackPreviewApiClientOptions {
  fetch?: typeof globalThis.fetch
  createIdempotencyKey?: () => string
  getSession?: () =>
    | StoredPreviewSession
    | null
    | undefined
    | Promise<StoredPreviewSession | null | undefined>
  clearSession?: () => void | Promise<void>
}

export class FullStackPreviewApiClient implements FullStackPreviewApi {
  private readonly fetch: typeof globalThis.fetch
  private readonly createIdempotencyKey: () => string
  private readonly getSession: () => Promise<
    StoredPreviewSession | null | undefined
  >
  private readonly clearSession: () => Promise<void>

  constructor(
    private readonly baseUrl: string,
    options: FullStackPreviewApiClientOptions = {},
  ) {
    this.fetch = (options.fetch ?? globalThis.fetch).bind(globalThis)
    this.createIdempotencyKey =
      options.createIdempotencyKey ??
      (() => `fullstack-request-${crypto.randomUUID()}`)
    this.getSession = async () => options.getSession?.()
    this.clearSession = async () => {
      await options.clearSession?.()
    }
  }

  async create(
    request: CreateFullStackPreviewRequest,
    options: CreateFullStackPreviewRequestOptions = {},
  ): Promise<FullStackPreview> {
    const body = await this.request("v1/fullstack-previews", {
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

    const preview = parseFullStackPreview(body.preview)
    if (
      !sameRepository(preview.repository, request.repository) ||
      preview.frontendSourceRoot !== request.frontendTarget.sourceRoot ||
      preview.backendSourceRoot !== request.backendSourceRoot
    ) {
      throw invalidResponse()
    }
    return preview
  }

  async get(
    previewId: string,
    options: FullStackPreviewRequestOptions = {},
  ): Promise<FullStackPreview> {
    const validatedId = validateFullStackPreviewId(previewId)
    const preview = parseFullStackPreview(
      await this.request(`v1/fullstack-previews/${validatedId}`, {
        method: "GET",
        signal: options.signal,
      }),
    )
    if (preview.id.toLowerCase() !== validatedId.toLowerCase()) {
      throw invalidResponse()
    }
    return preview
  }

  async stop(
    previewId: string,
    options: FullStackPreviewRequestOptions = {},
  ): Promise<FullStackPreview> {
    const validatedId = validateFullStackPreviewId(previewId)
    const preview = parseFullStackPreview(
      await this.request(`v1/fullstack-previews/${validatedId}`, {
        method: "DELETE",
        signal: options.signal,
      }),
    )
    if (preview.id.toLowerCase() !== validatedId.toLowerCase()) {
      throw invalidResponse()
    }
    return preview
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const sessionToken = await this.getSessionToken()
    let response: Response

    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        ...init,
        credentials: "omit",
        cache: "no-store",
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${sessionToken}`,
        },
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new FullStackPreviewApiError(
        "NETWORK_ERROR",
        "The Peephole full-stack preview service could not be reached.",
      )
    }

    const body = await readJson(response)
    if (response.status === 401) await this.clearSession()
    if (!response.ok) throw parseErrorResponse(response, body)
    return body
  }

  private async getSessionToken(): Promise<string> {
    const session = await this.getSession()
    const expiresAtMs = session ? Date.parse(session.expiresAt) : Number.NaN
    if (
      !session?.token ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= Date.now() + SESSION_EXPIRY_SKEW_MS
    ) {
      await this.clearSession()
      throw new FullStackPreviewApiError(
        "UNAUTHORIZED",
        "Connect GitHub to run a full-stack preview.",
      )
    }
    return session.token
  }
}

function validateFullStackPreviewId(previewId: string): string {
  if (!FULLSTACK_ID_PATTERN.test(previewId)) throw invalidResponse()
  return previewId
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
): FullStackPreviewApiError {
  const error = isObject(body) && isObject(body.error) ? body.error : null
  const retryAfter = response.headers.get("retry-after")
  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null

  return new FullStackPreviewApiError(
    error &&
      typeof error.code === "string" &&
      API_ERROR_CODES.has(error.code as FullStackPreviewApiErrorCode)
      ? (error.code as FullStackPreviewApiErrorCode)
      : "INTERNAL_ERROR",
    error && typeof error.message === "string"
      ? error.message
      : "The full-stack preview service could not complete the request.",
    response.status,
    Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : null,
  )
}

function parseFullStackPreview(value: unknown): FullStackPreview {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !FULLSTACK_ID_PATTERN.test(value.id) ||
    !isRepositoryRef(value.repository) ||
    typeof value.frontendSourceRoot !== "string" ||
    !isSafePreviewSourceRoot(value.frontendSourceRoot) ||
    typeof value.backendSourceRoot !== "string" ||
    !isSafePreviewSourceRoot(value.backendSourceRoot) ||
    typeof value.status !== "string" ||
    !PREVIEW_STATUSES.has(value.status as FullStackPreviewStatus) ||
    (typeof value.url !== "string" && value.url !== null) ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== "string" ||
        !PREVIEW_ERROR_CODES.has(
          value.errorCode as FullStackPreviewErrorCode,
        ))) ||
    (typeof value.errorMessage !== "string" && value.errorMessage !== null) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt) ||
    !isIsoDate(value.expiresAt)
  ) {
    throw invalidResponse()
  }
  if (value.status === "ready" && value.url === null) throw invalidResponse()
  if (
    [
      "queued",
      "building_frontend",
      "starting_backend",
      "awaiting_activation",
    ].includes(value.status) &&
    value.url !== null
  ) {
    throw invalidResponse()
  }
  return value as unknown as FullStackPreview
}

function isRepositoryRef(value: unknown): value is PreviewRepositoryRef {
  return (
    isObject(value) &&
    typeof value.repositoryId === "number" &&
    Number.isSafeInteger(value.repositoryId) &&
    value.repositoryId > 0 &&
    typeof value.owner === "string" &&
    /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/.test(value.owner) &&
    typeof value.name === "string" &&
    /^[A-Za-z\d_.-]+$/.test(value.name) &&
    typeof value.commitSha === "string" &&
    /^[a-f\d]{40}$/i.test(value.commitSha)
  )
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

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function invalidResponse(): FullStackPreviewApiError {
  return new FullStackPreviewApiError(
    "INVALID_RESPONSE",
    "The full-stack preview service returned an invalid response.",
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function createFullStackPreviewRequest(input: {
  repository: PreviewRepositoryRef
  frontendSourceRoot: string
  backendSourceRoot: string
  /** M12: sent only when non-empty, so requests for backends without
   * user-provided configuration are byte-for-byte unchanged. */
  userEnvironment?: readonly UserEnvironmentEntry[]
}): CreateFullStackPreviewRequest {
  return {
    contractVersion: FULLSTACK_PREVIEW_CONTRACT_VERSION,
    repository: input.repository,
    frontendTarget: { sourceRoot: input.frontendSourceRoot },
    backendSourceRoot: input.backendSourceRoot,
    ...(input.userEnvironment && input.userEnvironment.length > 0
      ? {
          userEnvironment: input.userEnvironment.map(({ name, value }) => ({
            name,
            value,
          })),
        }
      : {}),
  }
}
