import { randomUUID } from "node:crypto"
import { request } from "node:http"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ProductionArtifactHost } from "../services/production/artifactHost"
import type { ProductionArtifactStore } from "../services/preview-api/postgres/productionArtifactStore"

const TEST_PORT = 18_788
const BASE_DOMAIN = "peepholeusercontent.dev"
const jobId = "01234567-89ab-cdef-0123-456789abcdef"

class InMemoryProductionArtifactStore implements ProductionArtifactStore {
  private readonly rows = new Map<string, Date>()
  /** Test hook: awaited right before listExpired() returns its result --
   * lets a test deterministically run a concurrent upsertMaxExpiry() in
   * the exact window between a reaper taking its candidate snapshot and
   * actually acting on it, without any sleep/timing dependence. */
  beforeListExpiredReturns?: () => Promise<void> | void

  async upsertMaxExpiry(artifactId: string, expiresAt: Date): Promise<void> {
    const existing = this.rows.get(artifactId)
    if (!existing || expiresAt.getTime() > existing.getTime()) {
      this.rows.set(artifactId, expiresAt)
    }
  }

  async get(artifactId: string): Promise<{ expiresAt: Date } | null> {
    const expiresAt = this.rows.get(artifactId)
    return expiresAt ? { expiresAt } : null
  }

  async listExpired(now: Date): Promise<string[]> {
    const result = [...this.rows.entries()]
      .filter(([, expiresAt]) => expiresAt.getTime() <= now.getTime())
      .map(([artifactId]) => artifactId)
    await this.beforeListExpiredReturns?.()
    return result
  }

  async deleteIfStillExpired(artifactId: string, now: Date): Promise<boolean> {
    const expiresAt = this.rows.get(artifactId)
    if (!expiresAt || expiresAt.getTime() > now.getTime()) return false
    this.rows.delete(artifactId)
    return true
  }

  /** Test-only inspection helper. */
  has(artifactId: string): boolean {
    return this.rows.has(artifactId)
  }
}

function newArtifactId(): string {
  return `artifact-${randomUUID()}`
}

async function writeArtifact(
  storageDir: string,
  artifactId: string,
  options: { html?: string; asset?: string } = {},
): Promise<void> {
  const dir = path.join(storageDir, artifactId)
  await mkdir(path.join(dir, "assets"), { recursive: true })
  await writeFile(
    path.join(dir, "index.html"),
    options.html ??
      '<!doctype html><script type="module" src="/assets/app.js"></script>',
  )
  await writeFile(
    path.join(dir, "assets", "app.js"),
    options.asset ?? "window.ok=1",
  )
}

