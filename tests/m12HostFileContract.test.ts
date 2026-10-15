import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const inspection = vi.hoisted(() => ({
  real: false,
  uid: 0,
  mode: 0o400,
  symlink: false,
  regular: true,
  canonical: true,
  contents: "",
  reads: 0,
}))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    realpath: async (file: string) =>
      inspection.real
        ? actual.realpath(file)
        : inspection.canonical
          ? file
          : "/other",
    lstat: async (file: string) =>
      inspection.real
        ? // The setup connection test shims privilege, not actual root ownership.
          // Preserve real type/mode/size and simulate only the root uid.
          Object.assign(await actual.lstat(file), { uid: 0 })
        : {
            uid: inspection.uid,
            mode: inspection.mode,
            size: 128,
            isFile: () => inspection.regular,
            isSymbolicLink: () => inspection.symlink,
          },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      inspection.reads++
      return inspection.real ? actual.readFile(...args) : inspection.contents
    },
  }
})
import {
  readCombinedHostFile,
  readCombinedParentMarker,
} from "./support/m12CombinedSafety"

const parent = "/srv/peephole-m12-file-contract"
const marker = `peephole-m12-test-parent/v1\n${"a".repeat(32)}\n${parent}\n`
beforeEach(() =>
  Object.assign(inspection, {
    real: false,
    uid: 0,
    mode: 0o400,
    symlink: false,
    regular: true,
    canonical: true,
    contents: marker,
    reads: 0,
  }),
)

describe("combined host file contracts", () => {
  it("accepts precisely the immutable 0400 parent marker", async () => {
    await expect(readCombinedParentMarker(parent)).resolves.toBeUndefined()
  })
  it.each([0o000, 0o600, 0o440, 0o444, 0o644, 0o777, 0o4400])(
    "rejects parent marker mode %i",
    async (mode) => {
      inspection.mode = mode
      await expect(readCombinedParentMarker(parent)).rejects.toThrow(
        "HOST_OWNERSHIP_REJECTED",
      )
      expect(inspection.reads).toBe(0)
    },
  )
  it.each(["attestation", "credential"] as const)(
    "retains 0600 for %s",
    async (kind) => {
      await expect(readCombinedHostFile("/private", kind)).rejects.toThrow(
        "HOST_OWNERSHIP_REJECTED",
      )
      inspection.mode = 0o600
      await expect(readCombinedHostFile("/private", kind)).resolves.toBe(marker)
      inspection.mode = 0o640
      await expect(readCombinedHostFile("/private", kind)).rejects.toThrow(
        "HOST_OWNERSHIP_REJECTED",
      )
    },
  )
  it.each([
    { uid: 1 },
    { symlink: true },
    { regular: false },
    { canonical: false },
  ])("rejects an unowned/nonregular/noncanonical marker %#", async (change) => {
    Object.assign(inspection, change)
    await expect(readCombinedParentMarker(parent)).rejects.toThrow(
      "HOST_OWNERSHIP_REJECTED",
    )
    expect(inspection.reads).toBe(0)
  })
  it.each([
    marker.replace("/v1", "/v2"),
    marker.replace("a".repeat(32), "wrong"),
    marker.replace(parent, "/srv/other"),
    `${marker}extra\n`,
    marker.trimEnd(),
  ])("rejects malformed or differently bound marker %#", async (contents) => {
    inspection.contents = contents
    await expect(readCombinedParentMarker(parent)).rejects.toThrow(
      "HOST_OWNERSHIP_REJECTED",
    )
  })
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})
it.skipIf(process.platform !== "linux")(
  "accepts the marker produced by actual setup (shimmed privilege/mount only)",
  async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises")
    const base = await actual.realpath(
      await actual.mkdtemp(path.join(os.tmpdir(), "m12-marker-contract-")),
    )
    roots.push(base)
    const target = path.join(base, "parent")
    const script = fileURLToPath(
      new URL("./support/m12-test-host.sh", import.meta.url),
    )
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; require_root() { :; }; mount() { :; }; findmnt() { echo tmpfs; }; cmd_setup "$2"',
        "m12-setup-contract",
        script,
        target,
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    const stat = await actual.lstat(
      path.join(target, ".peephole-m12-test-parent"),
    )
    expect(stat.mode & 0o7777).toBe(0o400)
    inspection.real = true
    await expect(readCombinedParentMarker(target)).resolves.toBeUndefined()
  },
)
