import { afterEach, describe, expect, it, vi } from "vitest"

import {
  journalIdentity,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_RECORDS,
  M12_JOURNAL_SENTINELS,
  M12_JOURNAL_TEST_FILTER,
  verifyIsolatedJournalRun,
  type JournalIO,
  type JournalScope,
  type JournalSource,
} from "./support/isolatedJournalVerification"
import * as harness from "./support/m12RealGvisorHarness"

const scope: JournalScope = {
  runId: "a".repeat(32),
  machineId: "b".repeat(32),
  bootId: "c".repeat(32),
  invocationId: "d".repeat(32),
  pid: 123,
}
const identity = journalIdentity(scope)
const source: JournalSource = {
  ...identity,
  invocationId: scope.invocationId,
  mainPid: scope.pid,
  active: true,
  stdout: "journal",
  stderr: "journal",
  owned: true,
  rateLimitInterval: "0",
  rateLimitBurst: "0",
  device: 1,
  inode: 2,
}
function fixture() {
  const entries: Array<Record<string, unknown>> = []
  const append = (message: string, extra: Record<string, unknown> = {}) => {
    entries.push({
      _NAMESPACE: identity.namespace,
      _MACHINE_ID: scope.machineId,
      _BOOT_ID: scope.bootId,
      _SYSTEMD_UNIT: identity.unit,
      _SYSTEMD_INVOCATION_ID: scope.invocationId,
      _PID: String(scope.pid),
      MESSAGE: message,
      ...extra,
    })
  }
  const io: JournalIO = {
    inspect: vi.fn(async () => source),
    writeMarker: vi.fn(async (message) => append(message)),
    collect: vi.fn(async () =>
      Buffer.from(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      ),
    ),
  }
  const scenario = vi.fn(async () => {
    append("scenario and cleanup completed")
    return 0
  })
  return { io, entries, append, scenario }
}

function entryAt(entries: Array<Record<string, unknown>>, index: number) {
  const entry = entries[index]
  if (!entry) throw new Error("TEST_ENTRY_MISSING")
  return entry
}

afterEach(() => vi.restoreAllMocks())

