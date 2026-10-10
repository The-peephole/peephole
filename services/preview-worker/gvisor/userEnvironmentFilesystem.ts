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
  assertValidUserEnvironmentValue,
  isEligibleUserEnvironmentName,
} from "../../../core/userEnvironment/userEnvironmentPolicy"
import {
  USER_ENVIRONMENT_LIMITS,
  type UserEnvironmentMaterial,
} from "../../../types/userEnvironment"
import {
  assertTmpfsFilesystem,
  assertValidRuntimeId,
} from "./generatedSecretFilesystem"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { SANDBOX_GID, SANDBOX_UID } from "./sandboxIdentity"

/**
 * M12 (D-035) host-side owner of one runtime's user-provided configuration
 * file. Structurally separate from M10's `/run/peephole/secrets` (`env`,
 * fixed `NAME=value` grammar with a base64url-only value alphabet) and
 * M11's `/run/peephole/db-credentials` (`database-url`, raw URL): neither
 * of those formats or paths changes. User values may contain `=`, spaces,
 * and non-ASCII text, so this file is one JSON object -- parsed by the
 * trusted bootstrap with `JSON.parse`, never by a shell or env-file parser.
 */
export const DEFAULT_USER_ENVIRONMENT_ROOT = "/run/peephole/user-env"
export const USER_ENVIRONMENT_FILE_NAME = "user-env"
export const SANDBOX_USER_ENVIRONMENT_FILE = `/run/secrets/${USER_ENVIRONMENT_FILE_NAME}`

/** JSON escaping can at most expand each value byte ~6x; bound the framed
 * file generously but finitely. Mirrors the bootstrap's own bound. */
const MAX_USER_ENVIRONMENT_FILE_BYTES = 64 * 1_024

export interface UserEnvironmentFilesystem {
  readonly rootDir: string
  /** Returns the created FILE's full host path; the caller bind-mounts this
   * file directly at `SANDBOX_USER_ENVIRONMENT_FILE`. */
  create(material: UserEnvironmentMaterial): Promise<string>
  /** Idempotently removes exactly one validated, directly-owned directory. */
  remove(runtimeId: string): Promise<void>
}

export interface TmpfsUserEnvironmentFilesystemOptions {
  rootDir?: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  /** Test seam. Production uses `findmnt` and accepts only tmpfs. */
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
  /** Test seam for platforms that cannot chown. */
  setOwnership?: (candidate: string, uid: number, gid: number) => Promise<void>
  /** Test seam for proving requested POSIX modes on non-POSIX hosts. */
  setMode?: (candidate: string, mode: number) => Promise<void>
  /** Additional persistent/bundle/credential roots that must stay disjoint. */
  forbiddenRoots?: readonly string[]
}

/** Same discipline as `TmpfsDatabaseCredentialFilesystem`: tmpfs-verified
 * root on every create, exclusive no-follow creation, 0700/0600 modes,
 * sandbox ownership, symlink refusal, narrow idempotent remove. */
export class TmpfsUserEnvironmentFilesystem implements UserEnvironmentFilesystem {
  readonly rootDir: string
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>
  private readonly setOwnership: (
    candidate: string,
    uid: number,
    gid: number,
  ) => Promise<void>
  private readonly setMode: (candidate: string, mode: number) => Promise<void>

