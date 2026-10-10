import {
  resolveBackendExecutionSupport,
  resolveBackendRuntimePlan,
} from "../analyzer/backendRuntimeAdapter"
import type { BackendCandidate } from "../../types/backend"
import type { BackendExecutionSupport } from "../../types/backendRuntime"
import type { PreviewRepositoryRef } from "../../types/preview"

/**
 * Client-side eligibility is only a conservative UX hint. The server still
 * re-derives and admits the exact frontend/backend pair at the pinned commit.
 */
export function resolveFullStackCandidateSupport(
  repository: PreviewRepositoryRef,
  candidate: BackendCandidate,
): BackendExecutionSupport {
  const standaloneSupport = resolveBackendExecutionSupport(candidate)
  if (standaloneSupport.supported) return standaloneSupport

  const trustedPlan = resolveBackendRuntimePlan(repository, candidate)
  return trustedPlan?.databaseRequirement
    ? {
        supported: true,
        adapterId: trustedPlan.adapterId,
        evidence: [
          "The exact pg + DATABASE_URL shape is eligible for trusted full-stack admission; the server will verify the exact commit.",
        ],
      }
    : standaloneSupport
}
