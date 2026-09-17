import type {
  EnvironmentExposure,
  EnvironmentRequirement,
  EnvironmentRequirementKind,
  EnvironmentSensitivity,
} from "../../types/environment"
import { ENV_TEMPLATE_FILENAMES } from "./envTemplateFiles"

const PUBLIC_CLIENT_NAME_PATTERN = /^(?:VITE_|NEXT_PUBLIC_)/

/**
 * A narrow, infrastructure-style allowlist. Only variables a *future*
 * Peephole runtime could plausibly set deterministically without any
 * external input -- never a secret. This stage never sets any of these.
 */
const AUTO_CONFIGURABLE_NAMES = new Set(["PORT", "HOST", "NODE_ENV"])

/**
 * A narrow allowlist of names a *future* ephemeral-secret stage could
 * plausibly generate itself (a random session/signing value with no
 * external dependency). This stage never generates, stores, or transmits
 * any value for these -- see the module doc on `types/environment.ts`.
 */
const PREVIEW_GENERATED_SECRET_NAMES = new Set([
  "JWT_SECRET",
  "SESSION_SECRET",
  "COOKIE_SECRET",
  "CSRF_SECRET",
])

/**
 * Broad secret-like name signal, mirroring `environmentDetector.ts`'s
 * `SECRET_NAME_PATTERN` plus `CLIENT_SECRET` explicitly (already implicitly
 * covered by the generic `SECRET` token there too). This is an independent
 * classification for the richer requirement model; it does not replace or
 * feed the existing `SECRET_ENV_REQUIRED` blocker path.
 */
const USER_REQUIRED_SECRET_PATTERN =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PAT|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET)(?:_|$)/i

const DATABASE_NAME_PATTERN =
  /(?:^|_)(?:DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|REDIS_URL|MONGO_URL|MONGODB_URI)(?:_|$)/i

const EXTERNAL_ROUTING_NAME_PATTERN =
  /(?:^|_)(?:API_URL|API_BASE_URL|BASE_URL)$/i

/**
 * Classifies bounded, already-fetched environment *template* variable names
 * for one source root. Never reads a value -- only the declared name -- and
 * never generates, stores, or transmits anything. See the module docs on
 * `types/environment.ts` for the full policy.
 */
export function detectEnvironmentRequirements(
  sourceRoot: string,
  presentPaths: readonly string[],
  textFiles: Readonly<Record<string, string>>,
): EnvironmentRequirement[] {
  const requirements = new Map<string, EnvironmentRequirement>()

  for (const templateName of ENV_TEMPLATE_FILENAMES) {
    if (!presentPaths.includes(templateName)) continue

    const content = textFiles[templateName]
    if (!content) continue

    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=/)
      const name = match?.[1]

      if (!name || requirements.has(name)) continue

      requirements.set(
        name,
        classifyEnvironmentRequirement(name, sourceRoot, templateName),
      )
    }
  }

  return Array.from(requirements.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

function classifyEnvironmentRequirement(
  name: string,
  sourceRoot: string,
  sourceTemplate: string,
): EnvironmentRequirement {
  const exposure: EnvironmentExposure = PUBLIC_CLIENT_NAME_PATTERN.test(name)
    ? "client-public"
    : "server"
  const evidence: string[] = []
  const warnings: string[] = []
  let requirementKind: EnvironmentRequirementKind = "unknown"
  let sensitivity: EnvironmentSensitivity = "unknown"

  if (AUTO_CONFIGURABLE_NAMES.has(name)) {
    requirementKind = "auto-configurable"
    sensitivity = "public"
    evidence.push(
      "Infrastructure-style variable name recognized as a future auto-configurable candidate",
    )
  } else if (DATABASE_NAME_PATTERN.test(name)) {
    requirementKind = "database-requirement"
    sensitivity = "secret-like"
    evidence.push(
      "Database connection requirement detected; temporary managed database provisioning is not implemented",
    )
  } else if (PREVIEW_GENERATED_SECRET_NAMES.has(name)) {
    requirementKind = "preview-generated-candidate"
    sensitivity = "secret-like"
    evidence.push(
      "Recognized as a future preview-generated secret candidate; no value is generated in this stage",
    )
  } else if (USER_REQUIRED_SECRET_PATTERN.test(name)) {
    requirementKind = "user-required"
    sensitivity = "secret-like"
    evidence.push(
      "Secret-like external credential or configuration name detected",
    )
  } else if (EXTERNAL_ROUTING_NAME_PATTERN.test(name)) {
    requirementKind = "external-routing-candidate"
    sensitivity = "public"
    evidence.push(
      "External service or future routing target detected; no URL is generated or rewritten in this stage",
    )
  } else if (exposure === "client-public") {
    // A client-public prefix with no other identifying evidence is treated
    // as ordinary public configuration, matching the VITE_/NEXT_PUBLIC_
    // bundling convention -- never as false certainty for anything else.
    sensitivity = "public"
  }

  if (exposure === "client-public" && sensitivity === "secret-like") {
    warnings.push(
      "Secret-like variable name is exposed through a client-public prefix.",
    )
  }

  return {
    name,
    sourceRoot,
    sourceTemplate,
    exposure,
    requirementKind,
    sensitivity,
    evidence,
    warnings,
  }
}
