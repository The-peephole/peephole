import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

import type { BackendRuntimeDialTarget } from "../backend-runtime-worker/ports"
import { validateTrustedAppOrigin } from "../production/trustedOrigin"
import type { FullStackBackendProxy } from "./ports"
import { previewSecurityHeaders } from "./securityHeaders"

export const MAX_BACKEND_RESPONSE_BYTES = 256 * 1024
export const BACKEND_REQUEST_TIMEOUT_MS = 5_000

export interface BoundedBackendProxyOptions {
  trustedAppOrigin: string
  timeoutMs?: number
  maxResponseBytes?: number
}

/** Minimal backend-v1 HTTP bridge. It intentionally buffers responses and
 * creates a new TCP connection per request. */
export class BoundedBackendProxy implements FullStackBackendProxy {
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly trustedAppOrigin: string

  constructor(options: BoundedBackendProxyOptions) {
    this.timeoutMs = options.timeoutMs ?? BACKEND_REQUEST_TIMEOUT_MS
    this.maxResponseBytes =
      options.maxResponseBytes ?? MAX_BACKEND_RESPONSE_BYTES
    this.trustedAppOrigin = validateTrustedAppOrigin(options.trustedAppOrigin)
  }

  async proxy(
    request: IncomingMessage,
    response: ServerResponse,
    target: BackendRuntimeDialTarget,
    requestTarget: string,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.sendError(response, 405, "Method not allowed.", {
        allow: "GET, HEAD",
      })
      return
    }
    const contentLength = request.headers["content-length"]
    if (
      request.headers["transfer-encoding"] !== undefined ||
      (contentLength !== undefined &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > 0))
    ) {
      this.sendError(response, 400, "Invalid request.")
      return
    }
    if (
      request.headers.upgrade !== undefined ||
      request.headers.connection?.toLowerCase().includes("upgrade")
    ) {
      this.sendError(response, 400, "Invalid request.")
      return
    }

    const headers: Record<string, string | string[]> = {
      host: `localhost:${target.port}`,
    }
    for (const name of ["accept", "accept-language"] as const) {
      const value = request.headers[name]
      if (value !== undefined) headers[name] = value
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (
        status: number,
        body: Buffer | string,
        extraHeaders: Record<string, string> = {},
      ) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (!response.headersSent && !response.destroyed) {
          const length =
            typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
          response.writeHead(status, {
            ...previewSecurityHeaders(this.trustedAppOrigin, "'self'"),
            ...extraHeaders,
            "content-length": length,
          })
          response.end(request.method === "HEAD" ? undefined : body)
        }
        resolve()
      }
      const fail = (status: 502 | 504) =>
        finish(
          status,
          status === 504 ? "Backend timed out." : "Backend unavailable.",
          { "content-type": "text/plain; charset=utf-8" },
        )

      const upstream = httpRequest(
        {
          host: target.host,
          port: target.port,
          method: request.method,
          path: requestTarget,
          headers,
          // A peer IP may be recycled after sandbox teardown. Never let a
          // pooled socket silently cross runtime identities.
          agent: false,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 0
          const declaredLength = upstreamResponse.headers["content-length"]
          if (
            status < 200 ||
            status > 599 ||
            (status >= 300 && status <= 399) ||
            (declaredLength !== undefined &&
              (!/^\d+$/.test(declaredLength) ||
                Number(declaredLength) > this.maxResponseBytes))
          ) {
            upstreamResponse.destroy()
            fail(502)
            return
          }

          const chunks: Buffer[] = []
          let total = 0
          upstreamResponse.on("data", (chunk: Buffer | string) => {
            if (settled) return
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            total += bytes.byteLength
            if (total > this.maxResponseBytes) {
              upstreamResponse.destroy()
              fail(502)
              return
            }
            chunks.push(bytes)
          })
          upstreamResponse.on("end", () => {
            if (settled) return
            const contentType = upstreamResponse.headers["content-type"]
            finish(
              status,
              Buffer.concat(chunks),
              typeof contentType === "string"
                ? { "content-type": contentType }
                : {},
            )
          })
          upstreamResponse.on("error", () => fail(502))
        },
      )
      const deadline = setTimeout(() => {
        upstream.destroy()
        fail(504)
      }, this.timeoutMs)
      upstream.on("upgrade", (upstreamResponse, socket) => {
        upstreamResponse.destroy()
        socket.destroy()
        fail(502)
      })
      upstream.on("error", () => fail(502))
      upstream.end()
    })
  }

  private sendError(
    response: ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void {
    if (response.headersSent || response.destroyed) return
    response.writeHead(status, {
      ...previewSecurityHeaders(this.trustedAppOrigin, "'self'"),
      ...headers,
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    })
    response.end(body)
  }
}
