import {
  FULLSTACK_PREVIEW_CONTRACT_VERSION,
  type CreateFullStackPreviewRequest,
} from "../../types/fullstackPreview"
import type { PreviewRequester } from "../../types/preview"
import type { FullStackPreviewControlPlane } from "./controlPlane"
import { FullStackPreviewControlError } from "./errors"

export interface FullStackPreviewHttpRequest {
  method: "GET" | "POST" | "DELETE"
  path: string
  headers: Readonly<Record<string, string | undefined>>
  body?: unknown
  requester: PreviewRequester
}

export interface FullStackPreviewHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

const PREVIEW_PATH = /^\/v1\/fullstack-previews\/([a-z\d-]{8,64})$/i

/** True only for a path this handler owns -- lets a combined server route
 * everything else to the existing preview-job/backend-runtime handlers
 * unchanged. Never wired into services/production/server.ts in Phase 2A. */
export function isFullStackPreviewHttpPath(path: string): boolean {
  return path === "/v1/fullstack-previews" || PREVIEW_PATH.test(path)
}

export function createFullStackPreviewHttpHandler(
  controlPlane: FullStackPreviewControlPlane,
): (
  request: FullStackPreviewHttpRequest,
) => Promise<FullStackPreviewHttpResponse> {
  return async (request) => {
    try {
      if (
        request.method === "POST" &&
        request.path === "/v1/fullstack-previews"
      ) {
        const body = parseCreateRequest(request.body)
        const idempotencyKey = getHeader(request.headers, "idempotency-key")

        if (!idempotencyKey) {
          throw new FullStackPreviewControlError(
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
        return jsonResponse(result.created ? 202 : 200, result)
      }

      const match = request.path.match(PREVIEW_PATH)

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

      throw new FullStackPreviewControlError(
        "NOT_FOUND",
        "Endpoint not found.",
        404,
      )
    } catch (error) {
      return errorResponse(error)
    }
  }
}

function parseCreateRequest(value: unknown): CreateFullStackPreviewRequest {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "repository",
      "frontendTarget",
      "backendSourceRoot",
    ]) ||
    value.contractVersion !== FULLSTACK_PREVIEW_CONTRACT_VERSION ||
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
    !isObject(value.frontendTarget) ||
    !hasOnlyKeys(value.frontendTarget, ["sourceRoot"]) ||
    typeof value.frontendTarget.sourceRoot !== "string" ||
    typeof value.backendSourceRoot !== "string"
  ) {
    throw new FullStackPreviewControlError(
      "INVALID_REQUEST",
      "Full-stack preview request body is invalid.",
      400,
    )
  }

  return {
    contractVersion: FULLSTACK_PREVIEW_CONTRACT_VERSION,
    repository: {
      repositoryId: value.repository.repositoryId,
      owner: value.repository.owner,
      name: value.repository.name,
      commitSha: value.repository.commitSha,
    },
    frontendTarget: { sourceRoot: value.frontendTarget.sourceRoot },
    backendSourceRoot: value.backendSourceRoot,
  }
}

function jsonResponse(
  status: number,
  body: unknown,
): FullStackPreviewHttpResponse {
  return { status, headers: { "content-type": "application/json" }, body }
}

function errorResponse(error: unknown): FullStackPreviewHttpResponse {
  if (error instanceof FullStackPreviewControlError) {
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
        message:
          "The full-stack preview service could not complete the request.",
      },
    },
  }
}

function getHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1]
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
