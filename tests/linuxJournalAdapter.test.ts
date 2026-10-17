import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(),
}))
vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: vi.fn(),
}))
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  lstat: mocks.lstat,
  realpath: mocks.realpath,
  readFile: mocks.readFile,
}))

import {
  journalIdentity,
  JOURNAL_MAX_BYTES,
  type JournalScope,
} from "./support/isolatedJournalVerification"
import {
  findProductionHostMarkers,
  SYSTEMD_UNIT_DIRECTORIES,
  type HostMarkerInspection,
} from "./support/m12RealGvisorHarness"
import {
  collectLinuxJournal,
  inspectLinuxJournalSource,
  inspectOwnedJournalPath,
  M12_JOURNAL_CONFIG,
} from "./support/runM12JournalVerification"

const scope: JournalScope = {
  runId: "a".repeat(32),
  machineId: "b".repeat(32),
  bootId: "c".repeat(32),
  invocationId: "d".repeat(32),
  pid: 42,
}
const identity = journalIdentity(scope)
const transientFragment = `/run/systemd/transient/${identity.unit}`
const stats = {
  uid: 0,
  mode: 0o700,
  dev: 1,
  ino: 2,
  size: 100,
  isSymbolicLink: () => false,
  isDirectory: () => true,
  isFile: () => true,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.lstat.mockResolvedValue(stats)
  mocks.realpath.mockImplementation(async (p) => p)
  mocks.readFile.mockResolvedValue(M12_JOURNAL_CONFIG)
  mocks.execFile.mockImplementation((binary, args, options, callback) => {
    let output = Buffer.alloc(0)
    if (binary === "/usr/bin/systemd-analyze")
      output = Buffer.from(`# trusted source\n${M12_JOURNAL_CONFIG}`)
    if (binary === "/usr/bin/systemctl")
      output = Buffer.from(
        [
          `LogNamespace=${identity.namespace}`,
          `InvocationID=${scope.invocationId}`,
          "MainPID=42",
          "ActiveState=active",
          "StandardOutput=journal",
          "StandardError=journal",
          "LogRateLimitIntervalUSec=0",
          "LogRateLimitBurst=0",
          "Transient=yes",
          `FragmentPath=${transientFragment}`,
          "DropInPaths=",
          "",
        ].join("\n"),
      )
    callback(null, output, Buffer.alloc(0))
  })
})

