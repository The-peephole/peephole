import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { get as httpGet } from "node:http"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  M12HarnessPreflightError,
  OWNER_MARKER_FILE,
  PRODUCTION_HOST_MARKERS,
  combineScanStatuses,
  createOwnedRunDirectory,
  destroyWorkspaces,
  stopRuntimeHandles,
  findProductionHostMarkers,
  mountsWithin,
  createOwnedRunSet,
  deriveM12ComponentPaths,
  formatM12PreflightSummary,
  inspectM12TestRootfs,
  m12RealSuiteEnabled,
  protectedResourceRoots,
  readM12HarnessConfig,
  removeOwnedRunDirectory,
  runWithOwnedCleanup,
  scanFileForRawValueStatus,
  scanForRawValueStatus,
  sha256,
  verifyOwnedRunDirectory,
  withSetupRollback,
  type OwnedDirectoryOperations,
  type PathInspection,
  type RootfsInspection,
} from "./support/m12RealGvisorHarness"

const SENTINEL = "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026"

// ------------------------------------------------------------ fake fs

type FakeEntry =
  | { kind: "dir"; dev: number; ino: number }
  | {
      kind: "file"
      content: string
      uid?: number
      mode?: number
      size?: number
    }
  | { kind: "symlink"; target: string }

class FakeFs {
  readonly entries = new Map<string, FakeEntry>()
  readonly removed: string[] = []
  readonly unlinked: string[] = []
  failRmdir = false
  /** Return an error to make the next marker write fail (after optional
   * side effects such as a partial file or a swapped directory). */
  onWriteFile?: (candidate: string) => Error | undefined
  mountInfo = "25 1 8:1 / / rw - ext4 /dev/sda1 rw\n"
  private nextIno = 100

  dir(candidate: string): this {
    this.entries.set(candidate, { kind: "dir", dev: 1, ino: this.nextIno++ })
    return this
  }

  operations(): OwnedDirectoryOperations {
    const stats = (entry: FakeEntry) => ({
      isDirectory: () => entry.kind === "dir",
      isFile: () => entry.kind === "file",
      isSymbolicLink: () => entry.kind === "symlink",
      dev: entry.kind === "dir" ? entry.dev : 1,
      ino: entry.kind === "dir" ? entry.ino : 0,
      uid: entry.kind === "file" ? (entry.uid ?? 0) : 0,
      mode: entry.kind === "file" ? (entry.mode ?? 0o644) : 0o755,
      size:
        entry.kind === "file"
          ? (entry.size ?? Buffer.byteLength(entry.content))
          : 0,
    })
    return {
      lstat: async (candidate) => {
        const entry = this.entries.get(candidate)
        if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        return stats(entry)
      },
      realpath: async (candidate) => {
        const entry = this.entries.get(candidate)
        if (!entry) throw new Error("ENOENT")
        return entry.kind === "symlink" ? entry.target : candidate
      },
      mkdtemp: async (prefix) => {
        const created = `${prefix}${String(this.nextIno)}`
        this.dir(created)
        return created
      },
      writeFile: async (candidate, contents) => {
        const injected = this.onWriteFile?.(candidate)
        if (injected) throw injected
        this.entries.set(candidate, { kind: "file", content: contents })
      },
      readFile: async (candidate) => {
        const entry = this.entries.get(candidate)
        if (!entry || entry.kind !== "file") throw new Error("ENOENT")
        return entry.content
      },
      readMountInfo: async () => this.mountInfo,
      rmdir: async (candidate) => {
        if (this.failRmdir) throw new Error("EBUSY")
        const children = [...this.entries.keys()].filter((key) =>
          key.startsWith(`${candidate}/`),
        )
        if (children.length > 0) throw new Error("ENOTEMPTY")
        this.removed.push(candidate)
        this.entries.delete(candidate)
      },
      unlink: async (candidate) => {
        this.unlinked.push(candidate)
        this.entries.delete(candidate)
      },
      rm: async (candidate) => {
        this.removed.push(candidate)
        for (const key of [...this.entries.keys()]) {
          if (key === candidate || key.startsWith(`${candidate}/`)) {
            this.entries.delete(key)
          }
        }
      },
    }
  }
}

const validRoots = {
  PEEPHOLE_M12_TEST_WORKSPACE_ROOT: "/srv/m12/workspace",
  PEEPHOLE_M12_TEST_RUNSC_ROOT: "/srv/m12/runsc",
  PEEPHOLE_M12_TEST_BASE_ROOTFS: "/srv/m12/rootfs",
  PEEPHOLE_M12_TEST_TMPFS_ROOT: "/run/peephole-m12-test",
}

function fakeWithRoots(): FakeFs {
  const fs = new FakeFs()
  for (const root of Object.values(validRoots)) fs.dir(root)
  return fs
}

