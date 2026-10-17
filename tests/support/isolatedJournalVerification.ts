import { performance } from "node:perf_hooks"

import {
  combineScanStatuses,
  scanFileForRawValueStatus,
  type ScanStatus,
} from "./m12RealGvisorHarness"

// The same non-credential values delivered by realUserEnvironmentRuntime.
export const M12_JOURNAL_SENTINELS = [
  "PEEPHOLE_E2E_SYNTHETIC_VALUE_2026",
  "PEEPHOLE_E2E_SYNTHETIC_MODE_2026",
] as const
export const M12_JOURNAL_TEST_FILTER = "G[1-6]:|H2/H3:"
export const JOURNAL_MAX_BYTES = 4 * 1024 * 1024
export const JOURNAL_MAX_RECORDS = 10_000

export interface JournalScope {
  runId: string
  machineId: string
  bootId: string
  invocationId: string
  pid: number
}

export interface JournalSource {
  directory: string
  namespace: string
  unit: string
  invocationId: string
  mainPid: number
  active: boolean
  stdout: string
  stderr: string
  rateLimitInterval: string
  rateLimitBurst: string
  /** Linux adapter proves canonical, non-symlink, root-owned source/config. */
  owned: boolean
  device: number
  inode: number
}

export interface JournalIO {
  inspect(): Promise<JournalSource>
  /** Emits ONLY the three synthetic control/boundary records to the proven
   * isolated unit's journal stream, never a general console/evidence sink. */
  writeMarker(message: string): Promise<void>
  /** Must sync the named namespace, read ALL its records without filters,
   * and reject any timeout, stderr warning, nonzero exit or buffer overflow. */
  collect(namespace: string): Promise<Buffer>
  now?(): number
}

export interface JournalEvidence {
  status: ScanStatus
  scope: "G1-G6/H2-H3"
  runId: string
  records: number
  scenarioRecords: number
  bytes: number
  complete: boolean
  positiveControl: boolean
  scenarioPassed: boolean
}

export function journalIdentity(scope: JournalScope) {
  if (
    ![scope.runId, scope.machineId, scope.bootId, scope.invocationId].every(
      (value) => /^[a-f0-9]{32}$/.test(value),
    ) ||
    !Number.isSafeInteger(scope.pid) ||
    scope.pid <= 0
  )
    throw new Error("ISOLATED_JOURNAL_SCOPE_INVALID")
  const namespace = `peephole-m12-${scope.runId}`
  return {
    namespace,
    unit: `${namespace}.service`,
    directory: `/run/log/journal/${scope.machineId}.${namespace}`,
    begin: `M12_JOURNAL_BEGIN_${scope.runId}`,
    control: `M12_JOURNAL_CONTROL_${scope.runId}`,
    end: `M12_JOURNAL_END_${scope.runId}`,
  }
}

function validSource(scope: JournalScope, source: JournalSource): boolean {
  const identity = journalIdentity(scope)
  return (
    source.directory === identity.directory &&
    source.namespace === identity.namespace &&
    source.unit === identity.unit &&
    source.invocationId === scope.invocationId &&
    source.mainPid === scope.pid &&
    source.active &&
    source.stdout === "journal" &&
    source.stderr === "journal" &&
    source.rateLimitInterval === "0" &&
    source.rateLimitBurst === "0" &&
    source.owned &&
    Number.isSafeInteger(source.device) &&
    Number.isSafeInteger(source.inode) &&
    source.inode > 0
  )
}

/** Decode journalctl --output=json --all, including binary and repeated
 * fields. JSON escaping must not hide a value; null/truncation is incomplete. */
function fieldBytes(value: unknown): Buffer[] {
  if (typeof value === "string") return [Buffer.from(value, "utf8")]
  if (Array.isArray(value) && value.length > 0) {
    if (
      value.every(
        (byte) =>
          Number.isInteger(byte) &&
          (byte as number) >= 0 &&
          (byte as number) <= 255,
      )
    )
      return [Buffer.from(value as number[])]
    return value.flatMap(fieldBytes)
  }
  throw new Error("ISOLATED_JOURNAL_FIELD_INCOMPLETE")
}

async function scanBuffer(input: Buffer, value: string): Promise<ScanStatus> {
  // Reuse the required-file scanner; this reader returns a completely read,
  // bounded in-memory journal field, not a raw journal export on disk.
  return scanFileForRawValueStatus(
    "isolated-journal-field",
    value,
    async () => input,
  )
}

/** Test-only controller seam. `scenario` must await the entire existing Vitest
 * child (including reporters and all owned cleanup), not just the test body.
 * No journal output or underlying exceptions escape this boundary. */
