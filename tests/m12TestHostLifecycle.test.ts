import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Lifecycle regression tests for tests/support/m12-test-host.sh that need
 * a real Linux /proc. Privilege and mounts are replaced by PATH shims for
 * `id`, `mount`, `umount`, `findmnt` (plus `chmod`/`find` failure
 * injection); every real mkdir/rmdir/rm happens only inside this test's own
 * temporary directory. A real `sudo` run resets PATH via secure_path, so
 * these shims model -- but can never affect -- a privileged run.
 *
 * Real root + real tmpfs + real `sudo` remain NOT_RUN here.
 */
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const SCRIPT = path.join(repositoryRoot, "tests", "support", "m12-test-host.sh")
const linuxProc =
  process.platform === "linux" &&
  spawnSync("bash", ["--version"]).status === 0 &&
  process.getuid?.() !== 0

interface Sandbox {
  base: string
  parent: string
  bin: string
  mountsFile: string
  log: string
  env: NodeJS.ProcessEnv
}

const SHIMS: Record<string, string> = {
  id: `#!/usr/bin/env bash
[[ "$1" == "-u" ]] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
`,
  mount: `#!/usr/bin/env bash
echo "mount $*" >>"$FAKE_LOG"
[[ "\${FAKE_MOUNT_FAIL:-}" == "1" ]] && exit 32
echo "\${@: -1}" >>"$FAKE_MOUNTS"
`,
  umount: `#!/usr/bin/env bash
echo "umount $*" >>"$FAKE_LOG"
[[ "\${FAKE_UMOUNT_FAIL:-}" == "1" ]] && exit 32
target="\${@: -1}"
grep -vxF -- "$target" "$FAKE_MOUNTS" >"$FAKE_MOUNTS.next" || true
mv "$FAKE_MOUNTS.next" "$FAKE_MOUNTS"
touch "$FAKE_MOUNTS.unmounted"
`,
  findmnt: `#!/usr/bin/env bash
case "$*" in
  "-rn -o TARGET")
    if [[ "\${FAKE_FINDMNT_FAIL:-}" == "always" ]]; then exit 1; fi
    if [[ "\${FAKE_FINDMNT_FAIL:-}" == "after-umount" && -e "$FAKE_MOUNTS.unmounted" ]]; then exit 1; fi
    echo /
    cat "$FAKE_MOUNTS"
    ;;
  "-n -o FSTYPE -M "*)
    target="\${@: -1}"
    if grep -qxF -- "$target" "$FAKE_MOUNTS"; then echo "\${FAKE_FSTYPE:-tmpfs}"; else exit 1; fi
    ;;
  *) exit 1 ;;
esac
`,
  chmod: `#!/usr/bin/env bash
[[ "\${FAKE_CHMOD_FAIL:-}" == "1" ]] && exit 1
exec /usr/bin/env -u FAKE_CHMOD_FAIL "$(command -v -p chmod)" "$@"
`,
  find: `#!/usr/bin/env bash
[[ "\${FAKE_FIND_FAIL:-}" == "1" ]] && exit 2
exec "$(command -v -p find)" "$@"
`,
}

async function createSandbox(
  overrides: NodeJS.ProcessEnv = {},
): Promise<Sandbox> {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "m12-life-")),
  )
  const bin = path.join(base, "bin")
  await mkdir(bin)
  for (const [name, source] of Object.entries(SHIMS)) {
    const file = path.join(bin, name)
    await writeFile(file, source)
    await chmod(file, 0o755)
  }
  const mountsFile = path.join(base, "mounts")
  const log = path.join(base, "log")
  await writeFile(mountsFile, "")
  await writeFile(log, "")
  return {
    base,
    parent: path.join(base, "parent"),
    bin,
    mountsFile,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_MOUNTS: mountsFile,
      FAKE_LOG: log,
      ...overrides,
    },
  }
}

