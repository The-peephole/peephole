import { ARTIFACT_ID_SOURCE } from "../artifactServing/staticFile"
import { FULLSTACK_PREVIEW_ID_SOURCE } from "../fullstack-preview-api/id"

const ARTIFACT_ID_PATTERN = new RegExp(`^${ARTIFACT_ID_SOURCE}$`)
const FULLSTACK_ID_PATTERN = new RegExp(`^${FULLSTACK_PREVIEW_ID_SOURCE}$`)

/** Exact single artifact label plus configured domain. No URL, port,
 * whitespace, trailing dot, or additional label normalization. HTTP Host
 * callers handle their explicitly permitted ports before using this. */
export function resolveProductionArtifactHostname(
  hostname: string,
  baseDomain: string,
): string | null {
  return resolveProductionHostname(hostname, baseDomain, ARTIFACT_ID_PATTERN)
}

/** Resolves the distinct, per-preview full-stack origin namespace. */
export function resolveProductionFullStackHostname(
  hostname: string,
  baseDomain: string,
): string | null {
  return resolveProductionHostname(hostname, baseDomain, FULLSTACK_ID_PATTERN)
}

function resolveProductionHostname(
  hostname: string,
  baseDomain: string,
  identityPattern: RegExp,
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
  const identity = normalized.slice(0, -suffix.length)
  const match = identityPattern.exec(identity)
  return match?.[0] === identity ? identity : null
}
