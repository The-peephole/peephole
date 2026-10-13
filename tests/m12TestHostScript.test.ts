import { spawnSync } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
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
 * Finding 3: the dedicated test parent is set up and torn down only through
 * tests/support/m12-test-host.sh. These cases exercise every refusal that
 * happens before any privileged or destructive step; none of them mounts,
 * unmounts, or deletes anything.
 */
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const SCRIPT = path.join(repositoryRoot, "tests", "support", "m12-test-host.sh")
const bashAvailable = spawnSync("bash", ["--version"]).status === 0
const posixHost = process.platform !== "win32"
const unprivileged = process.getuid?.() !== 0

function run(...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

describe.skipIf(!bashAvailable)("m12-test-host.sh refusals", () => {
  it.each([
    [[], /usage/],
    [["wipe", "/srv/m12"], /unknown command wipe/],
    [["setup", "relative/m12"], /absolute path/],
    [["setup", "/"], /absolute path/],
    [["setup", "/srv"], /system directory \/srv/],
    [["setup", "/tmp"], /system directory \/tmp/],
    [["teardown", "/var/lib/peephole"], /at or under \/var\/lib\/peephole/],
    [
      ["teardown", "/var/lib/peephole/jobs/m12"],
      /at or under \/var\/lib\/peephole/,
    ],
    [["teardown", "/run/peephole/m12"], /at or under \/run\/peephole/],
    [
      ["teardown", "/var/run/peephole/runsc"],
      /at or under \/var\/run\/peephole/,
    ],
    [["teardown", "/run/netns/m12"], /at or under \/run\/netns/],
    [["teardown", "/srv/a/../b"], /normalized/],
    [["teardown", "/srv/a//b"], /normalized/],
    [["teardown", "/srv/m12/"], /normalized/],
    [["teardown", "/srv/m12 x"], /absolute path/],
    [
      ["teardown", "/srv/peephole-m12-never-created"],
      /not a verified dedicated test parent/,
    ],
  ])("refuses %j", (args, message) => {
    const result = run(...(args as string[]))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(message)
    expect(result.stdout).toBe("")
  })

  it("is a strict-mode script with no unguarded recursive force deletion", async () => {
    const source = await readFile(SCRIPT, "utf8")
    expect(source).toMatch(/^set -euo pipefail$/m)
    expect(source).not.toMatch(/rm -rf/)
    // One recursive removal command (the echo that announces it is not one).
    expect(source.match(/^\s+rm -r /gm)).toHaveLength(1)
    expect(source).toContain('rm -r --one-file-system -- "$parent/rootfs"')
  })
})

describe.skipIf(!bashAvailable || !posixHost || !unprivileged)(
  "m12-test-host.sh marker verification (POSIX, unprivileged)",
  () => {
    const created: string[] = []
    afterEach(async () => {
      for (const dir of created.splice(0)) {
        await rm(dir, { recursive: true, force: true })
      }
    })

    async function parentWithMarker(lines?: string[]) {
      const base = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "m12-host-")),
      )
      created.push(base)
      const parent = path.join(base, "parent")
      await mkdir(parent)
      if (lines) {
        await writeFile(
          path.join(parent, ".peephole-m12-test-parent"),
          `${lines.join("\n")}\n`,
        )
      }
      return parent
    }

    it("refuses a directory without the setup marker", async () => {
      const parent = await parentWithMarker()
      expect(run("teardown", parent).stderr).toMatch(/no marker/)
    })

    it.each([
      [
        "a wrong schema",
        (parent: string) => ["other/v1", "a".repeat(32), parent],
      ],
      [
        "a malformed token",
        (parent: string) => ["peephole-m12-test-parent/v1", "zz", parent],
      ],
      [
        "another parent's path",
        () => ["peephole-m12-test-parent/v1", "a".repeat(32), "/srv/elsewhere"],
      ],
    ])("refuses a marker with %s", async (_label, lines) => {
      const parent = await parentWithMarker()
      await writeFile(
        path.join(parent, ".peephole-m12-test-parent"),
        `${lines(parent).join("\n")}\n`,
      )
      expect(run("teardown", parent).stderr).toMatch(/marker does not match/)
    })

    it("refuses a symlinked parent and a symlinked marker", async () => {
      const parent = await parentWithMarker([
        "peephole-m12-test-parent/v1",
        "a".repeat(32),
        "placeholder",
      ])
      const link = `${parent}-link`
      await symlink(parent, link)
      expect(run("teardown", link).stderr).toMatch(/missing or symlink/)

      const other = await parentWithMarker()
      await symlink(
        path.join(parent, ".peephole-m12-test-parent"),
        path.join(other, ".peephole-m12-test-parent"),
      )
      expect(run("teardown", other).stderr).toMatch(/no marker/)
    })

    it("a verified marker still stops at the root requirement before any action", async () => {
      const parent = await parentWithMarker()
      await writeFile(
        path.join(parent, ".peephole-m12-test-parent"),
        `peephole-m12-test-parent/v1\n${"a".repeat(32)}\n${parent}\n`,
      )
      const result = run("teardown", parent)
      expect(result.stderr).toMatch(/requires root/)
      await expect(
        readFile(path.join(parent, ".peephole-m12-test-parent"), "utf8"),
      ).resolves.toContain(parent)
    })
  },
)

describe("runbook cleanup guidance", () => {
  it("routes setup, rootfs build, and teardown through the guarded script only", async () => {
    const runbook = await readFile(
      path.join(repositoryRoot, "docs", "M12_REAL_GVISOR_VERIFICATION.md"),
      "utf8",
    )
    expect(runbook).not.toMatch(/rm -rf/)
    expect(runbook).not.toMatch(/^\s*exit 1/m)
    for (const step of ["setup", "build-rootfs", "teardown"]) {
      expect(runbook).toContain(`tests/support/m12-test-host.sh ${step}`)
    }
  })
})
