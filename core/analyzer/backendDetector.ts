import type {
  BackendCandidate,
  BackendDetection,
  BackendFramework,
} from "../../types/backend"
import { detectEnvironmentRequirements } from "./environmentRequirements"
import { getAllDependencies, type ParsedPackageJson } from "./packageJson"

/**
 * Strong framework evidence. `hapi` (the legacy unscoped package name) is
 * recognized alongside the current `@hapi/hapi`, improving on
 * `analyzeBuildTarget.ts`'s `SERVER_DEPENDENCIES` (which only lists the
 * legacy name) without changing that blocker's behavior at all.
 */
export const BACKEND_FRAMEWORK_DEPENDENCIES: Readonly<
  Record<string, BackendFramework>
> = {
  express: "express",
  "@nestjs/core": "nestjs",
  fastify: "fastify",
  koa: "koa",
  "@hapi/hapi": "hapi",
  hapi: "hapi",
}

/**
 * Database/server-side dependency evidence -- supporting, not framework,
 * evidence. Mirrors the non-framework portion of `analyzeBuildTarget.ts`'s
 * `SERVER_DEPENDENCIES`; kept as an independent list here so a database
 * dependency is never reported as if it confirmed a specific framework.
 */
export const DATABASE_DEPENDENCIES = new Set([
  "@prisma/client",
  "prisma",
  "pg",
  "mysql2",
  "mongoose",
  "better-sqlite3",
])

/**
 * Hosted backend clients are evidence of an *external* service, never of a
 * local backend server. Mirrors `analyzeBuildTarget.ts`'s
 * `HOSTED_BACKEND_DEPENDENCIES`.
 */
export const HOSTED_BACKEND_DEPENDENCIES = new Set([
  "@supabase/supabase-js",
  "aws-amplify",
  "firebase",
])

/** Weak evidence only -- never sufficient by itself to create a candidate. */
const CONVENTIONAL_BACKEND_DIRECTORY_NAMES = new Set([
  "backend",
  "server",
  "api",
])

/**
 * Matches exactly `<runner> <relative-path>` with nothing else -- no flags,
 * no chaining (`&&`, `;`, `|`), no substitution (`$()`, backticks), no
 * quotes. A script that does not match this narrow grammar yields no
 * entrypoint rather than a guess.
 */
const SAFE_ENTRYPOINT_SCRIPT_PATTERN =
  /^(?:node|nodemon|tsx|ts-node)\s+([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|mts|cts))$/i

/**
 * Classifies one already-fetched candidate directory's backend evidence.
 * Returns null when there is no backend evidence at all -- a directory name
 * alone, or a database dependency with no other signal absent, is not
 * treated as confirmed backend evidence (see module docs on
 * `types/backend.ts`). `packageJson` must already be null for a package.json
 * that was absent *or* malformed: a parse failure is never itself backend
 * evidence, so this function cannot tell the two apart and does not need
 * to -- callers surface a parse failure separately via
 * `backendPackageJsonParseWarning` and `BackendDetection.complete`, never by
 * fabricating a candidate here.
 */
export function detectBackendCandidate(
  sourceRoot: string,
  packageJson: ParsedPackageJson | null,
  envPresentPaths: readonly string[],
  envTextFiles: Readonly<Record<string, string>>,
  packageLockPresent = false,
): BackendCandidate | null {
  if (!packageJson) return null

  const dependencies = getAllDependencies(packageJson)
  const dependencyNames = Object.keys(dependencies)
  const frameworkName = dependencyNames.find(
    (name) => name in BACKEND_FRAMEWORK_DEPENDENCIES,
  )
  const databaseDependencies = dependencyNames.filter((name) =>
    DATABASE_DEPENDENCIES.has(name),
  )
  const hostedBackendDependencies = dependencyNames.filter((name) =>
    HOSTED_BACKEND_DEPENDENCIES.has(name),
  )

  if (!frameworkName && databaseDependencies.length === 0) {
    return null
  }

  const environmentRequirements = detectEnvironmentRequirements(
    sourceRoot,
    envPresentPaths,
    envTextFiles,
  )
  const framework: BackendFramework = frameworkName
    ? BACKEND_FRAMEWORK_DEPENDENCIES[frameworkName]!
    : "unknown"
  const evidence: string[] = []
  const warnings: string[] = []

  evidence.push(
    frameworkName
      ? `${frameworkName} dependency detected`
      : "Database/server-side dependency detected without a recognized backend framework",
  )

  if (databaseDependencies.length > 0) {
    evidence.push(
      `Database/server dependency detected: ${databaseDependencies.join(", ")}`,
    )
  }

  if (hostedBackendDependencies.length > 0) {
    warnings.push(
      `Hosted backend client detected: ${hostedBackendDependencies.join(", ")}; this is not local backend server evidence.`,
    )
  }

  const scripts = packageJson.scripts
  const entrypoint =
    resolveSafeEntrypoint(scripts.start) ?? resolveSafeEntrypoint(scripts.dev)

  if (scripts.start) {
    evidence.push(`start script detected: ${scripts.start}`)
  } else if (scripts.dev) {
    evidence.push(`dev script detected: ${scripts.dev}`)
  }

  if (entrypoint) {
    evidence.push(`Entrypoint evidence (unverified): ${entrypoint}`)
  }

  const directoryName = sourceRoot.split("/").at(-1) ?? sourceRoot
  if (CONVENTIONAL_BACKEND_DIRECTORY_NAMES.has(directoryName)) {
    evidence.push(
      `Directory name "${directoryName}" matches a conventional backend location`,
    )
  }

  return {
    sourceRoot,
    framework,
    runtime: "node",
    packageName: packageJson.name,
    packageManager: packageJson.packageManager,
    entrypoint,
    databaseDependencies,
    environmentRequirements,
    packageLockPresent,
    evidence,
    warnings,
  }
}

/**
 * Shared wording for a package.json that was found but could not be parsed
 * for a given backend candidate path. A parse failure is a read/parse gap,
 * not backend evidence -- callers must combine this warning with
 * `complete: false` and must not call `detectBackendCandidate` for the same
 * read (there is no usable `packageJson` to classify).
 */
export function backendPackageJsonParseWarning(
  sourceRoot: string,
  parseError: string,
): string {
  const path =
    sourceRoot === "." ? "package.json" : `${sourceRoot}/package.json`
  return `${path} could not be parsed: ${parseError}`
}

/** Pure assembly step: turns candidate results into the final `BackendDetection`. */
export function assembleBackendDetection(
  candidates: readonly (BackendCandidate | null)[],
  warnings: readonly string[],
  complete: boolean,
  truncated: boolean,
): BackendDetection {
  const found = candidates.filter(
    (candidate): candidate is BackendCandidate => candidate !== null,
  )

  return {
    status: found.length > 0 ? "detected" : "not-detected",
    candidates: found,
    evidence:
      found.length > 0
        ? [
            `${found.length} backend candidate${found.length === 1 ? "" : "s"} detected`,
          ]
        : [],
    warnings: Array.from(new Set(warnings)),
    complete,
    truncated,
  }
}

function resolveSafeEntrypoint(script: string | undefined): string | null {
  if (!script) return null

  const match = SAFE_ENTRYPOINT_SCRIPT_PATTERN.exec(script.trim())
  const path = match?.[1]

  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return null
  }

  return path
}
