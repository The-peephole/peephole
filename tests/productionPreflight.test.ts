import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  ensureDatabaseCredentialCapability,
  ensureProductionPreflight,
  ensureProductionDiskLayout,
  ensureGeneratedSecretInjectionCapability,
  ensureSandboxDiskCapability,
  runProductionPreflightChecks,
} from "../services/production/preflight"
import type { RootfsEntry } from "../services/production/preflight"
import type {
  ProcessRunner,
  ProcessRunResult,
} from "../services/preview-worker/gvisor/processRunner"

class FakeProcessRunner implements ProcessRunner {
  constructor(
    private readonly responses: Record<
      string,
      ProcessRunResult | "reject"
    > = {},
  ) {}

  async run(command: string): Promise<ProcessRunResult> {
    const response = this.responses[command]

    if (response === "reject" || response === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
      })
    }

    return response
  }
}

function ok(stdout: string): ProcessRunResult {
  return { exitCode: 0, timedOut: false, stdout, stderr: "" }
}

const HEALTHY_FILES: Record<string, string> = {
  "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
  "/proc/sys/net/ipv4/ip_forward": "1\n",
  "/etc/resolv.conf": "nameserver 10.255.255.254\n",
}

const HEALTHY_EXISTS = new Set([
  "/sys/fs/cgroup/cgroup.controllers",
  "/var/lib/peephole/base-rootfs/usr/local/bin/node",
])

const ROOTFS = "/var/lib/peephole/base-rootfs"

/** The layout scripts/gvisor/build-base-rootfs.sh produces. */
function healthyRootfsEntries(): Map<string, RootfsEntry> {
  const directory: RootfsEntry = {
    kind: "directory",
    size: 4096,
    uid: 0,
    mode: 0o755,
  }
  return new Map<string, RootfsEntry>([
    [`${ROOTFS}/run`, directory],
    [`${ROOTFS}/run/secrets`, directory],
    [
      `${ROOTFS}/run/secrets/env`,
      { kind: "file", size: 0, uid: 0, mode: 0o644 },
    ],
    [
      `${ROOTFS}/run/secrets/database-url`,
      { kind: "file", size: 0, uid: 0, mode: 0o644 },
    ],
    [`${ROOTFS}/opt`, directory],
    [`${ROOTFS}/opt/peephole`, directory],
    [
      `${ROOTFS}/opt/peephole/secret-bootstrap.mjs`,
      { kind: "file", size: 2048, uid: 0, mode: 0o555 },
    ],
  ])
}

function healthyOptions(entries = healthyRootfsEntries()) {
  return {
    baseRootfsImage: ROOTFS,
    inspectRootfsEntry: async (candidate: string) =>
      entries.get(candidate) ?? null,
    processRunner: new FakeProcessRunner({
      runsc: ok("runsc version release-20260817.0"),
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
      fallocate: ok("fallocate from util-linux"),
      "mkfs.ext4": ok("mke2fs 1.47"),
      mount: ok("mount from util-linux"),
      umount: ok("umount from util-linux"),
      losetup: ok("losetup from util-linux"),
      findmnt: ok("findmnt from util-linux"),
    }),
    readFile: (path: string) => HEALTHY_FILES[path] ?? null,
    pathExists: async (path: string) => HEALTHY_EXISTS.has(path),
  }
}

