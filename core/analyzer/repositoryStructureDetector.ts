import type { Framework } from "../../types/analysis"
import type {
  ProjectCandidateRole,
  RepositoryProjectCandidate,
  RepositoryStructure,
  RepositoryStructureLayout,
} from "../../types/structure"
import { isRepositorySafePathSegment } from "../github/repositoryPath"
import { getAllDependencies, type ParsedPackageJson } from "./packageJson"

/** Bounded single-level directory listings performed for `dir/*` patterns. */
export const MAX_STRUCTURE_DIRECTORY_LISTINGS = 8
/** Bounded subdirectories considered from any one listed directory. */
export const MAX_STRUCTURE_DIRECTORY_ENTRIES = 200
/** Bounded number of candidate paths probed for a nested package.json. */
export const MAX_STRUCTURE_CANDIDATE_PROBES = 20
/** Bounded number of projects surfaced in a result, root included. */
export const MAX_STRUCTURE_PROJECT_CANDIDATES = 20
/** Bounded size of a single nested package.json read. */
export const MAX_NESTED_PACKAGE_JSON_BYTES = 256 * 1024
/** Bounded total bytes read across every nested package.json probe. */
export const MAX_STRUCTURE_TOTAL_BYTES = 512 * 1024

/**
 * Conventional directory names probed directly for their own package.json.
 */
const DIRECT_CONVENTIONAL_DIRECTORIES = [
  "frontend",
  "backend",
  "client",
  "web",
] as const

/**
 * Conventional directory names treated as containers rather than projects:
 * never probed for their own package.json, but bounded-listed exactly like a
 * declared `dir/*` wildcard so their immediate `type: "dir"` children can be
 * discovered even without a workspace declaration.
 */
const CONTAINER_CONVENTIONAL_DIRECTORIES = ["apps", "packages"] as const

const FRONTEND_FRAMEWORK_DEPENDENCIES = [
  "vite",
  "react",
  "vue",
  "svelte",
  "next",
]

export type WorkspacePatternClassification =
  | { kind: "literal"; path: string }
  | { kind: "wildcard"; parentDir: string }
  | { kind: "unsupported"; pattern: string }

export interface WorkspacePatternParseResult {
  patterns: string[] | null
  warning: string | null
}

/**
 * Extracts declared workspace glob patterns from a parsed package.json
 * `workspaces` field. Supports the array form and the `{ packages: [...] }`
 * object form; anything else is reported as a warning, never guessed.
 */
export function parsePackageJsonWorkspacePatterns(
  workspaces: unknown,
): WorkspacePatternParseResult {
  if (workspaces === undefined) {
    return { patterns: null, warning: null }
  }

  let raw: unknown

  if (Array.isArray(workspaces)) {
    raw = workspaces
  } else if (isObject(workspaces) && Array.isArray(workspaces.packages)) {
    raw = workspaces.packages
  } else {
    return {
      patterns: null,
      warning: "package.json workspaces field has an unsupported shape.",
    }
  }

  const entries = raw as unknown[]

  if (!entries.every((entry) => typeof entry === "string")) {
    return {
      patterns: null,
      warning: "package.json workspaces field contains a non-string entry.",
    }
  }

  const patterns = entries as string[]

  if (patterns.length === 0) {
    return {
      patterns: null,
      warning: "package.json workspaces field is empty.",
    }
  }

  return { patterns, warning: null }
}

/**
 * Reads the bounded `packages:` subset of pnpm-workspace.yaml, e.g.:
 *
 *   packages:
 *     - "apps/*"
 *     - "packages/*"
 *
 * This is not a YAML parser. Anything outside this simple list form (flow
 * arrays, anchors, multi-document files, nested maps) is reported as a
 * warning rather than guessed.
 */
