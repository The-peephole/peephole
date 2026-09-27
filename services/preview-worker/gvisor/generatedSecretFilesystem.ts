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

import { assertValidGeneratedSecretNames } from "../../../core/backendSecrets/generatedSecretPolicy"
import type { GeneratedSecretMaterial } from "../../../types/backendRuntimeSecrets"
import { NodeProcessRunner } from "./nodeProcessRunner"
import type { ProcessRunner } from "./processRunner"
import { SANDBOX_GID, SANDBOX_UID } from "./sandboxIdentity"

export const DEFAULT_GENERATED_SECRET_ROOT = "/run/peephole/secrets"
export const GENERATED_SECRET_FILE_NAME = "env"
export const SANDBOX_GENERATED_SECRET_DIR = "/run/secrets"
export const SANDBOX_GENERATED_SECRET_FILE = `${SANDBOX_GENERATED_SECRET_DIR}/${GENERATED_SECRET_FILE_NAME}`

const RUNTIME_ID_PATTERN = /^[a-z\d-]{8,64}$/i
const GENERATED_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_SECRET_VALUE_BYTES = 4_096
const MAX_TOTAL_SECRET_BYTES = 16 * 1_024

export interface GeneratedSecretFilesystem {
  readonly rootDir: string
  /** Material is already generated. This primitive only validates, writes,
   * and returns the host directory that may be bind-mounted read-only. */
  create(material: GeneratedSecretMaterial): Promise<string>
  /** Idempotently removes exactly one validated, directly-owned directory. */
  remove(runtimeId: string): Promise<void>
}

export interface TmpfsGeneratedSecretFilesystemOptions {
  rootDir?: string
  processRunner?: ProcessRunner
  findmntBinaryPath?: string
  /** Test seam. Production uses `findmnt` and accepts only tmpfs. */
  verifyMemoryBackedRoot?: (rootDir: string) => Promise<void>
  /** Test seam for platforms that cannot chown. */
  setOwnership?: (candidate: string, uid: number, gid: number) => Promise<void>
  /** Test seam for proving requested POSIX modes on non-POSIX hosts. */
  setMode?: (candidate: string, mode: number) => Promise<void>
  /** Additional persistent/bundle roots that must remain disjoint. */
  forbiddenRoots?: readonly string[]
}

/**
 * Host-side owner of the short-lived plaintext file used for one runtime.
 * It never generates values and never accepts a caller-provided filename.
 * The configured root is verified as tmpfs every time material is created,
 * so an accidentally persistent production path fails closed at use time.
 */
export class TmpfsGeneratedSecretFilesystem implements GeneratedSecretFilesystem {
  readonly rootDir: string
  private readonly verifyMemoryBackedRoot: (rootDir: string) => Promise<void>
  private readonly setOwnership: (
    candidate: string,
    uid: number,
    gid: number,
  ) => Promise<void>
  private readonly setMode: (candidate: string, mode: number) => Promise<void>

