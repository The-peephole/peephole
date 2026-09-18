import type { Stats } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  SANDBOX_GID,
  SANDBOX_UID,
} from "../services/preview-worker/gvisor/sandboxIdentity"
import { normalizeSandboxWorkspaceOwnership } from "../services/preview-worker/gvisor/sandboxWorkspaceOwnership"

type FakeKind = "directory" | "file" | "symlink" | "special"

interface FakeNode {
  stats: Stats
  children?: string[]
}

interface NormalizedEntry {
  path: string
  uid: number
  gid: number
  mode: number
}

describe("normalizeSandboxWorkspaceOwnership", () => {
  it("normalizes root and nested trees for the sandbox without destroying executable bits", async () => {
    const root = path.resolve("sandbox-workspace")
    const nodes = new Map<string, FakeNode>([
      [root, node("directory", 0o40777, 1, ["package.json", "apps"])],
      [path.join(root, "package.json"), node("file", 0o100666, 2)],
      [path.join(root, "apps"), node("directory", 0o40777, 3, ["web"])],
      [
        path.join(root, "apps", "web"),
        node("directory", 0o40755, 4, ["package-lock.json", "build.sh"]),
      ],
      [
        path.join(root, "apps", "web", "package-lock.json"),
        node("file", 0o100644, 5),
      ],
      [path.join(root, "apps", "web", "build.sh"), node("file", 0o100755, 6)],
    ])
    const normalized: NormalizedEntry[] = []

    await normalizeSandboxWorkspaceOwnership(root, {
      operations: operations(root, nodes, normalized),
    })

    expect(normalized).toHaveLength(nodes.size)
    expect(
      normalized.every(
        (entry) => entry.uid === SANDBOX_UID && entry.gid === SANDBOX_GID,
      ),
    ).toBe(true)

    const rootResult = resultFor(normalized, root)
    const nestedResult = resultFor(normalized, path.join(root, "apps", "web"))
    expect(rootResult.mode).toBe(0o755)
    expect(nestedResult.mode & 0o700).toBe(0o700)
    expect(nestedResult.mode & 0o022).toBe(0)
    expect(
      resultFor(normalized, path.join(root, "apps", "web", "build.sh")).mode,
    ).toBe(0o755)
    expect(
      resultFor(normalized, path.join(root, "apps", "web", "package-lock.json"))
        .mode,
    ).toBe(0o644)
  })

  it.each([
    ["symbolic link", "symlink" as const, 1],
    ["special object", "special" as const, 1],
    ["hard-linked file", "file" as const, 2],
  ])(
    "fails closed on a %s before changing any ownership",
    async (_, kind, nlink) => {
      const root = path.resolve("sandbox-workspace")
      const child = path.join(root, "unexpected")
      const nodes = new Map<string, FakeNode>([
        [root, node("directory", 0o40700, 1, ["unexpected"])],
        [child, node(kind, 0o100644, 2, undefined, nlink)],
      ])
      const normalized: NormalizedEntry[] = []

      await expect(
        normalizeSandboxWorkspaceOwnership(root, {
          operations: operations(root, nodes, normalized),
        }),
      ).rejects.toThrow(/symbolic link|non-ordinary|hard-linked/u)
      expect(normalized).toEqual([])
    },
  )

  it("rejects a traversal entry before looking outside the canonical root", async () => {
    const root = path.resolve("sandbox-workspace")
    const nodes = new Map<string, FakeNode>([
      [root, node("directory", 0o40700, 1, [".."])],
    ])
    const normalized: NormalizedEntry[] = []

    await expect(
      normalizeSandboxWorkspaceOwnership(root, {
        operations: operations(root, nodes, normalized),
      }),
    ).rejects.toThrow("unsafe entry")
    expect(normalized).toEqual([])
  })
})

function operations(
  root: string,
  nodes: Map<string, FakeNode>,
  normalized: NormalizedEntry[],
) {
  return {
    realpath: async () => root,
    lstat: async (candidate: string) => {
      const existing = nodes.get(candidate)
      if (!existing) throw new Error(`Unexpected traversal: ${candidate}`)
      return existing.stats
    },
    readdir: async (candidate: string) => nodes.get(candidate)?.children ?? [],
    normalize: async (
      candidate: string,
      _expected: Stats,
      _kind: "directory" | "file",
      uid: number,
      gid: number,
      mode: number,
    ) => {
      normalized.push({ path: candidate, uid, gid, mode })
    },
  }
}

function node(
  kind: FakeKind,
  mode: number,
  ino: number,
  children?: string[],
  nlink = 1,
): FakeNode {
  return {
    stats: {
      dev: 1,
      ino,
      mode,
      nlink,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => kind === "symlink",
    } as Stats,
    children,
  }
}

function resultFor(
  normalized: NormalizedEntry[],
  candidate: string,
): NormalizedEntry {
  const result = normalized.find((entry) => entry.path === candidate)
  if (!result) throw new Error(`Missing normalization result: ${candidate}`)
  return result
}