// ------------------------------------------------------------- gating

describe("M12 real-gVisor gates", () => {
  it("requires both gates set to exactly 1", () => {
    expect(
      m12RealSuiteEnabled({
        PEEPHOLE_REAL_GVISOR_TESTS: "1",
        PEEPHOLE_M12_REAL_GVISOR_TESTS: "1",
      }),
    ).toBe(true)
    expect(m12RealSuiteEnabled({})).toBe(false)
    expect(m12RealSuiteEnabled({ PEEPHOLE_REAL_GVISOR_TESTS: "1" })).toBe(false)
    expect(m12RealSuiteEnabled({ PEEPHOLE_M12_REAL_GVISOR_TESTS: "1" })).toBe(
      false,
    )
  })

  it.each(["", "0", "true", "yes", "on", "TRUE", " 1", "1 ", "2"])(
    "refuses the non-exact value %j",
    (value) => {
      expect(
        m12RealSuiteEnabled({
          PEEPHOLE_REAL_GVISOR_TESTS: "1",
          PEEPHOLE_M12_REAL_GVISOR_TESTS: value,
        }),
      ).toBe(false)
      expect(
        m12RealSuiteEnabled({
          PEEPHOLE_REAL_GVISOR_TESTS: value,
          PEEPHOLE_M12_REAL_GVISOR_TESTS: "1",
        }),
      ).toBe(false)
    },
  )

  it("the broad M10/M11 gate alone never enables M12", () => {
    expect(
      m12RealSuiteEnabled({
        PEEPHOLE_REAL_GVISOR_TESTS: "1",
        PEEPHOLE_M11_REAL_GVISOR_DATABASE_TESTS: "1",
      }),
    ).toBe(false)
  })
})

// ------------------------------------------------------------- paths

describe("readM12HarnessConfig", () => {
  it("accepts four explicit, canonical, disjoint test roots", async () => {
    const fs = fakeWithRoots()
    await expect(
      readM12HarnessConfig(validRoots, fs.operations()),
    ).resolves.toEqual({
      workspaceRoot: "/srv/m12/workspace",
      runscRoot: "/srv/m12/runsc",
      baseRootfs: "/srv/m12/rootfs",
      tmpfsRoot: "/run/peephole-m12-test",
    })
  })

  it.each(Object.keys(validRoots))(
    "never falls back to a default when %s is missing",
    async (variable) => {
      const fs = fakeWithRoots()
      const environment = { ...validRoots, [variable]: "" }
      await expect(
        readM12HarnessConfig(environment, fs.operations()),
      ).rejects.toThrow(new RegExp(`${variable} is required`))
    },
  )

  it.each([
    ["a relative path", "srv/m12/workspace"],
    ["the filesystem root", "/"],
    ["/run", "/run"],
    ["/run/peephole", "/run/peephole"],
    ["/tmp", "/tmp"],
    ["/var/lib/peephole", "/var/lib/peephole"],
    ["the production user-env root", "/run/peephole/user-env"],
    ["inside the production user-env root", "/run/peephole/user-env/m12"],
    ["inside the production secret root", "/run/peephole/secrets/m12"],
    ["inside the production credential root", "/run/peephole/db-credentials/x"],
    ["the production base rootfs", "/var/lib/peephole/base-rootfs"],
    ["inside production jobs", "/var/lib/peephole/jobs/m12"],
    ["the production runsc root", "/var/run/peephole/runsc"],
    ["inside the production runsc root", "/var/run/peephole/runsc/m12"],
    ["the production lease directory", "/var/run/peephole/net-leases"],
    ["the shared netns directory", "/run/netns/m12"],
  ])("rejects %s", async (_label, candidate) => {
    const fs = fakeWithRoots().dir(candidate)
    await expect(
      readM12HarnessConfig(
        { ...validRoots, PEEPHOLE_M12_TEST_WORKSPACE_ROOT: candidate },
        fs.operations(),
      ),
    ).rejects.toBeInstanceOf(M12HarnessPreflightError)
  })

  it("protects operator-overridden production roots too", async () => {
    const fs = fakeWithRoots().dir("/srv/prod-user-env/m12")
    await expect(
      readM12HarnessConfig(
        {
          ...validRoots,
          PEEPHOLE_USER_ENVIRONMENT_ROOT: "/srv/prod-user-env",
          PEEPHOLE_M12_TEST_TMPFS_ROOT: "/srv/prod-user-env/m12",
        },
        fs.operations(),
      ),
    ).rejects.toThrow(/protected production root \/srv\/prod-user-env/)
  })

  it("rejects a root that is an ancestor of a protected root", async () => {
    const fs = fakeWithRoots().dir("/srv/prod")
    await expect(
      readM12HarnessConfig(
        {
          ...validRoots,
          PEEPHOLE_GVISOR_BUNDLES_DIR: "/srv/prod/jobs",
          PEEPHOLE_M12_TEST_WORKSPACE_ROOT: "/srv/prod",
        },
        fs.operations(),
      ),
    ).rejects.toThrow(/overlaps the protected production root/)
  })

  it("rejects a missing directory, a file, and a symlink", async () => {
    const missing = fakeWithRoots()
    missing.entries.delete("/srv/m12/runsc")
    await expect(
      readM12HarnessConfig(validRoots, missing.operations()),
    ).rejects.toThrow(/must already exist/)

    const symlink = fakeWithRoots()
    symlink.entries.set("/srv/m12/runsc", {
      kind: "symlink",
      target: "/var/run/peephole/runsc",
    })
    await expect(
      readM12HarnessConfig(validRoots, symlink.operations()),
    ).rejects.toThrow(/not a symlink/)
  })

  it("rejects a root reached through a symlinked ancestor", async () => {
    const fs = fakeWithRoots()
    const operations: PathInspection = {
      ...fs.operations(),
      realpath: async (candidate) =>
        candidate === "/srv/m12/runsc" ? "/var/run/peephole/runsc" : candidate,
    }
    await expect(readM12HarnessConfig(validRoots, operations)).rejects.toThrow(
      /must not traverse a symlink/,
    )
  })

  it("rejects overlapping test roots", async () => {
    const fs = fakeWithRoots().dir("/srv/m12/workspace/runsc")
    await expect(
      readM12HarnessConfig(
        {
          ...validRoots,
          PEEPHOLE_M12_TEST_RUNSC_ROOT: "/srv/m12/workspace/runsc",
        },
        fs.operations(),
      ),
    ).rejects.toThrow(/must not overlap/)
  })

  it("prints a summary with paths and gate booleans only", async () => {
    const fs = fakeWithRoots()
    const environment = {
      ...validRoots,
      PEEPHOLE_REAL_GVISOR_TESTS: "1",
      PEEPHOLE_GITHUB_TOKEN: SENTINEL,
      PEEPHOLE_SESSION_SIGNING_SECRET: SENTINEL,
    }
    const config = await readM12HarnessConfig(environment, fs.operations())
    const summary = formatM12PreflightSummary(config, environment)
    expect(summary).not.toContain(SENTINEL)
    expect(JSON.parse(summary).gates).toEqual({
      PEEPHOLE_REAL_GVISOR_TESTS: true,
      PEEPHOLE_M12_REAL_GVISOR_TESTS: false,
    })
  })
})