describe("Linux journal command adapter (mocked, NO native commands)", () => {
  it("reads only the exact named namespace, synchronizes first, and never filters/tails fields", async () => {
    await collectLinuxJournal(identity.namespace)
    expect(mocks.execFile.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["/usr/bin/journalctl", [`--namespace=${identity.namespace}`, "--sync"]],
      [
        "/usr/bin/journalctl",
        [
          `--namespace=${identity.namespace}`,
          "--no-pager",
          "--output=json",
          "--all",
        ],
      ],
    ])
    expect(
      mocks.execFile.mock.calls.every(
        (call) =>
          call[2].maxBuffer === JOURNAL_MAX_BYTES && call[2].timeout === 10_000,
      ),
    ).toBe(true)
  })

  it.each(["", "*", "+default", "../other", "default", "peephole-m12-evil"])(
    "refuses unsafe namespace %s before any command",
    async (namespace) => {
      await expect(collectLinuxJournal(namespace)).rejects.toThrow(
        "NAMESPACE_INVALID",
      )
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
  )

  it.each(["nonzero exit", "timeout", "maxBuffer", "stderr"])(
    "does not treat %s as a complete collection",
    async (kind) => {
      mocks.execFile.mockImplementation((binary, args, options, callback) => {
        callback(
          kind === "stderr"
            ? null
            : Object.assign(new Error("unsafe raw child error"), {
                code: kind,
              }),
          Buffer.from("unsafe raw output"),
          Buffer.from(kind === "stderr" ? "warning" : ""),
        )
      })
      await expect(collectLinuxJournal(identity.namespace)).rejects.toThrow(
        "ISOLATED_JOURNAL_COMMAND_INCOMPLETE",
      )
      expect(mocks.execFile).toHaveBeenCalledTimes(1)
    },
  )

  it("proves filesystem ownership and the test unit's current namespace/invocation/output binding", async () => {
    expect(await inspectLinuxJournalSource(scope)).toMatchObject({
      namespace: identity.namespace,
      directory: identity.directory,
      owned: true,
      invocationId: scope.invocationId,
      mainPid: 42,
    })
    const serialized = JSON.stringify(mocks.execFile.mock.calls)
    expect(serialized.includes("Environment")).toBe(false)
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith(
      `/etc/systemd/journald@${identity.namespace}.conf`,
      "utf8",
    )
  })

  it.each([
    "relative",
    "normalized",
    "alias",
    "symlink",
    "not root",
    "writable",
    "unreadable",
    "wrong kind",
  ])("rejects %s source paths", async (kind) => {
    let candidate = identity.directory
    if (kind === "relative") candidate = "relative"
    if (kind === "normalized") candidate += "/../other"
    if (kind === "alias") mocks.realpath.mockResolvedValue("/other")
    if (kind === "symlink")
      mocks.lstat.mockResolvedValue({ ...stats, isSymbolicLink: () => true })
    if (kind === "not root")
      mocks.lstat.mockResolvedValue({ ...stats, uid: 1000 })
    if (kind === "writable")
      mocks.lstat.mockResolvedValue({ ...stats, mode: 0o777 })
    if (kind === "unreadable")
      mocks.lstat.mockRejectedValue(new Error("unreadable"))
    if (kind === "wrong kind")
      mocks.lstat.mockResolvedValue({ ...stats, isDirectory: () => false })
    await expect(inspectOwnedJournalPath(candidate, true)).rejects.toThrow()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it("refuses an altered config and an effective drop-in override", async () => {
    mocks.readFile.mockResolvedValue(M12_JOURNAL_CONFIG + "RateLimitBurst=1\n")
    await expect(inspectLinuxJournalSource(scope)).rejects.toThrow(
      "CONFIG_INVALID",
    )
    expect(mocks.execFile).not.toHaveBeenCalled()
    mocks.readFile.mockResolvedValue(M12_JOURNAL_CONFIG)
    mocks.execFile.mockImplementation((binary, args, options, callback) =>
      callback(
        null,
        Buffer.from(M12_JOURNAL_CONFIG + "RateLimitBurst=1\n"),
        Buffer.alloc(0),
      ),
    )
    await expect(inspectLinuxJournalSource(scope)).rejects.toThrow(
      "EFFECTIVE_CONFIG_INVALID",
    )
  })
})

function systemctlShow(overrides: Record<string, string>) {
  const values: Record<string, string> = {
    LogNamespace: identity.namespace,
    InvocationID: scope.invocationId,
    MainPID: "42",
    ActiveState: "active",
    StandardOutput: "journal",
    StandardError: "journal",
    LogRateLimitIntervalUSec: "0",
    LogRateLimitBurst: "0",
    Transient: "yes",
    FragmentPath: transientFragment,
    DropInPaths: "",
    ...overrides,
  }
  mocks.execFile.mockImplementation((binary, args, options, callback) => {
    let output = Buffer.alloc(0)
    if (binary === "/usr/bin/systemd-analyze")
      output = Buffer.from(M12_JOURNAL_CONFIG)
    if (binary === "/usr/bin/systemctl")
      output = Buffer.from(
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n") + "\n",
      )
    callback(null, output, Buffer.alloc(0))
  })
}

describe("journal test unit vs the unchanged Production-host guard", () => {
  function listing(
    entries: Record<string, string[] | undefined>,
  ): HostMarkerInspection {
    const missing = () =>
      Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    return {
      lstat: missing,
      readdir: (candidate: string) => {
        const found = entries[candidate]
        return found ? Promise.resolve(found) : missing()
      },
    }
  }

  it.each(SYSTEMD_UNIT_DIRECTORIES)(
    "a persistent test unit file in %s is still refused as a Production marker",
    async (directory) => {
      expect(
        await findProductionHostMarkers(
          listing({ [directory]: [identity.unit] }),
        ),
      ).toEqual([`${directory}/${identity.unit}`])
    },
  )

  it("a persistent drop-in or enablement link for the test unit is still refused", async () => {
    expect(
      await findProductionHostMarkers(
        listing({
          "/etc/systemd/system": [
            `${identity.unit}.d`,
            "multi-user.target.wants",
          ],
          "/etc/systemd/system/multi-user.target.wants": [identity.unit],
        }),
      ),
    ).toEqual([
      `/etc/systemd/system/${identity.unit}.d`,
      `/etc/systemd/system/multi-user.target.wants/${identity.unit}`,
    ])
  })

  it("the guard never lists systemd's transient or runtime control directories", () => {
    for (const directory of [
      "/run/systemd/transient",
      "/run/systemd/system.control",
      "/etc/systemd/system.control",
    ])
      expect(SYSTEMD_UNIT_DIRECTORIES).not.toContain(directory)
  })

  it("a transient test unit alone does not trip the guard", async () => {
    expect(
      await findProductionHostMarkers(
        listing({
          "/run/systemd/transient": [identity.unit],
          "/etc/systemd/system": ["sshd.service"],
        }),
      ),
    ).toEqual([])
  })

  it("a transient test unit does not mask a real Production unit or state", async () => {
    const inspection = listing({
      "/run/systemd/transient": [identity.unit],
      "/etc/systemd/system": ["peephole.service"],
    })
    expect(await findProductionHostMarkers(inspection)).toEqual([
      "/etc/systemd/system/peephole.service",
    ])
    expect(
      await findProductionHostMarkers({
        ...inspection,
        lstat: (candidate: string) =>
          candidate === "/var/lib/peephole"
            ? Promise.resolve({})
            : inspection.lstat(candidate),
      }),
    ).toContain("/var/lib/peephole")
  })

  it("accepts only the root-owned systemd-run fragment for the exact unit", async () => {
    systemctlShow({})
    await expect(inspectLinuxJournalSource(scope)).resolves.toMatchObject({
      unit: identity.unit,
    })
    expect(mocks.lstat).toHaveBeenCalledWith(transientFragment)
  })

  it.each([
    ["not transient", { Transient: "no" }],
    ["unknown transient", { Transient: "" }],
    [
      "persistent fragment",
      { FragmentPath: `/etc/systemd/system/${identity.unit}` },
    ],
    [
      "other transient unit",
      { FragmentPath: "/run/systemd/transient/run-u1.service" },
    ],
    ["no fragment", { FragmentPath: "" }],
    [
      "drop-in",
      { DropInPaths: `/run/systemd/system.control/${identity.unit}.d/x.conf` },
    ],
  ])("refuses a %s test unit", async (_kind, overrides) => {
    systemctlShow(overrides)
    await expect(inspectLinuxJournalSource(scope)).rejects.toThrow(
      "ISOLATED_JOURNAL_UNIT_NOT_TRANSIENT",
    )
  })

  it.each(["not root", "writable", "symlink"])(
    "refuses a %s transient fragment",
    async (kind) => {
      systemctlShow({})
      mocks.lstat.mockImplementation(async (candidate: string) =>
        candidate === transientFragment
          ? {
              ...stats,
              uid: kind === "not root" ? 1000 : 0,
              mode: kind === "writable" ? 0o666 : 0o644,
              isSymbolicLink: () => kind === "symlink",
            }
          : stats,
      )
      await expect(inspectLinuxJournalSource(scope)).rejects.toThrow(
        "ISOLATED_JOURNAL_OWNERSHIP_INVALID",
      )
    },
  )
})
