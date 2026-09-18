import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import { SANDBOX_GID, SANDBOX_UID } from "./sandboxIdentity"

interface OwnershipNormalizationOperations {
  realpath(candidate: string): Promise<string>
  lstat(candidate: string): Promise<Stats>
  readdir(candidate: string): Promise<string[]>
  normalize(
    candidate: string,
    expected: Stats,
    kind: "directory" | "file",
    uid: number,
    gid: number,
    mode: number,
  ): Promise<void>
}

export interface SandboxWorkspaceOwnershipOptions {
  signal?: AbortSignal
  /** Test seam. Production always uses descriptor-based, no-follow mutation. */
  operations?: OwnershipNormalizationOperations
}

interface OrdinaryEntry {
  path: string
  stats: Stats
  kind: "directory" | "file"
}

const DEFAULT_OPERATIONS: OwnershipNormalizationOperations = {
  realpath,
  lstat,
  readdir: (candidate) => readdir(candidate),
  normalize: normalizeOpenEntry,
}

/**
 * Transfers the already-extracted workspace tree to the fixed sandbox
 * identity before any untrusted container is allowed to run.
 *
 * Validation is deliberately a complete first pass: an unexpected symlink,
 * hardlink, device, FIFO, socket, or escaping directory entry prevents every
 * ownership mutation. The sandbox is not running at this boundary, so the
 * validated tree cannot be raced by untrusted code. The mutation pass opens
 * every entry with O_NOFOLLOW and operates on the verified descriptor.
 */
export async function normalizeSandboxWorkspaceOwnership(
  workspaceRoot: string,
  options: SandboxWorkspaceOwnershipOptions = {},
): Promise<void> {
  const operations = options.operations ?? DEFAULT_OPERATIONS
  options.signal?.throwIfAborted()

  const rootStats = await operations.lstat(workspaceRoot)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Sandbox workspace root must be an ordinary directory.")
  }

  const canonicalRoot = await operations.realpath(workspaceRoot)
  const entries: OrdinaryEntry[] = []
  await collectOrdinaryEntries(
    canonicalRoot,
    canonicalRoot,
    entries,
    operations,
    options.signal,
  )

  for (const entry of entries) {
    options.signal?.throwIfAborted()
    await operations.normalize(
      entry.path,
      entry.stats,
      entry.kind,
      SANDBOX_UID,
      SANDBOX_GID,
      normalizedMode(entry.stats.mode, entry.kind),
    )
  }
}

async function collectOrdinaryEntries(
  canonicalRoot: string,
  candidate: string,
  entries: OrdinaryEntry[],
  operations: OwnershipNormalizationOperations,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  assertContained(canonicalRoot, candidate)
  const stats = await operations.lstat(candidate)

  if (stats.isSymbolicLink()) {
    throw new Error(`Sandbox workspace contains a symbolic link: ${candidate}`)
  }

  if (stats.isFile()) {
    if (stats.nlink !== 1) {
      throw new Error(
        `Sandbox workspace contains a hard-linked file: ${candidate}`,
      )
    }
    entries.push({ path: candidate, stats, kind: "file" })
    return
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `Sandbox workspace contains a non-ordinary filesystem object: ${candidate}`,
    )
  }

  entries.push({ path: candidate, stats, kind: "directory" })
  const names = await operations.readdir(candidate)
  for (const name of names) {
    if (
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      path.isAbsolute(name) ||
      path.basename(name) !== name
    ) {
      throw new Error("Sandbox workspace traversal returned an unsafe entry.")
    }
    const child = path.join(candidate, name)
    assertContained(canonicalRoot, child)
    await collectOrdinaryEntries(
      canonicalRoot,
      child,
      entries,
      operations,
      signal,
    )
  }
}

async function normalizeOpenEntry(
  candidate: string,
  expected: Stats,
  kind: "directory" | "file",
  uid: number,
  gid: number,
  mode: number,
): Promise<void> {
  const flags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    (kind === "directory" ? constants.O_DIRECTORY : 0)
  const handle = await open(candidate, flags)
  try {
    const actual = await handle.stat()
    const expectedKind =
      kind === "directory" ? actual.isDirectory() : actual.isFile()
    if (
      !expectedKind ||
      actual.isSymbolicLink() ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      throw new Error(
        `Sandbox workspace entry changed during ownership normalization: ${candidate}`,
      )
    }
    await handle.chown(uid, gid)
    await handle.chmod(mode)
  } finally {
    await handle.close()
  }
}

function normalizedMode(mode: number, kind: "directory" | "file"): number {
  // The owner always receives the access needed by npm/build tools. Preserve
  // read/execute visibility and executable file bits, strip special bits and
  // group/other writes, and never introduce world-writable directories.
  return kind === "directory" ? 0o700 | (mode & 0o055) : 0o600 | (mode & 0o155)
}

function assertContained(canonicalRoot: string, candidate: string): void {
  const relative = path.relative(canonicalRoot, path.resolve(candidate))
  if (
    relative !== "" &&
    (relative.startsWith("..") || path.isAbsolute(relative))
  ) {
    throw new Error("Sandbox workspace traversal escaped its canonical root.")
  }
}
