import {
  PREVIEW_GENERATED_SECRET_NAME_SET,
  type PreviewGeneratedSecretName,
} from "../../types/backendRuntimeSecrets"

export class InvalidGeneratedSecretNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidGeneratedSecretNameError"
  }
}

/** Peephole's own fixed infrastructure names (`types/backendRuntime.ts`'s
 * `platformEnvironment`) -- a generated-secret name may never collide with
 * one of these. */
const PLATFORM_ENVIRONMENT_NAMES = new Set(["PORT", "HOST", "NODE_ENV"])

/** A client-public bundling prefix must never be eligible for server secret
 * material -- see docs/EPHEMERAL_SECRETS.md section 15 "Frontend safety". */
const CLIENT_PUBLIC_NAME_PATTERN = /^(?:VITE_|NEXT_PUBLIC_)/

/**
 * Defense-in-depth against process-affecting/reserved names, independent of
 * (and in addition to) fixed-allowlist membership -- so a future, careless
 * widening of `PREVIEW_GENERATED_SECRET_NAMES` still cannot smuggle one of
 * these through. Not claimed to be exhaustive -- see
 * docs/EPHEMERAL_SECRETS.md section 12's bounds discussion.
 */
const RESERVED_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^PATH$/,
  /^LD_PRELOAD$/,
  /^LD_LIBRARY_PATH$/,
  /^HOME$/,
  /^SHELL$/,
  /^ENV$/,
  /^BASH_ENV$/,
  /^NPM_CONFIG_/i,
  /^PEEPHOLE_/,
]

/** The strict env-name form from docs/EPHEMERAL_SECRETS.md section 12:
 * uppercase-leading, uppercase/digit/underscore only, bounded length. */
const STRICT_ENV_NAME_FORM = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * Whether `name` is currently eligible to receive Peephole-generated secret
 * material. Every gate below is checked independently of fixed-allowlist
 * membership -- see the module doc comment on `RESERVED_ENV_NAME_PATTERNS`.
 */
export function isEligiblePreviewGeneratedSecretName(
  name: string,
): name is PreviewGeneratedSecretName {
  if (!STRICT_ENV_NAME_FORM.test(name)) return false
  if (CLIENT_PUBLIC_NAME_PATTERN.test(name)) return false
  if (PLATFORM_ENVIRONMENT_NAMES.has(name)) return false
  if (RESERVED_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return false
  }
  return PREVIEW_GENERATED_SECRET_NAME_SET.has(name)
}

/** Throws `InvalidGeneratedSecretNameError` unless `name` is eligible. */
export function assertEligiblePreviewGeneratedSecretName(
  name: string,
): PreviewGeneratedSecretName {
  if (!isEligiblePreviewGeneratedSecretName(name)) {
    throw new InvalidGeneratedSecretNameError(
      `"${name}" is not an eligible preview-generated secret name.`,
    )
  }
  return name
}

/**
 * Validates a whole collection at once: every name must be individually
 * eligible, and no name may repeat. Because eligibility already requires
 * fixed-allowlist membership, the returned array can never exceed
 * `PREVIEW_GENERATED_SECRET_NAMES`'s own length -- there is deliberately no
 * separate "max count" constant here (see docs/EPHEMERAL_SECRETS.md's
 * bounds discussion; this PR ties the bound to the allowlist itself rather
 * than introducing headroom that could later admit an unsupported name).
 */
export function assertValidGeneratedSecretNames(
  names: readonly string[],
): PreviewGeneratedSecretName[] {
  const seen = new Set<string>()
  const validated: PreviewGeneratedSecretName[] = []
  for (const name of names) {
    if (seen.has(name)) {
      throw new InvalidGeneratedSecretNameError(
        `Duplicate generated secret name: "${name}".`,
      )
    }
    seen.add(name)
    validated.push(assertEligiblePreviewGeneratedSecretName(name))
  }
  return validated
}
