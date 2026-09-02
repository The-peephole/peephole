import type { RepositoryMetadata } from "../../types/repository"
import type { GitHubClient, GitHubContentEntry } from "./client"

const MAX_ROOT_ENTRIES = 1_000
const MAX_TOTAL_TEXT_BYTES = 512 * 1024

const KNOWN_ROOT_FILES = new Set([
  "package.json",
  "index.html",
  "README.md",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.local.example",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "svelte.config.js",
  "svelte.config.mjs",
  "vue.config.js",
  "vue.config.ts",
  "tsconfig.json",
  "vercel.json",
  "netlify.toml",
  "turbo.json",
  "nx.json",
  "lerna.json",
])

const TEXT_FILE_LIMITS = new Map<string, number>([
  ["package.json", 256 * 1024],
  ["README.md", 128 * 1024],
  [".env.example", 64 * 1024],
  [".env.sample", 64 * 1024],
  [".env.template", 64 * 1024],
  [".env.local.example", 64 * 1024],
  ["vite.config.js", 128 * 1024],
  ["vite.config.mjs", 128 * 1024],
  ["vite.config.ts", 128 * 1024],
  ["vite.config.mts", 128 * 1024],
])

export interface RepositoryFileSnapshot {
  presentPaths: string[]
  textFiles: Record<string, string>
  warnings: string[]
  complete: boolean
}

export class KnownRepositoryFilesLoader {
  constructor(private readonly githubClient: GitHubClient) {}

  async load(
    repository: RepositoryMetadata,
    signal?: AbortSignal,
  ): Promise<RepositoryFileSnapshot> {
    const rootEntries = await this.githubClient.getRepositoryRootEntries(
      repository,
      signal,
    )
    const warnings: string[] = []
    const complete = rootEntries.length < MAX_ROOT_ENTRIES

    if (!complete) {
      warnings.push(
        "The repository root reached GitHub's listing limit; analysis may be incomplete.",
      )
    }

    const knownEntries = rootEntries
      .filter(isKnownRootFile)
      .sort((left, right) => left.path.localeCompare(right.path))
    const textFiles: Record<string, string> = {}
    let totalBytes = 0

    for (const entry of knownEntries) {
      const maxBytes = TEXT_FILE_LIMITS.get(entry.path)

      if (!maxBytes) {
        continue
      }

      if (entry.size > maxBytes) {
        warnings.push(
          `${entry.path} exceeds Peephole's ${maxBytes}-byte analysis limit.`,
        )
        continue
      }

      if (totalBytes + entry.size > MAX_TOTAL_TEXT_BYTES) {
        warnings.push(
          "Known text files exceed Peephole's total analysis byte limit.",
        )
        break
      }

      const content = await this.githubClient.getRepositoryTextFile(
        repository,
        entry.path,
        maxBytes,
        signal,
      )

      if (content !== null) {
        textFiles[entry.path] = content
        totalBytes += new TextEncoder().encode(content).byteLength
      }
    }

    return {
      presentPaths: knownEntries.map((entry) => entry.path),
      textFiles,
      warnings,
      complete,
    }
  }
}

function isKnownRootFile(entry: GitHubContentEntry): boolean {
  return (
    entry.type === "file" &&
    entry.path === entry.name &&
    KNOWN_ROOT_FILES.has(entry.path)
  )
}
