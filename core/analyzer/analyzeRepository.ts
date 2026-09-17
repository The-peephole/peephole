import {
  ANALYZER_VERSION,
  PREVIEW_CONTRACT_VERSION,
  type PreviewBlocker,
  type RepositoryAnalysis,
} from "../../types/analysis"
import type { RepositoryMetadata } from "../../types/repository"
import type { RepositoryStructure } from "../../types/structure"
import type { RepositoryFileSnapshot } from "../github/knownFiles"
import { analyzeBuildTarget, deduplicateBlockers } from "./analyzeBuildTarget"
import { detectDeployment } from "./deploymentDetector"
import { parsePackageJson } from "./packageJson"
import { detectRepositoryStructure } from "./repositoryStructureDetector"
import { detectWorkspace } from "./workspaceDetector"

export function analyzeRepository(
  repository: RepositoryMetadata,
  files: RepositoryFileSnapshot,
  structure?: RepositoryStructure,
): RepositoryAnalysis {
  const targetAnalysis = analyzeBuildTarget(
    repository,
    { sourceRoot: "." },
    files,
    PREVIEW_CONTRACT_VERSION,
  )
  const packageJsonPresent = files.presentPaths.includes("package.json")
  const packageJson = parsePackageJson(files.textFiles["package.json"]).value
  const deployment = detectDeployment(repository, files.presentPaths)
  const workspace = detectWorkspace(packageJson, files.presentPaths)
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
    preview: {
      ...targetAnalysis.preview,
      mode,
      blockers: uniqueBlockers,
    },
    inspectedFiles: targetAnalysis.inspectedFiles,
    warnings: targetAnalysis.warnings,
  }
}