// ------------------------------------------------------------- rootfs

describe("inspectM12TestRootfs", () => {
  const bootstrap = Buffer.from(
    "// current bootstrap --peephole-require-user-environment",
  )
  function rootfs(
    overrides: Record<string, FakeEntry | null> = {},
  ): RootfsInspection {
    const base: Record<string, FakeEntry | null> = {
      "/rootfs/usr/local/bin/node": {
        kind: "file",
        content: "elf",
        mode: 0o755,
      },
      "/rootfs/run/secrets": { kind: "dir", dev: 1, ino: 1 },
      "/rootfs/run/secrets/env": { kind: "file", content: "" },
      "/rootfs/run/secrets/database-url": { kind: "file", content: "" },
      "/rootfs/run/secrets/user-env": { kind: "file", content: "" },
      "/rootfs/opt/peephole/secret-bootstrap.mjs": {
        kind: "file",
        content: bootstrap.toString(),
        mode: 0o555,
      },
      ...overrides,
    }
    const fs = new FakeFs()
    for (const [candidate, entry] of Object.entries(base)) {
      if (entry) fs.entries.set(candidate, entry)
    }
    const operations = fs.operations()
    return {
      lstat: operations.lstat,
      readFile: async (candidate) =>
        Buffer.from(await operations.readFile(candidate)),
    }
  }

  it("accepts a rootfs built from this checkout", async () => {
    await expect(
      inspectM12TestRootfs("/rootfs", bootstrap, rootfs()),
    ).resolves.toEqual([])
  })

  it.each([
    [
      "a missing rootfs",
      {
        "/rootfs/usr/local/bin/node": null,
        "/rootfs/run/secrets": null,
        "/rootfs/run/secrets/env": null,
        "/rootfs/run/secrets/database-url": null,
        "/rootfs/run/secrets/user-env": null,
        "/rootfs/opt/peephole/secret-bootstrap.mjs": null,
      },
      /node is missing/,
    ],
    [
      "a missing node",
      { "/rootfs/usr/local/bin/node": null },
      /node is missing/,
    ],
    [
      "a missing M12 placeholder",
      { "/rootfs/run/secrets/user-env": null },
      /user-env is missing/,
    ],
    [
      "a non-empty placeholder",
      { "/rootfs/run/secrets/user-env": { kind: "file", content: "x" } },
      /user-env is not empty/,
    ],
    [
      "a writable placeholder",
      { "/rootfs/run/secrets/env": { kind: "file", content: "", mode: 0o666 } },
      /env does not have mode 0644/,
    ],
    [
      "a non-root placeholder",
      {
        "/rootfs/run/secrets/database-url": {
          kind: "file",
          content: "",
          uid: 65534,
        },
      },
      /database-url is not root-owned/,
    ],
    [
      "a symlinked placeholder",
      {
        "/rootfs/run/secrets/user-env": {
          kind: "symlink",
          target: "/etc/shadow",
        },
      },
      /user-env is missing or not a regular file/,
    ],
    [
      "a stale bootstrap",
      {
        "/rootfs/opt/peephole/secret-bootstrap.mjs": {
          kind: "file",
          content: "// old M11 bootstrap --peephole-require-user-environment",
          mode: 0o555,
        },
      },
      /stale rootfs/,
    ],
    [
      "a writable bootstrap",
      {
        "/rootfs/opt/peephole/secret-bootstrap.mjs": {
          kind: "file",
          content: bootstrap.toString(),
          mode: 0o755,
        },
      },
      /mode 0555/,
    ],
  ])("refuses %s", async (_label, overrides, problem) => {
    const problems = await inspectM12TestRootfs(
      "/rootfs",
      bootstrap,
      rootfs(overrides as Record<string, FakeEntry | null>),
    )
    expect(problems.join("; ")).toMatch(problem)
  })
})

