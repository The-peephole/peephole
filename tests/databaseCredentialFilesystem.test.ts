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

import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../core/backendDatabase/databaseUrl"
import { mintTemporaryDatabaseResourceId } from "../core/backendDatabase/resourceIdentity"
import { createOpaqueSecretValue } from "../core/backendSecrets/generatedSecretValue"
import {
  DATABASE_CREDENTIAL_FILE_NAME,
  TmpfsDatabaseCredentialFilesystem,
  serializeDatabaseCredentialMaterial,
} from "../services/preview-worker/gvisor/databaseCredentialFilesystem"
import { DatabaseCredentialOrphanReaper } from "../services/preview-worker/gvisor/databaseCredentialOrphanReaper"
import type { TemporaryDatabaseRuntimeCredentialMaterial } from "../types/temporaryDatabase"

const RUNTIME_ID = "runtime-1234"
const MARKER = "DbCredMarker_7Hn9-Q"
const RESOURCE_ID = mintTemporaryDatabaseResourceId(() =>
  new Uint8Array(14).fill(3),
)

function material(
  runtimeId = RUNTIME_ID,
  url = `postgresql://pv_x:${MARKER}@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/pv_x`,
): TemporaryDatabaseRuntimeCredentialMaterial {
  return {
    runtimeId,
    resourceId: RESOURCE_ID,
    databaseUrl: createOpaqueSecretValue(url),
  }
}

