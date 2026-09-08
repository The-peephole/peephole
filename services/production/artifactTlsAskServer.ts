import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

import type { ProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import { resolveProductionArtifactHostname } from "./artifactDomain"

const LOOPBACK_HOST = "127.0.0.1"

export interface ProductionArtifactTlsAskServerOptions {
  store: Pick<ProductionArtifactStore, "get">
  port?: number
  baseDomain?: string
  now?: () => Date
  // Deliberately no bind-address option: this is an internal listener.
}

/** Caddy contract: ask http://127.0.0.1:8790/check
 * Only GET /check?domain=<hostname> with live DB metadata allows issuance.
 * This grants no serving rights; ProductionArtifactHost authorizes each
 * HTTP request independently. No filesystem or DNS lookup occurs here. */
export class ProductionArtifactTlsAskServer {
  private server: Server | undefined
  private listening: Promise<{ host: string; port: number }> | undefined
  private readonly now: () => Date

  constructor(private readonly options: ProductionArtifactTlsAskServerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  listen(): Promise<{ host: string; port: number }> {
    if (!this.listening) {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response)
      })
      this.server = server
      this.listening = new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(this.options.port ?? 8_790, LOOPBACK_HOST, () => {
          const address = server.address()
          if (!address || typeof address === "string") {
            reject(new Error("TLS ask listener has no TCP address."))
            return
          }
          resolve({ host: LOOPBACK_HOST, port: address.port })
        })
      })
    }
    return this.listening
  }

  async close(): Promise<void> {
    await this.listening?.catch(() => undefined)
    const server = this.server
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
    this.server = undefined
    this.listening = undefined
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== "GET") {
        sendText(response, 405, "Method not allowed.", { Allow: "GET" })
        return
      }
      // Match the raw path before URL parsing can normalize dot segments,
      // absolute URLs, or other malformed request targets into /check.
      const target = request.url ?? ""
      const queryIndex = target.indexOf("?")
      const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex)
      if (pathname !== "/check" || target.includes("#")) {
        sendText(response, 404, "Not found.")
        return
      }
      const query = new URLSearchParams(
        queryIndex === -1 ? "" : target.slice(queryIndex + 1),
      )
      const domains = query.getAll("domain")
      const artifactId =
        domains.length === 1
          ? resolveProductionArtifactHostname(
              domains[0] ?? "",
              this.options.baseDomain ?? "peepholeusercontent.dev",
            )
          : null
      if (!artifactId) {
        sendText(response, 403, "Forbidden.")
        return
      }
      const metadata = await this.options.store.get(artifactId)
      // Positive comparison also rejects invalid dates. Check after the
      // lookup so a row that expired while awaiting DB cannot be allowed.
      if (metadata && metadata.expiresAt.getTime() > this.now().getTime()) {
        sendText(response, 200, "Allowed.")
        return
      }
    } catch {
      // DB failures must neither authorize issuance nor expose DB details.
    }
    sendText(response, 403, "Forbidden.")
  }
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
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(body)
}