// --------------------------------------------------- owned directories

describe("owned run directories", () => {
  it("creates a direct child with a marker and removes it only after re-proving ownership", async () => {
    const fs = fakeWithRoots()
    const owned = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    expect(path.posix.dirname(owned.path)).toBe("/srv/m12/workspace")
    expect(fs.entries.has(`${owned.path}/${OWNER_MARKER_FILE}`)).toBe(true)
    await expect(
      verifyOwnedRunDirectory(owned, fs.operations()),
    ).resolves.toEqual({
      ok: true,
    })
    await expect(
      removeOwnedRunDirectory(owned, fs.operations()),
    ).resolves.toEqual({
      removed: true,
    })
    expect(fs.removed).toEqual([owned.path])
  })

  it.each([
    [
      "a tampered marker",
      (fs: FakeFs, owned: { path: string }) => {
        fs.entries.set(`${owned.path}/${OWNER_MARKER_FILE}`, {
          kind: "file",
          content: "{}",
        })
      },
      /does not match/,
    ],
    [
      "a missing marker",
      (fs: FakeFs, owned: { path: string }) => {
        fs.entries.delete(`${owned.path}/${OWNER_MARKER_FILE}`)
      },
      /could not be inspected/,
    ],
    [
      "a replaced directory (new inode)",
      (fs: FakeFs, owned: { path: string }) => {
        fs.dir(owned.path)
      },
      /device\/inode changed/,
    ],
    [
      "a directory swapped for a symlink",
      (fs: FakeFs, owned: { path: string }) => {
        fs.entries.set(owned.path, {
          kind: "symlink",
          target: "/run/peephole/user-env",
        })
      },
      /no longer an ordinary directory/,
    ],
  ])("refuses to delete after %s", async (_label, tamper, reason) => {
    const fs = fakeWithRoots()
    const owned = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    tamper(fs, owned)
    const outcome = await removeOwnedRunDirectory(owned, fs.operations())
    expect(outcome.removed).toBe(false)
    expect(outcome.removed ? "" : outcome.reason).toMatch(reason)
    expect(fs.removed).toEqual([])
  })

  it("a copied marker from another run never authorizes deletion", async () => {
    const fs = fakeWithRoots()
    const first = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    const forged = { ...first, runId: "00000000-0000-0000-0000-000000000000" }
    await expect(
      removeOwnedRunDirectory(forged, fs.operations()),
    ).resolves.toMatchObject({
      removed: false,
    })
    expect(fs.removed).toEqual([])
  })

  it("refuses an unowned path that merely shares the root prefix", async () => {
    const fs = fakeWithRoots().dir("/srv/m12/workspace-other")
    const owned = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    const outcome = await removeOwnedRunDirectory(
      { ...owned, path: "/srv/m12/workspace-other" },
      fs.operations(),
    )
    expect(outcome.removed).toBe(false)
    expect(fs.removed).toEqual([])
  })

  it("rolls back already created run directories when a later one fails", async () => {
    const fs = fakeWithRoots()
    const operations = fs.operations()
    let calls = 0
    const failing: OwnedDirectoryOperations = {
      ...operations,
      mkdtemp: async (prefix) => {
        calls += 1
        if (calls === 3) throw new Error("tmpfs root unavailable")
        return operations.mkdtemp(prefix)
      },
    }
    const config = await readM12HarnessConfig(validRoots, operations)
    await expect(createOwnedRunSet(config, failing)).rejects.toThrow(
      "tmpfs root unavailable",
    )
    expect(fs.removed).toHaveLength(2)
  })

  it("releases the run set when setup fails, and keeps it when setup succeeds", async () => {
    const fs = fakeWithRoots()
    const operations = fs.operations()
    const config = await readM12HarnessConfig(validRoots, operations)
    const runs = await createOwnedRunSet(config, operations)
    await expect(
      withSetupRollback(runs, async () => "ready", operations),
    ).resolves.toBe("ready")
    expect(fs.removed).toEqual([])
    await expect(
      withSetupRollback(
        runs,
        async () => {
          throw new Error("not tmpfs")
        },
        operations,
      ),
    ).rejects.toThrow("not tmpfs")
    expect(fs.removed).toHaveLength(3)
  })
})

