import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { isSafeEntryPath } from "../../core/runner/archivePolicy"

/**
 * Static-file-serving primitives shared between
 * services/local-preview/artifactHost.ts (dev: one HTTP server per
 * artifact, on its own loopback port) and
 * services/production/artifactHost.ts (production: one fixed listener,
 * routing every request to an artifact root by Host header). Only *how* a
 * request gets routed to an artifact root differs between the two -- the
 * on-disk file resolution and path-safety rules below are identical, and
 * security-critical enough that they should have exactly one
 * implementation.
 */
// Anchor-free so services/production/artifactHost.ts can embed it inside a
// larger Host-header pattern (`<id>.<baseDomain>`); ARTIFACT_ID_PATTERN
// below anchors it for standalone validation.
export const ARTIFACT_ID_SOURCE = "artifact-[a-f\\d]{8}-[a-f\\d-]{27}"
export const ARTIFACT_ID_PATTERN = new RegExp(`^${ARTIFACT_ID_SOURCE}$`, "i")

/**
 * Resolves `storageDir/artifactId` to a real, on-disk directory, refusing
 * to hand it back unless: the id is syntactically valid, the resolved
 * directory doesn't escape storageDir even once every symlink along its
 * own path is followed (catches the artifact directory itself -- or any
 * of its parent segments -- being a symlink, not just a symlink inside
 * it), and it contains a real, non-symlink `index.html`. Throws a
 * descriptive error on any violation; callers decide how that becomes an
 * HTTP response (LocalArtifactHost refuses to start hosting;
 * ProductionArtifactHost turns it into a 404).
 */
export async function resolveVerifiedArtifactRoot(
  storageDir: string,
  artifactId: string,
): Promise<string> {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new Error("Invalid artifact id.")
  }

  const storageRoot = await realpath(storageDir)
  const directPath = path.join(storageRoot, artifactId)

  // Checked *before* realpath(), and independently of it: realpath()
  // resolving to somewhere still inside storageRoot (e.g. a symlink
  // planted at storageRoot/<this id> pointing at a *different*, otherwise
  // legitimate artifact's own directory) would not look like an escape at
  // all -- the target is a real directory inside storageRoot -- so it
  // would sail through the relative-path check below undetected. The
  // artifact id's own path segment must be a real directory, full stop,
  // regardless of where a symlink there might otherwise resolve to.
  const rootStat = await lstat(directPath).catch(() => null)

  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Artifact root is missing or not a real directory.")
  }

  const candidate = await realpath(directPath)
  const relative = path.relative(storageRoot, candidate)

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Artifact path escapes its storage root.")
  }

  const index = await lstat(path.join(candidate, "index.html"))

  if (!index.isFile() || index.isSymbolicLink()) {
    throw new Error("Artifact has no regular index.html file.")
  }

  return candidate
}

/**
 * Resolves a request path to a real file inside `artifactRoot`, walking
 * every path segment to reject a symlink anywhere along the way (not just
 * at the final component) and falling back to `<dir>/index.html` for a
 * directory request. Returns null (never throws) for anything unsafe or
 * missing -- callers turn that into a 404.
 */
export async function resolveRequestedFile(
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
    let current = artifactRoot
    for (const segment of relativePath.split("/")) {
      current = path.join(current, segment)
      if ((await lstat(current)).isSymbolicLink()) return null
    }
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

/** Whether a request's `Accept` header prefers HTML -- used to decide
 * whether an extensionless, otherwise-missing path should fall back to
 * `index.html` (a client-side-routed SPA navigation) rather than 404. */
export function acceptsHtml(accept: string | undefined): boolean {
  return accept?.includes("text/html") ?? false
}

export function contentTypeFor(filePath: string): string {
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