export async function verifyIsolatedJournalRun(
  scope: JournalScope,
  scenario: () => Promise<number>,
  io: JournalIO,
): Promise<JournalEvidence> {
  const evidence: JournalEvidence = {
    status: "INCOMPLETE",
    scope: "G1-G6/H2-H3",
    runId: /^[a-f0-9]{32}$/.test(scope.runId) ? scope.runId : "INVALID",
    records: 0,
    scenarioRecords: 0,
    bytes: 0,
    complete: false,
    positiveControl: false,
    scenarioPassed: false,
  }
  const statuses: ScanStatus[] = []
  try {
    const identity = journalIdentity(scope)
    const before = await io.inspect()
    if (!validSource(scope, before)) return evidence
    await io.writeMarker(identity.begin)
    // Deliberate NON-CREDENTIAL positive control in this isolated input only.
    await io.writeMarker(identity.control)
    try {
      evidence.scenarioPassed = (await scenario()) === 0
    } catch {
      evidence.scenarioPassed = false
    }
    // Includes child stderr, ProcessRunner errors and the last cleanup/reporter
    // output, even when the child failed. End must be observed, never assumed.
    await io.writeMarker(identity.end)
    const now = io.now ?? (() => performance.now())
    const deadline = now() + 30_000
    const contents = await io.collect(identity.namespace)
    evidence.bytes = contents.length
    if (contents.length === 0 || contents.length > JOURNAL_MAX_BYTES)
      return evidence
    // Detect visible raw leaks even if another part of this input is malformed.
    for (const value of M12_JOURNAL_SENTINELS)
      statuses.push(await scanBuffer(contents, value))
    const after = await io.inspect()
    if (
      !validSource(scope, after) ||
      before.device !== after.device ||
      before.inode !== after.inode ||
      now() > deadline
    )
      throw new Error("ISOLATED_JOURNAL_SOURCE_CHANGED")
    if (!contents.subarray(-1).equals(Buffer.from("\n")))
      throw new Error("ISOLATED_JOURNAL_PARTIAL_RECORD")
    const lines = contents.toString("utf8").split("\n").slice(0, -1)
    if (lines.length === 0 || lines.length > JOURNAL_MAX_RECORDS)
      throw new Error("ISOLATED_JOURNAL_RECORD_BOUND")
    const markerIndexes = new Map<string, number[]>()
    for (const [index, line] of lines.entries()) {
      if (now() > deadline) throw new Error("ISOLATED_JOURNAL_SCAN_DEADLINE")
      let entry: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error()
        entry = parsed as Record<string, unknown>
      } catch {
        statuses.push("INCOMPLETE")
        continue
      }
      evidence.records += 1
      const sameSource =
        entry._NAMESPACE === identity.namespace &&
        entry._MACHINE_ID === scope.machineId &&
        entry._BOOT_ID === scope.bootId
      if (!sameSource || entry._LINE_BREAK === "line-max")
        statuses.push("INCOMPLETE")
      const ownInvocation =
        entry._SYSTEMD_UNIT === identity.unit &&
        entry._SYSTEMD_INVOCATION_ID === scope.invocationId &&
        entry._PID === String(scope.pid)
      if (
        ownInvocation &&
        [identity.begin, identity.control, identity.end].includes(
          String(entry.MESSAGE),
        )
      ) {
        const key = String(entry.MESSAGE)
        markerIndexes.set(key, [...(markerIndexes.get(key) ?? []), index])
        if (key === identity.control)
          evidence.positiveControl =
            (await scanBuffer(Buffer.from(key), identity.control)) === "FAIL"
      }
      // Inspect ALL fields of ALL records, including records outside markers;
      // neither a unit filter nor a MESSAGE-only scan can silently omit data.
      for (const value of Object.values(entry)) {
        try {
          for (const bytes of fieldBytes(value))
            for (const sentinel of M12_JOURNAL_SENTINELS)
              statuses.push(await scanBuffer(bytes, sentinel))
        } catch {
          statuses.push("INCOMPLETE")
        }
      }
    }
    const begin = markerIndexes.get(identity.begin) ?? []
    const control = markerIndexes.get(identity.control) ?? []
    const end = markerIndexes.get(identity.end) ?? []
    const first = begin[0],
      positive = control[0],
      last = end[0]
    const bounded =
      begin.length === 1 &&
      control.length === 1 &&
      end.length === 1 &&
      first !== undefined &&
      positive !== undefined &&
      last !== undefined &&
      first < positive &&
      positive < last
    evidence.scenarioRecords =
      bounded && last !== undefined && positive !== undefined
        ? last - positive - 1
        : 0
    if (
      !bounded ||
      evidence.scenarioRecords === 0 ||
      !evidence.positiveControl ||
      now() > deadline
    )
      statuses.push("INCOMPLETE")
    evidence.complete = !statuses.includes("INCOMPLETE")
  } catch {
    statuses.push("INCOMPLETE")
  }
  evidence.status = combineScanStatuses(statuses)
  return evidence
}
