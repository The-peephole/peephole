import type {
  BuildTargetAnalysis,
  RepositoryAnalysis,
} from "../../types/analysis"
import type { FullStackPreview } from "../../types/fullstackPreview"
import { parseFullStackPreview } from "../fullstack/apiClient"

export interface RetainedFullStackControl {
  analysis: BuildTargetAnalysis & RepositoryAnalysis
  preview: FullStackPreview
}
interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}
export interface FullStackControlStore {
  load(): Promise<RetainedFullStackControl | null>
  save(control: RetainedFullStackControl | null): Promise<void>
}

const ANALYSIS_FIELDS = [
  "repository",
  "analyzerVersion",
  "targetAnalyzerVersion",
  "target",
  "technologies",
  "packageManager",
  "runtime",
  "environment",
  "environmentRequirements",
  "deployment",
  "workspace",
  "structure",
  "backend",
  "preview",
  "inspectedFiles",
  "warnings",
] as const
const PREVIEW_FIELDS = [
  "id",
  "frontendSourceRoot",
  "backendSourceRoot",
  "status",
  "url",
  "errorCode",
  "errorMessage",
  "createdAt",
  "updatedAt",
  "expiresAt",
] as const

/** Trusted session-only snapshot. No Create request, session or input values. */
export function createTabFullStackControlStore(
  tabId: number,
  storage: SessionArea = browser.storage.session,
): FullStackControlStore {
  if (!Number.isSafeInteger(tabId) || tabId < 0)
    throw new Error("A valid source tab is required.")
  const key = `peepholeFullStackControl:${tabId}`
  let pending = Promise.resolve()
  return {
    async load() {
      const value = (await storage.get(key))[key]
      if (value === undefined) return null
      if (!isObject(value) || value.version !== 1 || !isObject(value.analysis))
        throw new Error("Invalid saved preview controls.")
      const preview = parseFullStackPreview(value.preview)
      const analysis =
        value.analysis as unknown as RetainedFullStackControl["analysis"]
      // This versioned analysis was written by this extension, not an API
      // request. Refuse truncated/cross-repository snapshots rather than run anew.
      if (
        !analysis.repository ||
        !analysis.target ||
        !analysis.preview ||
        !analysis.backend ||
        !Array.isArray(analysis.backend.candidates) ||
        !Array.isArray(analysis.environmentRequirements) ||
        analysis.repository.repositoryId !== preview.repository.repositoryId ||
        analysis.repository.owner.toLowerCase() !==
          preview.repository.owner.toLowerCase() ||
        analysis.repository.repo.toLowerCase() !==
          preview.repository.name.toLowerCase() ||
        analysis.repository.commitSha !== preview.repository.commitSha ||
        analysis.target.sourceRoot !== preview.frontendSourceRoot
      )
        throw new Error("Invalid saved preview identity.")
      return { analysis, preview }
    },
    save(control) {
      // Explicit projection excludes any unrelated object fields. Environment
      // input values live only inside FullStackPreviewPanel, never in analysis.
      const snapshot = control
        ? {
            version: 1,
            analysis: Object.fromEntries(
              ANALYSIS_FIELDS.map((field) => [field, control.analysis[field]]),
            ),
            preview: {
              ...Object.fromEntries(
                PREVIEW_FIELDS.map((field) => [field, control.preview[field]]),
              ),
              repository: {
                repositoryId: control.preview.repository.repositoryId,
                owner: control.preview.repository.owner,
                name: control.preview.repository.name,
                commitSha: control.preview.repository.commitSha,
              },
            },
          }
        : null
      const write = pending
        .catch(() => undefined)
        .then(async () => {
          if (snapshot) await storage.set({ [key]: snapshot })
          else await storage.remove(key)
        })
      pending = write
      return write
    },
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