describe("runProductionPreflightChecks", () => {
  it("reports every check ok on a healthy host", async () => {
    const results = await runProductionPreflightChecks(healthyOptions())

    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => result.name)).toEqual([
      "runsc",
      "ip",
      "iptables",
      "ip6tables",
      "fallocate",
      "mkfs.ext4",
      "mount",
      "umount",
      "losetup",
      "findmnt",
      "cgroup v2",
      "net.ipv4.ip_forward",
      "base rootfs image",
      "base rootfs secret contract",
      "DNS config source",
    ])
  })

  it("fails the runsc check when the binary is not on PATH", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
    })

    const results = await runProductionPreflightChecks(options)
    const runsc = results.find((result) => result.name === "runsc")

    expect(runsc?.ok).toBe(false)
    expect(runsc?.detail).toMatch(/not runnable on PATH/)
  })

  it("fails closed before accepting jobs when ip6tables is unavailable", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      runsc: ok("runsc version release-20260817.0"),
      ip: ok("ip utility, iproute2-6.19.0"),
      iptables: ok("iptables v1.8.11 (nf_tables)"),
    })

    const results = await runProductionPreflightChecks(options)
    const ip6tables = results.find((result) => result.name === "ip6tables")

    expect(ip6tables?.ok).toBe(false)
    expect(ip6tables?.detail).toMatch(/not runnable on PATH/)
  })

  it("fails the ip_forward check when it reads 0", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) =>
      path === "/proc/sys/net/ipv4/ip_forward"
        ? "0\n"
        : (HEALTHY_FILES[path] ?? null)

    const results = await runProductionPreflightChecks(options)
    const ipForward = results.find(
      (result) => result.name === "net.ipv4.ip_forward",
    )

    expect(ipForward?.ok).toBe(false)
    expect(ipForward?.detail).toMatch(/sysctl -w net\.ipv4\.ip_forward=1/)
  })

  it("fails the cgroup v2 check when the unified hierarchy marker is missing", async () => {
    const options = healthyOptions()
    options.pathExists = async (path: string) =>
      path !== "/sys/fs/cgroup/cgroup.controllers" && HEALTHY_EXISTS.has(path)

    const results = await runProductionPreflightChecks(options)
    const cgroup = results.find((result) => result.name === "cgroup v2")

    expect(cgroup?.ok).toBe(false)
  })

  it("fails the base rootfs check when the image is missing node", async () => {
    const options = healthyOptions()
    options.pathExists = async (path: string) =>
      path === "/sys/fs/cgroup/cgroup.controllers"

    const results = await runProductionPreflightChecks(options)
    const rootfs = results.find((result) => result.name === "base rootfs image")

    expect(rootfs?.ok).toBe(false)
    expect(rootfs?.detail).toMatch(/base-rootfs\.sh/)
  })

  it("fails the DNS check when resolv.conf resolves to a loopback-only stub with no usable uplink", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) =>
      path === "/etc/resolv.conf"
        ? "nameserver 127.0.0.53\n"
        : (HEALTHY_FILES[path] ?? null)

    const results = await runProductionPreflightChecks(options)
    const dns = results.find((result) => result.name === "DNS config source")

    expect(dns?.ok).toBe(false)
    expect(dns?.detail).toMatch(/no usable/)
  })

  it("passes the DNS check when the systemd-resolved uplink file is usable", async () => {
    const options = healthyOptions()
    options.readFile = (path: string) => {
      if (path === "/etc/resolv.conf") return "nameserver 127.0.0.53\n"
      if (path === "/run/systemd/resolve/resolv.conf")
        return "nameserver 172.31.0.2\n"
      return HEALTHY_FILES[path] ?? null
    }

    const results = await runProductionPreflightChecks(options)
    const dns = results.find((result) => result.name === "DNS config source")

    expect(dns?.ok).toBe(true)
    expect(dns?.detail).toMatch(/run\/systemd\/resolve\/resolv\.conf/)
  })
})

describe("ensureProductionPreflight", () => {
  it("resolves without throwing on a healthy host", async () => {
    await expect(
      ensureProductionPreflight(healthyOptions()),
    ).resolves.toBeUndefined()
  })

  it("throws one error listing every failed check", async () => {
    const options = healthyOptions()
    options.processRunner = new FakeProcessRunner({
      iptables: ok("iptables v1.8.11 (nf_tables)"),
      ip6tables: ok("ip6tables v1.8.11 (nf_tables)"),
    })
    options.readFile = (path: string) =>
      path === "/proc/sys/net/ipv4/ip_forward" ? "0\n" : null

    await expect(ensureProductionPreflight(options)).rejects.toThrow(
      /runsc[\s\S]*ip[\s\S]*net\.ipv4\.ip_forward[\s\S]*DNS config source/,
    )
  })
})

describe("ensureSandboxDiskCapability", () => {
  it("fails closed when the post-reconciliation loop/ext4 probe fails", async () => {
    const unusedManager = {} as Parameters<
      typeof ensureSandboxDiskCapability
    >[0]
    await expect(
      ensureSandboxDiskCapability(unusedManager, async () => {
        throw new Error("mount denied")
      }),
    ).rejects.toThrow(/hard-quota capability probe failed.*mount denied/)
  })
})

