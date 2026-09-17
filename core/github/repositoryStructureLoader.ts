import { detectFramework } from "../analyzer/frameworkDetector"
import { parsePackageJson } from "../analyzer/packageJson"
import {
  detectRepositoryStructure,
  parsePackageJsonWorkspacePatterns,
  parsePnpmWorkspacePackages,
  planStructureCandidatePaths,
  MAX_NESTED_PACKAGE_JSON_BYTES,
  MAX_STRUCTURE_CANDIDATE_PROBES,
  MAX_STRUCTURE_DIRECTORY_ENTRIES,
  MAX_STRUCTURE_DIRECTORY_LISTINGS,
  MAX_STRUCTURE_TOTAL_BYTES,
  type StructureCandidateProbe,
} from "../analyzer/repositoryStructureDetector"
import { detectWorkspace } from "../analyzer/workspaceDetector"
import type { RepositoryMetadata } from "../../types/repository"
import type { RepositoryStructure } from "../../types/structure"
import type { GitHubContentEntry } from "./client"
import type { RepositoryFileSnapshot } from "./knownFiles"

interface StructureGitHubSource {
  getRepositoryDirectoryEntries(
    repository: RepositoryMetadata,
    path: string,
    signal?: AbortSignal,
  ): Promise<GitHubContentEntry[]>
  getRepositoryTextFile(
    repository: RepositoryMetadata,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string | null>
}

/**
 * Discovers a bounded `RepositoryStructure` for the repository's already
 * resolved commit. Combines declared workspace patterns
 * (package.json `workspaces`, `pnpm-workspace.yaml`) with a small,
 * capability-driven set of conventional root directory names, then probes
 * each candidate path for a nested package.json. Every read uses
 * `repository.commitSha`; it never fetches a mutable branch reference.
 */
export class RepositoryStructureLoader {
  constructor(private readonly githubClient: StructureGitHubSource) {}

  async load(
    repository: RepositoryMetadata,
    files: RepositoryFileSnapshot,
    signal?: AbortSignal,
  ): Promise<RepositoryStructure> {
    const packageJsonPresent = files.presentPaths.includes("package.json")
    const packageJsonResult = parsePackageJson(files.textFiles["package.json"])
    const packageJson = packageJsonResult.value
    const rootFramework = detectFramework(
      packageJson,
      packageJsonPresent,
      files.presentPaths,
    ).framework
    const legacyWorkspace = detectWorkspace(packageJson, files.presentPaths)

    const warnings: string[] = []
    const workspacePatterns: string[] = []

    const packageJsonWorkspaces = parsePackageJsonWorkspacePatterns(
      packageJson?.workspaces,
    )
    if (packageJsonWorkspaces.warning) {
      warnings.push(packageJsonWorkspaces.warning)
    }
    if (packageJsonWorkspaces.patterns) {
      workspacePatterns.push(...packageJsonWorkspaces.patterns)
    }

    const pnpmWorkspaceContent = files.textFiles["pnpm-workspace.yaml"]
    if (pnpmWorkspaceContent !== undefined) {
      const pnpmWorkspaces = parsePnpmWorkspacePackages(pnpmWorkspaceContent)
      if (pnpmWorkspaces.warning) warnings.push(pnpmWorkspaces.warning)
      if (pnpmWorkspaces.patterns) {
        workspacePatterns.push(...pnpmWorkspaces.patterns)
      }
    }

    const plan = planStructureCandidatePaths({
      workspacePatterns,
      rootDirectories: files.rootDirectories ?? [],
    })

    for (const pattern of plan.unsupportedPatterns) {
      warnings.push(`Unsupported workspace pattern: "${pattern}".`)
    }

    const literalPaths = new Set(plan.literalPaths)
    const boundedWildcardParents = plan.wildcardParents.slice(
      0,
      MAX_STRUCTURE_DIRECTORY_LISTINGS,
    )
    let directoryListingsTruncated =
      plan.wildcardParents.length > boundedWildcardParents.length
    let directoryListingFailed = false

    for (const parentDir of boundedWildcardParents) {
      let entries: GitHubContentEntry[]

      try {
        entries = await this.githubClient.getRepositoryDirectoryEntries(
          repository,
          parentDir,
          signal,
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        warnings.push(
          `${parentDir} could not be listed: ${getErrorMessage(error)}`,
        )
        directoryListingFailed = true
        continue
      }

      if (entries.length > MAX_STRUCTURE_DIRECTORY_ENTRIES) {
        directoryListingsTruncated = true
      }

      for (const entry of entries.slice(0, MAX_STRUCTURE_DIRECTORY_ENTRIES)) {
        if (entry.type !== "dir") continue
        literalPaths.add(`${parentDir}/${entry.name}`)
      }
    }

    const allPaths = Array.from(literalPaths)
    const candidatePathsExceeded =
      allPaths.length > MAX_STRUCTURE_CANDIDATE_PROBES
    const boundedPaths = allPaths.slice(0, MAX_STRUCTURE_CANDIDATE_PROBES)

    const candidates: StructureCandidateProbe[] = []
    let totalBytes = 0
    let byteBudgetExceeded = false

    for (const path of boundedPaths) {
      const remainingBytes = MAX_STRUCTURE_TOTAL_BYTES - totalBytes

      if (remainingBytes <= 0) {
        byteBudgetExceeded = true
        break
      }

      let content: string | null

      try {
        content = await this.githubClient.getRepositoryTextFile(
          repository,
          `${path}/package.json`,
          Math.min(MAX_NESTED_PACKAGE_JSON_BYTES, remainingBytes),
          signal,
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        candidates.push({
          path,
          packageJson: null,
          parseError: null,
          requestError: getErrorMessage(error),
        })
        continue
      }

      if (content === null) continue

      totalBytes += new TextEncoder().encode(content).byteLength
      const parsed = parsePackageJson(content)

      candidates.push({
        path,
        packageJson: parsed.value,
        parseError: parsed.error,
        requestError: null,
      })
    }

    return detectRepositoryStructure({
      rootFramework,
      rootPackageJsonPresent: packageJsonPresent,
      rootPackageName: packageJson?.name ?? null,
      workspaceEvidence: legacyWorkspace.evidence,
      warnings,
      candidates,
      candidatePathsTruncated: candidatePathsExceeded || byteBudgetExceeded,
      directoryListingsTruncated,
      directoryListingFailed,
    })
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "an unknown error occurred"
}