describe("isolated journal verification (portable inputs, not Linux evidence)", () => {
  it("requires an observed control, nonempty scenario, and complete scope for PASS", async () => {
    const f = fixture()
    const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
    expect(result).toMatchObject({
      status: "PASS",
      records: 4,
      scenarioRecords: 1,
      complete: true,
      positiveControl: true,
      scenarioPassed: true,
    })
    expect(f.io.collect).toHaveBeenCalledExactlyOnceWith(identity.namespace)
  })

  it.each(["plain", "escaped", "binary", "repeated", "metadata"])(
    "detects a sentinel in %s journal fields",
    async (encoding) => {
      const f = fixture()
      f.scenario.mockImplementation(async () => {
        const sentinel = M12_JOURNAL_SENTINELS[0]
        f.append(
          "runtime output",
          encoding === "metadata"
            ? { EXTRA: sentinel }
            : {
                MESSAGE:
                  encoding === "binary"
                    ? [...Buffer.from(sentinel)]
                    : encoding === "repeated"
                      ? ["safe", sentinel]
                      : sentinel,
              },
        )
        return 0
      })
      const collect = f.io.collect
      if (encoding === "escaped")
        f.io.collect = async (namespace) => {
          const bytes = await collect(namespace)
          return Buffer.from(
            bytes.toString().replaceAll("PEEPHOLE_E2E", "\\u0050EEPHOLE_E2E"),
          )
        }
      const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
      expect(result.status).toBe("FAIL")
      expect(JSON.stringify(result).includes(M12_JOURNAL_SENTINELS[0])).toBe(
        false,
      )
    },
  )

  it.each(["read error", "timeout", "stderr warning", "buffer limit"])(
    "fails closed on collector %s",
    async () => {
      const f = fixture()
      f.io.collect = async () => {
        throw new Error("untrusted raw output")
      }
      const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
      expect(result.status).toBe("INCOMPLETE")
      expect(result.complete).toBe(false)
      expect(JSON.stringify(result).includes("untrusted")).toBe(false)
    },
  )

  it.each([
    "empty",
    "oversized",
    "record bound",
    "partial line",
    "malformed",
    "null field",
    "line split",
    "missing end",
    "missing control",
    "duplicate control",
    "wrong order",
    "empty scenario",
  ])("does not PASS %s input", async (kind) => {
    const f = fixture()
    const original = f.io.collect
    f.io.collect = async (namespace) => {
      if (kind === "empty") return Buffer.alloc(0)
      if (kind === "oversized") return Buffer.alloc(JOURNAL_MAX_BYTES + 1)
      if (kind === "record bound")
        return Buffer.from("{}\n".repeat(JOURNAL_MAX_RECORDS + 1))
      if (kind === "missing end") f.entries.pop()
      if (kind === "missing control") f.entries.splice(1, 1)
      if (kind === "duplicate control")
        f.entries.splice(1, 0, { ...f.entries[1] })
      if (kind === "wrong order")
        [f.entries[0], f.entries[1]] = [
          entryAt(f.entries, 1),
          entryAt(f.entries, 0),
        ]
      if (kind === "empty scenario") f.entries.splice(2, 1)
      if (kind === "null field") entryAt(f.entries, 2).EXTRA = null
      if (kind === "line split") entryAt(f.entries, 2)._LINE_BREAK = "line-max"
      const data = await original(namespace)
      if (kind === "partial line") return data.subarray(0, -1)
      if (kind === "malformed")
        return Buffer.concat([data, Buffer.from("not json\n")])
      return data
    }
    expect(
      (await verifyIsolatedJournalRun(scope, f.scenario, f.io)).status,
    ).toBe("INCOMPLETE")
  })

  it.each([
    "directory",
    "namespace",
    "unit",
    "invocationId",
    "mainPid",
    "active",
    "stdout",
    "stderr",
    "owned",
    "rateLimitInterval",
    "rateLimitBurst",
  ])("rejects an unproven source %s before running a scenario", async (key) => {
    const f = fixture()
    f.io.inspect = async () => ({
      ...source,
      [key]:
        typeof source[key as keyof JournalSource] === "boolean"
          ? false
          : "invalid",
    })
    expect(
      (await verifyIsolatedJournalRun(scope, f.scenario, f.io)).status,
    ).toBe("INCOMPLETE")
    expect(f.scenario).not.toHaveBeenCalled()
    expect(f.io.collect).not.toHaveBeenCalled()
    expect(f.io.writeMarker).not.toHaveBeenCalled()
  })

  it.each([
    "_NAMESPACE",
    "_MACHINE_ID",
    "_BOOT_ID",
    "_SYSTEMD_INVOCATION_ID",
    "_PID",
  ])("does not trust control records with incorrect %s", async (key) => {
    const f = fixture()
    const collect = f.io.collect
    f.io.collect = async (namespace) => {
      entryAt(f.entries, 1)[key] = "other"
      return collect(namespace)
    }
    expect(
      (await verifyIsolatedJournalRun(scope, f.scenario, f.io)).status,
    ).toBe("INCOMPLETE")
  })

  it("does not trust source ownership changes during collection", async () => {
    const f = fixture()
    f.io.inspect = vi
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, inode: 999 })
    expect(
      (await verifyIsolatedJournalRun(scope, f.scenario, f.io)).status,
    ).toBe("INCOMPLETE")
  })

  it("reports INCOMPLETE when the scan deadline expires", async () => {
    const f = fixture()
    f.io.now = vi.fn().mockReturnValueOnce(0).mockReturnValue(30_001)
    expect(
      (await verifyIsolatedJournalRun(scope, f.scenario, f.io)).status,
    ).toBe("INCOMPLETE")
  })

  it("requires the reused scanner to actually detect the observed positive control", async () => {
    vi.spyOn(harness, "scanFileForRawValueStatus").mockResolvedValue("PASS")
    const f = fixture()
    const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
    expect(result.status).toBe("INCOMPLETE")
    expect(result.positiveControl).toBe(false)
  })

  it("preserves FAIL when a leak coexists with incomplete input", async () => {
    const f = fixture()
    f.scenario.mockImplementation(async () => {
      f.append(M12_JOURNAL_SENTINELS[1], { EXTRA: null })
      return 0
    })
    const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
    expect(result.status).toBe("FAIL")
    expect(result.complete).toBe(false)
  })

  it("collects after failed scenario and independent cleanup, without swallowing lifecycle failure", async () => {
    const f = fixture()
    const order: string[] = []
    f.scenario.mockImplementation(async () => {
      await harness.runWithOwnedCleanup(async () => {
        order.push("scenario")
        throw new Error("unsafe")
      }, [
        async () => {
          order.push("cleanup1")
          f.append(M12_JOURNAL_SENTINELS[0])
          throw new Error("unsafe")
        },
        async () => {
          order.push("cleanup2")
          f.append("last cleanup")
        },
      ])
      return 0
    })
    const collect = f.io.collect
    f.io.collect = async (namespace) => {
      order.push("collect")
      return collect(namespace)
    }
    const result = await verifyIsolatedJournalRun(scope, f.scenario, f.io)
    expect(order).toEqual(["scenario", "cleanup1", "cleanup2", "collect"])
    expect(result.status).toBe("FAIL")
    expect(result.scenarioPassed).toBe(false)
  })

  it("keeps a lifecycle failure separate from a clean journal scan", async () => {
    const f = fixture()
    f.scenario.mockImplementation(async () => {
      f.append("safe failure code")
      return 1
    })
    expect(
      await verifyIsolatedJournalRun(scope, f.scenario, f.io),
    ).toMatchObject({ status: "PASS", scenarioPassed: false })
  })

  it.each(["", "*", "+default", "../other", "A".repeat(32)])(
    "rejects an invalid run identity without journal access",
    async (runId) => {
      const f = fixture()
      expect(
        (await verifyIsolatedJournalRun({ ...scope, runId }, f.scenario, f.io))
          .status,
      ).toBe("INCOMPLETE")
      expect(f.io.inspect).not.toHaveBeenCalled()
    },
  )

  it("selects all six existing G cases, G6, and H2/H3 without adding a crash scenario", () => {
    const filter = new RegExp(M12_JOURNAL_TEST_FILTER)
    expect(
      [
        "G1:",
        "G2:",
        "G3: empty",
        "G3: malformed",
        "G4:",
        "G5:",
        "G6:",
        "H2/H3:",
      ].every((name) => filter.test(name)),
    ).toBe(true)
    expect(filter.test("E1:")).toBe(false)
  })
})
