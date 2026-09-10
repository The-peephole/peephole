import { lstat, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const DEFAULT_PRODUCTION_BUNDLES_ROOT = "/var/lib/peephole/jobs"
const TEST_ROOT_ENV = "PEEPHOLE_REAL_GVISOR_TEST_ROOT"

/**
 * Creates one uniquely named, test-owned child. The configured parent must
 * already exist so a typo cannot silently place multi-GiB images on another
 * filesystem. Callers remove only the returned child, never the parent.
 */
export async function createRealGvisorTestDirectory(
  prefix: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!/^[a-z\d][a-z\d-]*-$/.test(prefix)) {
    throw new Error("Real gVisor test directory prefix is unsafe.")
  }

  const configured = environment[TEST_ROOT_ENV]?.trim()
  if (!configured) return mkdtemp(path.join(os.tmpdir(), prefix))
  if (!path.isAbsolute(configured)) {
    throw new Error(`${TEST_ROOT_ENV} must be an absolute path.`)
  }

  const stats = await lstat(configured)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${TEST_ROOT_ENV} must be an ordinary directory.`)
  }
  const testRoot = await realpath(configured)
  const productionRoot = await canonicalPathForComparison(
    environment.PEEPHOLE_GVISOR_BUNDLES_DIR ?? DEFAULT_PRODUCTION_BUNDLES_ROOT,
  )
  if (pathsOverlap(testRoot, productionRoot)) {
    throw new Error(
      `${TEST_ROOT_ENV} must be a dedicated directory separate from the production bundles root.`,
    )
  }

  return mkdtemp(path.join(testRoot, prefix))
}

async function canonicalPathForComparison(candidate: string): Promise<string> {
  return realpath(candidate).catch(() => path.resolve(candidate))
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}
