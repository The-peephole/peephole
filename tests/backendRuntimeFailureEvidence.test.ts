import { describe, expect, it, vi } from "vitest"
import { BackendRuntimeControlPlane } from "../services/backend-runtime-api/controlPlane"
import {
  InMemoryBackendRuntimeStore,
  InMemoryBackendRuntimeQueue,
} from "../services/backend-runtime-api/inMemoryAdapters"
import {
  type BackendRuntimeFailureEvidence,
  RuntimeProcessFailure,
  annotateRuntimeFailure,
  runtimeFailureDetail,
} from "../services/backend-runtime-api/diagnostics"

const evidence: BackendRuntimeFailureEvidence = {
  kind: "primary_failure",
  runtimeId: "00000000-0000-4000-8000-000000000001",
  parentId: "fullstack-00000000-0000-4000-8000-000000000002",
  resourceId: `r${"a".repeat(28)}`,
  elapsedMs: 100,
  failureStage: "RUNTIME_START",
  primaryFailureCode: "RUNTIME_START_FAILED",
  cleanupFailureCode: null,
  failureStep: "OCI_PREPARATION",
  exitCode: null,
  startupCleanupFailed: false,
}

function compose(sink = vi.fn()) {
  const store = new InMemoryBackendRuntimeStore()
  const control = new BackendRuntimeControlPlane(
    { resolve: vi.fn() },
    store,
    new InMemoryBackendRuntimeQueue(),
    { onFailureEvidence: sink },
  )
  return { control, store, sink }
}

describe("targeted runtime evidence boundary", () => {
  it("projects only allowlisted fields without reading a store or invoking toJSON", () => {
    const c = compose()
    const read = vi
      .spyOn(c.store, "get")
      .mockRejectedValue(new Error("SENSITIVE"))
    const toJSON = vi.fn(() => {
      throw new Error("SENSITIVE")
    })
    c.control.emitWorkerFailureEvidence({
      ...evidence,
      error: new Error("SENSITIVE"),
      password: "SENSITIVE",
      stdout: "SENSITIVE",
      stderr: "SENSITIVE",
      DATABASE_URL: "SENSITIVE",
      toJSON,
    } as BackendRuntimeFailureEvidence)
    expect(c.sink).toHaveBeenCalledExactlyOnceWith(evidence)
    expect(JSON.stringify(c.sink.mock.calls)).not.toContain("SENSITIVE")
    expect(read).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it.each([
    { kind: "SENSITIVE" },
    { runtimeId: "SENSITIVE" },
    { parentId: "SENSITIVE" },
    { resourceId: "SENSITIVE" },
    { failureStage: "SENSITIVE" },
    { primaryFailureCode: "toString" },
    { primaryFailureCode: "SENSITIVE" },
    { cleanupFailureCode: "SENSITIVE" },
    { failureStep: "SENSITIVE" },
    { exitCode: 256 },
    { exitCode: -1 },
    { exitCode: "SENSITIVE" },
    { elapsedMs: NaN },
    { elapsedMs: -1 },
    { elapsedMs: 1.5 },
    { startupCleanupFailed: "SENSITIVE" },
  ])("drops invalid evidence without output: %#", (invalid) => {
    const c = compose()
    expect(() =>
      c.control.emitWorkerFailureEvidence({
        ...evidence,
        ...invalid,
      } as BackendRuntimeFailureEvidence),
    ).not.toThrow()
    expect(c.sink).not.toHaveBeenCalled()
  })

  it.each(["throw", "reject", "hang"])(
    "does not await or propagate a %s sink",
    async (mode) => {
      const sink = vi.fn(() => {
        if (mode === "throw") throw new Error("SENSITIVE")
        if (mode === "reject") return Promise.reject(new Error("SENSITIVE"))
        return new Promise<void>(() => {})
      })
      const c = compose(sink)
      expect(c.control.emitWorkerFailureEvidence(evidence)).toBeUndefined()
      await Promise.resolve()
      expect(sink).toHaveBeenCalledOnce()
    },
  )

  it("does not let a getter-bearing diagnostic interrupt execution", () => {
    const c = compose()
    const hostile = {
      ...evidence,
      get failureStep(): never {
        throw new Error("SENSITIVE")
      },
    }
    expect(() => c.control.emitWorkerFailureEvidence(hostile)).not.toThrow()
    expect(c.sink).not.toHaveBeenCalled()
  })

  it("distinguishes pending cleanup from completed NONE", () => {
    const c = compose()
    c.control.emitWorkerFailureEvidence({
      ...evidence,
      cleanupFailureCode: "NONE",
    })
    c.control.emitWorkerFailureEvidence({
      ...evidence,
      kind: "cleanup_complete",
      cleanupFailureCode: null,
    })
    expect(c.sink).not.toHaveBeenCalled()
    c.control.emitWorkerFailureEvidence({
      ...evidence,
      kind: "cleanup_complete",
      cleanupFailureCode: "NONE",
    })
    expect(c.sink).toHaveBeenCalledOnce()
  })

  it("preserves legacy error identity while projecting safe detail", () => {
    const error = new AggregateError([new Error("SENSITIVE")], "SENSITIVE")
    const detail = {
      failureStep: "MATERIAL_FILESYSTEM" as const,
      exitCode: null,
      startupCleanupFailed: true,
    }
    expect(annotateRuntimeFailure(error, detail)).toBe(error)
    expect(runtimeFailureDetail(error)).toEqual(detail)
    expect(JSON.stringify(runtimeFailureDetail(error))).not.toContain(
      "SENSITIVE",
    )
    expect(runtimeFailureDetail(new Error("SENSITIVE"))).toBeUndefined()
    expect(
      runtimeFailureDetail(
        new RuntimeProcessFailure("RUNSC_EXIT_UNVERIFIED", -999),
      )?.exitCode,
    ).toBeNull()
  })
})