// ------------------------------------------------- component paths

describe("deriveM12ComponentPaths", () => {
  it("routes every component to an owned run directory, never a production default", async () => {
    const fs = fakeWithRoots()
    const operations = fs.operations()
    const config = await readM12HarnessConfig(validRoots, operations)
    const runs = await createOwnedRunSet(config, operations)
    const paths = deriveM12ComponentPaths(
      config,
      runs,
      protectedResourceRoots({}),
    )
    const productionDefaults = [
      "/var/lib/peephole/jobs",
      "/var/run/peephole/runsc",
      "/var/run/peephole/net-leases",
      "/var/lib/peephole/base-rootfs",
      "/run/peephole/secrets",
      "/run/peephole/db-credentials",
      "/run/peephole/user-env",
    ]
    for (const value of Object.values(paths)) {
      expect(productionDefaults).not.toContain(value)
      expect(
        [
          runs.workspace.path,
          runs.runsc.path,
          runs.tmpfs.path,
          config.baseRootfs,
        ].some((owner) => value === owner || value.startsWith(`${owner}/`)),
      ).toBe(true)
    }
  })

  it("refuses a run set that sits inside a protected root", async () => {
    const fs = fakeWithRoots()
    const operations = fs.operations()
    const config = await readM12HarnessConfig(validRoots, operations)
    const runs = await createOwnedRunSet(config, operations)
    expect(() =>
      deriveM12ComponentPaths(
        config,
        { ...runs, tmpfs: { ...runs.tmpfs, path: "/run/peephole/user-env/x" } },
        protectedResourceRoots({}),
      ),
    ).toThrow(M12HarnessPreflightError)
  })
})

// ------------------------------------------------------------ scanner

describe("scan status", () => {
  const created: string[] = []
  afterEach(async () => {
    for (const dir of created.splice(0))
      await rm(dir, { recursive: true, force: true })
  })

  it("reports PASS, FAIL, and INCOMPLETE distinctly", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "peephole-m12-scan-"))
    created.push(dir)
    await writeFile(path.join(dir, "clean.json"), "{}")
    expect(await scanForRawValueStatus(dir, SENTINEL)).toBe("PASS")
    await writeFile(path.join(dir, "leak.json"), `{"v":"${SENTINEL}"}`)
    expect(await scanForRawValueStatus(dir, SENTINEL)).toBe("FAIL")
    expect(
      await scanForRawValueStatus(dir, SENTINEL, {
        opendir: async () => {
          throw new Error("EACCES")
        },
      }),
    ).toBe("INCOMPLETE")
    expect(await scanForRawValueStatus(dir, SENTINEL, { maxBytes: 1 })).toBe(
      "INCOMPLETE",
    )
  })

  it("treats an unreadable required file as INCOMPLETE, never PASS", async () => {
    expect(
      await scanFileForRawValueStatus(
        "/missing/config.json",
        SENTINEL,
        async () => {
          throw new Error("ENOENT")
        },
      ),
    ).toBe("INCOMPLETE")
    expect(
      await scanFileForRawValueStatus("/x", SENTINEL, async () =>
        Buffer.from(`["${SENTINEL}"]`),
      ),
    ).toBe("FAIL")
  })

  it("combines statuses fail-closed", () => {
    expect(combineScanStatuses(["PASS", "PASS"])).toBe("PASS")
    expect(combineScanStatuses(["PASS", "INCOMPLETE"])).toBe("INCOMPLETE")
    expect(combineScanStatuses(["INCOMPLETE", "FAIL"])).toBe("FAIL")
    expect(combineScanStatuses([])).toBe("INCOMPLETE")
  })
})

// ----------------------------------------------------- cleanup order

