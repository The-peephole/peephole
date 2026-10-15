import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
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
  stat: `#!/usr/bin/env bash
out="$("$(command -v -p stat)" "$@")" || exit 1
case "$2" in
  '%u:%a'|'%u:%a:%h')
    uid=0
    if [[ "\${@: -1}" == */.peephole-m12-combined.json ]]; then uid="\${FAKE_ATTESTATION_UID:-0}"; fi
    printf '%s:%s\\n' "$uid" "\${out#*:}"
    ;;
  *) printf '%s\\n' "$out" ;;
esac
`,
  rm: `#!/usr/bin/env bash
[[ "\${FAKE_ROOTFS_RM_FAIL:-}" == "1" && "\${@: -1}" == */rootfs ]] && exit 1
exec "$(command -v -p rm)" "$@"
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

    async function addAttestation(
      sandbox: Sandbox,
      changes: Record<string, unknown> = {},
    ) {
      const file = path.join(sandbox.parent, ".peephole-m12-combined.json")
      await writeFile(
        file,
        JSON.stringify({
          schema: "peephole-m12-combined/v1",
          dedicatedNonProduction: true,
          parent: sandbox.parent,
          postgresRoot: "/srv/peephole-m12-db-lifecycle",
          machineId: (await readFile("/etc/machine-id", "utf8")).trim(),
          bootId: (
            await readFile("/proc/sys/kernel/random/boot_id", "utf8")
          ).trim(),
          ...changes,
        }),
        { mode: 0o600 },
      )
      return file
    }

    it("tears down a valid combined attestation and rootfs without touching siblings", async () => {
      const sandbox = await setUp()
      await addAttestation(sandbox)
      await mkdir(path.join(sandbox.parent, "rootfs"))
      await writeFile(
        path.join(sandbox.parent, "rootfs", "fixture"),
        "keep until verified",
      )
      const outside = path.join(sandbox.base, "postgres-attestation")
      await writeFile(outside, "outside deletion scope")
      const result = runScript(sandbox, ["teardown", sandbox.parent])
      expect(result.status, result.stderr).toBe(0)
      expect(await exists(sandbox.parent)).toBe(false)
      expect(await readFile(outside, "utf8")).toBe("outside deletion scope")
    })

    it.each([
      "schema",
      "parent",
      "machineId",
      "bootId",
      "postgresRoot",
      "dedicatedNonProduction",
    ])(
      "rejects bad attestation %s before any teardown action",
      async (field) => {
        const sandbox = await setUp()
        const file = await addAttestation(sandbox, {
          [field]: "SYNTHETIC-PRIVATE-MARKER",
        })
        await mkdir(path.join(sandbox.parent, "rootfs"))
        const result = runScript(sandbox, ["teardown", sandbox.parent])
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain("BLOCKED")
        expect(result.stderr).not.toContain("SYNTHETIC-PRIVATE-MARKER")
        expect(await exists(file)).toBe(true)
        expect(await exists(path.join(sandbox.parent, "rootfs"))).toBe(true)
        expect(await readFile(sandbox.log, "utf8")).not.toContain("umount")
      },
    )
    it.each([
      "symlink",
      "directory",
      "unowned",
      "permissions",
      "malformed",
      "extra",
      "child-extra",
      "nested-mount",
      "preserved-run",
    ])("preserves all resources for %s", async (failure) => {
      const sandbox = await setUp()
      const file = await addAttestation(sandbox)
      const extra: NodeJS.ProcessEnv = {}
      if (failure === "symlink") {
        await rm(file)
        await symlink(sandbox.log, file)
      }
      if (failure === "directory") {
        await rm(file)
        await mkdir(file)
      }
      if (failure === "unowned") extra.FAKE_ATTESTATION_UID = "1"
      if (failure === "permissions") await chmod(file, 0o644)
      if (failure === "malformed")
        await writeFile(file, "{SYNTHETIC-PRIVATE-MARKER")
      if (failure === "extra")
        await writeFile(path.join(sandbox.parent, "unexpected"), "x")
      if (failure === "child-extra")
        await writeFile(
          path.join(sandbox.parent, "workspace", "unexpected"),
          "x",
        )
      if (failure === "nested-mount")
        await writeFile(
          sandbox.mountsFile,
          `${sandbox.parent}/tmpfs\n${sandbox.parent}/rootfs/nested\n`,
        )
      if (failure === "preserved-run")
        await mkdir(
          path.join(sandbox.parent, "workspace", "peephole-m12-preserved"),
        )
      await mkdir(path.join(sandbox.parent, "rootfs"))
      const result = runScript(sandbox, ["teardown", sandbox.parent], extra)
      expect(result.status).not.toBe(0)
      expect(result.stderr).not.toContain("SYNTHETIC-PRIVATE-MARKER")
      for (const name of [
        "workspace",
        "runsc",
        "tmpfs",
        "rootfs",
        ".peephole-m12-test-parent",
        ".peephole-m12-combined.json",
      ])
        expect(await exists(path.join(sandbox.parent, name))).toBe(true)
      expect(await readFile(sandbox.log, "utf8")).not.toContain("umount")
    })

    it("reports partial deletion as BLOCKED and retains attestations and remaining rootfs", async () => {
      const sandbox = await setUp()
      await addAttestation(sandbox)
      await mkdir(path.join(sandbox.parent, "rootfs"))
      const result = runScript(sandbox, ["teardown", sandbox.parent], {
        FAKE_ROOTFS_RM_FAIL: "1",
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("BLOCKED: partial rootfs teardown")
      for (const name of [
        "rootfs",
        ".peephole-m12-test-parent",
        ".peephole-m12-combined.json",
      ])
        expect(await exists(path.join(sandbox.parent, name))).toBe(true)
      expect(result.stdout).not.toContain("parent removed")
    })

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

// ------------------------------------- Finding 1/3: fake /proc trees

const posixBash =
  process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0

describe.skipIf(!posixBash)(
  "assert_no_processes_reference (sourced, fake /proc)",
  () => {
    const roots: string[] = []
    afterEach(async () => {
      for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true })
    })

    const PARENT = "/srv/peephole-m12-test-x"
    type Proc = {
      ppid?: number
      argv?: string[]
      cmdlineIsDirectory?: boolean
      noStatus?: boolean
      vanished?: boolean
    }

    async function procTree(processes: Record<number, Proc>): Promise<string> {
      const root = await mkdtemp(path.join(os.tmpdir(), "m12-proc-"))
      roots.push(root)
      for (const [pid, proc] of Object.entries(processes)) {
        const dir = path.join(root, pid)
        if (proc.vanished) {
          await symlinkTo(path.join(root, "gone"), dir)
          continue
        }
        await mkdir(dir)
        if (!proc.noStatus) {
          await writeFile(
            path.join(dir, "status"),
            `Name:\tx\nPPid:\t${String(proc.ppid ?? 1)}\n`,
          )
        }
        if (proc.cmdlineIsDirectory) await mkdir(path.join(dir, "cmdline"))
        else
          await writeFile(
            path.join(dir, "cmdline"),
            (proc.argv ?? []).map((arg) => `${arg}\0`).join(""),
          )
      }
      return root
    }

    function check(root: string, self: number) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          // $0 is a label, not the script, so sourcing never runs main().
          'source "$1"; assert_no_processes_reference "$2" "$3" "$4"; echo CLEAN',
          "m12-proc-test",
          SCRIPT,
          PARENT,
          root,
          String(self),
        ],
        { encoding: "utf8" },
      )
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }

    const launcherTree = (): Record<number, Proc> => ({
      1: { ppid: 0, argv: ["/sbin/init"] },
      2: { ppid: 0, argv: [] }, // kernel thread: empty cmdline
      100: {
        ppid: 1,
        argv: ["sudo", "bash", "m12-test-host.sh", "teardown", PARENT],
      },
      101: {
        ppid: 100,
        argv: ["sudo", "bash", "m12-test-host.sh", "teardown", PARENT],
      },
      200: {
        ppid: 101,
        argv: ["bash", "m12-test-host.sh", "teardown", PARENT],
      },
      201: {
        ppid: 200,
        argv: ["bash", "m12-test-host.sh", "teardown", PARENT],
      }, // own helper
      300: { ppid: 1, argv: ["sshd: operator"] },
    })

    it("excludes only itself, its launcher ancestors, and its own helpers", async () => {
      const result = check(await procTree(launcherTree()), 200)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("CLEAN")
    })

    it("still refuses a leftover runsc that is not an ancestor, without printing its argv", async () => {
      const tree = launcherTree()
      tree[4242] = {
        ppid: 1,
        argv: [
          "runsc",
          "--root",
          `${PARENT}/runsc/state`,
          "run",
          "TOPSECRET-ARG",
        ],
      }
      const result = check(await procTree(tree), 200)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/process 4242 still references/)
      expect(result.stderr).not.toContain("TOPSECRET-ARG")
      expect(result.stderr).not.toContain("runsc --root")
    })

    it("refuses a leftover that is a sibling of the launcher", async () => {
      const tree = launcherTree()
      tree[150] = { ppid: 100, argv: ["bash", "-c", `sleep 60 ${PARENT}`] }
      expect(check(await procTree(tree), 200).stderr).toMatch(
        /process 150 still references/,
      )
    })

    it("ignores a process that exited during inspection", async () => {
      const tree = launcherTree()
      tree[700] = { vanished: true }
      expect(check(await procTree(tree), 200).stdout).toContain("CLEAN")
    })

    it("refuses when a live process cannot be inspected", async () => {
      const tree = launcherTree()
      tree[500] = { ppid: 1, cmdlineIsDirectory: true }
      const result = check(await procTree(tree), 200)
      expect(result.stderr).toMatch(/process 500 could not be inspected/)
    })

    it("refuses when its own ancestry cannot be inspected", async () => {
      const tree = launcherTree()
      tree[101] = { ...tree[101]!, noStatus: true }
      expect(check(await procTree(tree), 200).stderr).toMatch(
        /ancestry of process 200 could not be inspected/,
      )
    })

    it("refuses when a referencing process's ancestry is unprovable", async () => {
      const tree = launcherTree()
      tree[900] = { ppid: 901, argv: ["runsc", "--root", `${PARENT}/runsc`] }
      tree[901] = { ppid: 1, noStatus: true, argv: ["containerd-shim"] }
      expect(check(await procTree(tree), 200).stderr).toMatch(
        /process 900 could not be inspected/,
      )
    })

    it("refuses an unreadable or missing process table", async () => {
      expect(
        check(path.join(os.tmpdir(), "m12-no-such-proc"), 200).stderr,
      ).toMatch(/process table .* is not readable/)
    })
  },
)

async function symlinkTo(target: string, link: string): Promise<void> {
  const { symlink } = await import("node:fs/promises")
  await symlink(target, link)
}
