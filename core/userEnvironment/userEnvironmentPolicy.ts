import { PREVIEW_GENERATED_SECRET_NAME_SET } from "../../types/backendRuntimeSecrets"
import { BACKEND_RUNTIME_DATABASE_ENV_NAME } from "../../types/backendRuntimeDatabase"
import type { EnvironmentRequirement } from "../../types/environment"
import {
  USER_ENVIRONMENT_LIMITS,
  type UserEnvironmentEntry,
  type UserEnvironmentNameDisposition,
} from "../../types/userEnvironment"

/**
 * The single policy for which declared variable names a user may supply a
 * value for (M12, D-035). It is shared by the extension (UX only), the
 * backend adapter (server-side plan derivation at the exact commit), the
 * plan validator, the HTTP boundary, and the tmpfs writer. The trusted
 * in-sandbox bootstrap keeps its own independent copy of the name grammar
 * and reserved list (`scripts/gvisor/secret-bootstrap.mjs`).
 *
 * A name is user-configurable only when ALL of these hold:
 * 1. the repository declares it in a bounded template at the exact commit
 *    (callers pass the server's own re-derived requirements, never a
 *    client list);
 * 2. it matches the strict uppercase grammar below;
 * 3. it is not Peephole-managed (`PORT`/`HOST`/`NODE_ENV`), not one of M10's
 *    four generated names, and not M11's `DATABASE_URL`;
 * 4. it is not client-public (bundled into frontend code) and not a
 *    process/runtime-control or network-coordinate name;
 * 5. neither the analyzer classification nor this module's own, more
 *    conservative token check reads it as secret-like, a database
 *    connection, or an external service endpoint.
 *
 * This is deliberately NOT "arbitrary environment variables": the result
 * is a small set of non-sensitive configuration names, and every value is
 * treated as public configuration (see docs/USER_PROVIDED_ENVIRONMENT.md).
 */

export class InvalidUserEnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidUserEnvironmentError"
  }
}

const STRICT_NAME_FORM = /^[A-Z][A-Z0-9_]{0,63}$/

const PLATFORM_NAMES: ReadonlySet<string> = new Set([
  "PORT",
  "HOST",
  "NODE_ENV",
])

/** Bundled into browser code by common frontend toolchains; never server
 * configuration. */
const CLIENT_PUBLIC_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "PUBLIC_",
] as const

/** Process, loader, toolchain, shell, resolver, and proxy controls. Not
 * claimed exhaustive -- the token checks below and the declared-at-commit
 * requirement narrow the set further. */
const RESERVED_EXACT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "HOSTNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GCONV_PATH",
  "LOCPATH",
  "HOSTALIASES",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FTP_PROXY",
])

const RESERVED_PREFIXES = [
  "NODE_",
  "NPM_",
  "LD_",
  "DYLD_",
  "PEEPHOLE_",
  "UV_",
  "V8_",
  "OPENSSL_",
  "SSL_",
  "GLIBC_",
  "MALLOC_",
  "COREPACK_",
  "YARN_",
  "PNPM_",
  "BUN_",
  "DENO_",
] as const

/** Deliberately broader than the analyzer's own secret pattern
 * (`core/analyzer/environmentRequirements.ts`): a false "secret-like" only
 * makes a name unsupported, never less safe. */
const SECRET_LIKE_TOKENS: ReadonlySet<string> = new Set([
  "KEY",
  "KEYS",
  "APIKEY",
  "SECRET",
  "SECRETS",
  "TOKEN",
  "TOKENS",
  "PAT",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "PRIVATE",
  "CERT",
  "CERTIFICATE",
  "SALT",
  "SIGNING",
  "SIGNATURE",
  "DSN",
  "WEBHOOK",
  "SESSION",
  "COOKIE",
  "JWT",
  "CSRF",
  "OAUTH",
])

