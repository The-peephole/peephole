import { request } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { LocalArtifactHost } from "../services/local-preview/artifactHost"

const artifactId = "artifact-01234567-89ab-cdef-0123-456789abcdef"
const jobId = "01234567-89ab-cdef-0123-456789abcdef"

describe("LocalArtifactHost", () => {
  let storageDir: string
  let host: LocalArtifactHost

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(os.tmpdir(), "peephole-host-test-"))
    const artifactDir = path.join(storageDir, artifactId)
    await mkdir(path.join(artifactDir, "assets"), { recursive: true })
    await writeFile(
      path.join(artifactDir, "index.html"),
      '<!doctype html><script type="module" src="/assets/app.js"></script>',
    )
    await writeFile(path.join(artifactDir, "assets", "app.js"), "window.ok=1")
    host = new LocalArtifactHost({ storageDir })
  })

  afterEach(async () => {
    await host.close()
    await rm(storageDir, { recursive: true, force: true })
  })

  it("serves an artifact from its own loopback origin with safe headers", async () => {
    const artifact = await host.sign(
      artifactId,
      jobId,
      new Date(Date.now() + 60_000),
    )
    const index = await fetch(artifact.url)
    const asset = await fetch(new URL("assets/app.js", artifact.url))

    expect(index.status).toBe(200)
    expect(index.headers.get("content-type")).toContain("text/html")
    expect(index.headers.get("permissions-policy")).toContain("camera=()")
    expect(await index.text()).toContain("/assets/app.js")
    expect(asset.headers.get("content-type")).toContain("text/javascript")
    expect(await asset.text()).toBe("window.ok=1")
  })

  it("uses index.html as a navigation fallback but rejects traversal", async () => {
    const artifact = await host.sign(
      artifactId,
      jobId,
      new Date(Date.now() + 60_000),
    )
    const navigation = await fetch(new URL("dashboard", artifact.url), {
      headers: { accept: "text/html" },
    })
    const traversal = await rawRequest(artifact.url, "/%2e%2e/secret.txt")

    expect(navigation.status).toBe(200)
    expect(await navigation.text()).toContain("<!doctype html>")
    expect(traversal.status).toBe(404)
  })

  it("expires an artifact and returns a clear expired state", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z")
    const expiringHost = new LocalArtifactHost({
      storageDir,
      now: () => now,
    })

    try {
      const artifact = await expiringHost.sign(
        artifactId,
        jobId,
        new Date(now.getTime() + 1_000),
      )
      const beforeExpiry = await fetch(artifact.url)
      expect(beforeExpiry.status).toBe(200)

      now = new Date(now.getTime() + 2_000)
      const afterExpiry = await fetch(artifact.url)
      expect(afterExpiry.status).toBe(410)
    } finally {
      await expiringHost.close()
    }
  })

  it("rejects invalid identifiers and artifacts without index.html", async () => {
    await expect(
      host.sign("../escape", jobId, new Date(Date.now() + 60_000)),
    ).rejects.toThrow("artifact id")

    const missingId = "artifact-11111111-1111-1111-1111-111111111111"
    await mkdir(path.join(storageDir, missingId))
    await expect(
      host.sign(missingId, jobId, new Date(Date.now() + 60_000)),
    ).rejects.toThrow("index.html")
  })
})

async function rawRequest(
  baseUrl: string,
  requestPath: string,
): Promise<{ status: number }> {
  const url = new URL(baseUrl)

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
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
