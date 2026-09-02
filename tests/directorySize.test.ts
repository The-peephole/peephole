import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { directorySizeExceeds } from "../services/preview-worker/local/directorySize"

describe("directorySizeExceeds", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "peephole-dirsize-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns false when the tree is within the limit", async () => {
    await writeFile(path.join(dir, "a.txt"), "x".repeat(10))
    await mkdir(path.join(dir, "nested"))
    await writeFile(path.join(dir, "nested", "b.txt"), "y".repeat(10))

    await expect(directorySizeExceeds(dir, 100)).resolves.toBe(false)
  })

  it("returns true once cumulative bytes exceed the limit, across nested directories", async () => {
    await writeFile(path.join(dir, "a.txt"), "x".repeat(60))
    await mkdir(path.join(dir, "nested"))
    await writeFile(path.join(dir, "nested", "b.txt"), "y".repeat(60))

    await expect(directorySizeExceeds(dir, 100)).resolves.toBe(true)
  })

  it("uses lstat, not stat, so a symlink never double-counts its target's bytes", async () => {
    await writeFile(path.join(dir, "real.txt"), "x".repeat(1_000))
    const { symlink } = await import("node:fs/promises")

    try {
      await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"))
    } catch {
      // Creating a file symlink can require elevated privileges on some
      // Windows configurations; skip the assertion where that's blocked
      // rather than fail on an environment limitation.
      return
    }

    // If this incorrectly followed the symlink (stat instead of lstat), the
    // 1000-byte target would be counted twice and exceed the limit.
    await expect(directorySizeExceeds(dir, 1_500)).resolves.toBe(false)
  })
})
