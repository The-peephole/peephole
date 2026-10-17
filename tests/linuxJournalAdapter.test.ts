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