const DATABASE_TOKENS: ReadonlySet<string> = new Set([
  "DATABASE",
  "DB",
  "POSTGRES",
  "POSTGRESQL",
  "PG",
  "MYSQL",
  "MARIADB",
  "REDIS",
  "MONGO",
  "MONGODB",
  "SQLITE",
  "SUPABASE",
  "FIREBASE",
])

/** External endpoints and network coordinates: backend-v1 is ingress-only
 * and its network position is Peephole-managed. */
const ENDPOINT_TOKENS: ReadonlySet<string> = new Set([
  "URL",
  "URI",
  "ENDPOINT",
  "HOST",
  "HOSTNAME",
  "PORT",
  "DOMAIN",
  "ORIGIN",
  "PROXY",
  "ADDR",
  "ADDRESS",
])

/** C0 controls (NUL, CR, LF, TAB, ...), DEL, C1 controls, the Unicode line
 * and paragraph separators, the byte-order mark, and any lone surrogate.
 * Iterating by code point keeps a well-formed astral pair intact. */
function hasDisallowedValueCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0xfeff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return true
    }
  }
  return false
}

/** Why `name` alone (no analyzer evidence) is or is not eligible. */
export function classifyUserEnvironmentName(
  name: string,
): UserEnvironmentNameDisposition {
  if (!STRICT_NAME_FORM.test(name)) return "invalid-name-unsupported"
  if (PLATFORM_NAMES.has(name)) return "platform-managed"
  if (PREVIEW_GENERATED_SECRET_NAME_SET.has(name)) return "generated-secret"
  if (name === BACKEND_RUNTIME_DATABASE_ENV_NAME) return "temporary-database"
  if (CLIENT_PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "client-public-unsupported"
  }
  if (
    RESERVED_EXACT_NAMES.has(name) ||
    RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return "reserved-unsupported"
  }
  const tokens = name.split("_").filter(Boolean)
  if (
    tokens.some(
      (token) => SECRET_LIKE_TOKENS.has(token) || DATABASE_TOKENS.has(token),
    )
  ) {
    return "secret-like-unsupported"
  }
  if (tokens.some((token) => ENDPOINT_TOKENS.has(token))) {
    return "external-routing-unsupported"
  }
  return "user-configurable"
}

/** Name-only eligibility, independent of any analyzer evidence. */
export function isEligibleUserEnvironmentName(name: string): boolean {
  return classifyUserEnvironmentName(name) === "user-configurable"
}

/**
 * Combines the name policy with the analyzer's own classification of one
 * declared requirement. Both must agree before a name becomes
 * user-configurable; either one alone can only make it unsupported.
 */
export function classifyUserEnvironmentRequirement(
  requirement: EnvironmentRequirement,
): UserEnvironmentNameDisposition {
  const byName = classifyUserEnvironmentName(requirement.name)
  if (byName !== "user-configurable") return byName
  if (requirement.exposure !== "server") return "client-public-unsupported"
  if (
    requirement.sensitivity === "secret-like" ||
    requirement.requirementKind === "user-required" ||
    requirement.requirementKind === "database-requirement" ||
    requirement.requirementKind === "preview-generated-candidate"
  ) {
    return "secret-like-unsupported"
  }
  if (requirement.requirementKind === "external-routing-candidate") {
    return "external-routing-unsupported"
  }
  if (requirement.requirementKind !== "unknown") return "reserved-unsupported"
  return "user-configurable"
}

export function isUserConfigurableRequirement(
  requirement: EnvironmentRequirement,
): boolean {
  return classifyUserEnvironmentRequirement(requirement) === "user-configurable"
}

/**
 * The sorted, de-duplicated user-configurable names among `requirements`,
 * or null when the backend declares more than the fixed bound (callers
 * treat null as unsupported, never as a truncated subset).
 */
export function resolveUserEnvironmentNames(
  requirements: readonly EnvironmentRequirement[],
): string[] | null {
  const names = Array.from(
    new Set(
      requirements
        .filter(isUserConfigurableRequirement)
        .map((requirement) => requirement.name),
    ),
  ).sort()
  return names.length > USER_ENVIRONMENT_LIMITS.maxEntries ? null : names
}

