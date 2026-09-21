import { resolveBackendRuntimePlan } from "../../core/analyzer/backendRuntimeAdapter"
import { detectBackendCandidate } from "../../core/analyzer/backendDetector"
import { ENV_TEMPLATE_FILENAMES } from "../../core/analyzer/envTemplateFiles"
import { parsePackageJson } from "../../core/analyzer/packageJson"
import { isNpmBackendPackageManagerDeclaration } from "../../core/analyzer/backendPackageManager"
import type { GitHubClient } from "../../core/github/client"
import { joinRepositoryPath } from "../../core/github/repositoryPath"
import { isSafePreviewSourceRoot } from "../../core/preview/sourceRoot"
import type { RepositoryStructureLoader } from "../../core/github/repositoryStructureLoader"
import { KnownRepositoryFilesLoader } from "../../core/github/knownFiles"
import type { BackendRuntimePlan } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"
import type { RepositoryMetadata } from "../../types/repository"
import type { BackendRuntimePlanResolver } from "./ports"

const MAX_ENV_TEMPLATE_READS = 4
const MAX_PACKAGE_JSON_BYTES = 256 * 1024
const MAX_PACKAGE_LOCK_PROBE_BYTES = 1024 * 1024
const MAX_ENV_TEMPLATE_BYTES = 64 * 1024

interface StructureLoaderSource {
  load(
    repository: RepositoryMetadata,
    files: Awaited<ReturnType<KnownRepositoryFilesLoader["load"]>>,
    signal?: AbortSignal,
  ): ReturnType<RepositoryStructureLoader["load"]>
}

/**
 * Independently re-derives a `BackendRuntimePlan` at the repository's exact
 * requested commit -- never trusts anything the client sent beyond
 * repository identity, commit, and an optional `sourceRoot` *hint*. Mirrors
 * `services/preview-api/githubPlanResolver.ts`'s exact-commit revalidation
 * shape for the static contract, but produces a `backend-v1` plan instead.
 */
export class GitHubBackendRuntimePlanResolver implements BackendRuntimePlanResolver {
  constructor(
    private readonly github: GitHubClient,
    private readonly knownFiles = new KnownRepositoryFilesLoader(github),
    private readonly structure?: StructureLoaderSource,
  ) {}

  async resolve(
    repository: PreviewRepositoryRef,
    sourceRootHint: string | undefined,
  ): Promise<BackendRuntimePlan | null> {
    if (
      sourceRootHint !== undefined &&
      !isSafePreviewSourceRoot(sourceRootHint)
    ) {
      return null
    }

    const metadata = await this.github.getRepositoryMetadataAtCommit(repository)
    const candidatePaths = await this.resolveCandidatePaths(
      metadata,
      sourceRootHint,
    )

    for (const path of candidatePaths) {
      // These reads are execution authorization evidence. Only the GitHub
      // client's confirmed-404 result is represented as `null` (handled
      // inside `loadCandidate` itself); a transport, rate-limit,
      // malformed-response, or size failure must propagate -- it can never
      // be mistaken for an absent file or silently bypassed by trying a
      // sibling candidate.
      const candidate = await this.loadCandidate(metadata, path)
      if (!candidate) continue
      const plan = resolveBackendRuntimePlan(repository, candidate)
      if (plan) return plan
    }

    return null
  }

  /**
   * A `sourceRoot` hint narrows to exactly that path; omitting it falls
   * back to the root plus the bounded set of structure candidates already
   * discovered for M7 -- never a fresh unbounded crawl. Client-provided
   * `sourceRoot` is a hint only: it is re-validated the same way as every
   * other path here, and an unrecognized hint simply yields no candidate.
   */
  private async resolveCandidatePaths(
    metadata: RepositoryMetadata,
    sourceRootHint: string | undefined,
  ): Promise<string[]> {
    if (sourceRootHint !== undefined) return [sourceRootHint]
    if (!this.structure) return ["."]

    const rootFiles = await this.knownFiles.load(metadata)
    const structure = await this.structure.load(metadata, rootFiles)
    return [
      ".",
      ...structure.projects
        .filter((project) => !project.isRoot)
        .map((project) => project.path),
    ]
  }

  private async loadCandidate(
    metadata: RepositoryMetadata,
    sourceRoot: string,
  ) {
    const packageJsonPath =
      sourceRoot === "."
        ? "package.json"
        : joinRepositoryPath(sourceRoot, "package.json")
    const packageJsonContent = await this.github.getRepositoryTextFile(
      metadata,
      packageJsonPath,
      MAX_PACKAGE_JSON_BYTES,
    )
    if (!packageJsonContent) return null

    const parsed = parsePackageJson(packageJsonContent)
    if (!parsed.value) return null
    if (!isNpmBackendPackageManagerDeclaration(parsed.value.packageManager))
      return null

    const lockPath =
      sourceRoot === "."
        ? "package-lock.json"
        : joinRepositoryPath(sourceRoot, "package-lock.json")
    const lockContent = await this.github.getRepositoryTextFile(
      metadata,
      lockPath,
      MAX_PACKAGE_LOCK_PROBE_BYTES,
    )

    const envPresentPaths: string[] = []
    const envTextFiles: Record<string, string> = {}
    for (const templateName of ENV_TEMPLATE_FILENAMES.slice(
      0,
      MAX_ENV_TEMPLATE_READS,
    )) {
      const templatePath =
        sourceRoot === "."
          ? templateName
          : joinRepositoryPath(sourceRoot, templateName)
      const content = await this.github.getRepositoryTextFile(
        metadata,
        templatePath,
        MAX_ENV_TEMPLATE_BYTES,
      )
      if (content !== null) {
        envPresentPaths.push(templateName)
        envTextFiles[templateName] = content
      }
    }

    return detectBackendCandidate(
      sourceRoot,
      parsed.value,
      envPresentPaths,
      envTextFiles,
      lockContent !== null,
    )
  }
}
