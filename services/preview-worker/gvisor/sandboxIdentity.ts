// The fixed, unprivileged identity every sandboxed process runs as --
// shared between the disk manager (which owns the writable workspace) and
// RunscCommandRunner. HOME and npm's cache deliberately live on the hard-
// capped workspace filesystem; the copied OCI rootfs is read-only.
export const SANDBOX_UID = 65534
export const SANDBOX_GID = 65534
export const SANDBOX_HOME = "/workspace/.home"
export const SANDBOX_NPM_CACHE = "/workspace/.home/.npm"
