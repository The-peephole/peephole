import {
  ANALYZER_VERSION,
  PREVIEW_CONTRACT_VERSION,
  type PreviewBlocker,
  type RepositoryAnalysis,
} from "../../types/analysis"
import type { BackendDetection } from "../../types/backend"
import type { EnvironmentRequirement } from "../../types/environment"
import type { RepositoryMetadata } from "../../types/repository"
import type { RepositoryStructure } from "../../types/structure"
import type { RepositoryFileSnapshot } from "../github/knownFiles"
import { analyzeBuildTarget, deduplicateBlockers } from "./analyzeBuildTarget"
import {
  assembleBackendDetection,
  backendPackageJsonParseWarning,
  detectBackendCandidate,
} from "./backendDetector"
import { detectDeployment } from "./deploymentDetector"
import { parsePackageJson } from "./packageJson"
import { detectRepositoryStructure } from "./repositoryStructureDetector"
import { detectWorkspace } from "./workspaceDetector"

/**
 * `nestedBackend` is the result of the separate, bounded
 * `BackendCandidateLoader` for non-root structure candidates (an I/O step
 * this pure function cannot perform itself). The repository root's own
 * backend evidence is always computed here from `files`, which this
 * function already has -- no extra network read is needed for the root.
 * Omitting `nestedBackend` (as every existing root-only fixture test does)
 * degrades to root-only backend detection, never a false "not-detected"
 * claim about nested candidates that were never actually probed.
 */
export function analyzeRepository(
  repository: RepositoryMetadata,
  files: RepositoryFileSnapshot,
  structure?: RepositoryStructure,
  nestedBackend?: BackendDetection,
): RepositoryAnalysis {
  const targetAnalysis = analyzeBuildTarget(
    repository,
    { sourceRoot: "." },
    files,
    PREVIEW_CONTRACT_VERSION,
  )
  const packageJsonPresent = files.presentPaths.includes("package.json")
  const packageJsonResult = parsePackageJson(files.textFiles["package.json"])
  const packageJson = packageJsonResult.value
  const deployment = detectDeployment(repository, files.presentPaths)
  const workspace = detectWorkspace(packageJson, files.presentPaths)
  // A malformed root package.json is a read/parse gap, not backend
  // evidence: it must never fabricate a candidate, and it degrades
  // `backend.complete` the same way a malformed nested candidate does.
  const rootBackendCandidate = packageJsonResult.error
    ? null
    : detectBackendCandidate(
        ".",
        packageJson,
        files.presentPaths,
        files.textFiles,
      )
  const rootBackendWarnings = packageJsonResult.error
    ? [backendPackageJsonParseWarning(".", packageJsonResult.error)]
    : []
  const backend = assembleBackendDetection(
    [rootBackendCandidate, ...(nestedBackend?.candidates ?? [])],
    [...rootBackendWarnings, ...(nestedBackend?.warnings ?? [])],
    !packageJsonResult.error && (nestedBackend?.complete ?? true),
    nestedBackend?.truncated ?? false,
  )
  const environmentRequirements = mergeEnvironmentRequirements([
    targetAnalysis.environmentRequirements,
    ...backend.candidates.map((candidate) => candidate.environmentRequirements),
  ])
  const resolvedStructure =
    structure ??
    detectRepositoryStructure({
      rootFramework: targetAnalysis.technologies.framework,
      rootPackageJsonPresent: packageJsonPresent,
      rootPackageName: packageJson?.name ?? null,
      workspaceEvidence: workspace.evidence,
      warnings: [],
      candidates: [],
      candidatePathsTruncated: false,
      directoryListingsTruncated: false,
      directoryListingFailed: false,
    })
  const blockers: PreviewBlocker[] = [...targetAnalysis.preview.blockers]

  if (workspace.ambiguous) {
    blockers.push({
      code: "AMBIGUOUS_WORKSPACE",
      message:
        resolvedStructure.projects.length > 1
          ? "Applications were detected, but a preview target must be selected."
          : "Workspace application selection is outside the root preview contract.",
    })
  }

  const uniqueBlockers = deduplicateBlockers(blockers)
  // Native build eligibility always wins: local deployment evidence
  // (declared homepage or provider config) is never proof of an actual live
  // deployment, so it must never override a genuinely buildable target. It
  // only downgrades the fallback message shown when a build is not possible.
  const mode =
    uniqueBlockers.length === 0
      ? "native-static-build"
      : deployment.status !== "unknown"
        ? "existing-deployment"
        : "unsupported"

  return {
    repository,
    analyzerVersion: ANALYZER_VERSION,
    technologies: targetAnalysis.technologies,
    packageManager: targetAnalysis.packageManager,
    runtime: targetAnalysis.runtime,
    environment: targetAnalysis.environment,
    deployment,
    workspace,
    structure: resolvedStructure,
    backend,
    environmentRequirements,
    preview: {
      ...targetAnalysis.preview,
      mode,
      blockers: uniqueBlockers,
    },
    inspectedFiles: targetAnalysis.inspectedFiles,
    warnings: targetAnalysis.warnings,
  }
}

function mergeEnvironmentRequirements(
  lists: readonly EnvironmentRequirement[][],
): EnvironmentRequirement[] {
  const seen = new Map<string, EnvironmentRequirement>()

  for (const list of lists) {
    for (const requirement of list) {
      const key = `${requirement.sourceRoot}:${requirement.name}`
      if (!seen.has(key)) seen.set(key, requirement)
    }
  }

  return Array.from(seen.values())
}
