import { readFileSync } from "node:fs"
import { isIPv4 } from "node:net"

const PRIMARY_RESOLV_CONF = "/etc/resolv.conf"

// systemd-resolved's real, published convention for exactly this problem
// (see below) -- the same file Docker and other container runtimes check.
const SYSTEMD_RESOLVED_UPLINK_RESOLV_CONF = "/run/systemd/resolve/resolv.conf"

export interface ResolveDnsConfigSourceOptions {
  /** Returns file content, or null if it doesn't exist/can't be read.
   * Injectable so this stays unit-testable without touching the real
   * filesystem. */
  readFile?: (path: string) => string | null
}

export interface ResolvedDnsConfig {
  source: string
  /** IPv4 resolvers reachable through the sandbox's IPv4-only egress path.
   * These exact addresses receive UDP/TCP port 53 firewall exceptions. */
  nameservers: readonly string[]
}

/**
 * Picks which resolv.conf to bind-mount into the sandbox's network
 * namespace (see ociConfig.ts's "/etc/resolv.conf" mount).
 *
 * On a systemd-resolved host (most current distros, including Ubuntu and
 * Amazon Linux), /etc/resolv.conf commonly points at 127.0.0.53 -- a
 * *stub* resolver that systemd-resolved binds only within the host's own
 * default network namespace. The sandbox's network namespace has its own,
 * separate loopback interface, where nothing is listening on 127.0.0.53:
 * bind-mounting that file verbatim looks correct but silently fails every
 * DNS lookup. Confirmed on a real AWS EC2 host (Ubuntu, systemd-resolved):
 * this was invisible on WSL2, whose own /etc/resolv.conf happens to point
 * at a real, non-loopback address already, so this exact failure mode
 * never came up there.
 *
 * systemd-resolved separately publishes the actual upstream nameserver(s)
 * it forwards to at /run/systemd/resolve/resolv.conf specifically so
 * containers/sandboxes that can't reach the stub have something real to
 * use instead -- the same file Docker and other container runtimes read
 * for this. This only falls back to it when /etc/resolv.conf's own
 * nameservers are all loopback-only; an environment whose
 * /etc/resolv.conf already lists a real, reachable nameserver (WSL2's
 * own gateway-proxied resolver, a plain DHCP-assigned one, etc.) is left
 * exactly as before.
 */
export function resolveDnsConfigSource(
  options: ResolveDnsConfigSourceOptions = {},
): string {
  return resolveDnsConfig(options).source
}

export function resolveDnsConfig(
  options: ResolveDnsConfigSourceOptions = {},
): ResolvedDnsConfig {
  const readFile = options.readFile ?? defaultReadFile
  const primary = readFile(PRIMARY_RESOLV_CONF)

  const primaryNameservers = parseUsableNameservers(primary)
  if (primaryNameservers.length > 0) {
    return {
      source: PRIMARY_RESOLV_CONF,
      nameservers: primaryNameservers,
    }
  }

  const uplink = readFile(SYSTEMD_RESOLVED_UPLINK_RESOLV_CONF)
  const uplinkNameservers = parseUsableNameservers(uplink)

  if (uplinkNameservers.length > 0) {
    return {
      source: SYSTEMD_RESOLVED_UPLINK_RESOLV_CONF,
      nameservers: uplinkNameservers,
    }
  }

  // Neither file has anything obviously better -- bind-mount the primary
  // file anyway rather than fail outright; this preserves prior behavior
  // for any environment this heuristic doesn't recognize.
  return { source: PRIMARY_RESOLV_CONF, nameservers: [] }
}

/** Exported for services/production/preflight.ts, which re-checks the file
 * resolveDnsConfigSource() actually picked -- if neither candidate file has
 * a usable nameserver, resolveDnsConfigSource() still returns *something*
 * (the primary path, as a last resort), so callers that need to know
 * whether DNS will actually work must check this themselves. */
export function hasUsableNameserver(resolvConfContent: string): boolean {
  return parseUsableNameservers(resolvConfContent).length > 0
}

function parseUsableNameservers(resolvConfContent: string | null): string[] {
  if (resolvConfContent === null) return []

  const nameservers: string[] = []

  for (const line of resolvConfContent.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line)

    if (match?.[1] && isUsableIpv4Nameserver(match[1])) {
      const canonical = match[1]
        .split(".")
        .map((octet) => String(Number(octet)))
        .join(".")
      if (!nameservers.includes(canonical)) nameservers.push(canonical)
    }
  }

  return nameservers
}

function isUsableIpv4Nameserver(address: string): boolean {
  if (!isIPv4(address)) return false
  const firstOctet = Number(address.split(".")[0])
  return firstOctet !== 0 && firstOctet !== 127 && firstOctet < 224
}

function defaultReadFile(path: string): string | null {
  try {
    // Synchronous and small: this runs once per command invocation
    // alongside other cheap, synchronous OCI-spec construction -- not
    // worth threading async through buildOciRuntimeSpec's callers for.
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
