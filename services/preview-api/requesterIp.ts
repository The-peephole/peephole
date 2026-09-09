import { isIP } from "node:net"
import type { IncomingMessage } from "node:http"

const FALLBACK_IP = "127.0.0.1"
const MAX_FORWARDED_FOR_LENGTH = 1_024
const MAX_FORWARDED_HOPS = 32

/**
 * Resolves the quota identity of the network client without granting an
 * arbitrary caller control over it. X-Forwarded-For is considered only when
 * the TCP peer is a loopback proxy. The chain is then evaluated right-to-left
 * so an untrusted hop cannot assert a client farther to its left.
 */
export function resolveRequesterIp(request: IncomingMessage): string {
  const peerIp = canonicalizeIp(request.socket.remoteAddress)

  // Keep the historical fallback for synthetic requests without a socket
  // address, but never use that fallback as evidence that the peer is trusted.
  if (!peerIp) return FALLBACK_IP
  if (!isLoopback(peerIp)) return peerIp

  const forwarded = parseForwardedFor(request.headers["x-forwarded-for"])
  if (!forwarded) return peerIp

  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const hop = forwarded[index]!
    if (!isLoopback(hop)) return hop
  }

  return peerIp
}

function parseForwardedFor(
  header: string | string[] | undefined,
): string[] | null {
  if (header === undefined) return null

  const values = Array.isArray(header) ? header : [header]
  const length =
    values.reduce((total, value) => total + value.length, 0) +
    Math.max(0, values.length - 1)
  if (
    values.length === 0 ||
    length > MAX_FORWARDED_FOR_LENGTH ||
    values.some((value) => value.length === 0)
  ) {
    return null
  }

  const entries = values.flatMap((value) => value.split(","))
  if (entries.length === 0 || entries.length > MAX_FORWARDED_HOPS) return null

  const addresses: string[] = []
  for (const entry of entries) {
    const value = entry.trim()
    if (!value) return null

    const address = canonicalizeIp(value)
    if (!address) return null
    addresses.push(address)
  }
  return addresses
}

function canonicalizeIp(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.includes("%")) return null

  const version = isIP(value)
  if (version === 4) {
    return value
      .split(".")
      .map((octet) => String(Number(octet)))
      .join(".")
  }
  if (version !== 6) return null

  let canonical: string
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    canonical = hostname.slice(1, -1)
  } catch {
    return null
  }

  // WHATWG URL serialization converts every IPv4-mapped form to this
  // canonical hexadecimal tail. Collapse it to IPv4 so mapped and native
  // spellings share one quota bucket (and mapped loopback remains trusted).
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(canonical)
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16)
    const low = Number.parseInt(mapped[2]!, 16)
    return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".")
  }

  return canonical
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."))
}
