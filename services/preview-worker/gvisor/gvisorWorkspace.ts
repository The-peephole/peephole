import type { LocalPreviewWorkspace } from "../local/localWorkspace"

/**
 * `rootDir` points at the allocation's loop-mounted ext4 workspace on the
 * host, bind-mounted at `/workspace` inside the sandboxed container. The
 * OCI root at `<bundleDir>/rootfs` is read-only. Extraction/build/output code shared with
 * `LocalDevSandboxProvisioner` only ever touches `rootDir`, so it works
 * unmodified whether or not a real sandbox is behind it.
 */
export interface GVisorPreviewWorkspace extends LocalPreviewWorkspace {
  readonly bundleDir: string
  registerContainer(containerId: string): void
  unregisterContainer(containerId: string): void
  listContainers(): string[]
  isDiskExhausted(): Promise<boolean>
  /**
   * Lazily creates (on first call) a real, routable network namespace for
   * this job and returns its path, reusing it for every later call so a
   * job's install phase only ever pays veth/NAT setup once even if it
   * runs multiple commands. Torn down by `destroy()`.
   */
  ensureNetworkNamespace(dnsServers: readonly string[]): Promise<string>
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
