import type {
  CreatePreviewJobRequest,
  PreviewRequester,
} from "../../types/preview"
import { PreviewControlError } from "./errors"
import type { PreviewControlPlane } from "./controlPlane"

export interface PreviewHttpRequest {
  method: "GET" | "POST" | "DELETE"
  path: string
  headers: Readonly<Record<string, string | undefined>>
  body?: unknown
  requester: PreviewRequester
}

export interface PreviewHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export function createPreviewHttpHandler(
  controlPlane: PreviewControlPlane,
): (request: PreviewHttpRequest) => Promise<PreviewHttpResponse> {
  return async (request) => {
    try {
      if (request.method === "POST" && request.path === "/v1/preview-jobs") {
        const body = parseCreateRequest(request.body)
        const idempotencyKey = getHeader(request.headers, "idempotency-key")

        if (!idempotencyKey) {
          throw new PreviewControlError(
            "INVALID_REQUEST",
            "Idempotency-Key header is required.",
            400,
          )
        }

        const result = await controlPlane.create(
          body,
          idempotencyKey,
          request.requester,
        )

        return jsonResponse(
          result.created && result.job.cacheStatus === "miss" ? 202 : 200,
          result,
        )
      }

      const jobMatch = request.path.match(
        /^\/v1\/preview-jobs\/([a-z\d-]{8,64})$/i,
      )

      if (jobMatch?.[1] && request.method === "GET") {
        return jsonResponse(
          200,
          await controlPlane.get(jobMatch[1], request.requester),
        )
      }

      if (jobMatch?.[1] && request.method === "DELETE") {
        return jsonResponse(
          202,
          await controlPlane.cancel(jobMatch[1], request.requester),
        )
      }

      throw new PreviewControlError("NOT_FOUND", "Endpoint not found.", 404)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

function parseCreateRequest(value: unknown): CreatePreviewJobRequest {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["repository", "contractVersion"]) ||
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
    typeof value.contractVersion !== "string"
  ) {
    throw new PreviewControlError(
      "INVALID_REQUEST",
      "Preview job request body is invalid.",
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
    contractVersion: value.contractVersion,
  }
}

function getHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )

  return entry?.[1] ?? null
}

function jsonResponse(status: number, body: unknown): PreviewHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
  }
}

function errorResponse(error: unknown): PreviewHttpResponse {
  if (error instanceof PreviewControlError) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    }

    if (error.retryAfterSeconds !== null) {
      headers["retry-after"] = String(error.retryAfterSeconds)
    }

    return {
      status: error.status,
      headers,
      body: {
        error: {
          code: error.code,
          message: error.message,
        },
      },
    }
  }

  return {
    status: 500,
    headers: { "content-type": "application/json" },
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "The preview service could not complete the request.",
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
