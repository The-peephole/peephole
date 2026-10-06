/**
 * Narrow parser for the IPv4 `/proc/net/route` table a sandboxed child reads
 * from inside gVisor. Once runsc starts, it imports the namespace's routes
 * into its own netstack, so this -- not `ip -n <namespace> route` on the host
 * -- is the route table the sandboxed process actually uses.
 */
export interface ProcNetRoute {
  iface: string
  destination: string
  gateway: string
  mask: string
  /** Null when the mask is not a contiguous prefix. */
  prefixLength: number | null
}

const HEADER = ["Iface", "Destination", "Gateway", "Flags"]
const HEX_IPV4 = /^[0-9A-Fa-f]{8}$/

/** Throws on any line it cannot parse exactly, so a malformed or truncated
 * table can never be read as "no matching route". */
export function parseProcNetRoute(text: string): ProcNetRoute[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  const header = lines[0]?.trim().split(/\s+/u) ?? []
  if (HEADER.some((name, index) => header[index] !== name)) {
    throw new Error(
      "Route table does not start with the /proc/net/route header.",
    )
  }
  const destinationIndex = header.indexOf("Destination")
  const gatewayIndex = header.indexOf("Gateway")
  const maskIndex = header.indexOf("Mask")
  if (maskIndex < 0) {
    throw new Error("Route table header has no Mask column.")
  }

  return lines.slice(1).map((line, index) => {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < header.length) {
      throw new Error(`Route table line ${String(index + 1)} is truncated.`)
    }
    const mask = hexToIpv4(fields[maskIndex] ?? "")
    return {
      iface: fields[0] ?? "",
      destination: hexToIpv4(fields[destinationIndex] ?? ""),
      gateway: hexToIpv4(fields[gatewayIndex] ?? ""),
      mask,
      prefixLength: prefixLengthOf(mask),
    }
  })
}

/** A default route matches every destination: an all-zero mask. */
export function isDefaultRoute(route: ProcNetRoute): boolean {
  return route.mask === "0.0.0.0"
}

/** `/proc/net/route` stores each address as host-order (little-endian) hex. */
function hexToIpv4(hex: string): string {
  if (!HEX_IPV4.test(hex)) {
    throw new Error(`Route table address "${hex}" is not 8 hex digits.`)
  }
  const bytes = [6, 4, 2, 0].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  )
  return bytes.join(".")
}

function prefixLengthOf(mask: string): number | null {
  const bits = mask
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("")
  if (!/^1*0*$/u.test(bits)) return null
  const firstZero = bits.indexOf("0")
  return firstZero === -1 ? 32 : firstZero
}