function rawRequest(
  requestPath: string,
  options: { host?: string; method?: string } = {},
): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: TEST_PORT,
        method: options.method ?? "GET",
        path: requestPath,
        headers:
          options.host === undefined ? undefined : { host: options.host },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("ProductionArtifactHost", () => {
  let storageDir: string
  let store: InMemoryProductionArtifactStore
  let host: ProductionArtifactHost

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "peephole-prod-host-"))
    store = new InMemoryProductionArtifactStore()
    host = new ProductionArtifactHost({
      storageDir,
      store,
      port: TEST_PORT,
      baseDomain: BASE_DOMAIN,
    })
    await host.listen()
  })

  afterEach(async () => {
    await host.close()
    await rm(storageDir, { recursive: true, force: true })
  })

  describe("listener", () => {
    it("uses a single fixed listener for every artifact, unlike LocalArtifactHost's per-artifact port", async () => {
      const a = newArtifactId()
      const b = newArtifactId()
      await writeArtifact(storageDir, a)
      await writeArtifact(storageDir, b)

      const refA = await host.sign(a, jobId, future())
      const refB = await host.sign(b, jobId, future())

      expect(new URL(refA.url).port).toBe("")
      expect(new URL(refB.url).port).toBe("")
      expect(new URL(refA.url).hostname).toBe(`${a}.${BASE_DOMAIN}`)
      expect(new URL(refB.url).hostname).toBe(`${b}.${BASE_DOMAIN}`)
    })
  })

  describe("routing", () => {
    it("routes to the right artifact purely by Host header, on one shared listener", async () => {
      const a = newArtifactId()
      const b = newArtifactId()
      await writeArtifact(storageDir, a, { html: "<!doctype html><p>A</p>" })
      await writeArtifact(storageDir, b, { html: "<!doctype html><p>B</p>" })
      await host.sign(a, jobId, future())
      await host.sign(b, jobId, future())

      const fromA = await rawRequest("/", { host: `${a}.${BASE_DOMAIN}` })
      const fromB = await rawRequest("/", { host: `${b}.${BASE_DOMAIN}` })

      expect(fromA.status).toBe(200)
      expect(fromA.body).toContain(">A<")
      expect(fromB.status).toBe(200)
      expect(fromB.body).toContain(">B<")
    })

    it("never serves artifact B's files through artifact A's Host, by path or traversal", async () => {
      const a = newArtifactId()
      const b = newArtifactId()
      await writeArtifact(storageDir, a)
      await writeArtifact(storageDir, b, {
        html: "<!doctype html><p>other-secret</p>",
      })
      await host.sign(a, jobId, future())
      await host.sign(b, jobId, future())

      const direct = await rawRequest(`/${b}/index.html`, {
        host: `${a}.${BASE_DOMAIN}`,
      })
      const traversal = await rawRequest(`/../${b}/index.html`, {
        host: `${a}.${BASE_DOMAIN}`,
      })

      expect(direct.status).toBe(404)
      expect(traversal.status).toBe(404)
    })
  })

  describe("Vite root-relative assets", () => {
    it("serves /assets/app.js from the same artifact origin", async () => {
      const a = newArtifactId()
      await writeArtifact(storageDir, a)
      await host.sign(a, jobId, future())

      const response = await rawRequest("/assets/app.js", {
        host: `${a}.${BASE_DOMAIN}`,
      })

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("text/javascript")
      expect(response.body).toBe("window.ok=1")
    })
  })

  describe("SPA fallback", () => {
    it("falls back to index.html for an extensionless HTML navigation", async () => {
      const a = newArtifactId()
      await writeArtifact(storageDir, a)
      await host.sign(a, jobId, future())

      const response = await rawRequest("/dashboard", {
        host: `${a}.${BASE_DOMAIN}`,
      })

      // rawRequest sends no accept header by default -- exercise the real
      // "accepts html" path explicitly.
      const withAccept = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: TEST_PORT,
              method: "GET",
              path: "/dashboard",
              headers: { host: `${a}.${BASE_DOMAIN}`, accept: "text/html" },
            },
            (res) => {
              const chunks: Buffer[] = []
              res.on("data", (chunk: Buffer) => chunks.push(chunk))
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              )
            },
          )
          req.on("error", reject)
          req.end()
        },
      )

      expect(response.status).toBe(404) // no accept header -> no fallback
      expect(withAccept.status).toBe(200)
      expect(withAccept.body).toContain("<!doctype html>")
    })

    it("does not fall back for a missing asset with an extension", async () => {
      const a = newArtifactId()
      await writeArtifact(storageDir, a)
      await host.sign(a, jobId, future())

      const response = await rawRequest("/assets/missing.js", {
        host: `${a}.${BASE_DOMAIN}`,
      })

      expect(response.status).toBe(404)
    })
  })

  describe("Host header validation", () => {
    let artifactId: string

    beforeEach(async () => {
      artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await host.sign(artifactId, jobId, future())
    })

    it("accepts a valid bare Host", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(200)
    })

    it("accepts a Host carrying this listener's own port (direct/local testing)", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:${String(TEST_PORT)}`,
      })
      expect(response.status).toBe(200)
    })

    it("accepts a Host carrying :443 -- what a reverse proxy that preserves the client's original Host verbatim may forward, even though a spec-compliant client already omits the scheme's default port", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:443`,
      })
      expect(response.status).toBe(200)
    })

    it("never puts a port in the URL sign() returns, even though :443 and the listener port are both acceptable inbound", async () => {
      const ref = await host.sign(artifactId, jobId, future())
      expect(ref.url).toBe(`https://${artifactId}.${BASE_DOMAIN}/`)
      expect(ref.url).not.toContain(":443")
      expect(ref.url).not.toContain(`:${String(TEST_PORT)}`)
    })

    it("rejects :80 -- accepting it would let the upstream be reached as if it were being served directly over plain HTTP", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:80`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a Host carrying a different, arbitrary port", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:9999`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a malformed port", async () => {
      const nonNumeric = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:abc`,
      })
      const doubleColon = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}::443`,
      })
      const trailingColon = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}:`,
      })

      expect(nonNumeric.status).toBe(404)
      expect(doubleColon.status).toBe(404)
      expect(trailingColon.status).toBe(404)
    })

    it("rejects the wrong domain", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId}.evil.example`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects an extra subdomain label", async () => {
      const response = await rawRequest("/", {
        host: `extra.${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a malformed artifact id", async () => {
      const response = await rawRequest("/", {
        host: `artifact-not-a-uuid.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a missing Host", async () => {
      const response = await rawRequest("/", { host: "" })
      expect(response.status).toBe(404)
    })

    it("rejects the bare base domain with no artifact label at all", async () => {
      const response = await rawRequest("/", { host: BASE_DOMAIN })
      expect(response.status).toBe(404)
    })

    it("is case-insensitive on the Host but maps to the exact lowercase directory", async () => {
      const response = await rawRequest("/", {
        host: `${artifactId.toUpperCase()}.${BASE_DOMAIN.toUpperCase()}`,
      })
      expect(response.status).toBe(200)
    })
  })

  describe("path traversal defense", () => {
    let artifactId: string

    beforeEach(async () => {
      artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await writeFile(path.join(storageDir, "secret.txt"), "top secret")
      await host.sign(artifactId, jobId, future())
    })

    it("rejects a literal ../ traversal", async () => {
      const response = await rawRequest("/../secret.txt", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a percent-encoded ../ traversal", async () => {
      const response = await rawRequest("/%2e%2e/secret.txt", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a path containing a literal backslash", async () => {
      const response = await rawRequest("/assets%5C..%5C..%5Csecret.txt", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("rejects a malformed percent-encoded path instead of crashing", async () => {
      const response = await rawRequest("/%", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })
  })

  describe("symlink defense", () => {
    it("refuses to serve a symlinked file", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const dir = path.join(storageDir, artifactId)
      await writeFile(path.join(storageDir, "outside.txt"), "outside")

      try {
        await symlink(
          path.join(storageDir, "outside.txt"),
          path.join(dir, "linked.txt"),
        )
      } catch {
        return // symlink creation can require elevated privileges on Windows
      }

      await host.sign(artifactId, jobId, future())
      const response = await rawRequest("/linked.txt", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("refuses to serve through a symlinked directory", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const dir = path.join(storageDir, artifactId)
      const targetDir = await mkdtemp(
        path.join(os.tmpdir(), "peephole-prod-outside-dir-"),
      )
      await writeFile(path.join(targetDir, "app.js"), "window.evil=1")

      try {
        await symlink(targetDir, path.join(dir, "linkedDir"), "dir")
      } catch {
        await rm(targetDir, { recursive: true, force: true })
        return
      }

      await host.sign(artifactId, jobId, future())
      const response = await rawRequest("/linkedDir/app.js", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
      await rm(targetDir, { recursive: true, force: true })
    })

    it("refuses to sign an artifact whose index.html is a symlink", async () => {
      const artifactId = newArtifactId()
      const dir = path.join(storageDir, artifactId)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(storageDir, "real-index.html"), "<p>real</p>")

      try {
        await symlink(
          path.join(storageDir, "real-index.html"),
          path.join(dir, "index.html"),
        )
      } catch {
        return
      }

      await expect(host.sign(artifactId, jobId, future())).rejects.toThrow(
        "index.html",
      )
    })

    it("refuses to serve an artifact whose root directory is itself a symlink", async () => {
      const realId = newArtifactId()
      await writeArtifact(storageDir, realId)
      const fakeId = newArtifactId()

      try {
        await symlink(
          path.join(storageDir, realId),
          path.join(storageDir, fakeId),
          "dir",
        )
      } catch {
        return
      }

      await expect(host.sign(fakeId, jobId, future())).rejects.toThrow()
    })
  })

  describe("expiry", () => {
    it("serves 200 before expiry and 410 after, per the persistent store's clock", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z")
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const clockedHost = new ProductionArtifactHost({
        storageDir,
        store,
        port: TEST_PORT + 1,
        baseDomain: BASE_DOMAIN,
        now: () => now,
      })
      await clockedHost.listen()

      try {
        await clockedHost.sign(
          artifactId,
          jobId,
          new Date(now.getTime() + 1_000),
        )

        const before = await rawGet(
          TEST_PORT + 1,
          `${artifactId}.${BASE_DOMAIN}`,
        )
        expect(before.status).toBe(200)

        now = new Date(now.getTime() + 2_000)
        const after = await rawGet(
          TEST_PORT + 1,
          `${artifactId}.${BASE_DOMAIN}`,
        )
        expect(after.status).toBe(410)
      } finally {
        await clockedHost.close()
      }
    })

    it("never shrinks an artifact's persisted expiry when re-signed with a shorter one", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const longExpiry = future(60_000)
      const shortExpiry = future(5_000)

      await host.sign(artifactId, jobId, longExpiry)
      await host.sign(artifactId, jobId, shortExpiry)

      const metadata = await store.get(artifactId)
      expect(metadata?.expiresAt.getTime()).toBe(longExpiry.getTime())
    })

    it("does not serve an artifact with no persistent metadata even if the directory exists", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      // Deliberately never signed.

      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })
      expect(response.status).toBe(404)
    })

    it("keeps serving a still-valid artifact from a brand-new host instance sharing the same store (restart simulation)", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await host.sign(artifactId, jobId, future())
      await host.close()

      const restarted = new ProductionArtifactHost({
        storageDir,
        store, // the persistent store, not process memory, survives "restart"
        port: TEST_PORT,
        baseDomain: BASE_DOMAIN,
      })
      await restarted.listen()

      try {
        const response = await rawRequest("/", {
          host: `${artifactId}.${BASE_DOMAIN}`,
        })
        expect(response.status).toBe(200)
      } finally {
        await restarted.close()
      }
    })
  })

  describe("security headers", () => {
    it("sets no Access-Control-Allow-Origin, CORP same-origin, and the rest of the safe defaults", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await host.sign(artifactId, jobId, future())

      const response = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}`,
      })

      expect(response.headers["access-control-allow-origin"]).toBeUndefined()
      expect(response.headers["cross-origin-resource-policy"]).toBe(
        "same-origin",
      )
      expect(response.headers["referrer-policy"]).toBe("no-referrer")
      expect(response.headers["permissions-policy"]).toContain("camera=()")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors",
      )
      expect(response.headers["content-security-policy"]).not.toContain("*")
      expect(response.headers["cache-control"]).toBe("no-store")
    })
  })

  describe("HTTP method", () => {
    it("allows GET and HEAD, rejects everything else with 405", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await host.sign(artifactId, jobId, future())

      const post = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}`,
        method: "POST",
      })
      const head = await rawRequest("/", {
        host: `${artifactId}.${BASE_DOMAIN}`,
        method: "HEAD",
      })

      expect(post.status).toBe(405)
      expect(post.headers.allow).toContain("GET")
      expect(head.status).toBe(200)
    })
  })

  describe("reap()", () => {
    it("removes an expired artifact's directory and its store row", async () => {
      let now = new Date("2026-01-01T00:00:00.000Z")
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const reapingHost = new ProductionArtifactHost({
        storageDir,
        store,
        port: TEST_PORT + 2,
        baseDomain: BASE_DOMAIN,
        now: () => now,
      })
      await reapingHost.listen()

      try {
        await reapingHost.sign(
          artifactId,
          jobId,
          new Date(now.getTime() + 1_000),
        )
        now = new Date(now.getTime() + 2_000)

        const removed = await reapingHost.reap()

        expect(removed).toContain(artifactId)
        expect(store.has(artifactId)).toBe(false)
        await expect(
          rm(path.join(storageDir, artifactId), { recursive: false }),
        ).rejects.toThrow() // already gone
      } finally {
        await reapingHost.close()
      }
    })

    it("does not touch a still-valid artifact", async () => {
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      await host.sign(artifactId, jobId, future())

      const removed = await host.reap()

      expect(removed).not.toContain(artifactId)
      expect(store.has(artifactId)).toBe(true)
    })

    it("eventually sweeps an orphaned directory that was never signed, once past the grace period", async () => {
      // Starts at the real current time (not a fixed past date): reap()
      // compares this fake clock against the *real* mtime the directory
      // was just created with, so the fake clock must start at or after
      // that real mtime for the "not yet past grace" / "past grace" steps
      // below to mean what they say.
      let now = new Date()
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId) // never signed
      const orphanHost = new ProductionArtifactHost({
        storageDir,
        store,
        port: TEST_PORT + 3,
        baseDomain: BASE_DOMAIN,
        now: () => now,
      })
      await orphanHost.listen()

      try {
        const tooSoon = await orphanHost.reap()
        expect(tooSoon).not.toContain(artifactId)

        now = new Date(now.getTime() + 3 * 60 * 60_000)
        const removed = await orphanHost.reap()
        expect(removed).toContain(artifactId)
      } finally {
        await orphanHost.close()
      }
    })

    it("does not destroy an artifact re-signed with a future expiry after reap() has already listed it as a candidate", async () => {
      // Deterministic reproduction of the exact race a stale-listing reaper
      // is vulnerable to: (1) reap() snapshots its expired candidates, (2)
      // before it acts on any of them, a concurrent build-cache-hit sign()
      // extends the same artifact into the future, (3) reap() must not go
      // on to destroy it anyway just because its snapshot said "expired".
      // The interleaving is forced by a store hook, not by sleeping, so
      // this can't flake on timing.
      let now = new Date()
      const artifactId = newArtifactId()
      await writeArtifact(storageDir, artifactId)
      const raceStore = new InMemoryProductionArtifactStore()
      const raceHost = new ProductionArtifactHost({
        storageDir,
        store: raceStore,
        port: TEST_PORT + 4,
        baseDomain: BASE_DOMAIN,
        now: () => now,
      })
      await raceHost.listen()

      try {
        await raceHost.sign(artifactId, jobId, new Date(now.getTime() + 1_000))
        now = new Date(now.getTime() + 2_000) // now expired

        let resignSucceeded = false
        raceStore.beforeListExpiredReturns = async () => {
          raceStore.beforeListExpiredReturns = undefined // fire once
          await raceHost.sign(
            artifactId,
            jobId,
            new Date(now.getTime() + 60_000),
          )
          resignSucceeded = true
        }

        const removed = await raceHost.reap()

        expect(resignSucceeded).toBe(true)
        expect(removed).not.toContain(artifactId)
        expect(await raceStore.get(artifactId)).not.toBeNull()

        const response = await rawGet(
          TEST_PORT + 4,
          `${artifactId}.${BASE_DOMAIN}`,
        )
        expect(response.status).toBe(200)
      } finally {
        await raceHost.close()
      }
    })
  })
})

function future(ms = 60_000): Date {
  return new Date(Date.now() + ms)
}

function rawGet(port: number, hostHeader: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        headers: { host: hostHeader },
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}