describe("runWithOwnedCleanup", () => {
  it("runs every cleanup after a failed assertion and rethrows it", async () => {
    const order: string[] = []
    const failure = new Error("assertion failed")
    await expect(
      runWithOwnedCleanup(async () => {
        throw failure
      }, [
        async () => {
          order.push("stop")
          throw new Error("stop failed")
        },
        async () => {
          order.push("destroy")
        },
        async () => {
          order.push("remove")
        },
      ]),
    ).rejects.toBe(failure)
    expect(order).toEqual(["stop", "destroy", "remove"])
    expect(
      (failure as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toHaveLength(1)
  })

  it("reports cleanup failures after a passing scenario", async () => {
    const later = vi.fn(async () => undefined)
    await expect(
      runWithOwnedCleanup(
        async () => "ok",
        [
          async () => {
            throw new Error("remove failed")
          },
          later,
        ],
      ),
    ).rejects.toBeInstanceOf(AggregateError)
    expect(later).toHaveBeenCalledOnce()
  })
})

// ------------------------------------------------------------ fixture

describe("M12 digest fixture (portable, no gVisor)", () => {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "m12-user-env-runtime",
    "digest-server.cjs",
  )

  it("never dumps the environment or logs", async () => {
    const source = await readFile(fixturePath, "utf8")
    expect(source).not.toMatch(/JSON\.stringify\(process\.env\)/)
    expect(source).not.toMatch(/console\./)
    expect(source).not.toMatch(/writeFile/)
  })

  it("reports a digest and presence, never the raw value", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer()
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address() as { port: number }
        probe.close(() => resolve(address.port))
      })
    })
    const child = spawn(process.execPath, [fixturePath], {
      env: { PORT: String(port), APP_GREETING: SENTINEL },
      stdio: "ignore",
    })
    try {
      const body = await retry(() => getText(port, "/env-check"))
      expect(body).not.toContain(SENTINEL)
      const parsed = JSON.parse(body) as {
        variables: Record<string, { present: boolean; sha256: string | null }>
        argvContainsConfiguredValue: boolean
      }
      expect(parsed.variables.APP_GREETING).toEqual({
        present: true,
        sha256: sha256(SENTINEL),
      })
      expect(parsed.variables.SESSION_SECRET).toEqual({
        present: false,
        sha256: null,
      })
      expect(parsed.argvContainsConfiguredValue).toBe(false)
    } finally {
      // Only this test's own ChildProcess handle, never a name-based kill.
      child.kill()
    }
  })
})

function getText(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host: "127.0.0.1", port, path: requestPath },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.once("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        )
        response.once("error", reject)
      },
    )
    request.once("error", reject)
  })
}

async function retry<T>(action: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

describe("production host guard and mount-aware removal", () => {
  it("refuses a host with any Peephole production marker, and fails closed on inspection errors", async () => {
    await expect(
      findProductionHostMarkers(async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      }),
    ).resolves.toEqual([])
    await expect(
      findProductionHostMarkers(async (candidate) => {
        if (candidate === "/etc/systemd/system/peephole.service") return {}
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      }),
    ).resolves.toEqual(["/etc/systemd/system/peephole.service"])
    await expect(
      findProductionHostMarkers(async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      }),
    ).resolves.toEqual([...PRODUCTION_HOST_MARKERS])
  })

  it("finds mounts at or below a run directory, decoding escaped paths", () => {
    const mountInfo = [
      "36 25 7:0 / /srv/m12/workspace/run-1/bundles/a/workspace rw - ext4 /dev/loop0 rw",
      "37 25 0:4 / /srv/m12/runsc/run-1/state/null-netns rw - nsfs nsfs rw",
      "38 25 0:5 / /srv/m12/workspace/run-10 rw - tmpfs tmpfs rw",
      "39 25 0:6 / /srv/m12/workspace/run-1/with\\040space rw - tmpfs tmpfs rw",
    ].join("\n")
    expect(mountsWithin("/srv/m12/workspace/run-1", mountInfo)).toEqual([
      "/srv/m12/workspace/run-1/bundles/a/workspace",
      "/srv/m12/workspace/run-1/with space",
    ])
  })

  it("never recursively removes a run directory that still contains a mount", async () => {
    const fs = fakeWithRoots()
    const owned = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    fs.mountInfo = `36 25 7:0 / ${owned.path}/bundles/x rw - ext4 /dev/loop0 rw\n`
    const outcome = await removeOwnedRunDirectory(owned, fs.operations())
    expect(outcome).toEqual({
      removed: false,
      reason: "still has 1 mount(s) inside",
    })
    expect(fs.removed).toEqual([])
  })

  it("refuses removal when the mount table cannot be read", async () => {
    const fs = fakeWithRoots()
    const owned = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    )
    const operations = {
      ...fs.operations(),
      readMountInfo: async () => {
        throw new Error("EACCES")
      },
    }
    await expect(removeOwnedRunDirectory(owned, operations)).resolves.toEqual({
      removed: false,
      reason: "mount table could not be read",
    })
    expect(fs.removed).toEqual([])
  })
})

