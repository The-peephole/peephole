import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import {
  GENERATED_SECRET_FILE_NAME,
  TmpfsGeneratedSecretFilesystem,
} from "../services/preview-worker/gvisor/generatedSecretFilesystem"
import { GeneratedSecretOrphanReaper } from "../services/preview-worker/gvisor/generatedSecretOrphanReaper"
import type { GeneratedSecretMaterial } from "../types/backendRuntimeSecrets"

const RUNTIME_ID = "runtime-1234"
const MARKER = "M10BMarker_7Hn9-Q"

function material(
  runtimeId = RUNTIME_ID,
  marker = MARKER,
): GeneratedSecretMaterial {
  return {
    runtimeId,
    values: new Map([
      ["SESSION_SECRET", createOpaqueSecretValue(marker)],
      ["JWT_SECRET", createOpaqueSecretValue("JwtValue_123")],
    ]),
  }
}

describe("TmpfsGeneratedSecretFilesystem", () => {
  let parentDir: string
  let secretRoot: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), "peephole-secrets-"))
    secretRoot = path.join(parentDir, "memory-root")
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function filesystem(
    overrides: Partial<
      ConstructorParameters<typeof TmpfsGeneratedSecretFilesystem>[0]
    > = {},
  ) {
    return new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
      ...overrides,
    })
  }

  it("writes deterministic material only below the configured root with restrictive modes", async () => {
    const store = filesystem()
    const runtimeDir = await store.create(material())
    const secretFile = path.join(runtimeDir, GENERATED_SECRET_FILE_NAME)

    expect(runtimeDir).toBe(path.join(secretRoot, RUNTIME_ID))
    expect(await readFile(secretFile, "utf8")).toBe(
      `JWT_SECRET=JwtValue_123\nSESSION_SECRET=${MARKER}\n`,
    )
    if (process.platform !== "win32") {
      expect((await stat(secretRoot)).mode & 0o777).toBe(0o700)
      expect((await stat(runtimeDir)).mode & 0o777).toBe(0o700)
      expect((await stat(secretFile)).mode & 0o777).toBe(0o600)
    }
    expect(path.relative(secretRoot, secretFile).startsWith("..")).toBe(false)
  })

  it("requests restrictive modes even on hosts without POSIX mode enforcement", async () => {
    const modes: Array<{ candidate: string; mode: number }> = []
    const store = filesystem({
      setMode: async (candidate, mode) => {
        modes.push({ candidate, mode })
      },
    })
    await store.create(material())

    expect(modes).toEqual([
      { candidate: secretRoot, mode: 0o700 },
      { candidate: path.join(secretRoot, RUNTIME_ID), mode: 0o700 },
      {
        candidate: path.join(
          secretRoot,
          RUNTIME_ID,
          GENERATED_SECRET_FILE_NAME,
        ),
        mode: 0o600,
      },
    ])
  })

  it("removes material idempotently", async () => {
    const store = filesystem()
    const runtimeDir = await store.create(material())

    await store.remove(RUNTIME_ID)
    await store.remove(RUNTIME_ID)

    await expect(lstat(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("cleans partial directory and file creation failures", async () => {
    const store = filesystem({
      setOwnership: async () => {
        throw new Error("simulated ownership failure")
      },
    })

    await expect(store.create(material())).rejects.toThrow(
      "Generated-secret filesystem operation failed",
    )
    await expect(readdir(secretRoot)).resolves.toEqual([])
  })

  it.each(["../escape", "short", "runtime/escape", "runtime\\escape"])(
    "rejects invalid runtime id %s",
    async (runtimeId) => {
      const store = filesystem()
      await expect(store.create(material(runtimeId))).rejects.toThrow(
        "Invalid backend runtime id",
      )
    },
  )

  it("fails closed on a runtime-shaped symlink without touching its target", async () => {
    await mkdir(secretRoot, { mode: 0o700 })
    const outside = path.join(parentDir, "outside")
    await mkdir(outside)
    await writeFile(path.join(outside, "keep"), "operator data")
    await symlink(outside, path.join(secretRoot, RUNTIME_ID), "junction")
    const store = filesystem()

    await expect(store.create(material())).rejects.toThrow(
      "Generated-secret filesystem operation failed",
    )
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe(
      "operator data",
    )
  })

  it("fails closed when the configured root is not verified as tmpfs and never includes a value in the error", async () => {
    const store = filesystem({
      verifyMemoryBackedRoot: async () => {
        throw new Error("not memory backed")
      },
    })
    const error = await store.create(material()).catch((failure) => failure)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(MARKER)
    await expect(readdir(secretRoot)).resolves.toEqual([])
  })

  it("never reflects a revealed-value failure into its error", async () => {
    const store = filesystem()
    const poisoned: GeneratedSecretMaterial = {
      runtimeId: RUNTIME_ID,
      values: new Map([
        [
          "SESSION_SECRET",
          {
            reveal: () => {
              throw new Error(MARKER)
            },
          },
        ],
      ]),
    }

    const error = await store.create(poisoned).catch((failure) => failure)
    expect(String(error)).not.toContain(MARKER)
  })

  it("rejects a secret root overlapping persistent bundle storage", () => {
    const bundlesRoot = path.join(parentDir, "jobs")
    expect(() =>
      filesystem({
        rootDir: path.join(bundlesRoot, "secrets"),
        forbiddenRoots: [bundlesRoot],
      }),
    ).toThrow(/separate from persistent bundle storage/)
  })
})

describe("GeneratedSecretOrphanReaper", () => {
  let parentDir: string
  let secretRoot: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), "peephole-reaper-"))
    secretRoot = path.join(parentDir, "secrets")
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function store() {
    return new TmpfsGeneratedSecretFilesystem({
      rootDir: secretRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
  }

  it("is safe on a missing root", async () => {
    const reaper = new GeneratedSecretOrphanReaper({
      rootDir: secretRoot,
      filesystem: store(),
      verifyMemoryBackedRoot: async () => undefined,
    })
    await expect(reaper.reapAll()).resolves.toEqual([])
  })

  it("deletes only valid owned directories and leaves unrelated entries", async () => {
    const filesystem = store()
    await filesystem.create(material("runtime-1111"))
    await filesystem.create(material("runtime-2222"))
    await writeFile(path.join(secretRoot, "operator-note"), "keep")
    const reaper = new GeneratedSecretOrphanReaper({
      rootDir: secretRoot,
      filesystem,
      verifyMemoryBackedRoot: async () => undefined,
    })

    await expect(reaper.reapAll()).resolves.toEqual([
      "runtime-1111",
      "runtime-2222",
    ])
    await expect(
      readFile(path.join(secretRoot, "operator-note"), "utf8"),
    ).resolves.toBe("keep")
  })

  it("rejects a runtime-shaped symlink escape", async () => {
    await mkdir(secretRoot, { recursive: true })
    const outside = path.join(parentDir, "outside")
    await mkdir(outside)
    await writeFile(path.join(outside, "keep"), "keep")
    await symlink(outside, path.join(secretRoot, RUNTIME_ID), "junction")
    const reaper = new GeneratedSecretOrphanReaper({
      rootDir: secretRoot,
      filesystem: store(),
      verifyMemoryBackedRoot: async () => undefined,
    })

    await expect(reaper.reapAll()).rejects.toThrow(/symlink/)
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe(
      "keep",
    )
  })

  it("bounds each startup sweep", async () => {
    const filesystem = store()
    for (const runtimeId of ["runtime-1111", "runtime-2222", "runtime-3333"]) {
      await filesystem.create(material(runtimeId))
    }
    const reaper = new GeneratedSecretOrphanReaper({
      rootDir: secretRoot,
      filesystem,
      maxEntriesPerSweep: 2,
      verifyMemoryBackedRoot: async () => undefined,
    })

    expect(await reaper.reapAll()).toHaveLength(2)
    expect(await readdir(secretRoot)).toHaveLength(1)
  })
})
