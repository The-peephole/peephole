import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as tar from "tar"

import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from "../../../core/runner/archivePolicy"
import type { PreviewRepositoryRef } from "../../../types/preview"
import type { ArchiveEntry, FetchedArchive } from "../../../types/runner"
import type { SourceArchiveFetcher } from "../ports"
import type { ArchiveByteStore } from "./archiveByteStore"

const COMMIT_SHA_PATTERN = /^[a-f\d]{40}$/i

export interface GitHubCommitArchiveFetcherOptions {
  limits?: ArchiveLimits
  timeoutMs?: number
  codeloadBaseUrl?: string
}

/**
 * Fetches the immutable tarball snapshot for a pinned commit SHA -- never a
 * branch name, never `git clone`, and never a re-resolved default-branch
 * HEAD. GitHub's codeload archives are content-addressed by commit, so the
 * same URL always returns the same bytes.
 */
export class GitHubCommitArchiveFetcher implements SourceArchiveFetcher {
  private readonly limits: ArchiveLimits
  private readonly timeoutMs: number
  private readonly baseUrl: string

  constructor(
    private readonly byteStore: ArchiveByteStore,
    options: GitHubCommitArchiveFetcherOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.baseUrl = options.codeloadBaseUrl ?? "https://codeload.github.com"
  }

  async fetch(repository: PreviewRepositoryRef): Promise<FetchedArchive> {
    if (!COMMIT_SHA_PATTERN.test(repository.commitSha)) {
      throw new Error("Refusing to fetch a non-immutable commit reference.")
    }

    const url = `${this.baseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tar.gz/${repository.commitSha}`
    const data = await downloadWithLimit(
      url,
      this.limits.maxCompressedBytes,
      this.timeoutMs,
    )
    const entries = await listTarEntries(data)

    this.byteStore.put(repository.commitSha, data)

    return { compressedBytes: data.byteLength, entries }
  }
}

async function downloadWithLimit(
  url: string,
  maxCompressedBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })

  if (!response.ok) {
    throw new Error(`Archive fetch failed with HTTP ${response.status}.`)
  }

  if (!response.body) {
    throw new Error("Archive fetch returned no response body.")
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    total += value.byteLength

    if (total > maxCompressedBytes) {
      await reader.cancel("archive exceeds compressed size limit")
      throw new Error("The source archive exceeds the compressed size limit.")
    }

    chunks.push(value)
  }

  const data = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }

  return data
}

async function listTarEntries(data: Uint8Array): Promise<ArchiveEntry[]> {
  const stagingDir = await mkdtemp(path.join(os.tmpdir(), "peephole-list-"))
  const archiveFile = path.join(stagingDir, "source.tar.gz")

  try {
    await writeFile(archiveFile, data)
    const entries: ArchiveEntry[] = []

    await tar.t({
      file: archiveFile,
      maxDecompressionRatio: 1_000,
      onReadEntry: (entry) => {
        if (entry.type === "Directory" || !entry.path) {
          return
        }

        // `strip` is an extraction-time option; `tar.t` always reports the
        // raw path including GitHub's "{repo}-{sha}/" wrapper directory, so
        // it is stripped by hand here to match what extraction will
        // actually write to disk.
        const strippedPath = entry.path
          .replace(/\/+$/, "")
          .split("/")
          .slice(1)
          .join("/")

        if (!strippedPath) {
          return
        }

        entries.push({
          path: strippedPath,
          bytes: entry.size ?? 0,
          isSymlink: entry.type === "SymbolicLink" || entry.type === "Link",
        })
      },
    })

    return entries
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

