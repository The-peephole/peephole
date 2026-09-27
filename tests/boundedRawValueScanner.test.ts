import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import {
  BoundedRawValueScanError,
  scanRegularFilesForRawValue,
  type ScannedDirectory,
  type ScannedDirEntry,
} from "./support/boundedRawValueScanner"

const MARKER = "M10C4A_RawValueMarker_9pQ2"

function fakeEntry(
  name: string,
  kind: "file" | "directory" | "symlink" | "other",
): ScannedDirEntry {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  }
}

function fakeDirectory(entries: ScannedDirEntry[]): ScannedDirectory {
  return {
    close: () => Promise.resolve(),
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: () =>
          Promise.resolve(
            index < entries.length
              ? { done: false as const, value: entries[index++]! }
              : { done: true as const, value: undefined },
          ),
      }
    },
  }
}

describe("scanRegularFilesForRawValue", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const temp = await mkdtemp(path.join(os.tmpdir(), "peephole-rawscan-"))
    try {
      return await fn(temp)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  it("finds a planted marker in a regular file", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, "nested"), { recursive: true })
      await writeFile(
        path.join(root, "nested", "env"),
        `SESSION_SECRET=${MARKER}\n`,
      )

      const result = await scanRegularFilesForRawValue(root, MARKER)

      expect(result.complete).toBe(true)
      expect(result.found).toBe(true)
    })
  })

  it("scans every file even after an early match, proving traversal never stops short", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "a.txt"), MARKER)
      await writeFile(path.join(root, "b.txt"), "clean")
      await writeFile(path.join(root, "c.txt"), "clean")

      const result = await scanRegularFilesForRawValue(root, MARKER)

      expect(result).toMatchObject({
        complete: true,
        found: true,
        scannedFiles: 3,
      })
    })
  })

  it("returns found:false only once every file has actually been inspected", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "a.txt"), "clean-a")
      await mkdir(path.join(root, "nested"))
      await writeFile(path.join(root, "nested", "b.txt"), "clean-b")

      const result = await scanRegularFilesForRawValue(root, MARKER)

      expect(result).toMatchObject({
        complete: true,
        found: false,
        scannedFiles: 2,
      })
    })
  })

  it("skips a symlinked file without following it", async () => {
    await withTempDir(async (root) => {
      await withTempDir(async (outside) => {
        await writeFile(path.join(outside, "target.txt"), MARKER)
        try {
          await symlink(
            path.join(outside, "target.txt"),
            path.join(root, "link.txt"),
          )
        } catch {
          // Creating a file symlink can require elevated privileges on some
          // Windows configurations; skip rather than fail on an environment
          // limitation (same pattern as tests/directorySize.test.ts).
          return
        }

        const result = await scanRegularFilesForRawValue(root, MARKER)

        expect(result).toEqual({
          found: false,
          scannedEntries: 1,
          scannedFiles: 0,
          scannedBytes: 0,
          skippedStructuralExclusions: 0,
          complete: true,
        })
      })
    })
  })

  it("does not descend into a symlinked directory", async () => {
    await withTempDir(async (root) => {
      await withTempDir(async (outside) => {
        await writeFile(path.join(outside, "target.txt"), MARKER)
        await symlink(outside, path.join(root, "linked"), "junction")

        const result = await scanRegularFilesForRawValue(root, MARKER)

        expect(result).toEqual({
          found: false,
          scannedEntries: 1,
          scannedFiles: 0,
          scannedBytes: 0,
          skippedStructuralExclusions: 0,
          complete: true,
        })
      })
    })
  })

  it("ignores a non-regular entry (socket/device/FIFO) without reading it, but still counts it", async () => {
    const readFile = vi.fn<() => Promise<Buffer>>()
    const opendir = vi.fn(() =>
      Promise.resolve(fakeDirectory([fakeEntry("weird", "other")])),
    )

    const result = await scanRegularFilesForRawValue("/root", MARKER, {
      opendir,
      readFile,
    })

    expect(result).toEqual({
      found: false,
      scannedEntries: 1,
      scannedFiles: 0,
      scannedBytes: 0,
      skippedStructuralExclusions: 0,
      complete: true,
    })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("fails closed when a directory cannot be opened", async () => {
    const opendir = vi.fn((targetPath: string) =>
      targetPath === "/root"
        ? Promise.resolve(fakeDirectory([fakeEntry("nested", "directory")]))
        : Promise.reject(new Error("permission denied")),
    )

    await expect(
      scanRegularFilesForRawValue("/root", MARKER, { opendir }),
    ).rejects.toThrow(BoundedRawValueScanError)
  })

  it("fails closed when a regular file cannot be read", async () => {
    const opendir = vi.fn(() =>
      Promise.resolve(fakeDirectory([fakeEntry("env", "file")])),
    )
    const lstat = vi.fn(() => Promise.resolve({ size: 10 }))
    const readFile = vi.fn(() =>
      Promise.reject(new Error("EACCES: permission denied")),
    )

    await expect(
      scanRegularFilesForRawValue("/root", MARKER, {
        opendir,
        lstat,
        readFile,
      }),
    ).rejects.toThrow(BoundedRawValueScanError)
  })

  it("fails closed when the entry bound would be exceeded", async () => {
    await withTempDir(async (root) => {
      for (let index = 0; index < 5; index += 1) {
        await writeFile(path.join(root, `file-${String(index)}.txt`), "x")
      }

      await expect(
        scanRegularFilesForRawValue(root, MARKER, { maxEntries: 3 }),
      ).rejects.toThrow(BoundedRawValueScanError)
    })
  })

  it("fails closed when the byte bound would be exceeded (checked before reading)", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "big.txt"), "x".repeat(100))

      await expect(
        scanRegularFilesForRawValue(root, MARKER, { maxBytes: 50 }),
      ).rejects.toThrow(BoundedRawValueScanError)
    })
  })

  it("fails closed when actual bytes read exceed the bound even though stat size did not", async () => {
    const opendir = vi.fn(() =>
      Promise.resolve(fakeDirectory([fakeEntry("grew.txt", "file")])),
    )
    // Models a file that grew between stat and read: the pre-read check
    // alone would let this through, so the post-read defensive check must
    // be the one that fails closed.
    const lstat = vi.fn(() => Promise.resolve({ size: 5 }))
    const readFile = vi.fn(() => Promise.resolve(Buffer.from("x".repeat(100))))

    await expect(
      scanRegularFilesForRawValue("/root", MARKER, {
        opendir,
        lstat,
        readFile,
        maxBytes: 50,
      }),
    ).rejects.toThrow(BoundedRawValueScanError)
  })

  it("never includes the raw value in a thrown error message", async () => {
    await withTempDir(async (root) => {
      await writeFile(path.join(root, "big.txt"), MARKER + "x".repeat(200))

      let thrown: unknown
      try {
        await scanRegularFilesForRawValue(root, MARKER, { maxBytes: 10 })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(BoundedRawValueScanError)
      expect(String(thrown)).not.toContain(MARKER)
    })
  })

  describe("structuralExclusions", () => {
    it("skips an exact excluded path without opening or reading it", async () => {
      await withTempDir(async (root) => {
        const excludedPath = path.join(root, "null-netns")
        await writeFile(excludedPath, MARKER)
        await writeFile(path.join(root, "other.txt"), "clean")

        const result = await scanRegularFilesForRawValue(root, MARKER, {
          structuralExclusions: new Set([path.resolve(excludedPath)]),
        })

        expect(result).toEqual({
          found: false,
          scannedEntries: 2,
          scannedFiles: 1,
          scannedBytes: 5,
          skippedStructuralExclusions: 1,
          complete: true,
        })
      })
    })

    it("never skips a same-named entry that is not in the exact exclusion set", async () => {
      await withTempDir(async (root) => {
        await writeFile(path.join(root, "null-netns"), MARKER)

        const result = await scanRegularFilesForRawValue(root, MARKER, {
          structuralExclusions: new Set([
            path.resolve(root, "not-the-same-file"),
          ]),
        })

        expect(result).toEqual({
          found: true,
          scannedEntries: 1,
          scannedFiles: 1,
          scannedBytes: MARKER.length,
          skippedStructuralExclusions: 0,
          complete: true,
        })
      })
    })

    it("never skips an unrelated file merely because some other exclusion is configured", async () => {
      await withTempDir(async (root) => {
        const excludedPath = path.join(root, "null-netns")
        await writeFile(excludedPath, "clean")
        await writeFile(path.join(root, "unrelated.txt"), MARKER)

        const result = await scanRegularFilesForRawValue(root, MARKER, {
          structuralExclusions: new Set([path.resolve(excludedPath)]),
        })

        expect(result.found).toBe(true)
        expect(result.skippedStructuralExclusions).toBe(1)
        expect(result.scannedFiles).toBe(1)
      })
    })

    it("still fails closed on an unreadable file that is not in the exclusion set", async () => {
      const opendir = vi.fn(() =>
        Promise.resolve(
          fakeDirectory([
            fakeEntry("null-netns", "file"),
            fakeEntry("other-unreadable", "file"),
          ]),
        ),
      )
      const lstat = vi.fn((targetPath: string) =>
        targetPath.endsWith("other-unreadable")
          ? Promise.reject(new Error("EACCES"))
          : Promise.resolve({ size: 0 }),
      )
      const readFile = vi.fn(() => Promise.resolve(Buffer.alloc(0)))

      await expect(
        scanRegularFilesForRawValue("/root", MARKER, {
          opendir,
          lstat,
          readFile,
          structuralExclusions: new Set([path.resolve("/root/null-netns")]),
        }),
      ).rejects.toThrow(BoundedRawValueScanError)
    })
  })
})
