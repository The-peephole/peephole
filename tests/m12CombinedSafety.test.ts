import { describe, expect, it, vi } from "vitest"
import type { BackendRuntimeDiagnosticEvent } from "../services/backend-runtime-api/diagnostics"
import { validateTemporaryDatabaseResourceId } from "../core/backendDatabase/resourceIdentity"
import {
  attemptCombinedCleanup,
  CombinedHarnessError,
  combinedSuiteEnabled,
  COMBINED_GATE,
  preflightCombinedHost,
  safeDiagnostic,
  takeCombinedParent,
  validateAttestation,
  validateCombinedHba,
  validateLocalPostgres,
  validatePostgresLogging,
  validatePostgresFiles,
  type LocalPostgresFacts,
} from "./support/m12CombinedSafety"
import { TestOwnershipStore } from "./support/temporaryDatabaseTestOwnership"
import { FullStackPreviewControlPlane } from "../services/fullstack-preview-api/controlPlane"
import {
  FakeFullStackPreviewStore,
  FakeFullStackPreviewQueue,
  validFrontendPlan,
  validBackendPlan,
  repository,
} from "./support/fakeFullStackPreview"

const gates = {
  PEEPHOLE_REAL_GVISOR_TESTS: "1",
  PEEPHOLE_M12_REAL_GVISOR_TESTS: "1",
  [COMBINED_GATE]: "1",
}
const expected = {
  parent: "/srv/m12-case",
  postgresRoot: "/srv/peephole-m12-db-case",
  machineId: "a".repeat(32),
  bootId: "b".repeat(36),
}
const attestation = {
  ...expected,
  schema: "peephole-m12-combined/v1",
  dedicatedNonProduction: true,
}
const postgres: LocalPostgresFacts = {
  pid: 1234,
  socketPid: 1234,
  postgresUid: 110,
  socketUid: 110,
  version: "18",
  dataDir: "/srv/peephole-m12-db-case/data",
  pidDataDir: "/srv/peephole-m12-db-case/data",
  processCwd: "/srv/peephole-m12-db-case/data",
  processExecutable: "/usr/lib/postgresql/18/bin/postgres",
}
const hba =
  "local all postgres peer\nlocal all m12_combined_provisioner scram-sha-256\nhost all all 10.200.0.0/16 scram-sha-256\n"
const logging = {
  log_statement: "none",
  log_min_error_statement: "panic",
  log_min_messages: "panic",
  log_duration: "off",
  log_min_duration_statement: "-1",
  log_min_duration_sample: "-1",
  log_transaction_sample_rate: "0",
  log_parameter_max_length: "0",
  log_parameter_max_length_on_error: "0",
}

