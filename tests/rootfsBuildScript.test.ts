import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const sourceDirectory = fileURLToPath(
  new URL("../scripts/gvisor/", import.meta.url),
)
const linux = process.platform === "linux"

// Run the real script with only the root gate and archive pins substituted.
// All privileged/network commands are shims; tar/sha256sum/install remain real.
// Actual root ownership, chroot and Node/npm are separately checked by a WSL build.
describe.skipIf(!linux)("rootfs builder fail-closed behavior", () => {
  let base: string
  let output: string
  let script: string
  let archive: string
  let source: string

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "peephole-rootfs-script-"))
    output = path.join(base, "rootfs")
    script = path.join(base, "build.sh")
    archive = path.join(base, "node.tar.xz")
    await mkdir(path.join(base, "bin"))
    await mkdir(path.join(base, "fixture/node/bin"), { recursive: true })
    await writeFile(path.join(base, "fixture/node/bin/node"), "node fixture\n")
    await writeFile(path.join(base, "fixture/node/bin/npm"), "npm fixture\n")
    const packed = spawnSync("tar", [
      "--owner=1000",
      "--group=1000",
      "-cJf",
      archive,
      "-C",
      path.join(base, "fixture"),
      "node",
    ])
    expect(packed.status).toBe(0)
    source = await readFile(
      path.join(sourceDirectory, "build-base-rootfs.sh"),
      "utf8",
    )
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")
    await writeFile(
      script,
      source
        .replace("if [[ $EUID -ne 0 ]]; then", "if false; then")
        .replace(/NODE_SHA256="[a-f0-9]{64}"/g, `NODE_SHA256="${digest}"`),
    )
    await copyFile(
      path.join(sourceDirectory, "secret-bootstrap.mjs"),
      path.join(base, "secret-bootstrap.mjs"),
    )
    const shims: Record<string, string> = {
      dpkg: 'echo "${TEST_ARCH:-amd64}"',
      mktemp: 'exec /usr/bin/mktemp -d "$TEST_BASE/download.XXXXXXXX"',
      debootstrap: `
echo debootstrap >> "$TEST_BASE/calls"
test -z "\${TMPDIR:-}\${TMP:-}\${TEMP:-}" || exit 91
mkdir -p "$3/usr/local" "$3/etc"
echo partial > "$3/sentinel"
[[ "\${TEST_FAIL:-}" != debootstrap ]]`,
      chroot: `
test -z "\${TMPDIR:-}\${TMP:-}\${TEMP:-}" || exit 92
echo "chroot $2" >> "$TEST_BASE/calls"
[[ "\${TEST_FAIL:-}" != chroot ]]`,
      curl: `
echo curl >> "$TEST_BASE/calls"
if [[ "\${TEST_FAIL:-}" == checksum ]]; then
  echo corrupted > "\${@: -1}"
else
  cp "$TEST_BASE/node.tar.xz" "\${@: -1}"
fi`,
      sha256sum: `
/usr/bin/sha256sum "$@"
status=$?
echo "sha256sum $status" >> "$TEST_BASE/calls"
exit "$status"`,
      tar: 'echo "tar $*" >> "$TEST_BASE/calls"; exec /usr/bin/tar "$@"',
      find: `
[[ "\${TEST_FAIL:-}" != find ]] || exit 2
if [[ "\${TEST_FAIL:-}" == owner ]]; then echo non-root-file
elif [[ $EUID == 0 ]]; then exec /usr/bin/find "$@"
fi`,
    }
    for (const [name, body] of Object.entries(shims)) {
      const file = path.join(base, "bin", name)
      await writeFile(file, `#!/usr/bin/env bash\n${body}\n`)
      await chmod(file, 0o755)
    }
    await writeFile(path.join(base, "calls"), "")
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function run(target = output, environment: NodeJS.ProcessEnv = {}) {
    return spawnSync("bash", [script, target], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${base}/bin:/usr/bin:/bin`,
        TEST_BASE: base,
        ...environment,
      },
    })
  }

  it.each(["directory", "file", "symlink", "dangling symlink"])(
    "preserves and refuses an existing %s before build commands",
    async (kind) => {
      if (kind === "directory") await mkdir(output)
      else if (kind === "file") await writeFile(output, "stable")
      else await symlink(kind === "symlink" ? base : `${base}/missing`, output)
      const before = await readdir(base)
      expect(run().status).not.toBe(0)
      expect(await readdir(base)).toEqual(before)
      expect(await readFile(path.join(base, "calls"), "utf8")).toBe("")
    },
  )

  it("refuses relative, root, noncanonical and symlink-ancestor paths", async () => {
    await symlink(base, path.join(base, "alias"))
    for (const target of [
      "relative",
      "/",
      `${base}/x/../rootfs`,
      `${base}/alias/rootfs`,
    ]) {
      expect(run(target).status).not.toBe(0)
    }
    expect(await readFile(path.join(base, "calls"), "utf8")).toBe("")
  })

  it("rejects corruption before extraction or Node/npm execution, preserving partial output", async () => {
    const result = run(output, { TEST_FAIL: "checksum" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("SHA256 mismatch")
    const calls = await readFile(path.join(base, "calls"), "utf8")
    expect(calls).toContain("sha256sum 1")
    expect(calls).not.toContain("tar ")
    expect(calls).not.toContain("chroot /usr/local/bin/")
    expect(await readFile(path.join(output, "sentinel"), "utf8")).toBe(
      "partial\n",
    )
    expect(
      (await readdir(base)).filter((entry) => entry.startsWith("download.")),
    ).toEqual([])
  })

  it.each(["amd64", "arm64"])(
    "builds the %s path with isolated temporary storage",
    async (arch) => {
      const result = run(output, {
        TEST_ARCH: arch,
        TMPDIR: `${base}/host-only`,
        TMP: `${base}/host-only`,
        TEMP: `${base}/host-only`,
      })
      expect(result.status, result.stderr).toBe(0)
      const calls = await readFile(path.join(base, "calls"), "utf8")
      expect(calls.indexOf("sha256sum 0")).toBeLessThan(calls.indexOf("tar "))
      expect(calls).toContain("--no-same-owner")
      expect(calls).toContain("chroot /usr/local/bin/node")
      expect(calls).toContain("chroot /usr/local/bin/npm")
      expect(
        await readFile(path.join(output, "opt/peephole/secret-bootstrap.mjs")),
      ).toEqual(
        await readFile(path.join(sourceDirectory, "secret-bootstrap.mjs")),
      )
      expect(
        (await stat(path.join(output, "opt/peephole/secret-bootstrap.mjs")))
          .mode & 0o777,
      ).toBe(0o555)
      for (const name of ["env", "database-url", "user-env"]) {
        const info = await stat(path.join(output, "run/secrets", name))
        expect(info.size).toBe(0)
        expect(info.mode & 0o777).toBe(0o644)
      }
      expect(
        (await readdir(base)).filter((entry) => entry.startsWith("download.")),
      ).toEqual([])
    },
  )

  it.each(["debootstrap", "chroot", "owner", "find"])(
    "preserves the partial image after %s failure",
    async (failure) => {
      expect(run(output, { TEST_FAIL: failure }).status).not.toBe(0)
      expect(await readFile(path.join(output, "sentinel"), "utf8")).toBe(
        "partial\n",
      )
      const calls = await readFile(path.join(base, "calls"), "utf8")
      expect(run().status).not.toBe(0)
      expect(await readFile(path.join(base, "calls"), "utf8")).toBe(calls)
    },
  )

  it("refuses unpinned architectures and versions before creating output", async () => {
    expect(run(output, { TEST_ARCH: "riscv64" }).status).not.toBe(0)
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace(
        'NODE_VERSION="24.20.0"',
        'NODE_VERSION="24.21.0"',
      ),
    )
    expect(run().status).not.toBe(0)
    expect(await readFile(path.join(base, "calls"), "utf8")).toBe("")
    expect(await readdir(base)).not.toContain("rootfs")
  })
})
