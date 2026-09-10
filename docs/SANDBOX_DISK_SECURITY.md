# Sandbox disk security

## Status and threat model

Peephole executes untrusted repository code, including npm lifecycle scripts,
as uid/gid 65534 inside gVisor. An attacker may write as quickly as possible,
create many tiny files, fill caches or temporary directories, crash the worker,
or leave a runsc container alive. The security objective is to prevent one job
from consuming the host filesystem while preserving normal `npm ci`, native
package executables such as esbuild, a second build container, and static
artifact publication.

The previous recursive directory-size watcher was only an early stop. A fast
writer could overshoot between polls and consume the host filesystem. It is
still retained as a soft limit, but it is no longer the security boundary.

## Writable surfaces

| Surface | Host location/backing | Policy |
| --- | --- | --- |
| Source, `node_modules`, build output | per-allocation `workspace.img` | fixed-size ext4 hard capacity |
| `HOME` and npm cache | `/workspace/.home` | same ext4 hard capacity |
| `/tmp` | gVisor tmpfs | 64 MiB byte hard capacity, `nosuid,nodev,noexec` |
| `/dev` | gVisor device filesystem | root-owned mode `0755`; sandbox uid cannot create regular files |
| `/dev/shm` | separate gVisor tmpfs | 16 MiB byte hard capacity, `nosuid,nodev,noexec` |
| `/dev/mqueue` | masked path | unavailable as a writable storage-like subtree |
| Copied base rootfs | per-allocation host directory | OCI root is read-only |
| `/etc/resolv.conf` | host bind mount | read-only |
| `/sys` | virtual sysfs | read-only |
| `/proc` | virtual procfs | gVisor-managed |
| Compressed GitHub archive | process memory plus host-only bundle staging | 50 MiB limit and admission reservation |
| Published artifact copy | artifact storage | at most 100 MiB per accepted output, outside workspace quota |

The ext4 mount root is owned by uid/gid 65534 with mode `0700`. World-writable
`0777` is no longer required: the production host process is privileged for
runsc/loop setup and can extract files into the uid-owned mount. The workspace
mount is `nodev,nosuid`, but intentionally not `noexec` because npm-installed
native executables must run from `node_modules`.

## Why loop-backed ext4

- A project quota on the host filesystem would require filesystem-specific
  deployment configuration and globally coordinated project IDs. A mistake has
  a larger blast radius than one owned image.
- A tmpfs workspace would couple disk pressure directly to memory, consume the
  cgroup budget, and lose the required install-to-build persistence.
- `RLIMIT_FSIZE` limits individual files, not total blocks or inode exhaustion.
- A separate block volume per job is operationally disproportionate.

Each allocation therefore uses this host-only layout:

```text
<bundles-root>/peephole-<128-bit-random-allocation-id>/
  .peephole-sandbox.json
  rootfs/                 # trusted copy, guest read-only
  staging/                # host-only compressed archive temp
  workspace.img           # preallocated fixed-size ext4
  workspace/              # verified host mount, guest /workspace
```

Allocation publication is transactional. While holding the cross-process disk
allocation lock, the manager creates only an exact temporary direct child:

```text
<bundles-root>/.peephole-allocating-<128-bit-allocation-id>-<128-bit-random>/
  .peephole-sandbox.json
```

The marker already contains the canonical paths of the future final bundle.
Peephole writes and `fsync`s the marker, `fsync`s the temporary directory,
atomically renames it to `peephole-<allocation-id>`, and `fsync`s the bundles
root. Only after that publication barrier does it create or preallocate
`workspace.img`; loop and mount setup remains later. A crash before rename
therefore leaves no final Peephole bundle or host disk resource. A crash after
rename leaves a marker-valid final bundle that the normal orphan reaper can
prove and clean.

`fallocate` consumes the configured image allocation before the allocation lock
is released. `mkfs.ext4 -m 0` keeps no root-only reserve, and ext4 capacity
(including its filesystem metadata and finite inode table) is the hard ceiling.
The normal ext4 journal is retained for safer crash recovery; its space is
inside the configured image capacity. Consequently `statfs().blocks * bsize`
reports usable filesystem capacity below the nominal `workspace.img` size; the
exact difference depends on mkfs.ext4 journal, inode-table, and metadata
settings and is not a security lower-bound invariant. `noatime` reduces
avoidable metadata writes.

