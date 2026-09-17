import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { isSafeRelativeOutputPath } from "../../../core/preview/buildPlan"
import { isSafePreviewSourceRoot } from "../../../core/preview/sourceRoot"

export async function resolveWorkspaceSourceRoot(
  workspaceRoot: string,
  sourceRoot: string,
): Promise<string> {
  if (!isSafePreviewSourceRoot(sourceRoot)) {
    throw new Error("Preview source root is unsafe.")
  }
  return resolveContainedDirectory(workspaceRoot, sourceRoot)
}

export async function resolveWorkspaceOutputRoot(
  workspaceRoot: string,
  sourceRoot: string,
  outputDirectory: string,
): Promise<string> {
  if (
    !isSafePreviewSourceRoot(sourceRoot) ||
    !isSafeRelativeOutputPath(outputDirectory)
  ) {
    throw new Error("Preview output path is unsafe.")
  }
  const relative = [sourceRoot, outputDirectory]
    .filter((part) => part !== ".")
    .join("/")
  return resolveContainedDirectory(workspaceRoot, relative || ".")
}

async function resolveContainedDirectory(
  workspaceRoot: string,
  relativePath: string,
): Promise<string> {
  const root = path.resolve(workspaceRoot)
  const candidate = path.resolve(root, relativePath)
  if (!isContained(root, candidate)) {
    throw new Error("Workspace path escapes the workspace root.")
  }

  let current = root
  for (const segment of relativePath === "." ? [] : relativePath.split("/")) {
    current = path.join(current, segment)
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) {
      throw new Error("Workspace path contains a symbolic link.")
    }
  }

  const stats = await lstat(candidate)
  if (!stats.isDirectory()) {
    throw new Error("Workspace path is not a directory.")
  }
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ])
  if (!isContained(realRoot, realCandidate)) {
    throw new Error("Workspace real path escapes the workspace root.")
  }
  return candidate
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}