describe("TmpfsDatabaseCredentialFilesystem", () => {
  let parentDir: string
  let credentialRoot: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), "peephole-db-cred-"))
    credentialRoot = path.join(parentDir, "memory-root")
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function filesystem(
    overrides: Partial<
      ConstructorParameters<typeof TmpfsDatabaseCredentialFilesystem>[0]
    > = {},
  ) {
    return new TmpfsDatabaseCredentialFilesystem({
      rootDir: credentialRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
      ...overrides,
    })
  }

  it("writes the exact fixed file, at the exact fixed host path, with restrictive modes", async () => {
    const store = filesystem()
    const input = material()
    const credentialFile = await store.create(input)

    expect(credentialFile).toBe(
      path.join(credentialRoot, RUNTIME_ID, DATABASE_CREDENTIAL_FILE_NAME),
    )
    expect(path.basename(credentialFile)).toBe("database-url")
    expect(await readFile(credentialFile, "utf8")).toBe(
      `${input.databaseUrl.reveal()}\n`,
    )
    if (process.platform !== "win32") {
      expect((await stat(credentialRoot)).mode & 0o777).toBe(0o700)
      expect(
        (await stat(path.join(credentialRoot, RUNTIME_ID))).mode & 0o777,
      ).toBe(0o700)
      expect((await stat(credentialFile)).mode & 0o777).toBe(0o600)
    }
    expect(path.relative(credentialRoot, credentialFile).startsWith("..")).toBe(
      false,
    )
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
      { candidate: credentialRoot, mode: 0o700 },
      { candidate: path.join(credentialRoot, RUNTIME_ID), mode: 0o700 },
      {
        candidate: path.join(
          credentialRoot,
          RUNTIME_ID,
          DATABASE_CREDENTIAL_FILE_NAME,
        ),
        mode: 0o600,
      },
    ])
  })

  it("removes material idempotently", async () => {
    const store = filesystem()
    const credentialFile = await store.create(material())

    await store.remove(RUNTIME_ID)
    await store.remove(RUNTIME_ID)

    await expect(lstat(credentialFile)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("cleans partial directory and file creation failures", async () => {
    const store = filesystem({
      setOwnership: async () => {
        throw new Error("simulated ownership failure")
      },
    })

    await expect(store.create(material())).rejects.toThrow(
      "Database credential filesystem operation failed",
    )
    await expect(readdir(credentialRoot)).resolves.toEqual([])
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
    await mkdir(credentialRoot, { mode: 0o700 })
    const outside = path.join(parentDir, "outside")
    await mkdir(outside)
    await writeFile(path.join(outside, "keep"), "operator data")
    await symlink(outside, path.join(credentialRoot, RUNTIME_ID), "junction")
    const store = filesystem()

    await expect(store.create(material())).rejects.toThrow(
      "Database credential filesystem operation failed",
    )
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe(
      "operator data",
    )
  })

  it("fails closed when the configured root is not verified as tmpfs and never includes the URL in the error", async () => {
    const store = filesystem({
      verifyMemoryBackedRoot: async () => {
        throw new Error("not memory backed")
      },
    })
    const error = await store.create(material()).catch((failure) => failure)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(MARKER)
    await expect(readdir(credentialRoot)).resolves.toEqual([])
  })

  it("never reflects a revealed-value failure into its error", async () => {
    const store = filesystem()
    const poisoned: TemporaryDatabaseRuntimeCredentialMaterial = {
      runtimeId: RUNTIME_ID,
      resourceId: RESOURCE_ID,
      databaseUrl: {
        reveal: () => {
          throw new Error(MARKER)
        },
      },
    }

    const error = await store.create(poisoned).catch((failure) => failure)
    expect(String(error)).not.toContain(MARKER)
  })

  it("rejects a database credential root overlapping persistent bundle storage", () => {
    const bundlesRoot = path.join(parentDir, "jobs")
    expect(() =>
      filesystem({
        rootDir: path.join(bundlesRoot, "db-credentials"),
        forbiddenRoots: [bundlesRoot],
      }),
    ).toThrow(/separate from other Peephole storage roots/)
  })

  it("rejects a database credential root overlapping the M10 generated-secret root", () => {
    const secretsRoot = "/run/peephole/secrets"
    expect(() =>
      filesystem({ rootDir: path.join(secretsRoot, "nested") }),
    ).toThrow(/separate from other Peephole storage roots/)
  })

  it("rejects an oversized value", () => {
    const oversized = `postgresql://pv_x:${"a".repeat(5_000)}@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/pv_x`
    expect(() =>
      serializeDatabaseCredentialMaterial(material(RUNTIME_ID, oversized)),
    ).toThrow(/invalid value/)
  })

  it("rejects a value that does not target the fixed tenant endpoint", () => {
    expect(() =>
      serializeDatabaseCredentialMaterial(
        material(RUNTIME_ID, "postgresql://pv_x:pw@evil.example:5432/pv_x"),
      ),
    ).toThrow(/tenant endpoint/)
  })

  it("rejects a non-URL value", () => {
    expect(() =>
      serializeDatabaseCredentialMaterial(material(RUNTIME_ID, "not-a-url")),
    ).toThrow(/not a valid URL/)
  })

  it("never uses generic NAME=value serialization -- the file has no '=' grammar", async () => {
    const store = filesystem()
    const url = `postgresql://pv_x:${MARKER}@${TENANT_DATABASE_HOST}:${String(TENANT_DATABASE_PORT)}/pv_x`
    const credentialFile = await store.create(material(RUNTIME_ID, url))
    const contents = await readFile(credentialFile, "utf8")

    expect(contents).toBe(`${url}\n`)
    expect(contents.split("\n").filter(Boolean)).toHaveLength(1)
  })
})

describe("DatabaseCredentialOrphanReaper", () => {
  let parentDir: string
  let credentialRoot: string

  beforeEach(async () => {
    parentDir = await mkdtemp(path.join(os.tmpdir(), "peephole-db-reaper-"))
    credentialRoot = path.join(parentDir, "db-credentials")
  })

  afterEach(async () => {
    await rm(parentDir, { recursive: true, force: true })
  })

  function store() {
    return new TmpfsDatabaseCredentialFilesystem({
      rootDir: credentialRoot,
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })
  }

  it("is safe on a missing root", async () => {
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem: store(),
      verifyMemoryBackedRoot: async () => undefined,
    })
    await expect(reaper.reapAll()).resolves.toEqual([])
  })

  it("rejects a reaper/filesystem root mismatch", () => {
    const mismatchedFilesystem = new TmpfsDatabaseCredentialFilesystem({
      rootDir: path.join(parentDir, "other-db-credentials"),
      verifyMemoryBackedRoot: async () => undefined,
      setOwnership: async () => undefined,
    })

    expect(
      () =>
        new DatabaseCredentialOrphanReaper({
          rootDir: credentialRoot,
          filesystem: mismatchedFilesystem,
          verifyMemoryBackedRoot: async () => undefined,
        }),
    ).toThrow(/roots must match/)
  })

  it("startup reapAll deletes every owned directory regardless of age", async () => {
    const filesystem = store()
    await filesystem.create(material("runtime-1111"))
    await filesystem.create(material("runtime-2222"))
    await writeFile(path.join(credentialRoot, "operator-note"), "keep")
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem,
      verifyMemoryBackedRoot: async () => undefined,
    })

    const removed = await reaper.reapAll()
    expect([...removed].sort()).toEqual(["runtime-1111", "runtime-2222"])
    await expect(
      readFile(path.join(credentialRoot, "operator-note"), "utf8"),
    ).resolves.toBe("keep")
  })

  it("maintenance reap() only removes entries older than the age threshold", async () => {
    const filesystem = store()
    await filesystem.create(material("runtime-1111"))
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem,
      maxAgeMs: 60_000,
      verifyMemoryBackedRoot: async () => undefined,
    })

    expect(await reaper.reap()).toEqual([])
    await expect(readdir(credentialRoot)).resolves.toEqual(["runtime-1111"])
  })

  it("rejects a runtime-shaped symlink escape", async () => {
    await mkdir(credentialRoot, { recursive: true })
    const outside = path.join(parentDir, "outside")
    await mkdir(outside)
    await writeFile(path.join(outside, "keep"), "keep")
    await symlink(outside, path.join(credentialRoot, RUNTIME_ID), "junction")
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem: store(),
      verifyMemoryBackedRoot: async () => undefined,
    })

    await expect(reaper.reapAll()).rejects.toThrow(/symlink/)
    await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe(
      "keep",
    )
  })

  it("requires a verified tmpfs root before sweeping", async () => {
    const filesystem = store()
    await filesystem.create(material("runtime-1111"))
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem,
      verifyMemoryBackedRoot: async () => {
        throw new Error("not memory backed")
      },
    })

    await expect(reaper.reapAll()).rejects.toThrow(/not memory backed/)
  })

  it("bounds each startup sweep", async () => {
    const filesystem = store()
    for (const runtimeId of ["runtime-1111", "runtime-2222", "runtime-3333"]) {
      await filesystem.create(material(runtimeId))
    }
    const reaper = new DatabaseCredentialOrphanReaper({
      rootDir: credentialRoot,
      filesystem,
      maxEntriesPerSweep: 2,
      verifyMemoryBackedRoot: async () => undefined,
    })

    expect(await reaper.reapAll()).toHaveLength(2)
    expect(await readdir(credentialRoot)).toHaveLength(1)
  })
})
