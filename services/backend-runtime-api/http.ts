import { BACKEND_RUNTIME_CONTRACT_VERSION } from "../../types/backendRuntime"
import type { CreateBackendRuntimeRequest } from "../../types/backendRuntime"
import type { PreviewRequester } from "../../types/preview"
import type { BackendRuntimeControlPlane } from "./controlPlane"
import { BackendRuntimeControlError } from "./errors"

export interface BackendRuntimeHttpRequest {
  method: "GET" | "POST" | "DELETE"
  path: string
  headers: Readonly<Record<string, string | undefined>>
  body?: unknown
  requester: PreviewRequester
}

export interface BackendRuntimeHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

const RUNTIME_PATH = /^\/v1\/backend-runtimes\/([a-z\d-]{8,64})$/i

/** True only for a path this handler owns -- lets a combined server route
 * everything else to the existing preview-job handler unchanged. */
export function isBackendRuntimeHttpPath(path: string): boolean {
  return path === "/v1/backend-runtimes" || RUNTIME_PATH.test(path)
}

export function createBackendRuntimeHttpHandler(
  controlPlane: BackendRuntimeControlPlane,
): (request: BackendRuntimeHttpRequest) => Promise<BackendRuntimeHttpResponse> {
  return async (request) => {
    try {
      if (
        request.method === "POST" &&
        request.path === "/v1/backend-runtimes"
      ) {
        const body = parseCreateRequest(request.body)
        const result = await controlPlane.create(body, request.requester)
        return jsonResponse(result.created ? 202 : 200, result)
      }

      const match = request.path.match(RUNTIME_PATH)

      if (match?.[1] && request.method === "GET") {
        return jsonResponse(
          200,
          await controlPlane.get(match[1], request.requester),
        )
      }

      if (match?.[1] && request.method === "DELETE") {
        return jsonResponse(
          202,
          await controlPlane.cancel(match[1], request.requester),
        )
      }

      throw new BackendRuntimeControlError(
        "NOT_FOUND",
        "Endpoint not found.",
        404,
      )
    } catch (error) {
      return errorResponse(error)
    }
  }
}

function parseCreateRequest(value: unknown): CreateBackendRuntimeRequest {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["repository", "contractVersion", "sourceRoot"]) ||
    !isObject(value.repository) ||
    !hasOnlyKeys(value.repository, [
      "repositoryId",
      "owner",
      "name",
      "commitSha",
    ]) ||
    typeof value.repository.repositoryId !== "number" ||
    typeof value.repository.owner !== "string" ||
    typeof value.repository.name !== "string" ||
    typeof value.repository.commitSha !== "string" ||
    value.contractVersion !== BACKEND_RUNTIME_CONTRACT_VERSION ||
    (value.sourceRoot !== undefined && typeof value.sourceRoot !== "string")
  ) {
    throw new BackendRuntimeControlError(
      "INVALID_REQUEST",
      "Backend runtime request body is invalid.",
      400,
    )
  }

  return {
    repository: {
      repositoryId: value.repository.repositoryId,
      owner: value.repository.owner,
      name: value.repository.name,
      commitSha: value.repository.commitSha,
    },
    contractVersion: BACKEND_RUNTIME_CONTRACT_VERSION,
    ...(value.sourceRoot === undefined
      ? {}
      : { sourceRoot: value.sourceRoot as string }),
  }
}

function jsonResponse(
  status: number,
  body: unknown,
): BackendRuntimeHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body }
}

function errorResponse(error: unknown): BackendRuntimeHttpResponse {
  if (error instanceof BackendRuntimeControlError) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    }
    if (error.retryAfterSeconds !== null) {
      headers["retry-after"] = String(error.retryAfterSeconds)
    }
    return {
      status: error.status,
      headers,
      body: { error: { code: error.code, message: error.message } },
    }
  }

  return {
    status: 500,
    headers: { "content-type": "application/json" },
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "The backend runtime service could not complete the request.",
      },
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}