The host file's `stat.blocks * 512` may also exceed its exact logical size by a
small host-filesystem metadata/allocation increment (4 KiB on the observed AWS
host). The real test requires the logical image size to equal the configured
cap and permits only 1 MiB of allocated-block accounting tolerance—never the
hundreds of MiB attempted by the hostile writer.

## Admission and concurrency

The configurable values are:

- `PEEPHOLE_SANDBOX_DISK_BYTES` (proposed default: 1 GiB)
- `PEEPHOLE_HOST_DISK_RESERVE_BYTES` (proposed default: 2 GiB)

These defaults are proposals, not production-approved values. They must be
confirmed against `df`, rootfs size, expected artifact retention, and EC2 volume
headroom before deployment.

Before rootfs copy, admission requires free space for:

```text
workspace hard allocation
+ logical base-rootfs copy size
+ 50 MiB archive staging reservation
+ 100 MiB artifact publication reservation
+ operator host reserve
+ outstanding outside-quota reservations from existing allocations
```

The image is preallocated under a cross-process allocation lock. The marker
durably records the outstanding outside-quota reservation. After the real
rootfs copy, a second locked check lowers that reservation to the remaining
archive/artifact allowance, and mount setup checks again. This prevents several
workers from all admitting against the same not-yet-consumed free space.

For concurrency `N`, plan conservatively for at least:

```text
host reserve + N * (workspace bytes + base-rootfs logical bytes + 150 MiB)
```

plus retained artifacts, filesystem metadata, logs, and normal operating-system
usage. Existing retained artifacts already reduce `statfs().bavail`; their
long-term capacity planning remains separate from the per-running-job formula.
The production default remains `PEEPHOLE_WORKER_CONCURRENCY=1`; raising it as
high as the schema maximum of 16 requires resizing and revalidating this budget.

Production startup requires the bundles root and artifact storage directory to
resolve to the same filesystem device. The archive extractor stages its bounded
compressed tar inside the host-only bundle. Consequently the 50 MiB archive and
100 MiB publication reservations are charged against the filesystem whose free
space admission actually checks.

## Lifecycle and fail-closed recovery

Normal cleanup order is:

1. kill/delete every registered runsc container and verify delete success;
2. tear down the network namespace;
3. verify mount target, loop source, and `ext4` filesystem type;
4. unmount and verify the mount disappeared;
5. verify the loop's canonical backing file, detach, and verify it disappeared;
6. remove `workspace.img`, the empty mountpoint, and finally the owned bundle.

An unmount or detach failure stops before recursive bundle removal. A safe leak
with a clear error is preferred to deleting through a live mount or detaching an
unrelated device.

The marker is stored outside the guest-visible workspace and contains version,
random allocation ID, and canonical bundle/image/mount paths. Reconciliation
accepts only direct children of the configured bundles root whose directory name
and marker agree exactly. Loop numbers are never trusted by name alone;
`losetup` must report the exact canonical backing image. `findmnt` must report
the exact target, expected loop source, and `ext4` type.

Unrelated directory names are ignored. A directory matching Peephole's random
allocation naming shape but missing a valid marker is preserved and causes
reconciliation/admission to fail closed; it is never guessed safe and deleted.
The transactional publisher prevents new markerless final bundles; this
fail-closed rule remains for legacy state, corruption, or operator-created
lookalikes.

Startup temporary recovery first acquires the same allocation lock. Existing
boot-id and PID ownership checks must prove any previous lock stale before the
scan can run, so a live allocator's transaction cannot be removed. Recovery
only recognizes the exact temporary naming pattern, canonical direct children,
ordinary non-symlink directories, and either empty or marker-only contents.
Unexpected files (including an image or mountpoint), a simultaneous final
bundle, and temporary symlinks all fail closed. Deletion unlinks at most the
bounded ordinary marker and removes the now-empty directory; it never uses a
recursive delete for transactional recovery. Arbitrary hidden directories are
ignored.

At process startup the order is:

```text
production preflight
-> database/migrations
-> runsc + owned disk reconciliation (awaited)
-> loop/ext4 capability probe
-> API/hosts and worker loops
```

