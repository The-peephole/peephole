import { readFileSync } from "node:fs"

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
  const readFile = options.readFile ?? defaultReadFile
  const primary = readFile(PRIMARY_RESOLV_CONF)

  if (primary !== null && hasUsableNameserver(primary)) {
    return PRIMARY_RESOLV_CONF
  }

  const uplink = readFile(SYSTEMD_RESOLVED_UPLINK_RESOLV_CONF)

  if (uplink !== null && hasUsableNameserver(uplink)) {
    return SYSTEMD_RESOLVED_UPLINK_RESOLV_CONF
  }

  // Neither file has anything obviously better -- bind-mount the primary
  // file anyway rather than fail outright; this preserves prior behavior
  // for any environment this heuristic doesn't recognize.
  return PRIMARY_RESOLV_CONF
}

function hasUsableNameserver(resolvConfContent: string): boolean {
  return parseNameservers(resolvConfContent).some(
    (address) => !isLoopbackAddress(address),
  )
}

function parseNameservers(resolvConfContent: string): string[] {
  const nameservers: string[] = []

  for (const line of resolvConfContent.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line)

    if (match?.[1]) {
      nameservers.push(match[1])
    }
  }

  return nameservers
}

function isLoopbackAddress(address: string): boolean {
  const stripped = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "")

  if (stripped === "::1") {
    return true
  }

  const ipv4Match = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(stripped)
  return ipv4Match !== null && Number(ipv4Match[1]) === 127
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
