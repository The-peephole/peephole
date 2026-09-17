import type { RepositoryMetadata } from "../../types/repository"
import type { PreviewTarget } from "../../types/target"
import { isSafePreviewSourceRoot } from "../preview/sourceRoot"
import type { GitHubContentEntry } from "./client"
import {
  KNOWN_REPOSITORY_FILES,
  MAX_KNOWN_FILE_ENTRIES,
  MAX_TOTAL_TEXT_BYTES,
  TEXT_FILE_LIMITS,
  type RepositoryFileSnapshot,
} from "./knownFiles"
import { joinRepositoryPath } from "./repositoryPath"

interface TargetKnownFilesSource {
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

/** Loads one selected directory at an already-resolved commit; never crawls. */
export class TargetKnownFilesLoader {
  constructor(private readonly github: TargetKnownFilesSource) {}

  async load(
    repository: RepositoryMetadata,
    target: PreviewTarget,
    signal?: AbortSignal,
  ): Promise<RepositoryFileSnapshot> {
    if (!isSafePreviewSourceRoot(target.sourceRoot)) {
      throw new Error("Preview target source root is invalid.")
    }

    const directory = target.sourceRoot === "." ? "" : target.sourceRoot
    const entries = await this.github.getRepositoryDirectoryEntries(
      repository,
      directory,
      signal,
    )
    const warnings: string[] = []
    const complete = entries.length < MAX_KNOWN_FILE_ENTRIES

    if (!complete) {
      warnings.push(
        "The preview target reached GitHub's listing limit; analysis may be incomplete.",
      )
    }

    const knownEntries = entries
      .filter((entry) => isKnownTargetFile(entry, directory))
      .sort((left, right) => left.name.localeCompare(right.name))
    const textFiles: Record<string, string> = {}
    let totalBytes = 0

    for (const entry of knownEntries) {
      const maxBytes = TEXT_FILE_LIMITS.get(entry.name)

      if (!maxBytes) continue

      if (entry.size > maxBytes) {
        warnings.push(
          `${entry.name} exceeds Peephole's ${maxBytes}-byte target analysis limit.`,
        )
        continue
      }

      if (totalBytes + entry.size > MAX_TOTAL_TEXT_BYTES) {
        warnings.push(
          "Preview target text files exceed Peephole's total analysis byte limit.",
        )
        break
      }

      const content = await this.github.getRepositoryTextFile(
        repository,
        joinRepositoryPath(directory, entry.name),
        maxBytes,
        signal,
      )

      if (content !== null) {
        textFiles[entry.name] = content
        totalBytes += new TextEncoder().encode(content).byteLength
      }
    }

    return {
      presentPaths: knownEntries.map((entry) => entry.name),
      textFiles,
      warnings,
      complete,
    }
  }
}

function isKnownTargetFile(
  entry: GitHubContentEntry,
  directory: string,
): boolean {
  return (
    entry.type === "file" &&
    entry.path === joinRepositoryPath(directory, entry.name) &&
    KNOWN_REPOSITORY_FILES.has(entry.name)
  )
}