  constructor(options: TmpfsUserEnvironmentFilesystemOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_USER_ENVIRONMENT_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("User environment root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    for (const forbiddenRoot of [
      "/var/lib/peephole/jobs",
      "/run/peephole/secrets",
      "/run/peephole/db-credentials",
      ...(options.forbiddenRoots ?? []),
    ]) {
      if (!path.isAbsolute(forbiddenRoot)) {
        throw new Error("User environment forbidden roots must be absolute.")
      }
      if (pathsOverlap(this.rootDir, path.resolve(forbiddenRoot))) {
        throw new Error(
          "User environment root must be separate from other Peephole storage roots.",
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

  async create(material: UserEnvironmentMaterial): Promise<string> {
    assertValidRuntimeId(material.runtimeId)
    let serialized: string
    try {
      serialized = serializeUserEnvironmentMaterial(material)
    } catch (error) {
      throw safeUserEnvironmentError(error)
    }
    const root = await this.prepareRoot()
    const runtimeDir = directRuntimePath(root, material.runtimeId)
    const environmentFile = path.join(runtimeDir, USER_ENVIRONMENT_FILE_NAME)
    let directoryCreated = false

    try {
      await mkdir(runtimeDir, { mode: 0o700 })
      directoryCreated = true
      await this.setMode(runtimeDir, 0o700)

      const noFollow = constants.O_NOFOLLOW ?? 0
      const handle = await open(
        environmentFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      )
      try {
        await handle.writeFile(serialized, { encoding: "utf8" })
      } finally {
        await handle.close()
      }
      await this.setMode(environmentFile, 0o600)
      await this.setOwnership(environmentFile, SANDBOX_UID, SANDBOX_GID)
      await this.setOwnership(runtimeDir, SANDBOX_UID, SANDBOX_GID)

      const [directoryStats, fileStats] = await Promise.all([
        lstat(runtimeDir),
        lstat(environmentFile),
      ])
      if (
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !fileStats.isFile() ||
        fileStats.isSymbolicLink()
      ) {
        throw new Error("User environment material did not remain regular.")
      }
      return environmentFile
    } catch (error) {
      const safeError = safeUserEnvironmentError(error)
      if (directoryCreated) {
        try {
          await removeRuntimeDirectory(root, material.runtimeId)
        } catch (cleanupError) {
          throw new AggregateError(
            [safeError, cleanupError],
            "User environment creation failed and cleanup was incomplete.",
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

/** One JSON object with sorted keys plus exactly one trailing newline. The
 * trusted write boundary re-checks every name and value against the shared
 * policy before anything touches disk; errors never include a value. */
export function serializeUserEnvironmentMaterial(
  material: UserEnvironmentMaterial,
): string {
  assertValidRuntimeId(material.runtimeId)
  const names = [...material.values.keys()].sort()
  if (names.length === 0 || names.length > USER_ENVIRONMENT_LIMITS.maxEntries) {
    throw new Error("User environment material has an invalid entry count.")
  }
  const object: Record<string, string> = {}
  let totalBytes = 0
  for (const name of names) {
    if (!isEligibleUserEnvironmentName(name)) {
      throw new Error("User environment material contains an invalid name.")
    }
    let value: string
    try {
      value = assertValidUserEnvironmentValue(
        name,
        material.values.get(name)?.reveal(),
      )
    } catch {
      throw new Error("User environment material contains an invalid value.")
    }
    totalBytes += Buffer.byteLength(value, "utf8")
    object[name] = value
  }
  if (totalBytes > USER_ENVIRONMENT_LIMITS.maxTotalValueBytes) {
    throw new Error("User environment material exceeds its size bound.")
  }
  const serialized = `${JSON.stringify(object)}\n`
  if (Buffer.byteLength(serialized, "utf8") > MAX_USER_ENVIRONMENT_FILE_BYTES) {
    throw new Error("User environment material exceeds its size bound.")
  }
  return serialized
}

export async function listOwnedUserEnvironmentRuntimeIds(
  rootDir: string,
  maxEntries: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("User environment sweep limit must be a positive integer.")
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
          "User environment root contains a symlink with a runtime-shaped name.",
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
    throw new Error("User environment root must be a regular directory.")
  }
  const canonical = await realpath(resolved)
  if (canonical !== resolved) {
    throw new Error("User environment root must not traverse symlinks.")
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
    throw new Error("Owned user environment path is not a regular directory.")
  }

  const environmentFile = path.join(runtimeDir, USER_ENVIRONMENT_FILE_NAME)
  try {
    const fileStats = await lstat(environmentFile)
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error("Owned user environment file is not regular.")
    }
    await unlink(environmentFile)
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

function safeUserEnvironmentError(error: unknown): Error {
  if (error instanceof AggregateError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return new Error(
    code
      ? `User environment filesystem operation failed (${code}).`
      : "User environment filesystem operation failed.",
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
