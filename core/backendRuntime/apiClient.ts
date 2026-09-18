import {
  BACKEND_RUNTIME_CONTRACT_VERSION,
  type BackendRuntime,
  type BackendRuntimeApiErrorCode,
  type BackendRuntimeStatus,
  type CreateBackendRuntimeRequest,
} from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"
import type { StoredPreviewSession } from "../preview/sessionStorage"

const RUNTIME_ID_PATTERN = /^[a-z\d-]{8,64}$/i
const MAX_RESPONSE_BYTES = 256 * 1024
const RUNTIME_STATUSES = new Set<BackendRuntimeStatus>([
  "queued",
  "fetching",
  "installing",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "cancelled",
  "expired",
])
const API_ERROR_CODES = new Set<BackendRuntimeApiErrorCode>([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "UNSUPPORTED_BACKEND",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "RATE_LIMITED",
  "INVALID_TRANSITION",
  "INTERNAL_ERROR",
])

type BackendRuntimeClientErrorCode =
  BackendRuntimeApiErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE"

/**
 * Mirrors `core/preview/apiClient.ts`'s `PreviewApiClient` exactly (same
 * session/auth handling, same defensive response validation, same
 * `credentials: "omit"`/no-store fetch policy) but talks to the wholly
 * separate `/v1/backend-runtimes` resource -- never `/v1/preview-jobs`. A
 * `BackendRuntime` never carries a URL of any kind (see
 * docs/PREVIEW_RUNTIME.md's "No public backend URL yet"); this client
 * cannot return one even if a server response tried to include it, since
 * `parseBackendRuntime` only reads the fields this exact shape declares.
 */
export class BackendRuntimeApiError extends Error {
  constructor(
    readonly code: BackendRuntimeClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = "BackendRuntimeApiError"
  }
}

export interface BackendRuntimeRequestOptions {
  signal?: AbortSignal
}

export interface BackendRuntimeApi {
  create(
    repository: PreviewRepositoryRef,
    sourceRoot: string | undefined,
    options?: BackendRuntimeRequestOptions,
  ): Promise<BackendRuntime>
  get(
    runtimeId: string,
    options?: BackendRuntimeRequestOptions,
  ): Promise<BackendRuntime>
  cancel(
    runtimeId: string,
    options?: BackendRuntimeRequestOptions,
  ): Promise<BackendRuntime>
}

export interface BackendRuntimeApiClientOptions {
  fetch?: typeof globalThis.fetch
  getSession?: () =>
    | StoredPreviewSession
    | null
    | undefined
    | Promise<StoredPreviewSession | null | undefined>
  clearSession?: () => void | Promise<void>
}

const SESSION_EXPIRY_SKEW_MS = 5_000

export class BackendRuntimeApiClient implements BackendRuntimeApi {
  private readonly fetch: typeof globalThis.fetch
  private readonly getSession: () => Promise<
    StoredPreviewSession | null | undefined
  >
  private readonly clearSession: () => Promise<void>

  constructor(
    private readonly baseUrl: string,
    options: BackendRuntimeApiClientOptions = {},
  ) {
    this.fetch = (options.fetch ?? globalThis.fetch).bind(globalThis)
    this.getSession = async () => options.getSession?.()
    this.clearSession = async () => {
      await options.clearSession?.()
    }
  }

  async create(
    repository: PreviewRepositoryRef,
    sourceRoot: string | undefined,
    options: BackendRuntimeRequestOptions = {},
  ): Promise<BackendRuntime> {
    const request: CreateBackendRuntimeRequest = {
      repository,
      contractVersion: BACKEND_RUNTIME_CONTRACT_VERSION,
      ...(sourceRoot === undefined ? {} : { sourceRoot }),
    }
    const body = await this.request("v1/backend-runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    })

    if (!isObject(body) || typeof body.created !== "boolean") {
      throw invalidResponse()
    }

    return parseBackendRuntime(body.runtime)
  }

  async get(
    runtimeId: string,
    options: BackendRuntimeRequestOptions = {},
  ): Promise<BackendRuntime> {
    return parseBackendRuntime(
      await this.request(
        `v1/backend-runtimes/${validateRuntimeId(runtimeId)}`,
        {
          method: "GET",
          signal: options.signal,
        },
      ),
    )
  }

  async cancel(
    runtimeId: string,
    options: BackendRuntimeRequestOptions = {},
  ): Promise<BackendRuntime> {
    return parseBackendRuntime(
      await this.request(
        `v1/backend-runtimes/${validateRuntimeId(runtimeId)}`,
        {
          method: "DELETE",
          signal: options.signal,
        },
      ),
    )
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const sessionToken = await this.getSessionToken()
    let response: Response

    try {
      response = await this.fetchJson(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${sessionToken}`,
        },
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }

      throw new BackendRuntimeApiError(
        "NETWORK_ERROR",
        "The Peephole backend runtime service could not be reached.",
      )
    }

    const body = await readJson(response)

    if (response.status === 401) {
      await this.clearSession()
    }

    if (!response.ok) {
      throw parseErrorResponse(response, body)
    }

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
      throw new BackendRuntimeApiError(
        "UNAUTHORIZED",
        "Connect GitHub to start a backend runtime.",
      )
    }
    return session.token
  }

  private fetchJson(url: string | URL, init: RequestInit): Promise<Response> {
    return this.fetch(url, { ...init, credentials: "omit", cache: "no-store" })
  }
}

function validateRuntimeId(runtimeId: string): string {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new BackendRuntimeApiError(
      "INVALID_RESPONSE",
      "The backend runtime id is invalid.",
    )
  }
  return runtimeId
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
): BackendRuntimeApiError {
  const error = isObject(body) && isObject(body.error) ? body.error : null
  const retryAfter = response.headers.get("retry-after")
  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null

  return new BackendRuntimeApiError(
    error &&
      typeof error.code === "string" &&
      API_ERROR_CODES.has(error.code as BackendRuntimeApiErrorCode)
      ? (error.code as BackendRuntimeApiErrorCode)
      : "INTERNAL_ERROR",
    error && typeof error.message === "string"
      ? error.message
      : "The backend runtime service could not complete the request.",
    response.status,
    Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : null,
  )
}

/** Deliberately reads only the fields `BackendRuntime` declares -- a
 * response carrying anything else (a URL, say) is never surfaced. */
function parseBackendRuntime(value: unknown): BackendRuntime {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !RUNTIME_ID_PATTERN.test(value.id) ||
    !isRepositoryRef(value.repository) ||
    typeof value.sourceRoot !== "string" ||
    value.adapterId !== "express-node-npm-v1" ||
    typeof value.status !== "string" ||
    !RUNTIME_STATUSES.has(value.status as BackendRuntimeStatus) ||
    (typeof value.errorCode !== "string" && value.errorCode !== null) ||
    (typeof value.errorMessage !== "string" && value.errorMessage !== null) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw invalidResponse()
  }

  return {
    id: value.id,
    repository: value.repository,
    sourceRoot: value.sourceRoot,
    adapterId: value.adapterId,
    status: value.status as BackendRuntimeStatus,
    errorCode: value.errorCode as BackendRuntime["errorCode"],
    errorMessage: value.errorMessage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  }
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

function invalidResponse(): BackendRuntimeApiError {
  return new BackendRuntimeApiError(
    "INVALID_RESPONSE",
    "The backend runtime service returned an invalid response.",
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