export function parsePnpmWorkspacePackages(
  content: string,
): WorkspacePatternParseResult {
  const lines = content.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) =>
    /^packages\s*:\s*$/.test(line.trim()),
  )

  if (headerIndex === -1) {
    return {
      patterns: null,
      warning: "pnpm-workspace.yaml packages field could not be parsed.",
    }
  }

  const patterns: string[] = []

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ""

    if (line.trim() === "") continue
    if (/^\S/.test(line)) break

    const match = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line)

    if (!match?.[1]) {
      return {
        patterns: null,
        warning: "pnpm-workspace.yaml contains an unsupported packages entry.",
      }
    }

    patterns.push(match[1].trim())
  }

  if (patterns.length === 0) {
    return {
      patterns: null,
      warning: "pnpm-workspace.yaml packages field is empty or unsupported.",
    }
  }

  return { patterns, warning: null }
}

/**
 * Classifies one workspace glob pattern into a bounded, safely handled
 * shape. Only an exact 1-2 segment literal path, or a `dir/*` single-level
 * wildcard, is supported; everything else (negation, `**`, mid-pattern
 * wildcards, absolute paths, `..`) is unsupported rather than guessed.
 */
export function classifyWorkspacePattern(
  pattern: string,
): WorkspacePatternClassification {
  const trimmed = pattern.trim()

  if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("/")) {
    return { kind: "unsupported", pattern }
  }

  const segments = trimmed.split("/")

  if (segments.length === 0 || segments.length > 2) {
    return { kind: "unsupported", pattern }
  }

  const firstSegment = segments[0] ?? ""

  if (segments.length === 2 && segments[1] === "*") {
    return isRepositorySafePathSegment(firstSegment)
      ? { kind: "wildcard", parentDir: firstSegment }
      : { kind: "unsupported", pattern }
  }

  return segments.every(isRepositorySafePathSegment)
    ? { kind: "literal", path: segments.join("/") }
    : { kind: "unsupported", pattern }
}

export interface StructureCandidatePlan {
  literalPaths: string[]
  wildcardParents: string[]
  unsupportedPatterns: string[]
}

/**
 * Pure planning step: decides which repository-relative paths are worth
 * probing for a nested package.json, from declared workspace patterns and
 * conventional root directory names. Performs no I/O.
 */
export function planStructureCandidatePaths(options: {
  workspacePatterns: readonly string[]
  rootDirectories: readonly string[]
}): StructureCandidatePlan {
  const literalPaths = new Set<string>()
  const wildcardParents = new Set<string>()
  const unsupportedPatterns: string[] = []

  for (const pattern of options.workspacePatterns) {
    const classification = classifyWorkspacePattern(pattern)

    if (classification.kind === "literal") {
      literalPaths.add(classification.path)
    } else if (classification.kind === "wildcard") {
      wildcardParents.add(classification.parentDir)
    } else {
      unsupportedPatterns.push(classification.pattern)
    }
  }

  for (const name of DIRECT_CONVENTIONAL_DIRECTORIES) {
    if (options.rootDirectories.includes(name) && !wildcardParents.has(name)) {
      literalPaths.add(name)
    }
  }

  // Container directories are never probed directly; they are listed like a
  // `dir/*` wildcard so their immediate children become candidates instead.
  // Adding to the same Set a workspace pattern may have already populated
  // naturally dedupes a repeated listing.
  for (const name of CONTAINER_CONVENTIONAL_DIRECTORIES) {
    if (options.rootDirectories.includes(name)) {
      wildcardParents.add(name)
    }
  }

  return {
    literalPaths: Array.from(literalPaths),
    wildcardParents: Array.from(wildcardParents),
    unsupportedPatterns,
  }
}

export interface StructureCandidateProbe {
  path: string
  /** Parsed package.json content, or null when absent (404) at this path. */
  packageJson: ParsedPackageJson | null
  /** Set when a package.json existed at this path but could not be parsed. */
  parseError: string | null
  /** Set when the GitHub request itself failed (not a plain absent file). */
  requestError: string | null
}

