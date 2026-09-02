import type { LocalPreviewWorkspace } from "../local/localWorkspace"

/**
 * `rootDir` points at `<bundleDir>/rootfs/workspace` on the host, which is
 * `/workspace` inside the sandboxed container (the OCI `root.path` is
 * `<bundleDir>/rootfs`). Extraction/build/output code shared with
 * `LocalDevSandboxProvisioner` only ever touches `rootDir`, so it works
 * unmodified whether or not a real sandbox is behind it.
 */
export interface GVisorPreviewWorkspace extends LocalPreviewWorkspace {
  readonly bundleDir: string
  registerContainer(containerId: string): void
  listContainers(): string[]
}

export function asGVisorWorkspace(
  workspace: LocalPreviewWorkspace,
): GVisorPreviewWorkspace {
  if (!("bundleDir" in workspace) || !("registerContainer" in workspace)) {
    throw new Error(
      "This adapter requires a workspace allocated by GVisorSandboxProvisioner.",
    )
  }

  return workspace as GVisorPreviewWorkspace
}