function runScript(
  sandbox: Sandbox,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...sandbox.env, ...extra },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await readdir(path.dirname(candidate)).then((entries) => {
      if (!entries.includes(path.basename(candidate)))
        throw new Error("missing")
    })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!linuxProc)(
  "m12-test-host.sh lifecycle (Linux /proc, shimmed privilege)",
  () => {
    const sandboxes: Sandbox[] = []
    const children: ChildProcess[] = []
    afterEach(async () => {
      for (const child of children.splice(0)) child.kill("SIGKILL")
      for (const sandbox of sandboxes.splice(0)) {
        await rm(sandbox.base, { recursive: true, force: true })
      }
    })

    async function setUp(overrides: NodeJS.ProcessEnv = {}) {
      const sandbox = await createSandbox(overrides)
      sandboxes.push(sandbox)
      const result = runScript(sandbox, ["setup", sandbox.parent])
      expect(result.status, result.stderr).toBe(0)
      return sandbox
    }

    it("baseline: setup then teardown removes exactly the parent", async () => {
      const sandbox = await setUp()
      const result = runScript(sandbox, ["teardown", sandbox.parent])
      expect(result.status, result.stderr).toBe(0)
      expect(await exists(sandbox.parent)).toBe(false)
      expect(await readFile(sandbox.log, "utf8")).toContain(
        `umount -- ${sandbox.parent}/tmpfs`,
      )
    })

    // ------------------------------------------------------ Finding 1

    it("Finding 1: a launcher (like sudo) whose command line names the parent is not a leftover", async () => {
      const sandbox = await setUp()
      // The launcher bash is the script's parent process and keeps the parent
      // path in its own argv, exactly like `sudo m12-test-host.sh teardown <p>`.
      const result = spawnSync(
        "bash",
        [
          "-c",
          `bash "$0" teardown "$1"; status=$?; exit $status`,
          SCRIPT,
          sandbox.parent,
        ],
        { encoding: "utf8", env: sandbox.env },
      )
      expect(result.stderr).not.toMatch(/still references/)
      expect(result.status).toBe(0)
      expect(await exists(sandbox.parent)).toBe(false)
    })

    it("Finding 1: a nested launcher chain (sudo + its pty monitor) is also excluded", async () => {
      const sandbox = await setUp()
      const result = spawnSync(
        "bash",
        [
          "-c",
          `bash -c 'bash "$0" teardown "$1"; s=$?; exit $s' "$0" "$1"; s=$?; exit $s`,
          SCRIPT,
          sandbox.parent,
        ],
        { encoding: "utf8", env: sandbox.env },
      )
      expect(result.status, result.stderr).toBe(0)
    })

    it("Finding 1: a non-ancestor process naming the parent still blocks teardown, without echoing its command line", async () => {
      const sandbox = await setUp()
      const leftover = spawn(
        "bash",
        [
          "-c",
          `sleep 60; : fake-runsc --root "$0/runsc/state" SECRET-ARG`,
          sandbox.parent,
        ],
        { stdio: "ignore" },
      )
      children.push(leftover)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const result = runScript(sandbox, ["teardown", sandbox.parent])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(
        new RegExp(`process ${String(leftover.pid)} still references`),
      )
      expect(result.stderr).not.toContain("SECRET-ARG")
      expect(await exists(sandbox.parent)).toBe(true)
    })

    // ------------------------------------------------------ Finding 2

    it.each([
      [
        "the marker cannot be finalized (chmod fails)",
        { FAKE_CHMOD_FAIL: "1" },
      ],
      ["the mount is not tmpfs", { FAKE_FSTYPE: "ext4" }],
    ])(
      "Finding 2: setup rolls back everything it created when %s",
      async (_label, failure) => {
        const sandbox = await createSandbox()
        sandboxes.push(sandbox)
        const result = runScript(sandbox, ["setup", sandbox.parent], failure)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toMatch(/setup failed; rolled back/)
        expect(await exists(sandbox.parent)).toBe(false)
        expect(await readFile(sandbox.mountsFile, "utf8")).toBe("")
      },
    )

    it("Finding 2: setup preserves and reports the exact path when its mount cannot be undone", async () => {
      const sandbox = await createSandbox()
      sandboxes.push(sandbox)
      const result = runScript(sandbox, ["setup", sandbox.parent], {
        FAKE_CHMOD_FAIL: "1",
        FAKE_UMOUNT_FAIL: "1",
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        `preserved for manual recovery: ${sandbox.parent}`,
      )
      expect(result.stderr).toMatch(/umount .*\/tmpfs/)
      expect(await exists(sandbox.parent)).toBe(true)
    })

    it("Finding 2: a failed mount leaves no directories behind", async () => {
      const sandbox = await createSandbox()
      sandboxes.push(sandbox)
      const result = runScript(sandbox, ["setup", sandbox.parent], {
        FAKE_MOUNT_FAIL: "1",
      })
      expect(result.status).not.toBe(0)
      expect(await exists(sandbox.parent)).toBe(false)
    })

    it("Finding 2: setup never touches a pre-existing directory", async () => {
      const sandbox = await createSandbox()
      sandboxes.push(sandbox)
      await mkdir(sandbox.parent)
      await writeFile(path.join(sandbox.parent, "keep"), "x")
      const result = runScript(sandbox, ["setup", sandbox.parent])
      expect(result.status).not.toBe(0)
      expect(await readFile(path.join(sandbox.parent, "keep"), "utf8")).toBe(
        "x",
      )
    })

    // ------------------------------------------------------ Finding 3

    it("Finding 3: an unreadable mount table after unmounting stops teardown and keeps the parent", async () => {
      const sandbox = await setUp()
      const result = runScript(sandbox, ["teardown", sandbox.parent], {
        FAKE_FINDMNT_FAIL: "after-umount",
      })
      expect(result.status).not.toBe(0)
      expect(result.stdout).not.toMatch(/removed/)
      expect(await exists(sandbox.parent)).toBe(true)
    })

    it("Finding 3: an unreadable mount table before any action stops teardown", async () => {
      const sandbox = await setUp()
      const result = runScript(sandbox, ["teardown", sandbox.parent], {
        FAKE_FINDMNT_FAIL: "always",
      })
      expect(result.status).not.toBe(0)
      expect(await readFile(sandbox.log, "utf8")).not.toContain("umount")
      expect(await exists(sandbox.parent)).toBe(true)
    })

    it("Finding 3: a failing run-directory inspection is never read as 'none left'", async () => {
      const sandbox = await setUp()
      const result = runScript(sandbox, ["teardown", sandbox.parent], {
        FAKE_FIND_FAIL: "1",
      })
      expect(result.status).not.toBe(0)
      expect(await readFile(sandbox.log, "utf8")).not.toContain("umount")
      expect(await exists(sandbox.parent)).toBe(true)
    })

    it("Finding 3: status reports INCOMPLETE instead of an empty listing when inspection fails", async () => {
      const sandbox = await setUp()
      const result = runScript(sandbox, ["status", sandbox.parent], {
        FAKE_FIND_FAIL: "1",
      })
      expect(result.stdout).toMatch(/INCOMPLETE/)
      expect(result.status).not.toBe(0)
    })

    it("Finding 3: a preserved run directory still blocks teardown", async () => {
      const sandbox = await setUp()
      await mkdir(
        path.join(sandbox.parent, "workspace", "peephole-m12-workspaceRoot-x"),
      )
      const result = runScript(sandbox, ["teardown", sandbox.parent])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/preserved run directories/)
      expect(await exists(sandbox.parent)).toBe(true)
    })
  },
)