/** Throws unless `value` is a non-empty, bounded, single-line, well-formed
 * string. Empty is rejected so "required" means the same thing in the Side
 * Panel and at the server. Messages never include the value. */
export function assertValidUserEnvironmentValue(
  name: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new InvalidUserEnvironmentError(`The value for ${name} is invalid.`)
  }
  if (value.length === 0) {
    throw new InvalidUserEnvironmentError(`A value for ${name} is required.`)
  }
  if (utf8ByteLength(value) > USER_ENVIRONMENT_LIMITS.maxValueBytes) {
    throw new InvalidUserEnvironmentError(
      `The value for ${name} exceeds ${String(USER_ENVIRONMENT_LIMITS.maxValueBytes)} bytes.`,
    )
  }
  if (hasDisallowedValueCharacter(value)) {
    throw new InvalidUserEnvironmentError(
      `The value for ${name} contains a control, line-break, or malformed character.`,
    )
  }
  return value
}

/**
 * Structural validation of an untrusted submission -- shape, grammar,
 * eligibility, duplicates, and bounds -- without knowledge of which names
 * the backend declares. `assertUserEnvironmentMatchesNames` performs that
 * second, authoritative check against the server's own plan.
 */
export function parseUserEnvironmentEntries(
  value: unknown,
): UserEnvironmentEntry[] {
  if (!Array.isArray(value)) {
    throw new InvalidUserEnvironmentError(
      "User environment must be a list of name/value entries.",
    )
  }
  if (value.length > USER_ENVIRONMENT_LIMITS.maxEntries) {
    throw new InvalidUserEnvironmentError(
      `At most ${String(USER_ENVIRONMENT_LIMITS.maxEntries)} user environment values are allowed.`,
    )
  }
  const seen = new Set<string>()
  const entries: UserEnvironmentEntry[] = []
  let totalBytes = 0
  for (const entry of value as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "name") ||
      !Object.hasOwn(entry, "value")
    ) {
      throw new InvalidUserEnvironmentError(
        "Each user environment entry must contain exactly a name and a value.",
      )
    }
    const { name, value: rawValue } = entry as Record<string, unknown>
    if (typeof name !== "string" || !STRICT_NAME_FORM.test(name)) {
      throw new InvalidUserEnvironmentError(
        "A user environment variable name is invalid.",
      )
    }
    if (!isEligibleUserEnvironmentName(name)) {
      throw new InvalidUserEnvironmentError(
        `${name} cannot be supplied as user configuration.`,
      )
    }
    if (seen.has(name)) {
      throw new InvalidUserEnvironmentError(
        `${name} was supplied more than once.`,
      )
    }
    seen.add(name)
    const validated = assertValidUserEnvironmentValue(name, rawValue)
    totalBytes += utf8ByteLength(validated)
    if (totalBytes > USER_ENVIRONMENT_LIMITS.maxTotalValueBytes) {
      throw new InvalidUserEnvironmentError(
        `User environment values exceed ${String(USER_ENVIRONMENT_LIMITS.maxTotalValueBytes)} bytes in total.`,
      )
    }
    entries.push({ name, value: validated })
  }
  return entries.sort((left, right) => compareNames(left.name, right.name))
}

/** The submission must supply exactly the server-derived names: none
 * missing, none extra. */
export function assertUserEnvironmentMatchesNames(
  entries: readonly UserEnvironmentEntry[],
  expectedNames: readonly string[],
): void {
  const supplied = new Set(entries.map((entry) => entry.name))
  const unexpected = entries.find(
    (entry) => !expectedNames.includes(entry.name),
  )
  if (unexpected) {
    throw new InvalidUserEnvironmentError(
      `${unexpected.name} is not a user-configurable variable of this backend at this commit.`,
    )
  }
  const missing = expectedNames.find((name) => !supplied.has(name))
  if (missing) {
    throw new InvalidUserEnvironmentError(`A value for ${missing} is required.`)
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
