export const MAX_FULLSTACK_REQUEST_TARGET_BYTES = 4_096

export interface ValidatedRequestTarget {
  /** Original, byte-for-byte request target forwarded upstream. */
  raw: string
  /** Decoded pathname for safe static-file lookup only. */
  decodedPathname: string
  routesToBackend: boolean
}

/** Validates origin-form before any URL parser can normalize dot segments. */
export function validateFullStackRequestTarget(
  target: string,
): ValidatedRequestTarget | null {
  if (
    Buffer.byteLength(target) > MAX_FULLSTACK_REQUEST_TARGET_BYTES ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    target.includes("\\") ||
    hasControlCharacter(target) ||
    /%(?![a-f\d]{2})/i.test(target)
  ) {
    return null
  }

  const queryIndex = target.indexOf("?")
  const rawPathname = queryIndex === -1 ? target : target.slice(0, queryIndex)
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(rawPathname)) return null

  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(rawPathname)
  } catch {
    return null
  }
  if (
    decodedPathname.includes("\\") ||
    hasControlCharacter(decodedPathname) ||
    decodedPathname
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    return null
  }

  return {
    raw: target,
    decodedPathname,
    routesToBackend: rawPathname === "/api" || rawPathname.startsWith("/api/"),
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