describe("combined integration safety (portable; no DB/runsc)", () => {
  const safeConfig =
    "shared_preload_libraries = ''\nsession_preload_libraries = ''"
  it.each([
    ["", ""],
    ["shared_preload_libraries='pgaudit'", ""],
    [`${safeConfig}\ninclude 'outside.conf'`, ""],
    [`${safeConfig}\ninclude_if_exists 'outside.conf'`, ""],
    [`${safeConfig}\ninclude_dir 'outside'`, ""],
    [`${safeConfig}\nhba_file='/etc/postgresql/pg_hba.conf'`, ""],
    [safeConfig, "log_statement='all'"],
    [`${safeConfig}\nshared_preload_libraries='pgaudit'`, ""],
  ])(
    "rejects unsafe/missing filesystem-only PG configuration: %#",
    (config, auto) => {
      expect(() => validatePostgresFiles(config, auto)).toThrow(
        "DATABASE_OWNERSHIP_REJECTED",
      )
    },
  )
  it("checks hidden preload configuration from owned files without additional SQL roles", () => {
    expect(() =>
      validatePostgresFiles(
        `# test\n${safeConfig}\nlisten_addresses='192.168.253.1'`,
        "# no overrides\n",
      ),
    ).not.toThrow()
  })
  it("uses the existing atomic Fullstack test-store queue instead of synthesizing a missing enqueue", async () => {
    const store = new FakeFullStackPreviewStore()
    const queue = new FakeFullStackPreviewQueue()
    const control = new FullStackPreviewControlPlane(
      { resolve: async () => validFrontendPlan },
      { resolve: async () => validBackendPlan },
      store,
      queue,
      { consume: async () => ({ allowed: true }) },
    )
    const created = await control.create(
      {
        contractVersion: "fullstack-v1",
        repository,
        frontendTarget: { sourceRoot: "frontend" },
        backendSourceRoot: "backend",
      },
      "d2a-request-key-123456789",
      { subject: "d2a-portable", ip: "127.0.0.1" },
    )
    expect(queue.enqueued).toEqual([])
    const payload = await takeCombinedParent(store, created.preview.id)
    expect(payload).toEqual({
      previewId: created.preview.id,
      repository,
      frontendSourceRoot: "frontend",
      backendSourceRoot: "backend",
    })
    await expect(takeCombinedParent(store, created.preview.id)).rejects.toThrow(
      "FULLSTACK_FAILED",
    )
    await expect(
      takeCombinedParent(store, "fullstack-wrong-identity"),
    ).rejects.toThrow("FULLSTACK_FAILED")
  })
  it.each(Object.keys(gates))(
    "requires exact gate %s independently",
    (gate) => {
      for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "])
        expect(combinedSuiteEnabled({ ...gates, [gate]: value })).toBe(false)
      expect(combinedSuiteEnabled(gates)).toBe(true)
    },
  )
  it("refuses preflight before inspecting host/DB when gates are absent", async () => {
    await expect(
      preflightCombinedHost({}, Buffer.alloc(0)),
    ).rejects.toMatchObject({ code: "PREFLIGHT_FAILED", stack: undefined })
  })
  it("requires a positive dedicated-host attestation, even if no production markers were found", () => {
    expect(() => validateAttestation({}, expected)).toThrow(
      "HOST_OWNERSHIP_REJECTED",
    )
    expect(() => validateAttestation(attestation, expected)).not.toThrow()
  })
  it.each([
    "parent",
    "postgresRoot",
    "machineId",
    "bootId",
    "schema",
    "dedicatedNonProduction",
  ])("rejects stale/wrong attestation %s", (key) => {
    expect(() =>
      validateAttestation({ ...attestation, [key]: "different" }, expected),
    ).toThrow("HOST_OWNERSHIP_REJECTED")
  })
  it.each([
    { pid: 0 },
    { socketPid: 2000 },
    { postgresUid: 0 },
    { socketUid: 120 },
    { version: "17" },
    { pidDataDir: "/var/lib/postgresql/18/main" },
    { processCwd: "/var/lib/postgresql/18/main" },
    { processExecutable: "/usr/bin/node" },
  ])("rejects unproven local PostgreSQL ownership: %#", (mismatch) => {
    expect(() => validateLocalPostgres({ ...postgres, ...mismatch })).toThrow(
      "DATABASE_OWNERSHIP_REJECTED",
    )
  })
  it("accepts matching positive PID/socket/data/UID/version proofs", () => {
    expect(() => validateLocalPostgres(postgres)).not.toThrow()
  })
  it.each([
    hba.replace("scram-sha-256", "trust"),
    `${hba}host all all 0.0.0.0/0 trust\n`,
    hba.replace("10.200.0.0/16", "0.0.0.0/0"),
    `include '/etc/postgresql/pg_hba.conf'\n${hba}`,
  ])("rejects HBA broadening, trust and external includes: %#", (rules) => {
    expect(() => validateCombinedHba(rules)).toThrow(
      "DATABASE_OWNERSHIP_REJECTED",
    )
  })
  it("allows only the dedicated SCRAM rules and harmless comments/spacing", () => {
    expect(() => validateCombinedHba(`# test only\n${hba}`)).not.toThrow()
  })
  it.each(Object.keys(logging))(
    "refuses unsafe/unknown PostgreSQL logging setting %s",
    (key) => {
      expect(() =>
        validatePostgresLogging({ ...logging, [key]: "unsafe" }),
      ).toThrow("POSTGRES_POLICY_REJECTED")
      expect(() => validatePostgresLogging(logging)).not.toThrow()
    },
  )
  it("projects only allowlisted D1 fields and never serializes exception/output/hash properties", () => {
    const marker = "D2A-SYNTHETIC-SENSITIVE-MARKER"
    const toJSON = vi.fn(() => {
      throw new Error(marker)
    })
    const event = {
      runtimeId: "12345678-1234-1234-1234-123456789012",
      failureStage: "READINESS",
      primaryFailureCode: "RUNTIME_READINESS_TIMEOUT",
      cleanupFailureCode: "DATABASE_REVOKE_FAILED",
      error: new Error(marker),
      stack: marker,
      stdout: marker,
      stderr: marker,
      DATABASE_URL: marker,
      password: marker,
      token: marker,
      hash: marker,
      userEnvironment: marker,
      toJSON,
    } as const
    const encoded = JSON.stringify(safeDiagnostic(event))
    expect(encoded).not.toContain(marker)
    expect(toJSON).not.toHaveBeenCalled()
    expect(JSON.parse(encoded)).toEqual({
      runtimeId: event.runtimeId,
      failureStage: "READINESS",
      primaryFailureCode: "RUNTIME_READINESS_TIMEOUT",
      cleanupFailureCode: "DATABASE_REVOKE_FAILED",
    })
  })
  it.each([
    "runtimeId",
    "failureStage",
    "primaryFailureCode",
    "cleanupFailureCode",
  ])("refuses unrecognized diagnostic %s", (key) => {
    const value = {
      runtimeId: "12345678-1234-1234-1234-123456789012",
      failureStage: "READINESS",
      primaryFailureCode: "RUNTIME_START_FAILED",
      cleanupFailureCode: "NONE",
      [key]: "D2A-RAW-EXCEPTION",
    } as BackendRuntimeDiagnosticEvent
    expect(() => safeDiagnostic(value)).toThrow("SCENARIO_FAILED")
  })
  it("never turns an unknown failure string into a reportable error code or raw stack", () => {
    const error = new CombinedHarnessError("D2A-RAW-EXCEPTION" as never)
    expect(error.code).toBe("SCENARIO_FAILED")
    expect(error.stack).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain("D2A-RAW-EXCEPTION")
  })
  it("attempts every cleanup step after failure and reports incomplete instead of forcing removal", async () => {
    const calls: string[] = []
    const complete = await attemptCombinedCleanup([
      async () => {
        calls.push("stop")
        throw new Error("D2A-RAW-EXCEPTION")
      },
      async () => {
        calls.push("await-workers")
      },
      async () => {
        calls.push("inspect")
      },
    ])
    expect(calls).toEqual(["stop", "await-workers", "inspect"])
    expect(complete).toBe(false)
    expect(await attemptCombinedCleanup([async () => undefined])).toBe(true)
  })
  it("reuses M11 ownership transitions and writes secret-free receipts before provisioning can continue", async () => {
    const receipts: unknown[] = []
    const store = new TestOwnershipStore(async (record) => {
      receipts.push(structuredClone(record))
    })
    const id = validateTemporaryDatabaseResourceId(`r${"a".repeat(28)}`)
    const now = new Date()
    const input = {
      resourceId: id,
      previewId: "fullstack-12345678",
      backendRuntimeId: "12345678-1234",
      now,
    }
    await store.createProvisioning(input)
    await expect(store.createProvisioning(input)).rejects.toThrow(
      "Test ownership already exists.",
    )
    await expect(store.markRevoked(id, now)).rejects.toThrow(
      "Test ownership transition was rejected.",
    )
    await store.markProvisioned(id, now)
    await store.markRevoking(id, now)
    await store.markRevoked(id, now)
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "provisioning" }),
        expect.objectContaining({ status: "revoked" }),
      ]),
    )
    expect((await store.getByResourceId(id))?.status).toBe("revoked")
  })
  it("rejects a failed ownership receipt before the caller can issue provisioning SQL", async () => {
    const store = new TestOwnershipStore(async () => {
      throw new Error("D2A-RECEIPT-WRITE-FAILED")
    })
    await expect(
      store.createProvisioning({
        resourceId: validateTemporaryDatabaseResourceId(`r${"b".repeat(28)}`),
        previewId: "fullstack-12345678",
        backendRuntimeId: "12345678-1234",
        now: new Date(),
      }),
    ).rejects.toThrow("D2A-RECEIPT-WRITE-FAILED")
  })
})
