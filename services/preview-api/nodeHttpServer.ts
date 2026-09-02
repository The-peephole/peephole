import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

import type { PreviewRequester } from "../../types/preview"
import type { PreviewHttpRequest, PreviewHttpResponse } from "./http"

const DEFAULT_MAX_BODY_BYTES = 16 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export type PreviewHttpHandler = (
  request: PreviewHttpRequest,
) => Promise<PreviewHttpResponse>

export interface NodePreviewApiServerOptions {
  handlePreviewRequest: PreviewHttpHandler
  resolveRequester: (
    request: IncomingMessage,
  ) => PreviewRequester | Promise<PreviewRequester>
  isReady?: () => boolean | Promise<boolean>
  maxBodyBytes?: number
  requestTimeoutMs?: number
}

export interface ListenOptions {
  host?: string
  port: number
}

export class NodePreviewApiServer {
  private readonly server: Server

  constructor(private readonly options: NodePreviewApiServerOptions) {
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new Error("Preview API body limit must be a positive integer.")
    }

    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("Preview API request timeout must be a positive integer.")
    }

    this.server = createServer((request, response) => {
      void this.handle(request, response, maxBodyBytes)
    })
    this.server.requestTimeout = requestTimeoutMs
    this.server.headersTimeout = Math.min(requestTimeoutMs, 10_000)
    this.server.keepAliveTimeout = 5_000
  }

  async listen({
    port,
    host = "127.0.0.1",
  }: ListenOptions): Promise<AddressInfo> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("Preview API port is invalid.")
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        this.server.off("listening", handleListening)
        reject(error)
      }
      const handleListening = () => {
        this.server.off("error", handleError)
        resolve()
      }

      this.server.once("error", handleError)
      this.server.once("listening", handleListening)
      this.server.listen(port, host)
    })

    const address = this.server.address()

    if (!address || typeof address === "string") {
      await this.close()
      throw new Error("Preview API did not receive a TCP address.")
    }

    return address
  }

  async close(): Promise<void> {
    if (!this.server.listening) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    maxBodyBytes: number,
  ): Promise<void> {
    try {
      const path = getPath(request)

      if (request.method === "GET" && path === "/healthz") {
        sendJson(response, 200, { ok: true })
        return
      }

      if (request.method === "GET" && path === "/readyz") {
        const ready = (await this.options.isReady?.()) ?? true
        sendJson(response, ready ? 200 : 503, { ready })
        return
      }

      if (!isSupportedMethod(request.method)) {
        sendError(response, 405, "INVALID_REQUEST", "Method not allowed.", {
          allow: "GET, POST, DELETE",
        })
        return
      }

      const body =
        request.method === "POST"
          ? await readJsonBody(request, maxBodyBytes)
          : undefined
      const requester = await this.options.resolveRequester(request)
      const result = await this.options.handlePreviewRequest({
        method: request.method,
        path,
        headers: normalizeHeaders(request.headers),
        body,
        requester,
      })

      sendJson(response, result.status, result.body, result.headers)
    } catch (error) {
      if (error instanceof HttpIngressError) {
        sendError(response, error.status, "INVALID_REQUEST", error.message)
        return
      }

      sendError(
        response,
        500,
        "INTERNAL_ERROR",
        "The preview service could not complete the request.",
      )
    }
  }
}

class HttpIngressError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "HttpIngressError"
  }
}

function getPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname
  } catch {
    throw new HttpIngressError(400, "Request URL is invalid.")
  }
}

function isSupportedMethod(
  method: string | undefined,
): method is PreviewHttpRequest["method"] {
  return method === "GET" || method === "POST" || method === "DELETE"
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim()

  if (contentType !== "application/json") {
    throw new HttpIngressError(415, "Content-Type must be application/json.")
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength

    if (totalBytes > maxBodyBytes) {
      throw new HttpIngressError(413, "Request body is too large.")
    }

    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    throw new HttpIngressError(400, "Request body must be valid JSON.")
  }
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  )
}

function sendError(
  response: ServerResponse,
  status: number,
  code: "INVALID_REQUEST" | "INTERNAL_ERROR",
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(response, status, { error: { code, message } }, headers)
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) {
    return
  }

  const payload = JSON.stringify(body)
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(payload)
}
