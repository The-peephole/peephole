import { ARTIFACT_ID_SOURCE } from "../artifactServing/staticFile"

const ARTIFACT_ID_PATTERN = new RegExp(`^${ARTIFACT_ID_SOURCE}$`)

/** Exact single artifact label plus configured domain. No URL, port,
 * whitespace, trailing dot, or additional label normalization. HTTP Host
 * callers handle their explicitly permitted ports before using this. */
export function resolveProductionArtifactHostname(
  hostname: string,
  baseDomain: string,
): string | null {
  if (
    hostname.length > 253 ||
    /[^a-zA-Z0-9.-]/.test(hostname) ||
    hostname.split(".").some((label) => label.length === 0 || label.length > 63)
  )
    return null
  const normalized = hostname.toLowerCase()
  const suffix = `.${baseDomain.toLowerCase()}`
  if (!normalized.endsWith(suffix)) return null
  const artifactId = normalized.slice(0, -suffix.length)
  const match = ARTIFACT_ID_PATTERN.exec(artifactId)
  return match?.[0] === artifactId ? artifactId : null
}
