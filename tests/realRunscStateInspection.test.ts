import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"
import {
  classifyNullNetns,
  parseMountInfo,
  reconcileDedicatedRunscStateForCleanup,
  removeDedicatedTestRootIfReconciled,
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

function enoent(): NodeJS.ErrnoException {
  const error = new Error(
    "ENOENT: no such file or directory",
  ) as NodeJS.ErrnoException
  error.code = "ENOENT"
  return error
}

function eacces(): NodeJS.ErrnoException {
  const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException
  error.code = "EACCES"
  return error
}

describe("parseMountInfo", () => {
  it("extracts mount point and filesystem type", () => {
    const contents = `${nsfsMountInfo(NULL_NETNS_PATH)}${otherFsMountInfo("/", "ext4")}`
    expect(parseMountInfo(contents)).toEqual([
      { mountPoint: NULL_NETNS_PATH, fsType: "nsfs" },
      { mountPoint: "/", fsType: "ext4" },
    ])
  })

  it("skips a malformed line rather than throwing", () => {
    expect(parseMountInfo("\n\nnot a real line\n")).toEqual([])
  })

  it("decodes octal-escaped whitespace in mount point paths", () => {
    const contents = "36 35 0:32 / /a\\040b rw shared:1 - nsfs nsfs rw\n"
    expect(parseMountInfo(contents)).toEqual([
      { mountPoint: "/a b", fsType: "nsfs" },
    ])
  })
})

describe("classifyNullNetns", () => {
  it("classifies absent when lstat reports ENOENT", async () => {
    const lstat = vi.fn(() => Promise.reject(enoent()))

    const result = await classifyNullNetns(RUNSC_ROOT, { lstat })

    expect(result).toEqual({ kind: "absent" })
  })

  it("classifies unknown, never absent, when lstat fails for any other reason", async () => {
    const lstat = vi.fn(() => Promise.reject(eacces()))

    const result = await classifyNullNetns(RUNSC_ROOT, { lstat })

    expect(result.kind).toBe("unknown")
    if (result.kind === "unknown") {
      expect(result.reason).not.toContain(MARKER)
    }
  })

  it("classifies symlink and never reads mount information for it", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => true, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual({ kind: "symlink" })
    expect(readMountInfo).not.toHaveBeenCalled()
  })

  it("classifies unknown when mount information cannot be read", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() => Promise.reject(eacces()))

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.kind).toBe("unknown")
  })

  it("classifies unknown when mount information contains an unparseable line", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // Looks nothing like a real mountinfo line -- a genuine
    // /proc/self/mountinfo never contains a line like this, so treating the
    // whole read as untrustworthy is the safe call.
    const readMountInfo = vi.fn(() =>
      Promise.resolve("this is not a mountinfo line at all\n"),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.kind).toBe("unknown")
  })

  it("classifies unknown when mount information is empty", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() => Promise.resolve(""))

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result.kind).toBe("unknown")
  })

  it("classifies present-non-nsfs for an ordinary file with no matching mount", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo("/", "ext4")),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual({ kind: "present-non-nsfs" })
  })

  it("classifies present-non-nsfs when the exact path is mounted but not nsfs", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(otherFsMountInfo(NULL_NETNS_PATH, "tmpfs")),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual({ kind: "present-non-nsfs" })
  })

  it("classifies present-non-nsfs when mountinfo shows only a containing mount, not an exact match", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // Only the parent directory is a distinct mount; null-netns itself is
    // just a regular file inside it, not its own mount point.
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(RUNSC_ROOT)),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual({ kind: "present-non-nsfs" })
  })

  it("classifies exact-nsfs-mount only for an exact, proven match", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )

    const result = await classifyNullNetns(RUNSC_ROOT, {
      lstat,
      readMountInfo,
    })

    expect(result).toEqual({ kind: "exact-nsfs-mount", path: NULL_NETNS_PATH })
  })
})

