import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import {
  findExactNullNetnsMount,
  parseMountInfo,
  reconcileDedicatedRunscStateForCleanup,
  scanRunscStateForRawValue,
} from "./support/realRunscStateInspection"

const MARKER = "M10C4B_RunscScanMarker_7fQx"
// Resolved with the same platform-default `path` module the source uses, so
// this matches exactly what `path.resolve(runscRootDir, "null-netns")`
// computes there -- a raw POSIX-style literal would silently mismatch on
// Windows, where `path.resolve` produces a drive-qualified, backslash path.
const RUNSC_ROOT = path.resolve("/run/peephole/real-gvisor-test/runsc")
const NULL_NETNS_PATH = path.join(RUNSC_ROOT, "null-netns")

function nsfsMountInfo(mountPoint: string): string {
  return `36 35 0:32 / ${mountPoint} rw shared:1 - nsfs nsfs rw\n`
}

function otherFsMountInfo(mountPoint: string, fsType: string): string {
  return `36 35 8:1 / ${mountPoint} rw relatime - ${fsType} /dev/root rw\n`
}

function okResult(): ProcessRunResult {
  return { exitCode: 0, timedOut: false, stdout: "", stderr: "" }
}

describe("parseMountInfo", () => {
  it("extracts mount point and filesystem type", () => {
    const contents = `${nsfsMountInfo(NULL_NETNS_PATH)}${otherFsMountInfo("/", "ext4")}`
    expect(parseMountInfo(contents)).toEqual([
      { mountPoint: NULL_NETNS_PATH, fsType: "nsfs" },
      { mountPoint: "/", fsType: "ext4" },
    ])
  })

  it("ignores blank lines and malformed entries", () => {
    expect(parseMountInfo("\n\nnot a real line\n")).toEqual([])
  })

  it("decodes octal-escaped whitespace in mount point paths", () => {
    const contents = "36 35 0:32 / /a\\040b rw shared:1 - nsfs nsfs rw\n"
    expect(parseMountInfo(contents)).toEqual([
      { mountPoint: "/a b", fsType: "nsfs" },
    ])
  })
})

describe("findExactNullNetnsMount", () => {
  it("excludes the exact path only when it exists, is not a symlink, and is a real nsfs mount", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual(new Set([NULL_NETNS_PATH]))
  })

  it("does not exclude when the path does not exist", async () => {
    const lstat = vi.fn(() => Promise.reject(new Error("ENOENT")))

    const result = await findExactNullNetnsMount(RUNSC_ROOT, { lstat })

    expect(result.size).toBe(0)
  })

  it("does not exclude a symlink, even if mountinfo would otherwise match", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => true, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.size).toBe(0)
    expect(readMountInfo).not.toHaveBeenCalled()
  })

  it("does not exclude a plain regular file that merely has the right name", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // No mount at this path at all -- just a regular file sharing the name.
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo("/", "ext4")),
    )

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.size).toBe(0)
  })

  it("does not exclude when the mount point exists but its filesystem type is not nsfs", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo(NULL_NETNS_PATH, "tmpfs")),
    )

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.size).toBe(0)
  })

  it("does not exclude when mountinfo shows only a containing mount, not an exact match", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // Only the parent directory is a distinct mount; null-netns itself is
    // just a regular file inside it, not its own mount point.
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(RUNSC_ROOT)),
    )

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.size).toBe(0)
  })

  it("does not exclude when mountinfo cannot be read", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() => Promise.reject(new Error("EACCES")))

    const result = await findExactNullNetnsMount(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.size).toBe(0)
  })
})

