import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { lstat, readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"

import type { PreviewArtifactReference } from "../../types/preview"
import type { PreviewArtifactSigner } from "../preview-api/ports"
import type { ProductionArtifactStore } from "../preview-api/postgres/productionArtifactStore"
import {
  ARTIFACT_ID_SOURCE,
  acceptsHtml,
  contentTypeFor,
  resolveRequestedFile,
  resolveVerifiedArtifactRoot,
} from "../artifactServing/staticFile"

import { validateTrustedAppOrigin } from "./trustedOrigin"

import { resolveProductionArtifactHostname } from "./artifactDomain"

const JOB_ID_PATTERN = /^[a-z\d-]{8,64}$/i
const ARTIFACT_ID_PATTERN = new RegExp(`^${ARTIFACT_ID_SOURCE}$`, "i")
// A directory the publisher created but that never got a metadata row at
// all (a crash between LocalArtifactPublisher.publish() and the control
// plane's complete()/sign() call) is swept after this grace period,
// mirroring LocalArtifactHost's own default for the same "abandoned,
// never actually hosted" case. Everything the DB *does* have a row for is
// governed entirely by its persisted expires_at, never mtime -- see
// reap()'s doc comment.
const ORPHANED_DIRECTORY_GRACE_MS = 2 * 60 * 60_000
const LOOPBACK_HOST = "127.0.0.1"

export interface ProductionArtifactHostOptions {
  storageDir: string
  store: ProductionArtifactStore
  /** Deliberately no `host` option: this listener must only ever bind
   * loopback in production (a reverse proxy, added in a later step, is
   * what actually faces the internet), so there is nothing here an
   * environment variable could misconfigure into 0.0.0.0. */
  port?: number
  baseDomain?: string
  /** Validated again at construction so standalone callers cannot inject CSP. */
  trustedAppOrigin?: string
  now?: () => Date
}

/**
 * Production artifact ingress: one fixed HTTP listener on
 * 127.0.0.1:<port> (default 8788, never 0.0.0.0 -- see
 * ProductionArtifactHostOptions), routing every request to an artifact
 * root purely by its Host header, e.g.
 * `https://artifact-<uuid>.peepholeusercontent.dev/` once a reverse proxy
 * forwards to this listener. This is a deliberately different shape from
 * services/local-preview/artifactHost.ts's LocalArtifactHost (one HTTP
 * server *per artifact*, on its own random loopback port): a real,
 * registrable wildcard domain gives every artifact its own origin without
 * needing a dedicated port per artifact, which is the only reason
 * LocalArtifactHost's per-port approach existed in the first place.
 * On-disk file resolution and path-safety rules are still the exact same
 * code as LocalArtifactHost's, shared via
 * services/artifactServing/staticFile.ts.
 *
 * Authorization/expiry is never taken from the filesystem (an artifact
 * directory existing on disk proves nothing) or from an in-memory Map
 * (which a process restart -- a normal systemd deploy -- would silently
 * wipe): `store` (PostgresProductionArtifactStore) is the sole
 * authoritative source, so a still-valid preview keeps working across a
 * restart and an expired one 410s even on a process that has never seen
 * it signed.
 */
export class ProductionArtifactHost implements PreviewArtifactSigner {
  private readonly storageDir: string
  private readonly store: ProductionArtifactStore
  private readonly port: number
  private readonly baseDomain: string
  private readonly trustedAppOrigin: string
  private readonly now: () => Date
  private server: Server | undefined
  private listening: Promise<{ host: string; port: number }> | undefined
  // Per-artifact-id async mutex: sign() and reap() each span a
  // verify/decide step and a destructive filesystem step, and this
  // process runs the API/worker (which calls sign()) and the maintenance
  // reaper in the same event loop -- serializing on the artifact id is
  // enough to make "reap() destroys an artifact sign() just extended"
  // impossible, with no database-level locking needed. See sign()/reap().
  private readonly artifactLocks = new Map<string, Promise<void>>()

  constructor(options: ProductionArtifactHostOptions) {
    this.storageDir = path.resolve(options.storageDir)
    this.store = options.store
    this.port = options.port ?? 8_788
    this.baseDomain = options.baseDomain ?? "peepholeusercontent.dev"
    this.trustedAppOrigin = validateTrustedAppOrigin(
      options.trustedAppOrigin ?? "https://app.peephole.dev",
    )
    this.now = options.now ?? (() => new Date())
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (!this.listening) {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response)
      })
      this.server = server
      this.listening = new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(this.port, LOOPBACK_HOST, () => {
          resolve({ host: LOOPBACK_HOST, port: this.port })
        })
      })
    }

    return this.listening
  }

  async close(): Promise<void> {
    if (!this.server?.listening) return
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  async sign(
    artifactId: string,
    jobId: string,
    expiresAt: Date,
  ): Promise<PreviewArtifactReference> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error("Invalid artifact id.")
    }

    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Invalid preview job id.")
    }

    if (expiresAt.getTime() <= this.now().getTime()) {
      throw new Error("Artifact expiry must be in the future.")
    }

    // Locked against reap() for this same artifact id -- see
    // artifactLocks's doc comment and reap()'s own lock usage. Without
    // this, a reap() cycle that already listed this artifact as expired
    // could delete its directory (and, moments later, overwrite the very
    // row upsertMaxExpiry below is about to write) *after* this function
    // had already verified the directory existed, silently breaking a
    // sign() call that otherwise reported success.
    return this.withArtifactLock(artifactId, async () => {
      // Validates the directory is real, doesn't escape storageDir even
      // through a symlink, and has a real (non-symlink) index.html --
      // throws otherwise. Result is intentionally discarded: routing
      // always re-resolves this fresh per request (see
      // resolveVerifiedArtifactRoot in handleRequest), since -- unlike
      // LocalArtifactHost, which pins one verified root for the lifetime
      // of one per-artifact server -- this listener is a single
      // long-lived process serving arbitrarily many artifacts over time,
      // so "verified once at sign() time" is not a safe substitute for
      // "verified for this specific request".
      await resolveVerifiedArtifactRoot(this.storageDir, artifactId)

      // The same artifact can be signed again later (a build-cache hit
      // reusing it for a new job) with a *shorter* expiry than it
      // already has -- upsertMaxExpiry only ever grows the persisted
      // expiry, so a still-valid preview never gets cut short by a
      // later, smaller ask.
      await this.store.upsertMaxExpiry(artifactId, expiresAt)

      return {
        url: `https://${artifactId}.${this.baseDomain}/`,
        expiresAt: expiresAt.toISOString(),
      }
    })
  }

  /**
   * Two independent sweeps:
   *  1. DB-authoritative: every artifact_id listExpired() names as
   *     expired is a *candidate*, not a certainty -- see
   *     deleteIfStillExpired()'s doc comment for why a plain
   *     unconditional delete here would be unsafe. Each candidate is
   *     re-checked, atomically, at the moment it's actually about to be
   *     destroyed, inside the same per-artifact lock sign() takes (see
   *     withArtifactLock): if a concurrent sign() already extended it,
   *     this leaves it alone entirely, directory and row both.
   *  2. Orphan cleanup: on-disk `artifact-*` directories with no row in
   *     the store at all (sign() was never reached, e.g. a crash right
   *     after publish()) are swept once they're older than a grace
   *     period. mtime is only ever consulted here, for directories the
   *     store has no opinion on whatsoever -- and the "no row" check is
   *     re-done inside the same lock immediately before deleting, for the
   *     same reason.
   */
  async reap(): Promise<string[]> {
    const removed: string[] = []

    for (const artifactId of await this.store.listExpired(this.now())) {
      const destroyed = await this.withArtifactLock(artifactId, async () => {
        const stillExpired = await this.store.deleteIfStillExpired(
          artifactId,
          this.now(),
        )
        if (!stillExpired) return false
        await this.removeArtifactDirectory(artifactId)
        return true
      })
      if (destroyed) removed.push(artifactId)
    }

    const entries = await readdir(this.storageDir, {
      withFileTypes: true,
    }).catch(() => [])

    for (const entry of entries) {
      if (!ARTIFACT_ID_PATTERN.test(entry.name) || !entry.isDirectory()) {
        continue
      }

      const removedOrphan = await this.withArtifactLock(
        entry.name,
        async () => {
          if (await this.store.get(entry.name)) return false // signed since the readdir() above -- not an orphan

          const candidate = path.resolve(this.storageDir, entry.name)
          if (path.dirname(candidate) !== this.storageDir) return false
          const stats = await lstat(candidate).catch(() => null)
          if (
            !stats ||
            stats.isSymbolicLink() ||
            this.now().getTime() - stats.mtimeMs <= ORPHANED_DIRECTORY_GRACE_MS
          )
            return false

          await rm(candidate, { recursive: true, force: true })
          return true
        },
      )
      if (removedOrphan) removed.push(entry.name)
    }

    return removed
  }

  private async removeArtifactDirectory(artifactId: string): Promise<void> {
    const candidate = path.resolve(this.storageDir, artifactId)
    // Must be a direct child of storageDir -- refuses to rm anything an
    // unexpected artifact_id value (however it got into the store) could
    // otherwise point outside of it.
    if (path.dirname(candidate) !== this.storageDir) return
    await rm(candidate, { recursive: true, force: true })
  }

  /**
   * Runs `fn` exclusively with respect to any other call (sign() or
   * reap()) currently holding the lock for the same `artifactId`, queuing
   * FIFO behind whichever one is already running. Each waiter's turn
   * starts only once the previous one has *settled* (succeeded or
   * thrown), so one failing call can never wedge the queue for that id.
   * The map entry is removed once nothing is queued behind the current
   * holder, so it never grows unboundedly over the life of the process.
   */
  private withArtifactLock<T>(
    artifactId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const run = (this.artifactLocks.get(artifactId) ?? Promise.resolve()).then(
      fn,
      fn,
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.artifactLocks.set(artifactId, settled)
    void settled.finally(() => {
      if (this.artifactLocks.get(artifactId) === settled) {
        this.artifactLocks.delete(artifactId)
      }
    })

    return run
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed.", { allow: "GET, HEAD" })
        return
      }

      const artifactId = this.resolveArtifactIdFromHost(request.headers.host)

      if (!artifactId) {
        // Wrong domain, extra label, malformed/missing Host, etc. --
        // indistinguishable from "no such artifact" on purpose, to avoid
        // leaking anything about which Host values are even well-formed.
        sendText(response, 404, "Not found.")
        return
      }

      const metadata = await this.store.get(artifactId)

      if (!metadata) {
        // A directory can exist on disk (e.g. publish() ran but sign()
        // never did) without ever being authorized to serve -- the store,
        // not the filesystem, decides what's servable.
        sendText(response, 404, "Not found.")
        return
      }

      if (metadata.expiresAt.getTime() <= this.now().getTime()) {
        sendText(response, 410, "Preview expired.")
        return
      }

      let artifactRoot: string
      try {
        artifactRoot = await resolveVerifiedArtifactRoot(
          this.storageDir,
          artifactId,
        )
      } catch {
        // The store says it's authorized, but the on-disk directory is
        // missing, escapes storageDir, or its index.html isn't a regular
        // file (e.g. the directory was replaced by a symlink after
        // sign() ran) -- re-checked on every request, not just once at
        // sign() time, since this listener outlives any single sign()
        // call by design.
        sendText(response, 404, "Not found.")
        return
      }

      const pathname = new URL(request.url ?? "/", "http://placeholder")
        .pathname
      const requestedPath = decodeURIComponent(pathname).replace(/^\/+/, "")
      const relativePath = requestedPath || "index.html"
      let filePath = await resolveRequestedFile(artifactRoot, relativePath)

      if (
        !filePath &&
        acceptsHtml(request.headers.accept) &&
        !path.posix.extname(relativePath)
      ) {
        filePath = await resolveRequestedFile(artifactRoot, "index.html")
      }

      if (!filePath) {
        sendText(response, 404, "Not found.")
        return
      }

      const body = await readFile(filePath)
      response.writeHead(
        200,
        artifactHeaders(filePath, body.byteLength, this.trustedAppOrigin),
      )
      response.end(request.method === "HEAD" ? undefined : body)
    } catch {
      sendText(response, 404, "Not found.")
    }
  }

  private resolveArtifactIdFromHost(
    hostHeader: string | undefined,
  ): string | null {
    if (!hostHeader) return null

    const host = hostHeader.trim().toLowerCase()
    const separator = host.lastIndexOf(":")
    if (separator !== -1) {
      const port = host.slice(separator + 1)
      if (port !== "443" && port !== String(this.port)) return null
    }
    return resolveProductionArtifactHostname(
      separator === -1 ? host : host.slice(0, separator),
      this.baseDomain,
    )
  }
}

function artifactHeaders(
  filePath: string,
  length: number,
  trustedAppOrigin: string,
): Record<string, string | number> {
  return {
    "content-type": contentTypeFor(filePath),
    "content-length": length,
    "cache-control": "no-store",
    // No Access-Control-Allow-Origin, ever: nothing should be able to
    // fetch() this cross-origin and read the bytes back, only navigate to
    // it (an iframe's src, which CORS never gated).
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "x-content-type-options": "nosniff",
    // frame-ancestors is the actual domain-separation boundary: only the
    // trusted control-plane origin (once it exists) and the extension
    // itself (the real client today, before that origin exists) may embed
    // preview content -- never an arbitrary website.
    "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors ${trustedAppOrigin} chrome-extension:`,
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
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}