`runsc list` failure, non-zero exit, or malformed JSON aborts reconciliation and
therefore startup before any uncertain mounted allocation is removed. Both
`null` (emitted by some real runsc versions for an empty Go slice) and `[]` are
normalized to an empty container list; every other non-array JSON shape remains
an error. Periodic maintenance uses the same disk-manager ownership contract and
retries failures.
Runsc containers whose bundle is below the configured root but has no matching
valid marker also block startup without guessed deletion; this covers legacy or
partially-created state that requires explicit operator review.
The deployment assumes one Peephole worker process owns a bundles root; running
two independent worker processes against the same root is unsupported.

## Error classification

`RUNNER_DISK_LIMIT` is a best-effort specialized classification emitted when
Peephole's live size watcher directly trips. A command may receive real ext4
`ENOSPC` while a post-failure `statfs` snapshot still reports non-zero
`bavail`/`ffree`, so Peephole does not infer the classification from that
snapshot or from stderr substring matching. Such failures retain
`INSTALL_FAILED` or `BUILD_FAILED`. The fixed-size ext4 capacity—not the API
error label—is the security boundary.

## Verification

Portable unit tests cover marker identity, admission, allocation/tool ordering,
exact mount and loop validation, partial setup cleanup, failure preservation,
read-only OCI root, bounded tmpfs options, reaper fail-closed behavior, and
conservative error mapping.

The opt-in real suite (`PEEPHOLE_REAL_GVISOR_TESTS=1`) additionally verifies:

- read-only `/home/sandbox` and `/var/tmp`;
- writable `/workspace` across install/build-style containers;
- hard ext4 ENOSPC behavior;
- `/tmp` and separately mounted `/dev/shm` byte-capacity exhaustion;
- bounded zero-byte-file metadata pressure under the sandbox memory and
  wall-clock limits, without persistent host-disk growth;
- `/dev` root and descendant write probes, standard device-node types, and
  `/dev/mqueue` unavailability;
- real `npm ci`, esbuild/Vite native execution, and `npm run build`;
- existing PID, memory, network, and orphan-recovery behavior.

Disk-intensive real-test directories use unique `mkdtemp` children under
`PEEPHOLE_REAL_GVISOR_TEST_ROOT`. The parent must be an existing, ordinary,
absolute test-only directory and must not overlap
`PEEPHOLE_GVISOR_BUNDLES_DIR` (default `/var/lib/peephole/jobs`). Without the
variable, tests retain an `os.tmpdir()` fallback for development hosts. The
hard-cap test logs blocks, free/available blocks, inode counts, fill-file
logical/allocated bytes, and image logical/allocated bytes for each AWS run.

## AWS deployment checks

Run these on the intended worker host and retain the output with the deployment
record:

```bash
df -B1 /var/lib/peephole/jobs /var/lib/peephole/artifacts
du -sb /var/lib/peephole/base-rootfs
findmnt -T /var/lib/peephole/jobs -o TARGET,SOURCE,FSTYPE,OPTIONS
sudo losetup --list --output NAME,BACK-FILE
sudo mkdir -p /var/lib/peephole/test-runs
sudo chmod 700 /var/lib/peephole/test-runs
sudo env \
  PEEPHOLE_REAL_GVISOR_TESTS=1 \
  PEEPHOLE_REAL_GVISOR_TEST_ROOT=/var/lib/peephole/test-runs \
  npm test -- \
  tests/realGvisorSandbox.test.ts \
  tests/realGvisorGoldenPath.test.ts
```

During the tmpfs test, separately sample the sandbox cgroup's
`memory.current`, `memory.peak`, and `memory.events`. Linux tmpfs pages are
normally memory-backed, but the exact gVisor/cgroup accounting observed on the
production runsc/kernel combination must be recorded rather than inferred from
OCI JSON alone.

runsc implements `/dev` using device-filesystem semantics and, on the verified
AWS host, reports a capacity unrelated to the OCI `size=` option. Peephole does
not treat `/dev` statfs capacity or the removed `/dev` size/inode options as a
security control. The enforced model is that uid 65534 cannot create arbitrary
regular files at `/dev` or in any descendant except the explicit, separately
bounded `/dev/shm` mount; `/dev/mqueue` is masked. The real suite emits a
`real-gvisor-dev-audit` record containing modes, ownership, file types,
capacities, `/tmp` byte and zero-file observations, optional cgroup memory
metrics, and write-probe results so this property is rechecked for every runsc
upgrade.