describe("scanRunscStateForRawValue", () => {
  it("skips the proven null-netns mount and still finds a marker elsewhere", async () => {
    const lstat = vi.fn((targetPath: string) =>
      targetPath === NULL_NETNS_PATH
        ? Promise.resolve({ isSymbolicLink: () => false, size: 0 })
        : Promise.resolve({ isSymbolicLink: () => false, size: MARKER.length }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const opendirCalls: string[] = []
    const opendir = vi.fn((targetPath: string) => {
      opendirCalls.push(targetPath)
      return Promise.resolve({
        close: () => Promise.resolve(),
        [Symbol.asyncIterator]: () => {
          const entries =
            targetPath === RUNSC_ROOT
              ? [
                  {
                    name: "null-netns",
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                  },
                  {
                    name: "state.json",
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                  },
                ]
              : []
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
      })
    })
    const readFile = vi.fn((targetPath: string) =>
      targetPath.endsWith("state.json")
        ? Promise.resolve(Buffer.from(MARKER))
        : Promise.reject(new Error("should never read null-netns")),
    )

    const result = await scanRunscStateForRawValue(RUNSC_ROOT, MARKER, {
      lstat,
      readMountInfo,
      opendir,
      readFile,
    })

    expect(result.found).toBe(true)
    expect(result.skippedKernelNamespaceMounts).toBe(1)
    expect(result.complete).toBe(true)
    expect(readFile).not.toHaveBeenCalledWith(NULL_NETNS_PATH)
  })

  it("still fails closed when null-netns is not a proven mount and cannot be read", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // mountinfo shows no match at all -- null-netns is left to the normal
    // (fail-closed) scan path, where it cannot actually be read.
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo("/", "ext4")),
    )
    const opendir = vi.fn(() =>
      Promise.resolve({
        close: () => Promise.resolve(),
        [Symbol.asyncIterator]: () => {
          const entries = [
            {
              name: "null-netns",
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
          ]
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
      }),
    )
    const readFile = vi.fn(() => Promise.reject(new Error("not readable")))

    await expect(
      scanRunscStateForRawValue(RUNSC_ROOT, MARKER, {
        lstat,
        readMountInfo,
        opendir,
        readFile,
      }),
    ).rejects.toThrow(/could not read/)
  })
})

describe("reconcileDedicatedRunscStateForCleanup", () => {
  it("returns ok:true without unmounting when null-netns does not exist", async () => {
    const lstat = vi.fn(() => Promise.reject(new Error("ENOENT")))
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      processRunner: { run },
    })

    expect(result).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  it("unmounts exactly the proven exact path once when a single mount clears immediately", async () => {
    let mounted = true
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(mounted ? nsfsMountInfo(NULL_NETNS_PATH) : ""),
    )
    const run = vi.fn<ProcessRunner["run"]>((_command, args) => {
      expect(args).toEqual([NULL_NETNS_PATH])
      mounted = false
      return Promise.resolve(okResult())
    })

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("loops a bounded number of times for a stacked mount and still succeeds", async () => {
    let remainingLayers = 3
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(
        remainingLayers > 0 ? nsfsMountInfo(NULL_NETNS_PATH) : "",
      ),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => {
      remainingLayers -= 1
      return Promise.resolve(okResult())
    })

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result).toEqual({ ok: true })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it("returns ok:false and preserves the root when the mount never clears within the retry budget", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const run = vi.fn<ProcessRunner["run"]>(() =>
      Promise.reject(new Error("umount: target is busy")),
    )

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).not.toContain(MARKER)
    }
  })

  it("refuses to touch a symlink where the mount should be", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => true, size: 0 }),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("does not unmount a plain regular file that is not actually a mount", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo("/", "ext4")),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  it("only ever targets the exact dedicated-root null-netns path, never a wildcard", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    let calls = 0
    const readMountInfo = vi.fn(() => {
      calls += 1
      return Promise.resolve(calls === 1 ? nsfsMountInfo(NULL_NETNS_PATH) : "")
    })
    const run = vi.fn<ProcessRunner["run"]>((command, args) => {
      expect(command).toBe("umount")
      expect(args).toEqual([NULL_NETNS_PATH])
      return Promise.resolve(okResult())
    })

    await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(run).toHaveBeenCalledTimes(1)
  })
})
