import {
  resolveBackendExecutionSupport,
  resolveBackendRuntimePlan,
} from "../analyzer/backendRuntimeAdapter"
import type { BackendCandidate } from "../../types/backend"
import type { BackendExecutionSupport } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"

export interface FullStackCandidateSupportOptions {
  /** M12 build-time opt-in (`WXT_USER_ENVIRONMENT_ENABLED`). Off: a backend
   * that declares user-provided configuration stays ineligible, exactly as
   * before M12. */
  userEnvironmentEnabled?: boolean
}

/**
 * Client-side eligibility is only a conservative UX hint. The server still
 * re-derives and admits the exact frontend/backend pair at the pinned commit.
 */
export function resolveFullStackCandidateSupport(
  repository: PreviewRepositoryRef,
  candidate: BackendCandidate,
  options: FullStackCandidateSupportOptions = {},
): BackendExecutionSupport {
  const standaloneSupport = resolveBackendExecutionSupport(candidate)
  if (standaloneSupport.supported) return standaloneSupport

  const trustedPlan = resolveBackendRuntimePlan(repository, candidate)
  if (!trustedPlan) return standaloneSupport

  if (trustedPlan.userEnvironmentNames.length > 0) {
    return options.userEnvironmentEnabled
      ? {
          supported: true,
          adapterId: trustedPlan.adapterId,
          evidence: [
            "This backend needs non-sensitive configuration values you enter before starting; the server will verify the exact commit.",
          ],
        }
      : {
          supported: false,
          adapterId: null,
          evidence: [
            "This backend declares configuration variables that need user-provided values, which this build does not accept.",
          ],
        }
  }

  return trustedPlan.databaseRequirement
    ? {
        supported: true,
        adapterId: trustedPlan.adapterId,
        evidence: [
          "The exact pg + DATABASE_URL shape is eligible for trusted full-stack admission; the server will verify the exact commit.",
        ],
      }
    : standaloneSupport
}
