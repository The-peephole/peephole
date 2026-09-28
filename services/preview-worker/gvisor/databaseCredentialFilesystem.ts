import { constants } from "node:fs"
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import {
  TENANT_DATABASE_HOST,
  TENANT_DATABASE_PORT,
} from "../../../core/backendDatabase/databaseUrl"
import type { TemporaryDatabaseRuntimeCredentialMaterial } from "../../../types/temporaryDatabase"
import {
  assertTmpfsFilesystem,
  assertValidRuntimeId,
} from "./generatedSecretFilesystem"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { SANDBOX_GID, SANDBOX_UID } from "./sandboxIdentity"

/**
 * Structurally separate from M10's `/run/peephole/secrets` root (see
 * `generatedSecretFilesystem.ts`). Deliberately its own module: the
 * temporary-database URL is not an M10 generated secret (it contains `:`,
 * `/`, `@`, which M10's `GENERATED_VALUE_PATTERN` rejects), and it never
 * uses M10's generic `NAME=value` serialization -- there is exactly one
 * fixed file, `database-url`, whose entire content is the canonical URL.
 */
export const DEFAULT_DATABASE_CREDENTIAL_ROOT = "/run/peephole/db-credentials"
export const DATABASE_CREDENTIAL_FILE_NAME = "database-url"
export const SANDBOX_DATABASE_CREDENTIAL_DIR = "/run/secrets"
export const SANDBOX_DATABASE_CREDENTIAL_FILE = `${SANDBOX_DATABASE_CREDENTIAL_DIR}/${DATABASE_CREDENTIAL_FILE_NAME}`

const MAX_DATABASE_URL_BYTES = 4_096

export interface DatabaseCredentialFilesystem {
  readonly rootDir: string
  /** Material is already assembled. Returns the created credential FILE's
   * full host path (never the runtime directory) -- the caller bind-mounts
   * this file directly at the fixed sandbox destination. */
  create(material: TemporaryDatabaseRuntimeCredentialMaterial): Promise<string>
  /** Idempotently removes exactly one validated, directly-owned directory. */
  remove(runtimeId: string): Promise<void>
}

export interface TmpfsDatabaseCredentialFilesystemOptions {
  rootDir?: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  /** Test seam. Production uses `findmnt` and accepts only tmpfs. */
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
  /** Test seam for platforms that cannot chown. */
  setOwnership?: (candidate: string, uid: number, gid: number) => Promise<void>
  /** Test seam for proving requested POSIX modes on non-POSIX hosts. */
  setMode?: (candidate: string, mode: number) => Promise<void>
  /** Additional persistent/bundle/M10-secret roots that must remain disjoint. */
  forbiddenRoots?: readonly string[]
}

/**
 * Host-side owner of the short-lived plaintext `DATABASE_URL` file used for
 * one runtime. Mirrors `TmpfsGeneratedSecretFilesystem`'s security
 * discipline (root must be tmpfs-backed, exclusive creation, restrictive
 * modes, sandbox ownership, symlink refusal, narrow idempotent remove) but
 * stays a wholly separate primitive -- see this module's own doc comment.
 */
export class TmpfsDatabaseCredentialFilesystem implements DatabaseCredentialFilesystem {
  readonly rootDir: string
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>
  private readonly setOwnership: (
    candidate: string,
    uid: number,
    gid: number,
  ) => Promise<void>
  private readonly setMode: (candidate: string, mode: number) => Promise<void>

  constructor(options: TmpfsDatabaseCredentialFilesystemOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_DATABASE_CREDENTIAL_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("Database credential root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    for (const forbiddenRoot of [
      "/var/lib/peephole/jobs",
      "/run/peephole/secrets",
      ...(options.forbiddenRoots ?? []),
    ]) {
      if (!path.isAbsolute(forbiddenRoot)) {
        throw new Error("Database credential forbidden roots must be absolute.")
      }
      if (pathsOverlap(this.rootDir, path.resolve(forbiddenRoot))) {
        throw new Error(
          "Database credential root must be separate from other Peephole storage roots.",
        )
      }
    }
    const processRunner = options.processRunner ?? new NodeProcessRunner()
    this.verifyMemoryBackedRoot =
      options.verifyMemoryBackedRoot ??
      ((rootDir) =>
        assertTmpfsFilesystem(
          rootDir,
          processRunner,
          options.findmntBinaryPath,
        ))
    this.setOwnership =
      options.setOwnership ??
      ((candidate, uid, gid) => chown(candidate, uid, gid))
    this.setMode =
      options.setMode ?? ((candidate, mode) => chmod(candidate, mode))
  }

  async create(
    material: TemporaryDatabaseRuntimeCredentialMaterial,
  ): Promise<string> {
    assertValidRuntimeId(material.runtimeId)
    let serialized: string
    try {
      serialized = serializeDatabaseCredentialMaterial(material)
    } catch (error) {
      throw safeDatabaseCredentialError(error)
    }
    const root = await this.prepareRoot()
    const runtimeDir = directRuntimePath(root, material.runtimeId)
    const credentialFile = path.join(runtimeDir, DATABASE_CREDENTIAL_FILE_NAME)
    let directoryCreated = false

    try {
      await mkdir(runtimeDir, { mode: 0o700 })
      directoryCreated = true
      await this.setMode(runtimeDir, 0o700)

      const noFollow = constants.O_NOFOLLOW ?? 0
      const handle = await open(
        credentialFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      )
      try {
        await handle.writeFile(serialized, { encoding: "utf8" })
      } finally {
        await handle.close()
      }
      await this.setMode(credentialFile, 0o600)
      await this.setOwnership(credentialFile, SANDBOX_UID, SANDBOX_GID)
      await this.setOwnership(runtimeDir, SANDBOX_UID, SANDBOX_GID)

      const [directoryStats, fileStats] = await Promise.all([
        lstat(runtimeDir),
        lstat(credentialFile),
      ])
      if (
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !fileStats.isFile() ||
        fileStats.isSymbolicLink()
      ) {
        throw new Error("Database credential material did not remain regular.")
      }
      return credentialFile
    } catch (error) {
      const safeError = safeDatabaseCredentialError(error)
      if (directoryCreated) {
        try {
          await removeRuntimeDirectory(root, material.runtimeId)
        } catch (cleanupError) {
          throw new AggregateError(
            [safeError, cleanupError],
            "Database credential creation failed and cleanup was incomplete.",
            { cause: cleanupError },
          )
        }
      }
      throw safeError
    }
  }

  async remove(runtimeId: string): Promise<void> {
    assertValidRuntimeId(runtimeId)
    let root: string
    try {
      root = await validateExistingRoot(this.rootDir)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    await removeRuntimeDirectory(root, runtimeId)
  }

  private async prepareRoot(): Promise<string> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    await this.setMode(this.rootDir, 0o700)
    const root = await validateExistingRoot(this.rootDir)
    await this.verifyMemoryBackedRoot(root)
    return root
  }
}

