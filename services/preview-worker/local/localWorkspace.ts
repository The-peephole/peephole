import type { PreviewWorkspace } from "../ports"

/**
 * A workspace backed by a real directory on this host's filesystem. Both the
 * dev (unsandboxed) and gVisor adapters expose this shape so extraction,
 * output-reading, and artifact publishing can share one implementation
 * regardless of where the install/build command actually executes.
 */
export interface LocalPreviewWorkspace extends PreviewWorkspace {
  readonly rootDir: string
  /** Milliseconds left in this job's total wall-clock budget, may be negative. */
  remainingMs(): number
}

export function asLocalWorkspace(
  workspace: PreviewWorkspace,
): LocalPreviewWorkspace {
  if (
    !("rootDir" in workspace) ||
    typeof workspace.rootDir !== "string" ||
    !("remainingMs" in workspace) ||
    typeof workspace.remainingMs !== "function"
  ) {
    throw new Error(
      "This adapter requires a workspace backed by a real filesystem root.",
    )
  }

  return workspace as LocalPreviewWorkspace
}