describe("ensureProductionDiskLayout", () => {
  it("requires artifact publication to share the admission filesystem", async () => {
    const prepared: string[] = []
    await expect(
      ensureProductionDiskLayout({
        bundlesRootDir: "/jobs",
        artifactStorageDir: "/artifacts",
        prepareDirectory: async (candidate) => {
          prepared.push(candidate)
        },
        deviceFor: async (candidate) => (candidate === "/jobs" ? 1 : 2),
      }),
    ).rejects.toThrow(/must share a filesystem/)
    expect(prepared).toEqual(["/jobs", "/artifacts"])
  })

  it("accepts a shared bundles/artifact filesystem", async () => {
    await expect(
      ensureProductionDiskLayout({
        bundlesRootDir: "/jobs",
        artifactStorageDir: "/artifacts",
        prepareDirectory: async () => undefined,
        deviceFor: async () => 7,
      }),
    ).resolves.toBeUndefined()
  })
})

describe("base rootfs secret contract", () => {
  async function contractResult(
    mutate: (entries: Map<string, RootfsEntry>) => void,
  ) {
    const entries = healthyRootfsEntries()
    mutate(entries)
    const results = await runProductionPreflightChecks(healthyOptions(entries))
    return results.find(
      (result) => result.name === "base rootfs secret contract",
    )
  }

  const file = (overrides: Partial<RootfsEntry> = {}): RootfsEntry => ({
    kind: "file",
    size: 0,
    uid: 0,
    mode: 0o644,
    ...overrides,
  })

  it("accepts the layout the current rootfs builder produces", async () => {
    expect(await contractResult(() => undefined)).toMatchObject({ ok: true })
  })

  it("rejects a pre-M11-C3 image with neither placeholder, independent of temporary databases", async () => {
    const result = await contractResult((entries) => {
      entries.delete(`${ROOTFS}/run/secrets/env`)
      entries.delete(`${ROOTFS}/run/secrets/database-url`)
    })

    expect(result?.ok).toBe(false)
    expect(result?.detail).toMatch(/run\/secrets\/env is missing/)
    expect(result?.detail).toMatch(/run\/secrets\/database-url is missing/)
    expect(result?.detail).toMatch(/build-base-rootfs\.sh/)
  })

  it.each(["env", "database-url"])(
    "rejects each defect of the %s placeholder",
    async (name) => {
      const target = `${ROOTFS}/run/secrets/${name}`
      for (const [entry, pattern] of [
        [null, /is missing/],
        [file({ kind: "directory" }), /is a directory/],
        [file({ kind: "symlink" }), /is a symlink/],
        [file({ size: 1 }), /is not empty/],
        [file({ mode: 0o600 }), /has mode 600, not 644/],
        [file({ uid: 1000 }), /is not root-owned/],
      ] as const) {
        const result = await contractResult((entries) => {
          if (entry) entries.set(target, entry)
          else entries.delete(target)
        })
        expect(result?.ok, `${name}: ${String(pattern)}`).toBe(false)
        expect(result?.detail).toMatch(pattern)
      }
    },
  )

  it("rejects a missing, non-file, symlinked, writable, or non-root bootstrap", async () => {
    const target = `${ROOTFS}/opt/peephole/secret-bootstrap.mjs`
    for (const [entry, pattern] of [
      [null, /is missing/],
      [file({ kind: "directory", mode: 0o555 }), /is a directory/],
      [file({ kind: "symlink", mode: 0o555 }), /is a symlink/],
      [file({ mode: 0o755 }), /has mode 755, not 555/],
      [file({ uid: 1000, mode: 0o555 }), /is not root-owned/],
    ] as const) {
      const result = await contractResult((entries) => {
        if (entry) entries.set(target, entry)
        else entries.delete(target)
      })
      expect(result?.ok, String(pattern)).toBe(false)
      expect(result?.detail).toMatch(pattern)
    }
  })

  it("rejects a symlinked /run/secrets directory", async () => {
    const result = await contractResult((entries) => {
      entries.set(`${ROOTFS}/run/secrets`, file({ kind: "symlink" }))
    })

    expect(result?.ok).toBe(false)
    expect(result?.detail).toMatch(/run\/secrets is a symlink/)
  })

  it("makes ensureProductionPreflight refuse startup on an old image", async () => {
    const entries = healthyRootfsEntries()
    entries.delete(`${ROOTFS}/run/secrets/database-url`)

    await expect(
      ensureProductionPreflight(healthyOptions(entries)),
    ).rejects.toThrow(/base rootfs secret contract/)
  })
})

