/**
 * Common safety validator for untrusted external URLs sourced from
 * repository/GitHub metadata (repository homepage, GitHub Deployment
 * `environment_url`). It never fetches, proxies, or embeds these URLs --
 * Peephole only ever renders them as `target="_blank"` navigation links -- so
 * this validator's job is to decide whether a URL is safe to present as a
 * clickable external link, not whether it is reachable.
 *
 * Policy:
 * - only `https:` is accepted, unless `allowHttp` is set, in which case
 *   plain `http:` is also accepted (used for the repository homepage, which
 *   has a pre-existing "normalized HTTP(S)" contract; every other rule below
 *   still applies);
 * - every other scheme is rejected, including `javascript:`, `data:`,
 *   `file:`, `blob:`, and `chrome-extension:` -- rejected implicitly by the
 *   scheme allowlist above rather than by name;
 * - no embedded username/password;
 * - no loopback, private (RFC 1918), link-local, unique-local (IPv6), or
 *   CGNAT (100.64.0.0/10) IP literal, in either IPv4 or IPv6 form (including
 *   an IPv4-mapped IPv6 literal); `localhost`/`*.localhost` is rejected the
 *   same way. This stage targets public deployed sites only -- GitHub
 *   Pages-style or local-development hosts are not special-cased in;
 * - no control characters and a bounded overall length.
 */

const MAX_EXTERNAL_URL_LENGTH = 2048

export interface ExternalUrlPolicyOptions {
  /** Also accept `http:` (used only for the repository homepage). */
  allowHttp?: boolean
}

export function isSafeExternalUrl(
  value: unknown,
  options: ExternalUrlPolicyOptions = {},
): value is string {
  if (typeof value !== "string") return false
  if (value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) return false
  if (hasControlCharacters(value)) return false

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  const allowedProtocols = options.allowHttp
    ? new Set(["https:", "http:"])
    : new Set(["https:"])
  if (!allowedProtocols.has(url.protocol)) return false
  if (url.username !== "" || url.password !== "") return false
  if (isDisallowedHostname(url.hostname)) return false

  return true
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isDisallowedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === "localhost" || lower.endsWith(".localhost")) return true

  const literal = stripIpv6Brackets(lower)
  const ipv4 = parseIpv4(literal)
  if (ipv4) return isDisallowedIpv4(ipv4)
  if (literal.includes(":")) return isDisallowedIpv6(literal)

  return false
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
}

type Ipv4Octets = [number, number, number, number]

function parseIpv4(value: string): Ipv4Octets | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return null

  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number)
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return null
  }
  return octets as Ipv4Octets
}

function isDisallowedIpv4([a, b]: Ipv4Octets): boolean {
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (RFC 6598)
  if (a === 0) return true // "this network"
  return false
}

/** Expands a syntactically valid IPv6 literal (no zone id) into 8 groups. */
function expandIpv6Groups(value: string): number[] | null {
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":")
    if (lastColon === -1) return null
    const head = value.slice(0, lastColon + 1) + "0:0"
    const ipv4 = parseIpv4(value.slice(lastColon + 1))
    if (!ipv4) return null
    const headGroups = expandIpv6Groups(head)
    if (!headGroups) return null
    return [
      ...headGroups.slice(0, 6),
      (ipv4[0] << 8) | ipv4[1],
      (ipv4[2] << 8) | ipv4[3],
    ]
  }

  const parts = value.split("::")
  if (parts.length > 2) return null

  const parseSide = (side: string): number[] | null => {
    if (side === "") return []
    const groups = side.split(":")
    const parsed = groups.map((group) =>
      /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
    )
    return parsed.some(Number.isNaN) ? null : parsed
  }

  if (parts.length === 1) {
    const groups = parseSide(parts[0]!)
    return groups && groups.length === 8 ? groups : null
  }

  const head = parseSide(parts[0]!)
  const tail = parseSide(parts[1]!)
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (missing <= 0) return null
  return [...head, ...new Array(missing).fill(0), ...tail]
}

function isDisallowedIpv6(value: string): boolean {
  const groups = expandIpv6Groups(value)
  if (!groups) return true // fail closed on anything we cannot parse

  if (groups.every((group) => group === 0)) return true // :: (unspecified)
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true // ::1 loopback
  }
  if ((groups[0]! & 0xffc0) >>> 0 === 0xfe80) return true // fe80::/10
  if ((groups[0]! & 0xfe00) >>> 0 === 0xfc00) return true // fc00::/7

  const isMappedV4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isMappedV4) {
    const ipv4: Ipv4Octets = [
      groups[6]! >>> 8,
      groups[6]! & 0xff,
      groups[7]! >>> 8,
      groups[7]! & 0xff,
    ]
    if (isDisallowedIpv4(ipv4)) return true
  }

  return false
}