describe("scanRunscStateForRawValue", () => {
  function fakeDirWithNullNetnsAndStateFile() {
    return vi.fn((targetPath: string) =>
      Promise.resolve({
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
      }),
    )
  }

  it("skips the proven null-netns mount and still finds a marker elsewhere", async () => {
    const lstat = vi.fn((targetPath: string) =>
      targetPath === NULL_NETNS_PATH
        ? Promise.resolve({ isSymbolicLink: () => false, size: 0 })
        : Promise.resolve({ isSymbolicLink: () => false, size: MARKER.length }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const opendir = fakeDirWithNullNetnsAndStateFile()
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

  it("adds no exclusion, and still fails closed, when classification is unknown", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    // mountinfo unreadable -- classification is "unknown", not a proven
    // exclusion, so null-netns is left to the normal (fail-closed) scan.
    const readMountInfo = vi.fn(() => Promise.reject(eacces()))
    const opendir = fakeDirWithNullNetnsAndStateFile()
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
  it("returns ok:true without unmounting when null-netns is absent (ENOENT)", async () => {
    const lstat = vi.fn(() => Promise.reject(enoent()))
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      processRunner: { run },
    })

    expect(result).toEqual({ ok: true })
    expect(run).not.toHaveBeenCalled()
  })

  it("returns ok:false, never ok:true, when lstat fails for a reason other than absence", async () => {
    const lstat = vi.fn(() => Promise.reject(eacces()))
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("returns ok:false when mount information cannot be read", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() => Promise.reject(eacces()))
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("returns ok:false when mount information is malformed/unparseable", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve("garbage, not mountinfo\n"),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it("returns ok:true, no umount, for a proven ordinary null-netns file", async () => {
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

  it("unmounts exactly the proven exact path once when a single mount clears immediately", async () => {
    let mounted = true
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(
        mounted
          ? nsfsMountInfo(NULL_NETNS_PATH)
          : otherFsMountInfo("/", "ext4"),
      ),
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
        remainingLayers > 0
          ? nsfsMountInfo(NULL_NETNS_PATH)
          : otherFsMountInfo("/", "ext4"),
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

  it("returns ok:false and preserves the root when a failed umount leaves the mount in place", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const run = vi.fn<ProcessRunner["run"]>(() =>
      Promise.resolve({
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "umount: target is busy",
      }),
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
    expect(run.mock.calls.length).toBeGreaterThan(1)
  })

  it("never infers success merely from the umount command's own invocation", async () => {
    // The command always reports success, but the mount never actually
    // clears -- proves success is judged only by reclassification.
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))

    const result = await reconcileDedicatedRunscStateForCleanup(RUNSC_ROOT, {
      lstat,
      readMountInfo,
      processRunner: { run },
    })

    expect(result.ok).toBe(false)
    expect(run.mock.calls.length).toBeGreaterThan(1)
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

  it("only ever targets the exact dedicated-root null-netns path, never a wildcard", async () => {
    let calls = 0
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? nsfsMountInfo(NULL_NETNS_PATH)
          : otherFsMountInfo("/", "ext4"),
      )
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

describe("removeDedicatedTestRootIfReconciled", () => {
  it("removes the root when null-netns is absent", async () => {
    const lstat = vi.fn(() => Promise.reject(enoent()))
    const rmFn = vi.fn(() => Promise.resolve())

    const outcome = await removeDedicatedTestRootIfReconciled(
      "/owned/test-root",
      RUNSC_ROOT,
      { lstat, rm: rmFn },
    )

    expect(outcome).toEqual({ removed: true })
    expect(rmFn).toHaveBeenCalledWith("/owned/test-root")
  })

  it("preserves the evidence root instead of removing it when classification is unknown", async () => {
    const lstat = vi.fn(() => Promise.reject(eacces()))
    const rmFn = vi.fn(() => Promise.resolve())

    const outcome = await removeDedicatedTestRootIfReconciled(
      "/owned/test-root",
      RUNSC_ROOT,
      { lstat, rm: rmFn },
    )

    expect(outcome.removed).toBe(false)
    expect(rmFn).not.toHaveBeenCalled()
  })

  it("preserves the evidence root when a genuine nsfs mount never clears", async () => {
    const lstat = vi.fn(() =>
      Promise.resolve({ isSymbolicLink: () => false, size: 0 }),
    )
    const readMountInfo = vi.fn(() =>
      Promise.resolve(nsfsMountInfo(NULL_NETNS_PATH)),
    )
    const run = vi.fn<ProcessRunner["run"]>(() => Promise.resolve(okResult()))
    const rmFn = vi.fn(() => Promise.resolve())

    const outcome = await removeDedicatedTestRootIfReconciled(
      "/owned/test-root",
      RUNSC_ROOT,
      { lstat, readMountInfo, processRunner: { run }, rm: rmFn },
    )

    expect(outcome.removed).toBe(false)
    expect(rmFn).not.toHaveBeenCalled()
  })
})