  constructor(options: TmpfsGeneratedSecretFilesystemOptions = {}) {
    const configuredRoot = options.rootDir ?? DEFAULT_GENERATED_SECRET_ROOT
    if (!path.isAbsolute(configuredRoot)) {
      throw new Error("Generated-secret root must be absolute.")
    }
    this.rootDir = path.resolve(configuredRoot)
    for (const forbiddenRoot of [
      "/var/lib/peephole/jobs",
      ...(options.forbiddenRoots ?? []),
    ]) {
      if (!path.isAbsolute(forbiddenRoot)) {
        throw new Error("Generated-secret forbidden roots must be absolute.")
      }
      if (pathsOverlap(this.rootDir, path.resolve(forbiddenRoot))) {
        throw new Error(
          "Generated-secret root must be separate from persistent bundle storage.",
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

  async create(material: GeneratedSecretMaterial): Promise<string> {
    assertValidRuntimeId(material.runtimeId)
    let serialized: string
    try {
      serialized = serializeGeneratedSecretMaterial(material)
    } catch (error) {
      throw safeSecretFilesystemError(error)
    }
    const root = await this.prepareRoot()
    const runtimeDir = directRuntimePath(root, material.runtimeId)
    const secretFile = path.join(runtimeDir, GENERATED_SECRET_FILE_NAME)
    let directoryCreated = false

    try {
      await mkdir(runtimeDir, { mode: 0o700 })
      directoryCreated = true
      await this.setMode(runtimeDir, 0o700)

      const noFollow = constants.O_NOFOLLOW ?? 0
      const handle = await open(
        secretFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      )
      try {
        await handle.writeFile(serialized, { encoding: "utf8" })
      } finally {
        await handle.close()
      }
      await this.setMode(secretFile, 0o600)
      await this.setOwnership(secretFile, SANDBOX_UID, SANDBOX_GID)
      await this.setOwnership(runtimeDir, SANDBOX_UID, SANDBOX_GID)

      const [directoryStats, fileStats] = await Promise.all([
        lstat(runtimeDir),
        lstat(secretFile),
      ])
      if (
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !fileStats.isFile() ||
        fileStats.isSymbolicLink()
      ) {
        throw new Error("Generated-secret material did not remain regular.")
      }
      return runtimeDir
    } catch (error) {
      const safeError = safeSecretFilesystemError(error)
      if (directoryCreated) {
        try {
          await removeRuntimeDirectory(root, material.runtimeId)
        } catch (cleanupError) {
          throw new AggregateError(
            [safeError, cleanupError],
            "Generated-secret creation failed and cleanup was incomplete.",
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

/** Deterministic `NAME=value\n` encoding. Names sort lexicographically and
 * generated values are revalidated before their one explicit reveal is used. */
export function serializeGeneratedSecretMaterial(
  material: GeneratedSecretMaterial,
): string {
  assertValidRuntimeId(material.runtimeId)
  const entries = Array.from(material.values.entries()).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )
  if (entries.length === 0) {
    throw new Error("Generated-secret material must not be empty.")
  }
  assertValidGeneratedSecretNames(entries.map(([name]) => name))

  let totalBytes = 0
  const lines: string[] = []
  for (const [name, opaqueValue] of entries) {
    const value = opaqueValue.reveal()
    const valueBytes = Buffer.byteLength(value, "utf8")
    if (
      valueBytes === 0 ||
      valueBytes > MAX_SECRET_VALUE_BYTES ||
      !GENERATED_VALUE_PATTERN.test(value)
    ) {
      throw new Error("Generated-secret material contains an invalid value.")
    }
    const line = `${name}=${value}\n`
    totalBytes += Buffer.byteLength(line, "utf8")
    if (totalBytes > MAX_TOTAL_SECRET_BYTES) {
      throw new Error("Generated-secret material exceeds the total byte limit.")
    }
    lines.push(line)
  }
  return lines.join("")
}

export function assertValidRuntimeId(runtimeId: string): void {
  if (!RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new Error("Invalid backend runtime id.")
  }
}

export async function assertTmpfsFilesystem(
  candidate: string,
  processRunner: ProcessRunner = new NodeProcessRunner(),
  findmntBinaryPath = "findmnt",
): Promise<void> {
  const result = await processRunner.run(
    findmntBinaryPath,
    ["--noheadings", "--output", "FSTYPE", "--target", candidate],
    { timeoutMs: 5_000 },
  )
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.stdout.trim() !== "tmpfs"
  ) {
    throw new Error("Generated-secret root is not backed by tmpfs.")
  }
}

export async function listOwnedSecretRuntimeIds(
  rootDir: string,
  maxEntries: number,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Generated-secret sweep limit must be a positive integer.")
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
      if (!RUNTIME_ID_PATTERN.test(entry.name)) continue
      if (entry.isSymbolicLink()) {
        throw new Error(
          "Generated-secret root contains a symlink with a runtime-shaped name.",
        )
      }
      if (entry.isDirectory()) owned.push(entry.name)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return owned
}

async function validateExistingRoot(configuredRoot: string): Promise<string> {
  const resolved = path.resolve(configuredRoot)
  const stats = await lstat(resolved)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Generated-secret root must be a regular directory.")
  }
  const canonical = await realpath(resolved)
  if (canonical !== resolved) {
    throw new Error("Generated-secret root must not traverse symlinks.")
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
    throw new Error("Owned generated-secret path is not a regular directory.")
  }

  const secretFile = path.join(runtimeDir, GENERATED_SECRET_FILE_NAME)
  try {
    const fileStats = await lstat(secretFile)
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error("Owned generated-secret file is not regular.")
    }
    await unlink(secretFile)
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

function safeSecretFilesystemError(error: unknown): Error {
  if (error instanceof AggregateError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return new Error(
    code
      ? `Generated-secret filesystem operation failed (${code}).`
      : "Generated-secret filesystem operation failed.",
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