// ---------------------------------------------------------- Finding 1

describe("Finding 1: runtime cleanup never swallows failures", () => {
  it("attempts every stop in reverse order and reports each failure", async () => {
    const calls: string[] = []
    const handles = [
      { stop: async () => void calls.push("first") },
      {
        stop: async () => {
          calls.push("second")
          throw new Error("runsc kill failed")
        },
      },
      { stop: async () => void calls.push("third") },
    ]
    const error = await stopRuntimeHandles(handles).catch(
      (caught: unknown) => caught,
    )
    expect(calls).toEqual(["third", "second", "first"])
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(1)
  })

  it("attempts every destroy and reports each failure", async () => {
    const calls: string[] = []
    const workspaces = [
      {
        destroy: async () => {
          calls.push("a")
          throw new Error("loop device busy")
        },
      },
      {
        destroy: async () => {
          calls.push("b")
          throw new Error("netns busy")
        },
      },
    ]
    const error = await destroyWorkspaces(workspaces).catch(
      (caught: unknown) => caught,
    )
    expect(calls).toEqual(["b", "a"])
    expect((error as AggregateError).errors).toHaveLength(2)
    await expect(destroyWorkspaces([])).resolves.toBeUndefined()
  })

  it("a passing scenario is reported as failed when runtime cleanup fails, and later cleanup still runs", async () => {
    const removeRuns = vi.fn(async () => undefined)
    await expect(
      runWithOwnedCleanup(
        async () => "scenario passed",
        [
          () =>
            stopRuntimeHandles([
              {
                stop: async () => {
                  throw new Error("stop failed")
                },
              },
            ]),
          () => destroyWorkspaces([{ destroy: async () => undefined }]),
          removeRuns,
        ],
      ),
    ).rejects.toBeInstanceOf(AggregateError)
    expect(removeRuns).toHaveBeenCalledOnce()
  })

  it("the real suite wires the reporting helpers instead of swallowing errors", async () => {
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "realUserEnvironmentRuntime.test.ts",
      ),
      "utf8",
    )
    expect(source).toContain("stopRuntimeHandles(environment.handles)")
    expect(source).toContain("destroyWorkspaces(environment.workspaces)")
    expect(source).not.toMatch(/\.stop\(\)\.catch\(\(\) => undefined\)/)
    expect(source).not.toMatch(/\.destroy\(\)\.catch\(\(\) => undefined\)/)
  })
})

// ---------------------------------------------------------- Finding 2

