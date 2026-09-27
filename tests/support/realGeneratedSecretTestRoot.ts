import { mkdir, mkdtemp } from "node:fs/promises"
import path from "node:path"

/** The same parent production's `TmpfsGeneratedSecretFilesystem` default
 * (`DEFAULT_GENERATED_SECRET_ROOT`'s directory) lives under -- real `/run` is
 * tmpfs on every supported host, which is exactly the backing this harness
 * must exercise. Callers create one unique child here and remove only that
 * child; this parent is never recursively removed, since production's own
 * default secret root (`/run/peephole/secrets`) is a sibling, not a
 * descendant, of any one test's directory. */
const SECRET_TEST_PARENT_DIR = "/run/peephole"

/**
 * Creates one uniquely named, test-owned child directory under the same
 * tmpfs-backed `/run/peephole` production uses, without touching anything
 * else already there. Mirrors `createRealGvisorTestDirectory`'s ownership
 * model (tests/support/realGvisorTestRoot.ts): the parent must already be
 * usable, the caller owns only the returned child, and cleanup must target
 * that exact path, never the parent.
 */
export async function createRealGeneratedSecretTestRoot(
  prefix = "real-gvisor-secrets-",
): Promise<string> {
  if (!/^[a-z\d][a-z\d-]*-$/.test(prefix)) {
    throw new Error("Real generated-secret test directory prefix is unsafe.")
  }
  await mkdir(SECRET_TEST_PARENT_DIR, { recursive: true, mode: 0o700 })
  return mkdtemp(path.join(SECRET_TEST_PARENT_DIR, prefix))
}
