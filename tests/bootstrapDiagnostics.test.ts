import { describe, expect, it } from "vitest"
import {
  BOOTSTRAP_READY,
  BOOTSTRAP_FAILED,
  APPLICATION_STARTED,
  classifyBootstrapExit,
} from "../services/preview-worker/gvisor/bootstrapDiagnostics"

describe("bootstrap reported evidence (not an authenticated cause)", () => {
  it.each([
    [BOOTSTRAP_FAILED, "BOOTSTRAP_REPORTED_FAILURE"],
    [BOOTSTRAP_READY, "APPLICATION_START_UNVERIFIED"],
    [`${BOOTSTRAP_READY}\n${APPLICATION_STARTED}`, "APPLICATION_REPORTED_EXIT"],
    [`${BOOTSTRAP_READY}\n${BOOTSTRAP_FAILED}`, "APPLICATION_START_UNVERIFIED"],
    [
      `${BOOTSTRAP_READY}\n${APPLICATION_STARTED}\n${BOOTSTRAP_FAILED}`,
      "APPLICATION_REPORTED_EXIT",
    ],
    [
      `${BOOTSTRAP_FAILED}\n${BOOTSTRAP_READY}\n${APPLICATION_STARTED}`,
      "BOOTSTRAP_REPORTED_FAILURE",
    ],
    [APPLICATION_STARTED, "RUNSC_EXIT_UNVERIFIED"],
    ["Peephole secret bootstrap failed.", "RUNSC_EXIT_UNVERIFIED"],
    ["SENSITIVE", "RUNSC_EXIT_UNVERIFIED"],
    [BOOTSTRAP_FAILED + " SENSITIVE", "RUNSC_EXIT_UNVERIFIED"],
    [BOOTSTRAP_READY.slice(0, -1), "RUNSC_EXIT_UNVERIFIED"],
    ["", "RUNSC_EXIT_UNVERIFIED"],
  ])("classifies only complete ordered fixed tokens: %#", (text, expected) => {
    expect(classifyBootstrapExit(text)).toBe(expected)
  })
})
