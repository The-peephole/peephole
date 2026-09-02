import { describe, expect, it } from "vitest"

import {
  ArchiveRejectedError,
  OutputRejectedError,
  validateFetchedArchive,
  validateResolvedOutput,
} from "../core/runner/archivePolicy"
import type { ArchiveEntry, FetchedArchive, ResolvedOutput } from "../types/runner"

function entry(path: string, bytes = 10, isSymlink = false): ArchiveEntry {
  return { path, bytes, isSymlink }
}

describe("validateFetchedArchive", () => {
  const limits = {
    maxCompressedBytes: 1_000,
    maxExpandedBytes: 2_000,
    maxFileCount: 3,
    maxEntryPathLength: 32,
  }

  const okArchive: FetchedArchive = {
    compressedBytes: 100,
    entries: [entry("index.html", 200), entry("src/app.ts", 300)],
  }

  it("accepts an archive within limits", () => {
    expect(() => validateFetchedArchive(okArchive, limits)).not.toThrow()
  })

  it("rejects an archive exceeding the compressed size limit", () => {
    expect(() =>
      validateFetchedArchive({ ...okArchive, compressedBytes: 1_001 }, limits),
    ).toThrow(ArchiveRejectedError)
  })

  it("rejects an archive exceeding the file-count limit", () => {
    expect(() =>
      validateFetchedArchive(
        {
          ...okArchive,
          entries: [entry("a"), entry("b"), entry("c"), entry("d")],
        },
        limits,
      ),
    ).toThrow(ArchiveRejectedError)
  })

  it("rejects an archive exceeding the expanded size limit", () => {
    expect(() =>
      validateFetchedArchive(
        { ...okArchive, entries: [entry("a", 1_500), entry("b", 1_000)] },
        limits,
      ),
    ).toThrow(ArchiveRejectedError)
  })

  it("rejects traversal, absolute, and backslash paths", () => {
    for (const path of ["../escape", "/etc/passwd", "src\\evil.ts", ""]) {
      expect(() =>
        validateFetchedArchive({ ...okArchive, entries: [entry(path)] }, limits),
      ).toThrow(ArchiveRejectedError)
    }
  })

  it("rejects symlinked entries", () => {
    expect(() =>
      validateFetchedArchive(
        { ...okArchive, entries: [entry("link", 10, true)] },
        limits,
      ),
    ).toThrow("Symlinked entries are not permitted")
  })
})

describe("validateResolvedOutput", () => {
  const limits = {
    maxTotalBytes: 1_000,
    maxFileCount: 2,
    maxEntryPathLength: 32,
  }

  it("accepts output within limits", () => {
    const output: ResolvedOutput = { entries: [entry("index.html", 500)] }
    expect(() => validateResolvedOutput(output, limits)).not.toThrow()
  })

  it("rejects empty output", () => {
    expect(() => validateResolvedOutput({ entries: [] }, limits)).toThrow(
      "produced no output files",
    )
  })

  it("rejects output exceeding the file-count limit", () => {
    const output: ResolvedOutput = {
      entries: [entry("a"), entry("b"), entry("c")],
    }
    expect(() => validateResolvedOutput(output, limits)).toThrow(
      OutputRejectedError,
    )
  })

  it("rejects output exceeding the total byte limit", () => {
    const output: ResolvedOutput = {
      entries: [entry("a", 600), entry("b", 500)],
    }
    expect(() => validateResolvedOutput(output, limits)).toThrow(
      OutputRejectedError,
    )
  })

  it("rejects an unsafe output path", () => {
    const output: ResolvedOutput = { entries: [entry("../outside", 1)] }
    expect(() => validateResolvedOutput(output, limits)).toThrow(
      "escapes the workspace root",
    )
  })
})
