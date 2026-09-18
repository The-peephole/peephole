// The fixed, unprivileged identity every sandboxed process runs as --
// shared between the disk manager (which owns the writable workspace) and
// RunscCommandRunner. HOME and npm's cache deliberately live on the hard-
// capped workspace filesystem; the copied OCI rootfs is read-only.
export const SANDBOX_UID = 65534
export const SANDBOX_GID = 65534
export const SANDBOX_HOME = "/workspace/.home"
export const SANDBOX_NPM_CACHE = "/workspace/.home/.npm"
// The base rootfs deterministically installs Node here (see
// scripts/gvisor/build-base-rootfs.sh and services/production/preflight.ts's
// own check for the same path). Containers with no shell and no PATH in
// their OCI env cannot resolve a bare "node" via executable-name lookup, so
// callers that only ever launch the base image's own Node must use this
// fixed absolute path instead of relying on PATH.
export const SANDBOX_NODE_BINARY = "/usr/local/bin/node"