export interface StructureDiscoveryInput {
  rootFramework: Framework
  rootPackageJsonPresent: boolean
  rootPackageName: string | null
  workspaceEvidence: string[]
  warnings: string[]
  candidates: StructureCandidateProbe[]
  /** True when the candidate path set was capped before probing. */
  candidatePathsTruncated: boolean
  /** True when a directory listing hit its own bound. */
  directoryListingsTruncated: boolean
  /**
   * True when a wildcard/container directory listing itself failed (e.g. a
   * GitHub request error), as opposed to hitting a size bound. This is an
   * explicit I/O-outcome signal computed by the loader; the detector never
   * infers it from warning text.
   */
  directoryListingFailed: boolean
}

/**
 * Pure assembly step: turns already-fetched probe results into the final
 * bounded `RepositoryStructure`. Performs no I/O.
 */
export function detectRepositoryStructure(
  input: StructureDiscoveryInput,
): RepositoryStructure {
  const warnings = [...input.warnings]
  let complete = !input.directoryListingFailed

  const rootHasEvidence = input.rootFramework !== "unknown"
  const rootCandidate: RepositoryProjectCandidate = {
    path: ".",
    isRoot: true,
    role: rootHasEvidence ? "project-candidate" : "unknown",
    hasPackageJson: input.rootPackageJsonPresent,
    packageName: input.rootPackageName,
    evidence: [],
    warnings: [],
  }

  const nested: RepositoryProjectCandidate[] = []

  for (const probe of input.candidates) {
    if (probe.requestError) {
      warnings.push(
        `${probe.path}/package.json could not be inspected: ${probe.requestError}`,
      )
      complete = false
      continue
    }

    if (probe.parseError) {
      nested.push({
        path: probe.path,
        isRoot: false,
        role: "unknown",
        hasPackageJson: true,
        packageName: null,
        evidence: ["package.json detected"],
        warnings: [probe.parseError],
      })
      continue
    }

    if (!probe.packageJson) {
      continue
    }

    nested.push(buildNestedCandidate(probe.path, probe.packageJson))
  }

  const nestedExceedsBound =
    nested.length > MAX_STRUCTURE_PROJECT_CANDIDATES - 1
  const boundedNested = nested.slice(0, MAX_STRUCTURE_PROJECT_CANDIDATES - 1)
  const projects = [rootCandidate, ...boundedNested]
  const layout = determineLayout(
    input.workspaceEvidence,
    boundedNested,
    rootHasEvidence,
  )
  const truncated =
    input.candidatePathsTruncated ||
    input.directoryListingsTruncated ||
    nestedExceedsBound

  return {
    layout,
    projects,
    workspaceEvidence: input.workspaceEvidence,
    warnings: Array.from(new Set(warnings)),
    complete,
    truncated,
  }
}

function buildNestedCandidate(
  path: string,
  packageJson: ParsedPackageJson,
): RepositoryProjectCandidate {
  const dependencies = getAllDependencies(packageJson)
  const frontendDependency = FRONTEND_FRAMEWORK_DEPENDENCIES.find(
    (name) => name in dependencies,
  )
  const isUnderPackagesConvention =
    path === "packages" || path.startsWith("packages/")
  const role: ProjectCandidateRole = isUnderPackagesConvention
    ? "package-candidate"
    : frontendDependency
      ? "project-candidate"
      : "unknown"
  const evidence = ["package.json detected"]

  if (frontendDependency) {
    evidence.push(`${frontendDependency} dependency detected`)
  }

  return {
    path,
    isRoot: false,
    role,
    hasPackageJson: true,
    packageName: packageJson.name,
    evidence,
    warnings: [],
  }
}

function determineLayout(
  workspaceEvidence: readonly string[],
  nested: readonly RepositoryProjectCandidate[],
  rootHasEvidence: boolean,
): RepositoryStructureLayout {
  if (workspaceEvidence.length > 0) return "workspace"
  if (nested.length > 0) return "multi-project"
  if (rootHasEvidence) return "single-project"
  return "unknown"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
