import { createServer, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"

import { isSafeEntryPath } from "../../core/runner/archivePolicy"
import type { PreviewArtifactReference } from "../../types/preview"
import type { PreviewArtifactSigner } from "../preview-api/ports"

const ARTIFACT_ID_PATTERN = /^artifact-[a-f\d]{8}-[a-f\d-]{27}$/i
const JOB_ID_PATTERN = /^[a-z\d-]{8,64}$/i

interface HostedArtifact {
  server: Server
  url: string
  expiration: { value: number }
  closeTimer: NodeJS.Timeout
}

export interface LocalArtifactHostOptions {
  storageDir: string
  host?: "127.0.0.1" | "::1"
  now?: () => Date
}

/**
 * Development-only static host. Each artifact gets a distinct loopback port,
 * which preserves root-relative Vite asset URLs without sharing an origin with
 * the extension or Preview API.
 */
export class LocalArtifactHost implements PreviewArtifactSigner {
  private readonly storageDir: string
  private readonly host: "127.0.0.1" | "::1"
  private readonly now: () => Date
  private readonly hosted = new Map<string, HostedArtifact>()

  constructor(options: LocalArtifactHostOptions) {
    this.storageDir = path.resolve(options.storageDir)
    this.host = options.host ?? "127.0.0.1"
    this.now = options.now ?? (() => new Date())
  }

  async sign(
    artifactId: string,
    jobId: string,
    expiresAt: Date,
  ): Promise<PreviewArtifactReference> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error("Local artifact id is invalid.")
    }

    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Local preview job id is invalid.")
    }

    if (expiresAt.getTime() <= this.now().getTime()) {
      throw new Error("Local artifact expiry must be in the future.")
    }

    const existing = this.hosted.get(artifactId)

    if (existing) {
      if (expiresAt.getTime() > existing.expiration.value) {
        clearTimeout(existing.closeTimer)
        existing.expiration.value = expiresAt.getTime()
        existing.closeTimer = this.scheduleClose(artifactId, existing)
      }

      return { url: existing.url, expiresAt: expiresAt.toISOString() }
    }

    const artifactRoot = await resolveArtifactRoot(this.storageDir, artifactId)
    const hosted = await this.startArtifactServer(artifactId, artifactRoot)
    this.hosted.set(artifactId, hosted)
    hosted.expiration.value = expiresAt.getTime()
    hosted.closeTimer = this.scheduleClose(artifactId, hosted)

    return { url: hosted.url, expiresAt: expiresAt.toISOString() }
  }

  async close(): Promise<void> {
    const artifacts = [...this.hosted.values()]
    this.hosted.clear()

    await Promise.all(
      artifacts.map(async (artifact) => {
        clearTimeout(artifact.closeTimer)
        await closeServer(artifact.server)
      }),
    )
  }

  private async startArtifactServer(
    artifactId: string,
    artifactRoot: string,
  ): Promise<HostedArtifact> {
    const expiration = { value: Number.POSITIVE_INFINITY }
    const server = createServer((request, response) => {
      void serveArtifactRequest(
        request.method,
        request.url,
        request.headers.accept,
        response,
        artifactRoot,
        () => expiration.value,
        this.now,
      )
    })
    const address = await listen(server, this.host)
    const displayHost = address.address.includes(":")
      ? `[${address.address}]`
      : address.address
    const url = `http://${displayHost}:${address.port}/`
    const placeholder = setTimeout(() => undefined, 1)
    clearTimeout(placeholder)

    const hosted: HostedArtifact = {
      server,
      url,
      expiration,
      closeTimer: placeholder,
    }

    server.on("error", () => {
      this.hosted.delete(artifactId)
    })

    return hosted
  }

  private scheduleClose(
    artifactId: string,
    artifact: HostedArtifact,
  ): NodeJS.Timeout {
    const delay = Math.max(1, artifact.expiration.value - this.now().getTime())
    const timer = setTimeout(() => {
      if (this.hosted.get(artifactId) !== artifact) return
      this.hosted.delete(artifactId)
      void closeServer(artifact.server)
    }, delay)
    timer.unref()
    return timer
  }
}

async function resolveArtifactRoot(
  storageDir: string,
  artifactId: string,
): Promise<string> {
  const storageRoot = await realpath(storageDir)
  const candidate = await realpath(path.join(storageRoot, artifactId))
  const relative = path.relative(storageRoot, candidate)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Local artifact path escapes its storage root.")
  }

  const index = await lstat(path.join(candidate, "index.html"))

  if (!index.isFile() || index.isSymbolicLink()) {
    throw new Error("Local artifact has no regular index.html file.")
  }

  return candidate
}

async function serveArtifactRequest(
  method: string | undefined,
  requestUrl: string | undefined,
  accept: string | undefined,
  response: ServerResponse,
  artifactRoot: string,
  getExpiresAtMs: () => number,
  now: () => Date,
): Promise<void> {
  try {
    if (method !== "GET" && method !== "HEAD") {
      sendText(response, 405, "Method not allowed.", { allow: "GET, HEAD" })
      return
    }

    if (now().getTime() >= getExpiresAtMs()) {
      sendText(response, 410, "Preview expired.")
      return
    }

    const pathname = new URL(requestUrl ?? "/", "http://localhost").pathname
    const requestedPath = decodeURIComponent(pathname).replace(/^\/+/, "")
    const relativePath = requestedPath || "index.html"
    let filePath = await resolveRequestedFile(artifactRoot, relativePath)

    if (!filePath && wantsHtml(accept) && !path.posix.extname(relativePath)) {
      filePath = await resolveRequestedFile(artifactRoot, "index.html")
    }

    if (!filePath) {
      sendText(response, 404, "Not found.")
      return
    }

    const body = await readFile(filePath)
    const headers = staticHeaders(filePath, body.byteLength)
    response.writeHead(200, headers)
    response.end(method === "HEAD" ? undefined : body)
  } catch {
    sendText(response, 404, "Not found.")
  }
}

async function resolveRequestedFile(
  artifactRoot: string,
  relativePath: string,
): Promise<string | null> {
  if (!isSafeEntryPath(relativePath, 4_096)) {
    return null
  }

  const candidate = path.resolve(artifactRoot, ...relativePath.split("/"))
  const relative = path.relative(artifactRoot, candidate)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null
  }

  try {
    const stats = await lstat(candidate)

    if (stats.isSymbolicLink()) return null
    if (stats.isDirectory()) {
      return resolveRequestedFile(
        artifactRoot,
        `${relativePath.replace(/\/+$/, "")}/index.html`,
      )
    }
    return stats.isFile() ? candidate : null
  } catch {
    return null
  }
}

function staticHeaders(filePath: string, length: number) {
  return {
    "content-type": contentType(filePath),
    "content-length": length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "x-content-type-options": "nosniff",
  }
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".txt": "text/plain; charset=utf-8",
    }[extension] ?? "application/octet-stream"
  )
}

function wantsHtml(accept: string | undefined): boolean {
  return accept?.includes("text/html") ?? false
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(status, {
    ...headers,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

async function listen(server: Server, host: string): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => resolve())
  })
  const address = server.address()

  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("Local artifact server did not receive a TCP address.")
  }

  return address
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
