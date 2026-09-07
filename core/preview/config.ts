const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export class PreviewConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreviewConfigurationError"
  }
}

export function parsePreviewApiBaseUrl(
  value: string | undefined,
): string | null {
  const candidate = value?.trim()

  if (!candidate) {
    return null
  }

  let url: URL

  try {
    url = new URL(candidate)
  } catch {
    throw new PreviewConfigurationError(
      "WXT_PREVIEW_API_BASE_URL must be an absolute URL.",
    )
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new PreviewConfigurationError(
      "The preview API URL cannot contain credentials, a query, or a fragment.",
    )
  }

  const isSecure = url.protocol === "https:"
  const isLocalDevelopment =
    url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname)

  if (!isSecure && !isLocalDevelopment) {
    throw new PreviewConfigurationError(
      "The preview API must use HTTPS, except on localhost during development.",
    )
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`
  return url.toString()
}

export function getPreviewApiHostPermission(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`
}

/**
 * A preview artifact may only be embedded from a loopback HTTP origin. This
 * is the local-development artifact host's trust boundary (D-018): Peephole
 * has not yet provisioned a dedicated, registrable preview domain (see
 * IMPLEMENTATION_CHECKLIST.md, "Preview Delivery"), so no HTTPS origin is
 * approved for embedding yet.
 */
export function isTrustedPreviewArtifactUrl(value: string): boolean {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return false
  }

  return (
    !url.username &&
    !url.password &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1"
  )
}
