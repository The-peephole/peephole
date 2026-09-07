// The fixed, unprivileged identity every sandboxed process runs as --
// shared between GVisorSandboxProvisioner (which must make SANDBOX_HOME
// writable by this uid/gid after copying the base rootfs image, since
// fs.cp does not preserve the source's ownership) and RunscCommandRunner
// (which sets this uid/gid and HOME on the OCI spec). SANDBOX_HOME must
// exist in the base rootfs image, owned by SANDBOX_UID:SANDBOX_GID (see
// scripts/gvisor/build-base-rootfs.sh).
export const SANDBOX_UID = 65534
export const SANDBOX_GID = 65534
export const SANDBOX_HOME = "/home/sandbox"
