# Base rootfs build policy

Run `scripts/gvisor/build-base-rootfs.sh` as root on a trusted Debian/Ubuntu
Linux host, including WSL2. It still builds Ubuntu **noble** with debootstrap
and installs Node **24.20.0** and its bundled npm. The host architecture is
selected by `dpkg --print-architecture`: amd64 uses linux-x64 and the primary
Ubuntu archive; arm64 uses linux-arm64 and the ports archive. This is not a
cross-build interface. Required host tools include debootstrap, Bash, curl,
tar with xz support, sha256sum, realpath and chroot.
Node archive identity is pinned; Ubuntu packages still follow the configured
archive, so this does not claim a bit-for-bit reproducible whole image.

## New paths only

```bash
sudo ./scripts/gvisor/build-base-rootfs.sh /var/lib/peephole/base-rootfs-candidate-UNIQUE
```

Choose a **new, canonical absolute path** in a trusted build directory. Relative
paths, `/`, noncanonical paths and symlink ancestors are refused. An existing
directory, file, symlink (including a dangling symlink), mountpoint or partial
image is refused before debootstrap. The builder atomically creates the output
leaf; a competing creator causes failure instead of replacement. Parent
directories may be created. Do not build under directories controlled by
untrusted users or concurrently move/change path ancestors during a root build.

The default remains `/var/lib/peephole/base-rootfs`, but it now fails if that
path already exists. Rebuilds must use separate image paths. This command does
not switch a service to the candidate, deploy it, or remove the previous image.

On failure, the partial image is **preserved**, and using that path again is
refused. Keep the error output and inspect it, including any mounts left by
debootstrap, before any separately reviewed cleanup. The builder never deletes
an output tree and provides no force/overwrite/delete option. Use another new
path for a later build. Only its private temporary download file and empty
download directory are cleaned up automatically.

## Node archive integrity and ownership

The script pins these exact version/architecture pairs:

| Node version | Host / archive architecture | SHA256 of `.tar.xz` |
| --- | --- | --- |
| 24.20.0 | amd64 / linux-x64 | `2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2` |
| 24.20.0 | arm64 / linux-arm64 | `5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7` |

The archive is verified **before extraction or Node/npm execution**. A mismatch
fails closed. There is no checksum override or fallback to an unpinned version.
Changing only `NODE_VERSION` also fails closed until the corresponding pinned
case and hashes are reviewed together.

For an update, follow [Node's binary verification procedure](https://github.com/nodejs/node#verifying-binaries):
verify the release's signed `SHASUMS256.txt.asc` with the official release keyring,
then review and pin both archive digests. Downloading an unsigned checksum from
the same location at build time detects corruption but does not independently
authenticate that location. Normal builds therefore use the committed pins
without fetching a new checksum manifest or keyring. The initial pins were
verified against the [24.20.0 signed manifest](https://nodejs.org/dist/v24.20.0/SHASUMS256.txt.asc)
on 2026-10-16 using `gpgv` and the official Node release keyring; the signer
fingerprint was `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.

Extraction uses `tar --no-same-owner`: archive UID/GID values must not make
Node/npm writable by host UID 1000. An immediate, error-checked `find` audit
requires every entry under `/usr/local` to be owned by **root:root**. A failed
audit or non-root entry aborts the build. Existing executable modes and the
Node/npm chroot version checks remain in place.

## Host/chroot temporary directories and compatibility

Downloads use a private `mktemp` directory under host `/var/tmp`, not a shared,
predictable `/tmp/node-*.tar.xz` file. Its path is never exported as `TMPDIR`.
The builder unsets ambient `TMPDIR`, `TMP` and `TEMP` in its own process before
debootstrap and chroot, so host-only paths cannot leak into package installation
inside the image. The calling shell's environment is unchanged. Chroot package
tools use their normal `/tmp`; host download files remain outside the image.

The re-canary executor supplied the host-only TMPDIR that first exposed the
failure. The ordinary builder inherited the same variables too, so sanitizing
them here also protects direct builds. By contrast, `/usr/sbin/chroot` was
hardcoded in the re-canary Python verifier, not this shell builder. This script
already resolves `chroot` through PATH, including `/usr/bin/chroot` on Ubuntu
26.04; no absolute chroot-path workaround is needed here.

The trusted M10/M11/M12 bootstrap is unchanged. It is installed byte-for-byte as
root-owned mode `0555`; `run/secrets/{env,database-url,user-env}` remain separate,
empty root-owned `0644` files. Existing images are not patched in place.

## Verification

The rootfs shell regression tests are in `tests/rootfsBuildScript.test.ts`:

```bash
bash -n scripts/gvisor/build-base-rootfs.sh
npx vitest run tests/rootfsBuildScript.test.ts tests/secretBootstrap.test.ts \
  tests/bootstrapDiagnostics.test.ts tests/userEnvironmentRuntimeInjection.test.ts \
  tests/productionPreflight.test.ts tests/m12TestHostScript.test.ts
```

The builder tests run on Linux, substituting the root gate and synthetic archive
pins in a temporary script copy and shimming network/privileged build commands.
They use real tar/checksum/install operations and do not download packages or
mount filesystems. They cover existing/unsafe path refusal, corrupt downloads,
both architecture branches, temporary environment isolation, bootstrap/modes,
ownership-audit failure and preservation of partial output. They do not prove an
arm64 executable runs on hardware, or replace a complete privileged build.

Local acceptance on 2026-10-16:

| Check | Result |
| --- | --- |
| Shell syntax, lint, typecheck, format, patch whitespace | PASS |
| Targeted suites above | 167 PASS, 6 SKIP (existing unprivileged-only cases in the root run) |
| Full test suite on WSL2, root | 2,802 PASS, 119 SKIP, 0 FAIL (opt-in/environment-gated tests remain skipped) |
| New rootfs builder regressions | 13 PASS as root and 13 PASS as uid 1000, including both mocked architecture paths |
| Full rootfs build: WSL2 Ubuntu 26.04 LTS x86_64, root; Ubuntu noble image | PASS |
| Host-only TMPDIR/TMP/TEMP supplied to the full build | PASS |
| Real chroot Node/npm | v24.20.0 / 11.19.0 |
| `/usr/local` non-root UID/GID entries | 0 |
| Bootstrap identity/mode and three placeholders | PASS: unchanged bootstrap, root:root 0555; root:root 0644 empty files |
| Existing completed image refusal | PASS: complete file/content/ownership/mode fingerprint unchanged |
| Real tmpfs mountpoint refusal | PASS: sentinel unchanged; own test mount unmounted |
| Native arm64 full build and Node execution | NOT_RUN: no arm64 host/emulation |
| Older Ubuntu host full build | NOT_RUN; PATH-based chroot and existing GNU tool interfaces retained |
| New gVisor/Production/Chrome execution | NOT_RUN; outside this PR |

The dedicated completed WSL test image was retained; no existing image was
deleted. These are local observations of this script, separate from the prior
Production canary history.

These changes do not establish the cause of the earlier Production `Backend
Failed`. The later M12 canary succeeded with a rebuilt image; that is historical
evidence, not a local test of this PR or proof of causality. No Production
deployment or Chrome artifact change is part of this PR.
