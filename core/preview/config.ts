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

/** Build-time public DNS root for untrusted production artifacts. */
export function parsePreviewArtifactBaseDomain(
  value: string | undefined,
): string | null {
  const domain = value?.trim().toLowerCase()
  if (!domain) return null
  if (
    domain.length > 253 ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    /^[\d.]+$/.test(domain) ||
    !/^[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)+$/.test(
      domain,
    ) ||
    domain.split(".").some((label) => label.length > 63)
  )
    throw new PreviewConfigurationError(
      "WXT_PREVIEW_ARTIFACT_BASE_DOMAIN must be a DNS hostname without a scheme, port, path, query, or fragment.",
    )
  // Reject alternate IPv4 spellings normalized by the browser URL parser.
  try {
    if (new URL(`https://${domain}`).hostname !== domain) throw new Error()
  } catch {
    throw new PreviewConfigurationError(
      "WXT_PREVIEW_ARTIFACT_BASE_DOMAIN must be a DNS hostname, not an IP literal.",
    )
  }
  return domain
}

export function getPreviewFrameSrc(baseDomain?: string | null): string {
  const domain = parsePreviewArtifactBaseDomain(baseDomain ?? undefined)
  return `frame-src 'self' http://127.0.0.1:*${domain ? ` https://*.${domain}` : ""};`
}

// Same rule as services/artifactServing/staticFile.ts ARTIFACT_ID_SOURCE.
// Keep server filesystem/Node imports out of the extension bundle.
const ARTIFACT_ID_PATTERN = /^artifact-[a-f\d]{8}-[a-f\d-]{27}$/

/** Local loopback HTTP or exactly one authorized production artifact label. */
export function isTrustedPreviewArtifactUrl(
  value: string,
  productionBaseDomain?: string | null,
): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return true
  if (!productionBaseDomain || url.protocol !== "https:") return false

  // Inspect raw authority: URL.port erases explicit :443. Reject browser
  // normalization of whitespace/backslashes and even empty query/fragment.
  const authority = /^https:\/\/([a-z\d.-]+)(?:\/[^?#]*)?$/i.exec(value)
  if (
    !authority ||
    /[\s\\?#]/.test(value) ||
    url.port ||
    url.search ||
    url.hash
  )
    return false
  let domain: string | null
  try {
    domain = parsePreviewArtifactBaseDomain(productionBaseDomain)
  } catch {
    return false
  }
  if (
    !domain ||
    url.hostname !== authority[1]?.toLowerCase() ||
    url.hostname.length > 253
  )
    return false
  const suffix = `.${domain}`
  if (!url.hostname.endsWith(suffix)) return false
  const artifactId = url.hostname.slice(0, -suffix.length)
  return ARTIFACT_ID_PATTERN.test(artifactId)
}