The verified runsc/gVisor version enforces the `size=` byte capacity on `/tmp`
and `/dev/shm`, but ignores tmpfs `nr_inodes=`: both mounts reported 243,867
files despite the smaller requested values. Peephole therefore no longer emits
or advertises an inode option as a security boundary. A bounded real test
creates at most 30,000 zero-byte `/tmp` files and confirms they do not appear in
the host rootfs or materially grow the persistent workspace. Metadata pressure
is bounded by the sandbox memory cgroup and per-command/job wall-clock limits;
the test never performs unbounded file creation. `memory.current`,
`memory.peak`, and `memory.events` are logged when gVisor exposes them, without
kernel-version-dependent numeric assertions.

After a deliberately interrupted job, verify that restart blocks until cleanup
completes and leaves no owned resources:

```bash
sudo runsc --root /var/run/peephole/runsc list --format json
sudo findmnt -rn -t ext4 | grep '/var/lib/peephole/jobs/' || true
sudo losetup --list --output NAME,BACK-FILE | grep '/var/lib/peephole/jobs/' || true
sudo find /var/lib/peephole/jobs -mindepth 1 -maxdepth 1 -print
```

## Production host requirements

- Ubuntu packages/utilities: `util-linux` (`fallocate`, `mount`, `umount`,
  `losetup`, `findmnt`), `e2fsprogs` (`mkfs.ext4`), plus the already-required
  `runsc`, `iproute2`, and iptables tooling.
- Kernel support: loop devices and `/dev/loop-control`, ext4, mount namespaces,
  cgroup v2, and the networking features already listed in the network security
  guide.
- Worker privilege: root or a deliberately validated capability set capable of
  loop setup, mount/unmount, chown, gVisor, and network namespace setup. The
  untrusted OCI process still receives none of those host capabilities.
- systemd: run only one worker owner per bundles root; ensure any
  `PrivateDevices` setting does not hide loop control; grant write access only to
  the configured bundles, artifacts, runsc state, and network-lease paths; and
  order the service after the filesystem containing bundles/artifacts is
  mounted. A `ProtectSystem` policy needs matching `ReadWritePaths`.

The post-reconciliation capability probe performs an actual preallocate,
losetup, ext4 format, verified mount, unmount, and detach. Production refuses to
start if any step is unavailable; it never falls back to polling-only mode.

## Remaining limits

- The hard cap bounds workspace capacity, not I/O rate; an attacker can still
  cause disk churn within the image.
- Base-rootfs copies and retained artifacts remain outside the per-job ext4
  cap. Admission/reserve and output limits bound running-job exposure, while
  artifact expiry and host monitoring remain required.
- Filesystem metadata outside the image and logs are small but not assigned a
  separate hard quota; the host reserve absorbs them.
- A local PostgreSQL data directory is not part of the job formula. If Postgres
  shares this host/volume rather than using the production remote database,
  its own reserve, quota, and monitoring are required.
- Loop/mount administration requires trusted host privileges. The sandbox never
  receives those devices or capabilities.
- Linux/gVisor enforcement cannot be proven on Windows. The real suites are a
  mandatory gate on the security branch before production deployment.

## References

- [losetup(8)](https://man7.org/linux/man-pages/man8/losetup.8.html) documents
  that `--find` is not atomic, recommends external locking, and describes
  `--nooverlap`. Peephole uses an atomic cross-process allocation directory
  lock plus `--nooverlap`.
- [mke2fs(8)](https://man7.org/linux/man-pages/man8/mke2fs.8.html) documents
  `-F` and the default superuser block reserve controlled by `-m`; Peephole
  formats only its newly allocated loop device and sets `-m 0`.
- [Linux tmpfs documentation](https://docs.kernel.org/filesystems/tmpfs.html)
  documents byte capacity and memory-backed behavior. Peephole relies only on
  the byte `size` behavior verified through its actual runsc/gVisor version,
  not the ignored inode option.
- [gVisor filesystem documentation](https://gvisor.dev/docs/user_guide/filesystem/)
  describes Gofer-backed bind mounts and mount configuration through OCI
  source/type/options.