describe("ensureDatabaseCredentialCapability", () => {
  it("rejects a non-absolute credential root", async () => {
    await expect(
      ensureDatabaseCredentialCapability({
        credentialRootDir: "relative/db-credentials",
      }),
    ).rejects.toThrow(/Database-credential root must be absolute/)
  })

  it("accepts only a tmpfs-backed directory", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-db-credential-preflight-"),
    )
    try {
      const root = path.join(temporaryDir, "db-credentials")
      await expect(
        ensureDatabaseCredentialCapability({
          credentialRootDir: root,
          processRunner: new FakeProcessRunner({ findmnt: ok("tmpfs\n") }),
        }),
      ).resolves.toBeUndefined()
      await expect(
        ensureDatabaseCredentialCapability({
          credentialRootDir: root,
          processRunner: new FakeProcessRunner({ findmnt: ok("ext4\n") }),
        }),
      ).rejects.toThrow(/not backed by tmpfs/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("rejects a credential root that is not a directory", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-db-credential-preflight-"),
    )
    try {
      const root = path.join(temporaryDir, "db-credentials")
      await writeFile(root, "not a directory")

      await expect(
        ensureDatabaseCredentialCapability({
          credentialRootDir: root,
          prepareDirectory: async () => undefined,
        }),
      ).rejects.toThrow(/Database-credential root must be a regular directory/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })
})

describe("ensureGeneratedSecretInjectionCapability", () => {
  it("rejects a non-absolute secret root", async () => {
    await expect(
      ensureGeneratedSecretInjectionCapability({
        secretRootDir: "relative/secrets",
        baseRootfsImage: path.resolve("rootfs"),
      }),
    ).rejects.toThrow(/must be absolute/)
  })

  it("accepts only a tmpfs-backed root with the trusted bootstrap in the base image", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      const root = path.join(temporaryDir, "secrets")
      const baseRootfsImage = path.join(temporaryDir, "rootfs")
      await mkdir(path.join(baseRootfsImage, "opt", "peephole"), {
        recursive: true,
      })
      await writeFile(
        path.join(baseRootfsImage, "opt", "peephole", "secret-bootstrap.mjs"),
        "trusted",
      )
      const processRunner = new FakeProcessRunner({
        findmnt: ok("tmpfs\n"),
      })

      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: root,
          baseRootfsImage,
          processRunner,
        }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("fails closed when findmnt reports persistent storage", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      const root = path.join(temporaryDir, "secrets")
      const baseRootfsImage = path.join(temporaryDir, "rootfs")
      await mkdir(path.join(baseRootfsImage, "opt", "peephole"), {
        recursive: true,
      })
      await writeFile(
        path.join(baseRootfsImage, "opt", "peephole", "secret-bootstrap.mjs"),
        "trusted",
      )

      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: root,
          baseRootfsImage,
          processRunner: new FakeProcessRunner({ findmnt: ok("ext4\n") }),
        }),
      ).rejects.toThrow(/not backed by tmpfs/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("fails closed when the configured root is not a directory", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      const root = path.join(temporaryDir, "secrets")
      await writeFile(root, "not a directory")

      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: root,
          baseRootfsImage: path.join(temporaryDir, "rootfs"),
          prepareDirectory: async () => undefined,
        }),
      ).rejects.toThrow(/regular directory/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("fails closed when the configured root is a symlink", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      const target = path.join(temporaryDir, "target")
      const root = path.join(temporaryDir, "secrets")
      await mkdir(target)
      await symlink(target, root, "junction")

      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: root,
          baseRootfsImage: path.join(temporaryDir, "rootfs"),
          prepareDirectory: async () => undefined,
        }),
      ).rejects.toThrow(/regular directory/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("fails closed when the configured root traverses a symlink", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      const targetParent = path.join(temporaryDir, "target")
      const linkedParent = path.join(temporaryDir, "linked")
      await mkdir(path.join(targetParent, "secrets"), { recursive: true })
      await symlink(targetParent, linkedParent, "junction")

      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: path.join(linkedParent, "secrets"),
          baseRootfsImage: path.join(temporaryDir, "rootfs"),
          prepareDirectory: async () => undefined,
        }),
      ).rejects.toThrow(/must not traverse symlinks/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })

  it("fails closed when the trusted bootstrap is missing", async () => {
    const temporaryDir = await mkdtemp(
      path.join(os.tmpdir(), "peephole-secret-preflight-"),
    )
    try {
      await expect(
        ensureGeneratedSecretInjectionCapability({
          secretRootDir: path.join(temporaryDir, "secrets"),
          baseRootfsImage: path.join(temporaryDir, "rootfs"),
          processRunner: new FakeProcessRunner({ findmnt: ok("tmpfs\n") }),
        }),
      ).rejects.toThrow(/bootstrap is missing/)
    } finally {
      await rm(temporaryDir, { recursive: true, force: true })
    }
  })
})