describe("Finding 2: a run directory whose marker write fails never becomes a silent orphan", () => {
  it("removes the just-created empty directory after re-proving its identity", async () => {
    const fs = fakeWithRoots()
    fs.onWriteFile = () => new Error("ENOSPC")
    const error = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    ).catch((caught: unknown) => caught as Error)
    expect(error.message).toMatch(
      /marker could not be written; the directory was removed/,
    )
    expect(fs.removed).toHaveLength(1)
    expect(
      [...fs.entries.keys()].filter((key) =>
        key.startsWith("/srv/m12/workspace/"),
      ),
    ).toEqual([])
  })

  it("unlinks a partially written marker before removing the directory", async () => {
    const fs = fakeWithRoots()
    fs.onWriteFile = (candidate) => {
      fs.entries.set(candidate, { kind: "file", content: '{"sche' })
      return new Error("EIO")
    }
    await expect(
      createOwnedRunDirectory(
        "/srv/m12/workspace",
        "workspaceRoot",
        fs.operations(),
      ),
    ).rejects.toThrow(/the directory was removed/)
    expect(fs.unlinked).toHaveLength(1)
    expect(fs.removed).toHaveLength(1)
  })

  it.each([
    [
      "the directory was replaced (inode changed)",
      (fs: FakeFs, candidate: string) => {
        fs.dir(path.posix.dirname(candidate))
      },
    ],
    [
      "the directory was swapped for a symlink",
      (fs: FakeFs, candidate: string) => {
        fs.entries.set(path.posix.dirname(candidate), {
          kind: "symlink",
          target: "/run/peephole/user-env",
        })
      },
    ],
    [
      "an unexpected entry appeared inside",
      (fs: FakeFs, candidate: string) => {
        fs.entries.set(`${path.posix.dirname(candidate)}/other`, {
          kind: "file",
          content: "x",
        })
      },
    ],
  ])("preserves and reports the exact path when %s", async (_label, tamper) => {
    const fs = fakeWithRoots()
    fs.onWriteFile = (candidate) => {
      tamper(fs, candidate)
      return new Error("EIO")
    }
    const error = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    ).catch((caught: unknown) => caught as Error & { preservedPath?: string })
    expect(error.message).toMatch(
      /preserved for manual review: \/srv\/m12\/workspace\/peephole-m12-workspaceRoot-/,
    )
    expect(error.preservedPath).toMatch(
      /^\/srv\/m12\/workspace\/peephole-m12-workspaceRoot-/,
    )
    expect(fs.removed).toEqual([])
  })

  it("preserves and reports the path when the rollback itself fails", async () => {
    const fs = fakeWithRoots()
    fs.onWriteFile = () => new Error("ENOSPC")
    fs.failRmdir = true
    const error = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      fs.operations(),
    ).catch((caught: unknown) => caught as Error & { preservedPath?: string })
    expect(error.message).toMatch(/preserved for manual review/)
    expect(error.preservedPath).toBeDefined()
  })

  it("reports a created path whose canonical form escapes the root, without touching it", async () => {
    const fs = fakeWithRoots()
    const operations = {
      ...fs.operations(),
      realpath: async (candidate: string) =>
        candidate.includes("peephole-m12-")
          ? "/run/peephole/user-env/x"
          : candidate,
    }
    const error = await createOwnedRunDirectory(
      "/srv/m12/workspace",
      "workspaceRoot",
      operations,
    ).catch((caught: unknown) => caught as Error & { preservedPath?: string })
    expect(error.preservedPath).toMatch(
      /^\/srv\/m12\/workspace\/peephole-m12-workspaceRoot-/,
    )
    expect(fs.removed).toEqual([])
  })

  it("a run-set rollback reports any directory it had to preserve", async () => {
    const fs = fakeWithRoots()
    const operations = fs.operations()
    const config = await readM12HarnessConfig(validRoots, operations)
    let writes = 0
    fs.onWriteFile = () => {
      writes += 1
      if (writes === 2) {
        fs.failRmdir = true
        return new Error("ENOSPC")
      }
      return undefined
    }
    const error = await createOwnedRunSet(config, operations).catch(
      (caught: unknown) =>
        caught as Error & { preservedRunDirectories?: string[] },
    )
    expect(error.preservedRunDirectories?.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------- Finding 4

describe("Finding 4: production host detection covers the documented locations", () => {
  function inspection(present: Record<string, string[] | true>) {
    const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    return {
      lstat: async (candidate: string) => {
        if (candidate in present) return {}
        throw enoent()
      },
      readdir: async (candidate: string) => {
        const listing = present[candidate]
        if (Array.isArray(listing)) return listing
        throw enoent()
      },
    }
  }

  it.each([
    "/etc/peephole",
    "/var/lib/peephole",
    "/var/lib/peephole/jobs",
    "/run/peephole/secrets",
    "/var/run/peephole/runsc",
  ])("detects the fixed marker %s", async (marker) => {
    expect(
      await findProductionHostMarkers(inspection({ [marker]: true })),
    ).toContain(marker)
  })

  it.each([
    ["/etc/systemd/system", "peephole.service"],
    ["/etc/systemd/system", "peephole-staging.service"],
    ["/etc/systemd/system", "peephole.service.d"],
    ["/usr/lib/systemd/system", "peephole.service"],
    ["/lib/systemd/system", "peephole-tenant-network.service"],
    ["/run/systemd/system", "peephole.timer"],
    ["/usr/local/lib/systemd/system", "peephole.service"],
  ])("detects %s/%s by a bounded listing", async (directory, entry) => {
    expect(
      await findProductionHostMarkers(
        inspection({ [directory]: ["sshd.service", entry] }),
      ),
    ).toEqual([`${directory}/${entry}`])
  })

  it("detects an enablement link under a .wants directory", async () => {
    expect(
      await findProductionHostMarkers(
        inspection({
          "/etc/systemd/system": ["multi-user.target.wants"],
          "/etc/systemd/system/multi-user.target.wants": [
            "ssh.service",
            "peephole.service",
          ],
        }),
      ),
    ).toEqual(["/etc/systemd/system/multi-user.target.wants/peephole.service"])
  })

  it("fails closed when a unit directory cannot be listed or is too large", async () => {
    const unreadable = {
      lstat: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      },
      readdir: async (candidate: string) => {
        if (candidate === "/etc/systemd/system") {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" })
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      },
    }
    expect(await findProductionHostMarkers(unreadable)).toEqual([
      "/etc/systemd/system",
    ])
    const huge = inspection({
      "/etc/systemd/system": Array.from(
        { length: 5_000 },
        (_, index) => `unit-${String(index)}.service`,
      ),
    })
    expect(await findProductionHostMarkers(huge)).toEqual([
      "/etc/systemd/system",
    ])
  })

  it("reports nothing on a clean host", async () => {
    expect(
      await findProductionHostMarkers(
        inspection({
          "/etc/systemd/system": ["sshd.service"],
          "/lib/systemd/system": [],
        }),
      ),
    ).toEqual([])
  })
})
