import { describe, expect, it, vi } from "vitest"

import {
  CANCEL_BUILD_TARGET_ANALYSIS,
  LOAD_BUILD_TARGET_ANALYSIS,
  createBuildTargetAnalysisMessageHandler,
  createBuildTargetAnalysisMessageLoader,
} from "../core/analyzer/targetMessages"
import { toRootBuildTargetAnalysis } from "../core/preview/buildAdapters"
import type { BuildTargetAnalysis } from "../types/analysis"
import { supportedAnalysis } from "./analysisFixture"

const requestId = "01234567-89ab-cdef-0123-456789abcdef"
const repository = supportedAnalysis.repository
const target = { sourceRoot: "apps/web" }
const analysis: BuildTargetAnalysis = {
  ...toRootBuildTargetAnalysis(supportedAnalysis),
  target,
}

describe("build target analysis messages", () => {
  it("validates the exact metadata and safe source root", async () => {
    const load = vi.fn().mockResolvedValue(analysis)
    const handle = createBuildTargetAnalysisMessageHandler(load)

    await expect(
      handle({
        type: LOAD_BUILD_TARGET_ANALYSIS,
        requestId,
        repository,
        target,
      }),
    ).resolves.toEqual({ ok: true, requestId, analysis })
    expect(
      handle({
        type: LOAD_BUILD_TARGET_ANALYSIS,
        requestId,
        repository,
        target: { sourceRoot: "../outside" },
      }),
    ).toBeUndefined()
  })

  it("aborts the matching background target read", () => {
    let signal: AbortSignal | undefined
    const handle = createBuildTargetAnalysisMessageHandler(
      (_repository, _target, options) => {
        signal = options?.signal
        return new Promise<BuildTargetAnalysis>(() => undefined)
      },
    )

    void handle({
      type: LOAD_BUILD_TARGET_ANALYSIS,
      requestId,
      repository,
      target,
    })
    handle({ type: CANCEL_BUILD_TARGET_ANALYSIS, requestId })
    expect(signal?.aborted).toBe(true)
  })

  it("rejects a response for a different target", async () => {
    const load = createBuildTargetAnalysisMessageLoader({
      send: vi.fn(async (message) => ({
        ok: true,
        requestId: message.requestId,
        analysis: { ...analysis, target: { sourceRoot: "apps/admin" } },
      })),
    })

    await expect(load(repository, target)).rejects.toMatchObject({
      code: "invalid-response",
    })
  })
})
