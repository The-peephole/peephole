export type RepositoryStructureLayout =
  "single-project" | "workspace" | "multi-project" | "unknown"

/**
 * Conservative, evidence-bounded role for a discovered directory. Structure
 * detection never claims "application" or "library" with more confidence
 * than the available evidence supports.
 */
export type ProjectCandidateRole =
  "project-candidate" | "package-candidate" | "unknown"

export interface RepositoryProjectCandidate {
  /** Repository-relative POSIX path; "." for the repository root. */
  path: string
  isRoot: boolean
  role: ProjectCandidateRole
  hasPackageJson: boolean
  packageName: string | null
  evidence: string[]
  warnings: string[]
}

export interface RepositoryStructure {
  layout: RepositoryStructureLayout
  projects: RepositoryProjectCandidate[]
  workspaceEvidence: string[]
  warnings: string[]
  /** False when a bounded read/listing failed and the result may be partial. */
  complete: boolean
  /** True when a limit was reached and more candidates may exist. */
  truncated: boolean
}
