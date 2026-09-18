import {
  assembleBackendDetection,
  backendPackageJsonParseWarning,
  detectBackendCandidate,
} from "../analyzer/backendDetector"
import {
  parsePackageJson,
  type ParsedPackageJson,
} from "../analyzer/packageJson"
import { ENV_TEMPLATE_FILENAMES } from "../analyzer/envTemplateFiles"
import type { BackendDetection } from "../../types/backend"
import type { RepositoryMetadata } from "../../types/repository"
import { joinRepositoryPath } from "./repositoryPath"

/** Bounded nested candidate paths ever probed for backend evidence. */
export const MAX_BACKEND_CANDIDATES = 5
/** Bounded env-template read attempts, summed across every candidate. */
export const MAX_BACKEND_ENV_TEMPLATE_READS = 10
/** Bounded env-template read attempts per single candidate. */
const MAX_BACKEND_ENV_TEMPLATE_READS_PER_CANDIDATE = 2
/** Bounded total bytes read across every backend candidate probe. */
export const MAX_BACKEND_TOTAL_BYTES = 512 * 1024
const MAX_BACKEND_PACKAGE_JSON_BYTES = 256 * 1024
const MAX_BACKEND_ENV_TEMPLATE_BYTES = 64 * 1024
/** Presence-only probe; a lockfile larger than this reads as "not confirmed
 * present" rather than throwing -- a conservative, fail-closed limitation
 * of this client-side/analysis-time signal only. A real backend runtime job
 * always re-verifies presence from the extracted archive with no such cap. */
const MAX_BACKEND_PACKAGE_LOCK_PROBE_BYTES = 1024 * 1024

interface BackendGitHubSource {
  getRepositoryTextFile(
    repository: RepositoryMetadata,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<string | null>
}

/**
 * Discovers backend evidence for a bounded set of *nested* candidate paths
 * already known from `RepositoryStructure.projects` (the repository root is
 * handled separately by `analyzeRepository.ts` from data it already has, at
 * zero extra cost). This loader never lists a directory and never discovers
 * new candidate paths itself -- it only probes `{path}/package.json` and a
 * bounded slice of `{path}/.env.*` template names, exactly one fixed file
 * fetch at a time, mirroring `repositoryStructureLoader.ts`'s own
 * direct-fetch candidate probing rather than a directory listing per
 * candidate.
 */
export class BackendCandidateLoader {
  constructor(private readonly githubClient: BackendGitHubSource) {}

  async load(
    repository: RepositoryMetadata,
    candidatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<BackendDetection> {
    const bounded = candidatePaths.slice(0, MAX_BACKEND_CANDIDATES)
    let truncated = candidatePaths.length > bounded.length
    let complete = true
    let totalBytes = 0
    let envReadsUsed = 0
    const warnings: string[] = []
    const candidates: ReturnType<typeof detectBackendCandidate>[] = []

    for (const path of bounded) {
      let packageJson: ParsedPackageJson | null = null
      let parseError: string | null = null

      const remainingForPackageJson = MAX_BACKEND_TOTAL_BYTES - totalBytes

      if (remainingForPackageJson <= 0) {
        truncated = true
      } else {
        try {
          const content = await this.githubClient.getRepositoryTextFile(
            repository,
            joinRepositoryPath(path, "package.json"),
            Math.min(MAX_BACKEND_PACKAGE_JSON_BYTES, remainingForPackageJson),
            signal,
          )

          if (content !== null) {
            totalBytes += byteLength(content)
            const parsed = parsePackageJson(content)
            packageJson = parsed.value
            parseError = parsed.error
          }
        } catch (error) {
          if (isAbortError(error)) throw error
          warnings.push(
            `${path}/package.json could not be inspected: ${getErrorMessage(error)}`,
          )
          complete = false
          continue
        }
      }

      // A package.json that was found but could not be parsed is a
      // read/parse gap, not backend evidence: never fabricate a candidate
      // from it. Skip this candidate's env-template probing too -- there is
      // no candidate left to attach that evidence to.
      if (parseError) {
        warnings.push(backendPackageJsonParseWarning(path, parseError))
        complete = false
        candidates.push(null)
        continue
      }

      const envPresentPaths: string[] = []
      const envTextFiles: Record<string, string> = {}
      let readsForThisCandidate = 0

      for (const templateName of ENV_TEMPLATE_FILENAMES) {
        if (
          readsForThisCandidate >= MAX_BACKEND_ENV_TEMPLATE_READS_PER_CANDIDATE
        ) {
          break
        }
        if (envReadsUsed >= MAX_BACKEND_ENV_TEMPLATE_READS) {
          truncated = true
          break
        }

        const remaining = MAX_BACKEND_TOTAL_BYTES - totalBytes
        if (remaining <= 0) {
          truncated = true
          break
        }

        envReadsUsed += 1
        readsForThisCandidate += 1

        try {
          const content = await this.githubClient.getRepositoryTextFile(
            repository,
            joinRepositoryPath(path, templateName),
            Math.min(MAX_BACKEND_ENV_TEMPLATE_BYTES, remaining),
            signal,
          )

          if (content !== null) {
            totalBytes += byteLength(content)
            envPresentPaths.push(templateName)
            envTextFiles[templateName] = content
          }
        } catch (error) {
          if (isAbortError(error)) throw error
          // A single env-template read failure is a non-fatal gap in
          // env-requirement evidence for this candidate -- the candidate
          // itself is still reported -- but it is still a bounded read that
          // failed, so it must set complete: false like every other read
          // failure in this loader, not be silently swallowed.
          warnings.push(
            `${joinRepositoryPath(path, templateName)} could not be inspected: ${getErrorMessage(error)}`,
          )
          complete = false
        }
      }

      const packageLockPresent = await this.probePackageLockPresent(
        repository,
        path,
        totalBytes,
        signal,
      )
      if (packageLockPresent.bytesRead > 0) {
        totalBytes += packageLockPresent.bytesRead
      }

      candidates.push(
        detectBackendCandidate(
          path,
          packageJson,
          envPresentPaths,
          envTextFiles,
          packageLockPresent.present,
        ),
      )
    }

    return assembleBackendDetection(candidates, warnings, complete, truncated)
  }

  /**
   * Presence-only: never used for its content. Failures (including the
   * bounded-size cap) degrade to "not confirmed present" rather than
   * throwing -- this is a best-effort UI signal, not an authorization path.
   */
  private async probePackageLockPresent(
    repository: RepositoryMetadata,
    path: string,
    bytesAlreadyUsed: number,
    signal?: AbortSignal,
  ): Promise<{ present: boolean; bytesRead: number }> {
    const remaining = MAX_BACKEND_TOTAL_BYTES - bytesAlreadyUsed
    if (remaining <= 0) return { present: false, bytesRead: 0 }

    try {
      const content = await this.githubClient.getRepositoryTextFile(
        repository,
        joinRepositoryPath(path, "package-lock.json"),
        Math.min(MAX_BACKEND_PACKAGE_LOCK_PROBE_BYTES, remaining),
        signal,
      )
      return content === null
        ? { present: false, bytesRead: 0 }
        : { present: true, bytesRead: byteLength(content) }
    } catch (error) {
      if (isAbortError(error)) throw error
      return { present: false, bytesRead: 0 }
    }
  }
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "an unknown error occurred"
}