/** The file's entire content is the canonical URL plus exactly one trailing
 * newline -- never a `NAME=value` line, never additional metadata. Validates
 * the value parses as a `postgresql:` URL pointed at the fixed tenant
 * endpoint before it is ever written to disk, as a defense-in-depth check on
 * top of the trusted builder's own invariants. */
export function serializeDatabaseCredentialMaterial(
  material: TemporaryDatabaseRuntimeCredentialMaterial,
): string {
  assertValidRuntimeId(material.runtimeId)
  const url = material.databaseUrl.reveal()
  const byteLength = Buffer.byteLength(url, "utf8")
  if (
    byteLength === 0 ||
    byteLength > MAX_DATABASE_URL_BYTES ||
    url.includes("\n")
  ) {
    throw new Error("Database credential material contains an invalid value.")
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Database credential material is not a valid URL.")
  }
  if (
    parsed.protocol !== "postgresql:" ||
    parsed.hostname !== TENANT_DATABASE_HOST ||
    parsed.port !== String(TENANT_DATABASE_PORT)
  ) {
    throw new Error(
      "Database credential material does not match the tenant endpoint.",
    )
  }
  return `${url}\n`
}

export async function listOwnedDatabaseCredentialRuntimeIds(
  rootDir: string,
  maxEntries: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error(
      "Database credential sweep limit must be a positive integer.",
    )
  }
  let root: string
  try {
    root = await validateExistingRoot(path.resolve(rootDir))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  const owned: string[] = []
  const directory = await opendir(root)
  let examined = 0
  try {
    for await (const entry of directory) {
      if (examined >= maxEntries) break
      examined += 1
      if (!isRuntimeIdShaped(entry.name)) continue
      if (entry.isSymbolicLink()) {
        throw new Error(
          "Database credential root contains a symlink with a runtime-shaped name.",
        )
      }
      if (entry.isDirectory()) owned.push(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return owned
}

function isRuntimeIdShaped(name: string): boolean {
  try {
    assertValidRuntimeId(name)
    return true
  } catch {
    return false
  }
}

async function validateExistingRoot(configuredRoot: string): Promise<string> {
  const resolved = path.resolve(configuredRoot)
  const stats = await lstat(resolved)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Database credential root must be a regular directory.")
  }
  const canonical = await realpath(resolved)
  if (canonical !== resolved) {
    throw new Error("Database credential root must not traverse symlinks.")
  }
  return canonical
}

function directRuntimePath(root: string, runtimeId: string): string {
  assertValidRuntimeId(runtimeId)
  const candidate = path.join(root, runtimeId)
  if (path.dirname(candidate) !== root) {
    throw new Error("Invalid backend runtime id.")
  }
  return candidate
}

async function removeRuntimeDirectory(
  root: string,
  runtimeId: string,
): Promise<void> {
  const runtimeDir = directRuntimePath(root, runtimeId)
  let directoryStats
  try {
    directoryStats = await lstat(runtimeDir)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(
      "Owned database credential path is not a regular directory.",
    )
  }

  const credentialFile = path.join(runtimeDir, DATABASE_CREDENTIAL_FILE_NAME)
  try {
    const fileStats = await lstat(credentialFile)
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error("Owned database credential file is not regular.")
    }
    await unlink(credentialFile)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  try {
    await rmdir(runtimeDir)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function safeDatabaseCredentialError(error: unknown): Error {
  if (error instanceof AggregateError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return new Error(
    code
      ? `Database credential filesystem operation failed (${code}).`
      : "Database credential filesystem operation failed.",
  )
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}
