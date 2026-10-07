# Ephemeral Environment / Secrets (M10) — Design

**Status: Implemented and production-verified (M10-C4B complete, 2026-09-28).**
Generated-material policy/broker, tmpfs/OCI/bootstrap injection, strict
names-only plan validation, fail-closed supervisor orchestration,
exact-commit eligibility, and explicit production broker/filesystem/preflight/
reaper wiring exist for the four canonical names. The environment-gated
(`PEEPHOLE_REAL_GVISOR_TESTS=1`) real-host test harness in
`tests/realBackendRuntime.test.ts` -- proving child-environment injection,
`config.json`/argv non-leakage, tmpfs lifetime, trusted-bootstrap PID 1 signal
forwarding, `runsc --root` state non-persistence of the raw value, and bounded
orphan reaping -- has now run on the real production host and passed 4/4. A
real production FullStack preview was created against the pinned M10 fixture
(`The-peephole/peephole-fixture-fullstack@e10b08153e49d94a05931820c5325892754db246`),
independently derived `SESSION_SECRET` server-side from the pinned commit,
proved `/api/secret-check` returns only a SHA-256 digest, produced zero
journal hits for the fixture's deliberate raw-value stdout probe, and normal
`DELETE` cleanup passed. Separately, with a fresh preview from the same
fixture left `ready`, an intentional `peephole` main-process `SIGKILL` (not a
`systemctl stop`, not a `SIGTERM`-forwarding test -- that is verified through
the harness's normal `stop()` path above) was followed by full systemd
recovery, generated-secret/runsc/network/disk state ending at zero residue,
the `ready` durable-parent record coming back
`failed`/`ORCHESTRATION_UNAVAILABLE` without reconstructing lost
coordinates/secrets, and old-route revocation -- see D-032 for the full
record. **Correction (2026-10-07):** that `MainPID` was the tsx wrapper, so
systemd sent the actual server `SIGTERM` and its graceful shutdown handler
ran. That test was therefore not an ungraceful server crash -- see D-032's
correction note. D-032 is Accepted and `docs/MVP_ROADMAP.md` stage 10 is
checked complete.

This never relaxes `SECRET_ENV_REQUIRED`/`BACKEND_REQUIRED` for the static
`static-v1`/`static-v2` contract, never starts M11 (temporary database
support), and never weakens the `backend-v1` ingress-only network policy.

## 1. Scope

M10 lets a narrowly supported `backend-v1`/`fullstack-v1` preview receive a
small, fixed set of Peephole-*generated* ephemeral secrets. It does not turn
Peephole into a general secret manager. In scope:

- Peephole-owned infrastructure values (`PORT`/`HOST`/`NODE_ENV`) — already
  implemented, unchanged.
- Peephole-*generated* secrets, restricted to the existing narrow
  `preview-generated-candidate` allowlist already defined in
  `core/analyzer/environmentRequirements.ts`: `JWT_SECRET`, `SESSION_SECRET`,
  `COOKIE_SECRET`, `CSRF_SECRET`.

Explicitly out of scope for this first slice (see §7, §15):

- User-supplied external credentials (`user-required`).
- `database-requirement` variables (M11).
- `external-routing-candidate` variables.
- Any name outside the fixed four above, however it is classified.
- Any relaxation of backend-v1 egress.

## 2. Current data flow (audited against this repository)

**BackendRuntime (standalone `/v1/backend-runtimes`):**

```
HTTP POST /v1/backend-runtimes
  -> BackendRuntimeControlPlane.create/createForOrchestration
       (services/backend-runtime-api/controlPlane.ts)
  -> GitHubBackendRuntimePlanResolver.resolve (independent re-derivation;
       client input is only a hint, never trusted)
  -> createFingerprint() -- SHA-256 of {repositoryId, owner, name, commitSha,
       contractVersion, sourceRoot} only. No secret material today.
  -> InMemoryBackendRuntimeStore.create()   <-- process memory, NOT Postgres
  -> InMemoryBackendRuntimeQueue.enqueue()  <-- process memory, NOT Postgres
  -> BackendRuntimeWorkerLoop leases
  -> BackendRuntimeSupervisor.run()
       -> SandboxProvisioner.allocate() (GVisorSandboxProvisioner)
       -> install phase (npm ci, real gVisor container, egress-NAT'd)
       -> GVisorBackendRuntimeProcess.start()
            -> buildOciRuntimeSpec({ env: Object.entries(plan.platformEnvironment)... })
            -> writeFile(<bundleDir>/config.json, JSON.stringify(spec))
            -> runsc run --bundle <bundleDir>
```

**FullStackPreview (`/v1/fullstack-previews`):**

```
HTTP POST /v1/fullstack-previews
  -> FullStackPreviewControlPlane.create
  -> StoredFullStackPreview / QueuedFullStackPreview   <-- Postgres, durable
       (id, repository, frontendSourceRoot, backendSourceRoot, child ids,
        status, expiry ONLY -- no plan, no env, no secret, confirmed against
        services/fullstack-preview-api/ports.ts)
  -> FullStackPreviewWorkerLoop leases
  -> FullStackPreviewSupervisor.run()
       -> frontend.createForOrchestration({repository, contractVersion, target})
       -> backend.createForOrchestration({repository, contractVersion, sourceRoot})
            -- same BackendRuntime path as above, orchestrationKey = full-stack id
       -> routingActivator.activate() binds the published artifact and the
            process-local LiveBackendRuntimeRouteRegistry entry into a public
            fullstack-<uuid>.<domain> route
```

### What is durable today, and where a naive `secrets: Record<string,string>` would leak

| Object | Durable? | Where |
|---|---|---|
| `StoredFullStackPreview` / `QueuedFullStackPreview` | **Yes — Postgres** | `services/fullstack-preview-api/postgres/{previewStore,queue}.ts` |
| `StoredBackendRuntime` / `QueuedBackendRuntime` (includes `BackendRuntimePlan`, i.e. `platformEnvironment`) | **No — process memory only** (`InMemoryBackendRuntimeStore`/`InMemoryBackendRuntimeQueue`, wired directly in `services/production/server.ts`) | Node heap, wiped on restart |
| OCI `config.json` (`process.env` serialized from `plan.platformEnvironment`) | **Yes — real ext4 disk** | `<bundlesRootDir>/peephole-<id>/config.json`, default `bundlesRootDir` = `/var/lib/peephole/jobs` (`services/production/config.ts`), confirmed non-tmpfs via `docs/SANDBOX_DISK_SECURITY.md`'s `findmnt -T /var/lib/peephole/jobs -o ... FSTYPE` check (ext4) |
| Idempotency fingerprint | **Yes — held with the store row** | SHA-256 of non-secret identity fields only |
| Backend process stdout/stderr | **No** | Captured in a bounded in-memory `Buffer` by `NodeProcessRunner`; `waitForExit()` discards it (`{exitCode}` only); the one error path uses `error.message`, never `result.stdout`/`stderr` |

**Conclusion:** the Postgres-durable full-stack parent row is already narrow
and secret-free by construction — M10 must keep it that way (§12). The one
concrete, already-real plaintext-on-persistent-disk exposure is OCI
`config.json`, addressed in §9. Everything else in the current backend-v1
path is either process-memory-only (acceptable per §4's trust boundary) or
already discarded (stdout/stderr).

## 3. Critical persistence finding: OCI `config.json`

`services/preview-worker/gvisor/backendRuntimeProcess.ts` builds the full OCI
spec — including `process.env` derived verbatim from
`plan.platformEnvironment` — and writes it with a plain `writeFile()` to
`<bundleDir>/config.json`. `bundleDir` (`services/preview-worker/gvisor/sandboxDisk.ts`,
`LoopbackSandboxDiskManager`) is a direct child of `bundlesRootDir`
(`/var/lib/peephole/jobs` in production), which sits on the host's ordinary,
persistent ext4 filesystem — **not** tmpfs. Only the *workspace* subdirectory
inside a bundle is a separate loop-mounted ext4 image for `/workspace`; the
bundle directory itself, and `config.json` within it, are ordinary files on
durable disk.

This file is deleted only by `LoopbackSandboxDiskManager.destroyAllocation()`
(`rm(bundleDir, { recursive: true })`), which runs:

- on normal stop/cleanup (`GVisorSandboxProvisioner`'s `destroy()`, called
  from `BackendRuntimeSupervisor.run()`'s `finally` block);
- on periodic orphan reaping, gated by `maxAgeMs` (default 30 minutes) —
  `GVisorOrphanReaper.reap()`;
- unconditionally on every process startup — `GVisorOrphanReaper.reapAll()`,
  which `services/production/server.ts` awaits before any listener opens.

**Therefore: if `plan.platformEnvironment` (or any sibling field) ever
carried a secret value, that value would sit in plaintext on persistent disk
for the runtime's full lifetime, and would survive a host crash in plaintext
until the next process startup's `reapAll()` runs.** This is the central
constraint the whole design works around (§9). `core/preview/backendRuntimePlanValidator.ts`'s
`validatePlatformEnvironment` already hard-enforces "exactly PORT, HOST,
NODE_ENV" (`Object.keys(value).length !== 3`), which is a second, independent
reason `platformEnvironment` itself must never be extended — M10 uses a
wholly separate field and delivery path instead (§9, §12).

**Open, unverified question** (flagged per instructions, not assumed away):
whether `runsc`'s own internal state root (`runscRootDir`, default
`/var/run/peephole/runsc` — conventionally tmpfs-backed on the target Ubuntu
hosts, but never explicitly verified or asserted anywhere in this codebase or
its docs) retains its own copy of the OCI spec after `runsc run` starts. This
repository has no code or documentation that inspects or constrains that.
Because the design in §9 keeps `config.json`'s `process.env` unchanged (no
secret ever enters it), this question does not block the recommendation, but
it must be verified on a real host (real-`runsc` test gate, §14) before M10
can claim complete secret-at-rest protection.

## 4. Threat model

**Trust boundaries, stated explicitly:**

- The Peephole production host (the single EC2 instance running
  `services/production/server.ts`) is trusted. Root/operator access to that
  host is **outside** any guarantee this design makes — a host-root attacker
  can already read process memory, ptrace, or read disk.
- The Peephole server process necessarily sees a generated secret's plaintext
  at the point it generates it (§8) — there is no way around this for a
  self-generated value.
- The sandboxed backend process necessarily sees the secret(s) intended for
  it, in its own memory — that is the entire point of injecting them.
- Everything *between* generation and the sandboxed process's own memory is
  the actual surface this design minimizes: durable stores, queue rows, disk
  files, logs, error messages, and any other process's memory.

**What this design does NOT claim:**

- No deterministic memory zeroization. Node/V8 offers no guarantee that a
  string or buffer is scrubbed from the heap the instant it's no longer
  referenced; this design minimizes *lifetime and references*, not memory
  content after the fact.
- No protection against a malicious backend process copying its own injected
  secret into its own stdout, a file it writes inside `/workspace`, or (if it
  ever gained egress, which it structurally cannot — §4/§6) exfiltrating it.
  Redaction policy (§10) addresses only Peephole's own handling, never what
  the untrusted backend code itself chooses to do with a value it was
  legitimately given.
- No complete DLP (data-loss-prevention) of transformed/re-encoded secret
  copies anywhere in the system.

## 5. Requirement-kind policy for M10

| `EnvironmentRequirementKind` | M10 behavior |
|---|---|
| `auto-configurable` | Unchanged (already supported: `PORT`/`HOST`/`NODE_ENV`). |
| `preview-generated-candidate` | **Newly supported**, restricted to the exact fixed set `{JWT_SECRET, SESSION_SECRET, COOKIE_SECRET, CSRF_SECRET}` already named in `core/analyzer/environmentRequirements.ts`. No generalization from any other name, even one that also looks like a generated-secret pattern. |
| `user-required` | **Not supported in this first slice.** See §7 for the explicit reasoning. |
| `database-requirement` | Not supported. Remains M11 (§15). |
| `external-routing-candidate` | Not supported. Out of scope — not a secret concern, but still not acted on. |
| `unknown` | Not supported. |

`core/analyzer/backendRuntimeAdapter.ts`'s `findUnsupportedReason` currently
rejects *any* requirement whose `requirementKind !== "auto-configurable"`
(line ~111). M10 widens exactly one clause: a requirement is also acceptable
if `requirementKind === "preview-generated-candidate"` **and** its `name` is
in the fixed four-name set. Every other requirement kind keeps producing
"Execution: Not supported yet" exactly as today.

## 6. Architecture options

### Option A — Generated-only, in-process ephemeral broker + tmpfs/bootstrap OCI injection (RECOMMENDED)

Peephole generates the four allowlisted secret names itself, server-side,
with no new client-facing HTTP input at all. A process-local broker
(mirroring the existing `LiveBackendRuntimeRouteRegistry` pattern) holds the
plaintext only from generation until the sandboxed process starts. Injection
uses a new tmpfs-backed bind mount plus a trusted bootstrap entrypoint (§9)
instead of the OCI `process.env` array. No new durable schema, no new public
API surface beyond the existing `preview-generated-candidate` requirement
already being reported (read-only) since M7.

### Option B — Generated + user-supplied secret values in one slice

Adds a new authenticated HTTP surface for a client to submit values for
`user-required` names declared by the pinned commit. Requires: new request
validation, a decision on whether values ride the existing `Idempotency-Key`
semantics or a separate mechanism, a decision on whether values are ever
echoed back (they must not be), and — critically — a justification for why a
backend that cannot originate any outbound connection (§4, unchanged
ingress-only network policy) would ever have a use for a *third-party API
key*, since it can't reach the third party. The only class of `user-required`
value plausibly useful without egress is something the backend only
*verifies* locally (e.g., a shared verification key), which is a narrow
enough case that it does not justify building the entire submission/HTTP/
idempotency/redaction surface in the first slice.

### Comparison

| | Option A (generated-only) | Option B (+ user-supplied) |
|---|---|---|
| New HTTP surface | None | Yes — submission endpoint, auth, validation |
| New durable schema risk | None (names only, in the plan; no values ever durable) | Real — must keep values out of every idempotency/durable path under load-bearing new discipline |
| Replay/idempotency complexity | Effectively unchanged (§11) | New: same-key-different-value conflict handling required |
| Useful given ingress-only egress | Yes — generated secrets are consumed locally by the backend (signing/verifying its own tokens/cookies), never sent anywhere | Often **no** — most third-party credentials are useless without egress |
| Extension UX | None needed | New: secret input form, browser-side handling discipline |
| Supportability | Small, fully self-contained | Large: user error surface ("my key doesn't work"), support burden |

**Decision: Option A.** It is materially safer, has zero new external-input
attack surface, and every currently-supported name is actually usable by a
network-isolated backend (a signing/session/CSRF secret is consumed
entirely locally). Option B is deferred; if a future phase revisits it, the
network-isolation argument above should be re-examined per credential class,
not decided as a single blanket toggle.

## 7. Recommended first slice: generated-secrets only

Confirmed explicitly: **the M10 first production slice is generated-secret
support only** (`JWT_SECRET`/`SESSION_SECRET`/`COOKIE_SECRET`/`CSRF_SECRET`).
User-supplied secrets are not part of this slice and are not designed in
detail here beyond the comparison in §6.

## 8. Ephemeral secret broker

**Process topology precondition (verified):** `services/production/server.ts`
runs the Preview API, the static worker, the backend-runtime worker, and the
full-stack worker in **one single Node process** (`main()`). Backend and
full-stack worker concurrency are both hard-coded to 1. This is the same
precondition `LiveBackendRuntimeRouteRegistry` (`services/backend-runtime-worker/liveRuntimeRegistry.ts`)
already relies on as a process-local, non-durable, injected singleton for a
different piece of runtime-only state (the live dial target). The secret
broker reuses that exact pattern rather than inventing a new one.

```ts
// services/backend-runtime-worker/secretBroker.ts (M10-A; internally wired by M10-C2)

export interface GeneratedSecretMaterial {
  readonly runtimeId: string
  readonly values: ReadonlyMap<PreviewGeneratedSecretName, OpaqueSecretValue>
}

export interface BackendRuntimeSecretBroker {
  /** Generates fresh CSPRNG material for exactly the names the
   * independently-resolved plan declares. Called once per runtime, by the
   * worker, never by anything client-facing. */
  issue(
    runtimeId: string,
    names: readonly PreviewGeneratedSecretName[],
  ): GeneratedSecretMaterial

  /** Single-consumer read-then-delete. Returns null if nothing was ever
   * issued, it was already consumed, or the process restarted since --
   * callers MUST fail closed (§13), never fall back to omitting secrets
   * silently. */
  take(runtimeId: string): GeneratedSecretMaterial | null

  /** Idempotent; safe to call even if nothing was ever issued. Called from
   * every cancellation/failure/cleanup path. */
  discard(runtimeId: string): void
}
```

- **Keying:** `runtimeId` — the same UUID `BackendRuntimeControlPlane`
  already mints after all admission/idempotency/ownership checks have
  passed. The broker trusts nothing about *how* that id was authorized; it
  is consulted only by the one supervisor codepath that already owns it.
- **Identifiers persisted?** No. The broker itself is never written to
  Postgres or to `InMemoryBackendRuntimeStore`; it exists only as a private
  process-local `Map`. M10-C3 constructs exactly one broker in the production
  composition root and passes that explicit instance to the backend runtime
  supervisor; no module-level/global/durable fallback exists.
- **Ownership binding:** implicit, via `runtimeId` — no separate
  repository/commit/sourceRoot/orchestration-key check is needed because the
  control plane has already bound `runtimeId` to exactly one
  requester+repository+commit+(optional orchestration key) before the
  supervisor ever sees it.
- **Expiry:** no independent TTL. `issue()` happens once, at the START phase
  (`BackendRuntimeSupervisor.fetchInstallStart`, immediately before
  `runtimeProcessStarter.start()`); the supervisor then calls `take()` exactly
  once and passes only that destructively consumed material to the process
  starter. The window between issue and take is one in-process function call,
  not a network round trip.
- **Single-consumer vs. reusable:** strictly single-consumer (`take`, not
  `get`). A retried/duplicated start attempt can never re-read material
  already handed to a previous attempt.
- **Cancellation cleanup:** `BackendRuntimeSupervisor.run()`'s existing
  `finally` block already does
  `this.liveRuntimeRegistry.unregister(queued.runtimeId)` unconditionally,
  first, before any other teardown. M10-C2 calls
  `secretBroker.discard(queued.runtimeId)` immediately beside it — same
  placement, same idempotency guarantee, same
  "runs on every exit path" property (normal stop, cancel, expiry,
  control-plane-unreachable abort, a start/readiness failure that never
  issued anything, or an unexpected process exit). A discard failure is
  swallowed so process/container/workspace teardown always continues.
- **Successful-start cleanup:** `take()` itself deletes the entry, so by the
  time `BackendRuntimeProcessStarter.start()` is called, nothing remains in
  the broker for that `runtimeId` regardless of what happens afterward.
- **Startup/restart behavior:** the broker is a plain `Map` recreated empty
  on every process start. It cannot contain stale material from a previous
  process by construction. This is consistent with the *already-existing*
  fact that `InMemoryBackendRuntimeStore`/`InMemoryBackendRuntimeQueue` are
  wiped on restart too, and that any full-stack parent still referencing a
  now-vanished backend runtime is already reaped fail-closed by
  `FullStackPreviewStartupReconciler`. **A server restart clearing all
  secret material is acceptable and consistent with existing M9 behavior; it
  introduces no new fragility.**
- **Orphan cleanup:** none needed independently — every producer has a
  matching consumer or `discard()` in its own `finally`, and the broker
  itself never outlives the process.
- **Concurrency:** production concurrency is 1 today; the interface is still
  specified as atomic single-consumer so a future concurrency increase does
  not silently reintroduce a race.
- **Maximum retained bytes:** bounded per-entry by §11's byte limits, and the
  number of live entries is already bounded by `maxActiveRuntimesPerRequester`-style
  admission (one active runtime per requester by default) — no unbounded
  growth path.
- **Fail-closed behavior on restart mid-flight:** if a process restart
  happens between `issue()` and `take()` (vanishingly small window, but
  possible under a forced deploy), the restarted process's worker loop
  recovers the queued/leased job per existing reconciliation, re-runs
  `startWorkerRuntime`, and reaches START again — which calls `issue()`
  again, generating **fresh** material. This is safe (fresh random secrets,
  never reused) and requires no special-casing beyond what `BackendRuntimeSupervisor`
  already does for recovered runs (`options.recovered`).

## 9. OCI / gVisor injection design

**The constraint restated:** `config.json`'s `process.env` must never gain a
secret value, because `bundleDir` (and therefore `config.json`) lives on
persistent ext4 disk (§3), not tmpfs, and is deleted only on normal
cleanup/reap/restart — none of which is "immediately after the value is no
longer needed."

**Recommended approach — tmpfs bind mount + trusted bootstrap entrypoint:**

1. **Host side, immediately before `runsc run`:** create a fresh,
   dedicated, per-runtime directory under a tmpfs-backed host path (e.g.
   `/run/peephole/secrets/<runtimeId>` — `/run` is conventionally tmpfs on
   the target Ubuntu hosts, and is already a *distinct* path from
   `bundlesRootDir`/`/var/lib/peephole/jobs`, which is confirmed
   ext4-persistent). Mode `0700`, owned by the same `SANDBOX_UID`/`SANDBOX_GID`
   already used for the workspace mount (`sandboxWorkspaceOwnership.ts`).
   Write one file inside it (mode `0600`) containing the secret names/values
   the broker's `take()` returned, in a fixed, simple format the bootstrap
   parses (e.g. `NAME=value\n` per line, values already free of control
   characters by construction — §11).
2. **OCI spec (`ociConfig.ts`):** add exactly one new entry to `mounts[]` —
   destination `/run/secrets` (a name the base rootfs image reserves, never
   writable by the sandboxed user beyond what's bind-mounted), `type:
   "bind"`, `source:` the host tmpfs directory from step 1, `options: ["bind",
   "ro", "nosuid", "nodev", "noexec"]`. This is additive and structurally
   identical to the existing `/etc/resolv.conf` bind mount already in this
   file — no new mount *type* is introduced. `process.env` is **completely
   unchanged** — still exactly `PORT`/`HOST`/`NODE_ENV`, so
   `validatePlatformEnvironment`'s "exactly 3 keys" invariant needs no
   change at all.
   **(M11-C3 update:** this mount is now onto `/run/secrets/env` specifically
   — an individual file bind onto a fixed placeholder baked into the base
   rootfs, source the runtime's `env` file rather than its containing
   directory — so it can coexist with M11's own `/run/secrets/database-url`
   mount without one nesting inside the other. Sandbox-visible behavior is
   unchanged; see `docs/TEMPORARY_DATABASES.md` section 15.)
3. **`process.args`:** change from `[SANDBOX_NODE_BINARY, ...plan.start.args]`
   to `[SANDBOX_NODE_BINARY, "/opt/peephole/secret-bootstrap.js",
   ...plan.start.args]` — a fixed, Peephole-authored file baked into the
   base rootfs image (`baseRootfsImage`), never user-controlled, never part
   of the extracted repository. Only present in the spec when
   `plan.generatedSecretNames` (§12) is non-empty; otherwise the entrypoint
   is unchanged from today.
4. **The bootstrap script itself** (new, small, reviewed, part of the base
   rootfs build — `scripts/gvisor/build-base-rootfs.sh`'s output, not a
   runtime download): reads `/run/secrets/env`, sets each `NAME=value` into
   its own `process.env` in memory, then `execve()`s (Node: `child_process`
   is not appropriate here — use a direct `process.exec`-style replace, or
   if Node cannot exec-replace itself, spawn the real entrypoint as a direct
   child with `stdio: "inherit"` and mirror its exit code/signal) the real
   `node <entrypoint>` with that augmented environment. The bootstrap never
   writes the values anywhere else, never logs them, and never accepts them
   from argv.
5. **Host-side cleanup:** delete the per-runtime tmpfs directory
   (`rm -rf /run/peephole/secrets/<runtimeId>`) at the same point
   `deleteContainer()`/`cleanupAfterExit` already runs in
   `backendRuntimeProcess.ts` — i.e., once `runPromise` resolves (process
   exited) or `stop()` is called. This bounds the plaintext-on-tmpfs window
   to "about to start" through "exited/stopped," not the job's full
   lifetime, and even within that window the bytes are memory-backed, never
   written to persistent disk. A crash mid-run leaves at worst a leaked
   tmpfs directory on a still-live host; that is addressed by a new,
   narrow reaper sweep analogous to `GVisorOrphanReaper` (§14), and vanishes
   entirely on host reboot since it is tmpfs.

### Option comparison

| | **A: tmpfs bind mount + bootstrap (recommended)** | B: inherited FD/pipe | C: whole-`bundleDir` on tmpfs |
|---|---|---|---|
| Secret at rest | Memory-backed only (tmpfs); never in `config.json` | Never touches disk (best in theory) | Memory-backed, but for the *entire* bundle |
| argv exposure | None (bootstrap reads a fixed mount path) | None | None |
| `/proc` exposure | Final node process's own `/proc/<pid>/environ` legitimately shows it (unavoidable, matches §4's trust boundary); host-side `runsc run` process never does | Open FD visible in `/proc/<pid>/fd/` (metadata only) | Same as A for the final process |
| Bundle (`config.json`) persistence | Unchanged — zero new exposure | Unchanged | N/A — bundle itself no longer persists, but neither does anything else in it (workspace.img, staging) |
| runsc internal state persistence | Open question (§3), but moot: the spec's `env` never carries the secret either way | Open question, likely moot for the same reason if achievable | Same open question |
| Cleanup complexity | Low — one new host dir + one `rm -rf`, symmetrical with existing container cleanup | Unknown — depends on unverified runsc FD-passing support | High — changes the disk-accounting/admission model for every job, not just secret-bearing ones |
| Crash recovery | Safe — tmpfs vanishes on reboot; live-host leak addressed by a new bounded reaper | Unknown | Safe, but see blast radius below |
| Compat with current `GVisorBackendRuntimeProcess` | High — additive `mounts[]` entry + one new `process.args` element; no interface change | Low — `NodeProcessRunner`/`runscCli.ts` do not plumb extra FDs into `runsc run` today; gVisor's OCI implementation only supports FD passing via `listenFds` (socket-activation-specific), a materially different, unverified mechanism | N/A (rejected before reaching this axis) |
| Testability | High — portable tests can assert `config.json` never contains a planted secret marker; a real-gVisor test can assert the mount is gone post-cleanup and the process actually received the value | Cannot be verified without deep runsc-internals research | High for the tmpfs property itself, but reopens `sandboxDisk.ts`'s entire admission-math audit |
| Required privileges | None beyond what's already used for the existing `/tmp`/`/dev/shm`/`/etc/resolv.conf` bind mounts | None extra, but high implementation risk | None extra, but changes host RAM accounting for the ext4-quota model `docs/SANDBOX_DISK_SECURITY.md` documents |

**Rejecting C explicitly:** `bundlesRootDir` also holds `workspace.img` (up
to `hardLimitBytes`, default 1 GiB) for *every* job, secret-bearing or not.
Moving it onto tmpfs would consume real host RAM proportional to concurrent
job workspace sizes and would require re-deriving `sandboxDisk.ts`'s entire
admission model (`assertFreeSpace`, `minimumHostReserveBytes`) against RAM
instead of disk — far too large a blast radius for a narrow first slice.

**Rejecting B for the first slice:** blocked on an unverified runsc
capability and would require new `ProcessRunner`/`runscCli.ts` plumbing this
codebase does not have today. Worth revisiting only if independently
verified against a real host as a future hardening, not a first-slice
requirement.

## 10. Logging / redaction policy

**Backend process stdout/stderr — the real risk this section addresses.**
A backend can trivially do `console.log(process.env.SESSION_SECRET)`.
Audited: `NodeProcessRunner.run()` captures `runsc run`'s (and therefore the
foreground sandboxed process's) stdout/stderr into a bounded in-memory
`Buffer`, but **`backendRuntimeProcess.ts` never logs or persists it today**
— `waitForExit()` discards it (`{ exitCode }` only), and the one error path
uses `error.message`, never `result.stdout`/`result.stderr`. **Policy: M10
must not change this.** No code path may add `console.log`/journal output of
a backend-v1 runtime's captured stdout/stderr, unconditionally — not just
"while secrets are active," since there is no reliable distinct flag for
that and the current safe behavior (never log it) is strictly simpler and
already correct. If a future feature wants to surface backend output to the
*requester* (not to Peephole's own logs/journal), that is out of scope for
M10 and needs its own dedicated security review.

**No claim of complete DLP.** Even if this were ever revisited, a
transformed or re-encoded copy of a secret (base64, hex, string
concatenation, partial substring) cannot be perfectly redacted by substring
matching against the known plaintext. "We redact known secret values from
logs" must never be treated as a complete guarantee — not logging the stream
at all (the current and recommended state) is the only complete guarantee.

**Peephole's own logs.** Existing `console.error` call sites (the Phase 2/3
GitHub-upstream-failure logs in `controlPlane.ts` files, the worker-loop
error logs in `server.ts`) already never reference `plan`, `platformEnvironment`,
or any secret-shaped value. M10 must not introduce a call site that logs the
new broker's contents, `GeneratedSecretMaterial`, or `OpaqueSecretValue`.
The `OpaqueSecretValue` type (§12) is deliberately not a plain `string` —
its only accessor is an explicit `.reveal()` call — specifically so an
accidental `console.log(someObjectThatHappensToContainIt)` is far more
likely to print an opaque object shape than a raw value. This is
belt-and-suspenders, not a substitute for "never log the stream."

## 11. Idempotency semantics

`createFingerprint()` (`services/backend-runtime-api/controlPlane.ts`)
already hashes only non-secret identity fields
(`repositoryId, owner, name, commitSha, contractVersion, sourceRoot`).
**Decision: M10 does not add anything to this fingerprint.** Because the
first slice adds **no new client-supplied field** at all — the server alone
decides, from its own independent re-derivation of the pinned commit's
`.env.example`-declared requirements, which of the four generated names
apply — there is no new "same key, different secret values" case to solve.
`CreateBackendRuntimeRequest` is unchanged.

- **Retry with the same idempotency identity:** reuses the existing active
  runtime exactly as today (`getActiveByFingerprint`/`getActiveByOrchestrationKey`);
  unchanged, zero new surface.
- **Replay after secret lease consumption:** not reachable in the first
  slice — nothing about secrets is client-visible or replayable; a retried
  `create()` either reuses the still-active runtime (which already consumed
  its own secrets once, internally) or, if terminal, is a genuinely new
  runtime that generates fresh secrets.
- **Process restart after durable job creation but before secret
  consumption:** covered in §8 — the runtime itself is not durable today
  (in-memory store), so this collapses into the already-existing
  "restart loses in-flight backend runtimes, fail-closed reconciliation
  handles it" behavior. No stale-secret-reuse path exists because there is
  no durable secret to reuse.
- **Client loses the first HTTP response and retries:** identical to
  today's existing idempotent-reuse behavior; `BackendRuntime`'s public
  shape never includes secret material, so nothing sensitive changes hands
  differently on a retry.

**Forward note for a possible future user-supplied-secret phase (not
designed here):** secret *values* must be excluded from the idempotency
fingerprint; only secret *names* (not values) should join the hashed
fingerprint input, so "same key, different declared names" is correctly
treated as the existing `CONFLICT`/409 case. Do not hash low-entropy
user-supplied values, even salted — that is an offline-guessable oracle for
low-entropy secrets. This is explicitly deferred, not part of this slice.

## 12. API / type design (production-code path active; real-host and production verified)

Design goal: secrets and public config are distinct types; nothing
secret-shaped is reachable through a type that is also serialized to
Postgres, a queue row, or an HTTP response.

```ts
// types/backendRuntimeSecrets.ts (NEW)

export type PreviewGeneratedSecretName =
  | "JWT_SECRET" | "SESSION_SECRET" | "COOKIE_SECRET" | "CSRF_SECRET"

/** Opaque by construction: no toJSON, no implicit string coercion path.
 * The only way to obtain the raw bytes is the explicit `.reveal()` call,
 * used in exactly one place (the OCI/tmpfs injection step, §9). */
export interface OpaqueSecretValue {
  readonly __brand: "OpaqueSecretValue"
  reveal(): string
}

/** Server-only. NEVER added to CreateBackendRuntimeRequest, BackendRuntime,
 * BackendRuntimePlan's serialized form, QueuedBackendRuntime, or any type
 * that crosses an HTTP response or a durable store. */
export interface GeneratedSecretMaterial {
  readonly runtimeId: string
  readonly values: ReadonlyMap<PreviewGeneratedSecretName, OpaqueSecretValue>
}
```

```ts
// types/backendRuntime.ts (CHANGED — additive only)

export interface BackendRuntimePlan {
  // ...unchanged fields...
  platformEnvironment: { PORT: string; HOST: string; NODE_ENV: string } // UNCHANGED
  /** Names only, never values. Safe to log, persist, and hash -- exactly
   * like `adapterId`. Determines which broker entries the worker expects
   * and which tmpfs mount the OCI spec receives (§9). Empty array when the
   * candidate declares no eligible generated-secret requirement. */
  generatedSecretNames: readonly PreviewGeneratedSecretName[]
}
```

```ts
// services/backend-runtime-worker/secretBroker.ts (NEW)
// -- full interface in §8 --
```

```ts
// services/preview-worker/gvisor/backendRuntimeProcess.ts (CHANGED signature)

export interface BackendRuntimeProcessStarter {
  start(
    workspace: LocalPreviewWorkspace,
    plan: BackendRuntimePlan,
    secrets: GeneratedSecretMaterial | null, // NEW — null when generatedSecretNames is empty
  ): Promise<RuntimeProcessHandle>
}
```

`core/preview/backendRuntimePlanValidator.ts` gains a small validator for
`generatedSecretNames` alongside the existing `validatePlatformEnvironment`:
bounded array (≤ 4, matching the fixed allowlist size), every element in the
fixed set, no duplicates — the same "narrowest possible allowlist" style
already used there.

**M10-C1 implementation status:** this names-only field and validation were
added. At that stage the reachable adapter still emitted
`generatedSecretNames: []` and rejected every non-`auto-configurable`
environment requirement; M10-C3 below is the later eligibility change.

**M10-C2 implementation status:** the supervisor provides a fail-closed
internal path for synthetic, already-validated non-empty plans: it issues once,
destructively takes once, validates the material/runtime/name correspondence,
and passes only the taken material to the process starter. Missing broker,
missing material, duplicate/stale issuance, or an equivalent lifecycle failure
produces `SECRET_UNAVAILABLE`; unconditional best-effort discard remains beside
route revocation. The ownership boundary is explicit: the supervisor owns
`issue -> take -> pass material`, while the process starter owns
`material -> tmpfs/OCI/bootstrap delivery`.

**M10-C3 implementation status:** exact-commit environment-template analysis
now admits only server-exposed `preview-generated-candidate` requirements whose
names pass the canonical generated-secret policy, and derives a deterministic
names-only plan array. `services/production/server.ts` owns one process-local
broker and one `TmpfsGeneratedSecretFilesystem`, with the configured bundles
and artifact roots explicitly forbidden. Startup performs the generated-secret
capability check and fail-closed `reapAll()` before worker construction or any
listener; bounded maintenance calls `reap()` with the existing orphan age.
FullStack gains no secret field and reuses its backend child's existing runtime
path. At the C3 stage, real-host tmpfs/bootstrap/runsc behavior,
trusted-bootstrap PID 1 signal semantics, and `runsc --root` persistence
inspection remained unverified, and production deployment had not occurred.
M10-C4A (harness) and M10-C4B (real-host/production execution), below,
completed that verification; D-032 is Accepted and M10 is complete.

**M10-C4A implementation status:** an environment-gated
(`PEEPHOLE_REAL_GVISOR_TESTS=1`) real-host harness now exists in
`tests/realBackendRuntime.test.ts`, reusing the existing real-backend suite's
resource-ownership/cleanup model rather than a parallel harness. It exercises
the real `issue -> take -> GVisorBackendRuntimeProcess.start()` lifecycle with
one CSPRNG-generated `SESSION_SECRET`, a dedicated tmpfs-backed secret root
under `/run/peephole/real-gvisor-secrets-*` (never production's own
`/run/peephole/secrets`), and a dedicated per-test `runsc --root` state
directory (never the shared production-default root the pre-existing suite
otherwise uses) so the new persistence-inspection assertions read only
this-test-owned state. It proves: the sandboxed child actually receives the
value (via a SHA-256 digest only, never the raw value, over `/secret-check`);
`config.json`'s serialized bytes and `process.args` never contain the raw
value; `process.env` in the OCI spec stays exactly platform-only; the one
expected `/run/secrets/env` read-only bind mount is present (an individual
file bind as of M11-C3, narrowed from a directory bind onto `/run/secrets`
itself); the host tmpfs
directory and file have the expected `0700`/`0600` sandbox-owned permissions
while running and are gone after `stop()`; a bounded, symlink-refusing,
device/socket-skipping scan of the dedicated runsc state root finds the raw
value neither while the container is active nor after it is deleted; and a
narrow ingress-only regression assertion (no default route in the runtime's
network namespace) accompanies the unchanged pre-existing egress-denial suite,
which continues to run in the same file. A separate narrow test proves
`GeneratedSecretOrphanReaper` reaps only a backdated, test-created,
runtime-id-shaped directory from a real tmpfs root, leaving a fresh entry, an
unrelated non-runtime-shaped entry, and the root itself untouched. No test
output ever contains the raw generated value, even in assertion-failure text
(every raw-value comparison reduces to a boolean before reaching an
assertion). **None of this had been run against a real Linux/gVisor host in
the C4A slice** -- the suite remained `describe.skipIf`-gated and was only
confirmed to load, typecheck, and skip correctly in the portable environment
at that point. M10-C4B, below, is the real-host execution of this harness.

**M10-C4B production verification status (complete, 2026-09-28):** the
M10-C4A harness above was run against a real Linux/gVisor host (production
SHA `ef466d09ce91857b5bb8dfa35b77cc9207086468`) and passed 4/4: the full
issue-to-take-to-`GVisorBackendRuntimeProcess.start()` lifecycle, tmpfs
injection with correct permissions and post-`stop()` removal, `config.json`/
`process.args`/OCI `process.env` non-leakage, the bounded
symlink-refusing/device-skipping scan finding the raw value absent from the
dedicated `runsc --root` state both while active and after deletion (see
§18, Open Question 1), the ingress-only network regression, and the orphan
reaper reaping only the intended entry. Beyond the harness, a real production
FullStack preview was created from the pinned fixture
`The-peephole/peephole-fixture-fullstack` at commit
`e10b08153e49d94a05931820c5325892754db246` (repository id `1371618449`),
which declares exactly `SESSION_SECRET` and exposes `/api/secret-check`: the
server derived and delivered the value with no client input, `/api/hello`
and `/api/secret-check` both returned 200 with `configured: true` and a
SHA-256 digest only, and a full journal scan for the fixture's deliberate
`PEEPHOLE_M10_SECRET_LOG_PROBE:<value>` marker found zero occurrences both
before and after the run. Normal `DELETE` cleanup was verified, and,
separately, the Peephole service's systemd `MainPID` was intentionally
`SIGKILL`ed, with the M10 FullStack preview above still `ready`, to exercise
crash recovery: systemd's existing `Restart=on-failure` brought the service
back automatically, generated secrets/runsc sandboxes/network namespaces/disk
state ended at zero residue (see the 2026-10-07 correction below for which
code path ran), the durable FullStack parent that had
been `ready` came back `failed`/`ORCHESTRATION_UNAVAILABLE` after
restart/reconciliation without process-local backend coordinates or secrets
ever being reconstructed, its old backend route returned 404 afterward, and
the final production host smoke
(`npm run smoke:production:host`) passed completely -- after an initial
run inside the smoke tool's unmodified default 15-minute lookback window
correctly reported `BLOCKED` on two expected worker-error lines produced by
the intentional `SIGKILL` boundary itself; no smoke setting was overridden,
no new errors appeared, and re-running the identical, unmodified command
once those two log lines aged out of the window produced a clean
`PRODUCTION SMOKE PASS` (see docs/PRODUCTION_SMOKE.md and
docs/TEST_PLAN.md for the full record). D-032 is Accepted and M10 is
complete for the four canonical generated-secret names as of 2026-09-28.

While building this harness, static review of `GVisorBackendRuntimeProcess`
found that `stop()` unconditionally sent `runsc kill ... SIGKILL` to every
backend runtime, including one started through the trusted secret bootstrap.
`SIGKILL` cannot be caught, so the bootstrap's `SIGTERM`/`SIGINT`/`SIGHUP`
forwarding logic (`scripts/gvisor/secret-bootstrap.mjs`, already portable-
tested in `tests/secretBootstrap.test.ts`) could never actually run in
production -- directly contradicting this document's own open question about
verifying PID 1 signal semantics (see §18). This was fixed at the narrowest
possible point: `runscKillArgs()` (`services/preview-worker/gvisor/runscCli.ts`)
now takes an explicit signal, defaulting to the previous `SIGKILL` everywhere
else (`GVisorOrphanReaper`, `GVisorSandboxProvisioner`, `RunscCommandRunner`
timeout cancellation all keep forceful semantics, correctly, since none of
them run a persistent server through the bootstrap); only
`GVisorBackendRuntimeProcess.stop()` now sends `SIGTERM` and waits a bounded
grace period (`stopGraceMs`, default 5s, races against the container's own
exit) before the existing unconditional `runsc delete --force` backstop
proceeds regardless -- so a hung or non-cooperating process is still
guaranteed to be force-terminated within a bounded time, and every existing
process (none of which install a `SIGTERM` handler) still dies immediately,
unchanged. This is covered by new portable regression tests
(`tests/gvisorAdapter.test.ts`, `tests/backendRuntimeProcess.test.ts`) proving
the signal choice and the bounded-wait behavior; the real-host secret test
above is the first scenario that actually depends on a caught, forwarded
signal reaching a child process. M10-C4B exercised this fix against real
runsc through the real-gVisor suite's normal `RuntimeProcessHandle.stop()`
path, confirming the trusted bootstrap's `SIGTERM` forwarding actually reaches
the sandboxed child under real runsc PID 1 semantics. That harness path
remains the only evidence for trusted-bootstrap `SIGTERM` forwarding.

**Correction (2026-10-07, found during M11-E6 preparation).** This document
previously said the intentional production `MainPID` `SIGKILL` test "kills
the Peephole service process itself, which cannot call `stop()` on
anything", and that every orphaned runtime it reconciled went through the
forceful reaper paths. That interpretation was wrong.
- `peephole.service` runs `ExecStart=…/node_modules/.bin/tsx
  services/production/server.ts`, so the systemd `MainPID` is the tsx CLI
  wrapper. The actual server is the wrapper's child Node process, in the
  same cgroup.
- `systemctl kill --kill-who=main --signal=SIGKILL` killed only the
  wrapper. `KillMode=control-group` then sent the surviving server
  `SIGTERM`.
- The 2026-09-28 journal shows the server logging `[peephole] received
  SIGTERM, shutting down...`. Its shutdown handler then aborted the workers
  (producing the two worker-loop error lines, including `Backend runtime
  stop command failed.`), before systemd recorded `Failed with result
  'signal'` and restarted the unit.

The server's graceful shutdown path therefore ran and may have performed
some of the observed cleanup. These outcomes remain valid: the automatic
restart, startup reconciliation running, the
`failed`/`ORCHESTRATION_UNAVAILABLE` parent with nothing reconstructed, the
`404` old route, zero final residue, and the eventual smoke pass. The test
is **not** evidence that no graceful shutdown handler ran. The first valid
pure ungraceful server-process crash evidence is M11-E6 (D-033,
docs/TEMPORARY_DATABASES.md section 19), which sent `SIGKILL` to the
verified server child only.

### Bounds (env-name and value safety)

A name is only ever accepted when it simultaneously:

1. was declared by the exact pinned repository/commit/sourceRoot (already
   true — `generatedSecretNames` is derived server-side from the same
   independent re-resolution `platformEnvironment`/`adapterId` already use,
   never client input);
2. exists in `environmentRequirements` for that source root;
3. has `requirementKind === "preview-generated-candidate"`;
4. is one of the four fixed literal names — never a pattern match, never
   "contains SECRET";
5. has `exposure === "server"` (categorically true for these four names,
   which never match the `VITE_`/`NEXT_PUBLIC_` client-public prefix — still
   enforced defensively, not just incidentally true);
6. does not collide with a Peephole-controlled name (`PORT`, `HOST`,
   `NODE_ENV` — trivially disjoint from the fixed four, enforced as an
   explicit invariant so a future name addition inherits the check rather
   than relying on incidental non-overlap);
7. passes a fixed reserved-name blocklist, so any future widening of this
   allowlist inherits the same fail-closed gate: `NODE_OPTIONS`, `NODE_PATH`,
   `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `HOME`, `SHELL`, `ENV`,
   `BASH_ENV`, anything starting with `NPM_CONFIG_`/`npm_config_`, anything
   starting with `PEEPHOLE_`, and anything not matching
   `^[A-Z][A-Z0-9_]{0,63}$`.

Bounds (deliberately small and defensible, not tuned for a future
user-supplied phase):

| Bound | Value |
|---|---|
| Max secret count per runtime | 4 (current fixed allowlist size) |
| Max variable name length | 64 bytes |
| Max individual value size | 4096 bytes |
| Max total secret bytes per runtime | 16 KiB |
| NUL/control characters | Rejected outright; generated values are base64url (no padding) or hex encoded specifically so they can never contain one by construction |

## 13. Generated-secret details

- **RNG:** `node:crypto`'s `randomBytes` — the same CSPRNG primitive this
  codebase already uses for ids (`randomBytes(4)`/`randomBytes(16)` in
  `backendRuntimeProcess.ts`, `gvisorSandboxProvisioner.ts`, `subnetAllocator.ts`).
- **Minimum entropy:** 256 bits (32 raw bytes) per value.
- **Output encoding:** base64url, unpadded — compact, safe inside the tmpfs
  `NAME=value` file, safe as an environment-variable value, contains no
  control characters and no shell metacharacters by construction.
- **Generation timing:** at the worker's START phase
  (`BackendRuntimeSupervisor.fetchInstallStart`), immediately before
  `runtimeProcessStarter.start()` — never at admission/control-plane time,
  never stored alongside the plan.
- **Ownership/lifetime:** owned entirely by the broker (§8), generated fresh
  per runtime, never reused across runtimes or across a restart.
- **Cleanup timing:** consumed (single read+delete) by the supervisor before
  `start()`; discarded unconditionally in the supervisor's `finally` block
  otherwise.
- **Restart behavior:** wiped with the rest of the in-memory backend-runtime
  state; a recovered run regenerates fresh material (§8).
- **Browser exposure:** never. `toPublicRuntime()` (`controlPlane.ts`)
  already excludes `plan` from `BackendRuntime`'s public shape;
  `generatedSecretNames` (names only) may safely be added if useful for
  client display, but no value ever crosses that boundary.

## 14. Failure semantics

| Case | Code | Public message | Notes |
|---|---|---|---|
| Broker has nothing for this `runtimeId` at consume time (restart, double-consume, bug) | `SECRET_UNAVAILABLE` (**new** `BackendRuntimeErrorCode`) | "The backend runtime's secret material is no longer available. Start a new preview." | Fail closed — never start the process without its declared secrets. |
| In-sandbox bootstrap cannot read/parse the mounted secret file | `RUNTIME_START_FAILED` (**existing** code, reused deliberately — indistinguishable from any other start failure to a client, and reusing the existing category is correct here, not a repurposing) | "The backend process could not be started." | Never includes bootstrap internals, mount paths, or file contents. |
| Repository declares a generated-secret name outside the fixed four, or a `user-required`/`database-requirement`/`external-routing-candidate`/`unknown` name | `UNSUPPORTED_BACKEND` (**existing** code — this is exactly today's "unsupported requirement" rejection, just with a narrower carve-out) | Existing message, unchanged | No new code needed; §5's allowlist is the only change. |
| A client-public (`VITE_`/`NEXT_PUBLIC_`) name that also happens to look secret-like | `UNSUPPORTED_BACKEND` | Existing message | Never "solved" by injecting a value into a static build — stays categorically blocked (§ frontend safety, below). |

No error message ever includes a secret name in a way that reveals its
*value*, and never a value itself. `SECRET_UNAVAILABLE`/`RUNTIME_START_FAILED`
are user-fixable-by-retry (transient orchestration loss); `UNSUPPORTED_BACKEND`
is a durable input error (the repository's declared requirement is not
eligible) — the existing distinction this codebase already makes between
those categories is preserved, not blurred.

## 15. Frontend safety

Unchanged and explicitly reaffirmed: a server secret must never reach a
static frontend artifact. `generatedSecretNames`/`GeneratedSecretMaterial`
are backend-v1-only types, never referenced by `BuildPlan`, the Vite build
env, or anything in `services/preview-worker/local`'s static pipeline. A
repository that declares a secret-like variable with a `VITE_`/`NEXT_PUBLIC_`
client-public prefix remains categorically unsupported (§14) — never solved
by injecting a value into the static build.

## 16. M11 boundary

`database-requirement` variables remain fully unsupported in M10. M10 does
not provision PostgreSQL/Redis/MySQL/etc., and does not accept a
user-supplied `DATABASE_URL` as a workaround — `findUnsupportedReason`
(`core/analyzer/backendRuntimeAdapter.ts`) already rejects any candidate with
`databaseDependencies.length > 0` independently of the environment-requirement
check, and this design does not touch that rejection.

*(Later, M11:* that rejection was narrowed by M11 itself, not by M10. It now
admits exactly one `pg` dependency plus exactly the server-side
`DATABASE_URL` requirement, for trusted `fullstack-v1` orchestration only,
with the value server-provisioned through M11's own credential path, never
through M10's `generatedSecretNames` or `/run/secrets/env`. Every other
database shape is still rejected. See D-033 and
docs/TEMPORARY_DATABASES.md.)

## 17. Test plan (portable: implemented; real-gVisor: implemented and run, passed)

Portable (no real gVisor needed):

- `config.json`'s serialized bytes never contain a planted marker secret
  value, for a plan with `generatedSecretNames` populated.
- `QueuedBackendRuntime`/`StoredBackendRuntime` (in-memory store/queue
  serialization) never contain a marker secret value.
- `StoredFullStackPreview`/`QueuedFullStackPreview` (Postgres row/queue)
  never contain a marker secret value, name, or reference — full-stack
  orchestration never adds a secret-shaped field to its own durable schema.
- `BackendRuntime`'s public HTTP response shape never contains a marker
  secret value, under every status.
- Idempotency-record equivalents (fingerprint hash) are unaffected by a
  marker secret value — same fingerprint regardless of the value (proves the
  fingerprint genuinely never hashes it).
- A declared name outside the fixed four (including a plausible-looking one)
  is rejected with `UNSUPPORTED_BACKEND`, never silently generated.
- A `VITE_`/`NEXT_PUBLIC_`-prefixed secret-like name stays blocked; no value
  is ever injected into a `BuildPlan`/static artifact env.
- A reserved name (`NODE_OPTIONS`, `PATH`, `PEEPHOLE_*`, etc.) is rejected by
  the safety policy even if it were hypothetically declared eligible
  upstream (defense in depth on the policy itself).
- Generated values have ≥256 bits of entropy and are pairwise-unique across
  repeated generations (statistical/format check, not a cryptographic proof).
- Broker: `take()` after a prior `take()` returns `null`; `take()` with
  nothing ever `issue()`d returns `null`; `discard()` is idempotent and safe
  to call with no prior `issue()`.
- Broker: cancellation before `start()` is ever called still results in
  `discard()` having been invoked (via the supervisor's `finally`).
- A simulated process "restart" (fresh broker instance) makes any previously
  issued-but-unconsumed material unavailable — `take()` returns `null`,
  producing `SECRET_UNAVAILABLE`, never a silent start without secrets.
- The GVisorBackendRuntimeProcess mount-building unit produces exactly one
  new `mounts[]` entry and zero `process.env` changes when secrets are
  present, and zero new mount/args changes when `generatedSecretNames` is
  empty (full backward compatibility with today's spec).

Real-gVisor-gated (`PEEPHOLE_REAL_GVISOR_TESTS=1`), required before claiming
production support — portable tests alone do not prove host secret cleanup.
The first five of these were implemented in `tests/realBackendRuntime.test.ts`
in M10-C4A (see the M10-C4A status paragraph above for exactly how) and run
against a real Linux/gVisor host, passing 4/4, in M10-C4B on 2026-09-28
(production SHA `ef466d09ce91857b5bb8dfa35b77cc9207086468`); the last two were
settled by M10-C4B's production FullStack E2E and intentional-crash test,
described in the M10-C4B status paragraph above:

- [verified, passed] The sandboxed process's own environment actually
  contains the correct generated value(s) (a fixture backend that echoes
  back a SHA-256 digest of what it received on an internal-only
  `/secret-check` endpoint, checked from the host's root-namespace probe path
  already used for readiness — never the raw value over the wire).
- [verified, passed] After the container exits/is stopped, the host-side
  tmpfs secret directory for that `runtimeId` no longer exists.
- [verified, passed] `config.json` on disk, inspected directly on the host,
  never contains the secret value at any point during the runtime's life; nor
  does argv; nor does a bounded, symlink-refusing scan of the dedicated
  `runsc --root` state directory, both while the container is active and
  after it is deleted.
- [verified, passed] The trusted secret bootstrap's `SIGTERM` forwarding
  actually reaches the sandboxed child under real runsc PID 1 semantics (a
  fixed, non-secret sentinel file written by the child on receipt), exercised
  through the real `RuntimeProcessHandle.stop()` — see the M10-C4A status
  paragraph above for the `SIGKILL`→`SIGTERM` production fix this required.
  This is verified only through the harness's normal `stop()` path; the
  separate intentional `MainPID` `SIGKILL`/systemd-recovery test (see the
  M10-C4B status paragraph above and its 2026-10-07 correction) is not
  evidence for this item.
- [verified, passed] Backend egress remains unconditionally blocked for the
  generated-secret variant specifically (a narrow no-default-route check),
  alongside the unchanged, unmodified pre-existing ingress-only suite in the
  same file.
- [verified, passed] A backend process that does `console.log(secretValue)`
  does not cause that value to appear in Peephole's own systemd journal
  (confirms §10's "never logged" policy holds under real stdio plumbing, not
  just in the unit-level `NodeProcessRunner` contract). Verified in M10-C4B
  against a real admitted, server-composed FullStack preview built from the
  first-party pinned fixture `The-peephole/peephole-fixture-fullstack@e10b081...`,
  which declares `SESSION_SECRET` and deliberately logs a fixed
  `PEEPHOLE_M10_SECRET_LOG_PROBE:<value>` marker on startup; a full journal
  scan found zero occurrences of that marker before or after the run. See
  docs/TEST_PLAN.md's real-gVisor section and docs/PRODUCTION_SMOKE.md for the
  complete executed record.
- [verified, passed — via production crash test, not a synthetic reaper-only
  test] A deliberately interrupted job (crash mid-run) leaves no live host
  tmpfs secret residue after the new bounded reaper sweep runs, mirroring the
  existing `GVisorOrphanReaper`/`docs/SANDBOX_DISK_SECURITY.md` "after a
  deliberately interrupted job" verification pattern. The M10-C4A
  orphan-reaper test covers a synthetically staged stale entry. M10-C4B's
  intentional production `MainPID` `SIGKILL` (see status paragraph above)
  ended at zero residue, but per the 2026-10-07 correction the server's
  `SIGTERM` shutdown handler ran first, so that run does not isolate the
  startup reaper. M11-E6 (2026-10-07) does: after `SIGKILL` of only the
  server child, the preview's generated-secret tmpfs entry was still present
  and was removed by the restarted instance's startup reconciliation, along
  with the runsc, network, disk, and database state.

## 18. Open questions

1. Does `runsc`'s internal `--root` state directory retain its own copy of
   the OCI spec (or the secret-bearing tmpfs paths) beyond what this design
   controls? **Settled by M10-C4B (2026-09-28).** A bounded, symlink-refusing
   scan for the exact raw value (`tests/realBackendRuntime.test.ts`, using a
   dedicated per-test `runsc --root`, never production's shared root) ran
   against a real Linux/gVisor host and found the raw value absent, both
   while the container was active and after it was deleted. Per §9's own
   framing, a `runsc`-retained copy of the runtime-id-shaped *path* (not the
   value) is expected and acceptable, and that is exactly what was observed;
   no raw-value finding occurred (§3, §9).
2. Is `/run` guaranteed tmpfs on every intended production host image, or
   should Peephole mount and own a dedicated, explicitly-tmpfs path (e.g.
   `/run/peephole` created and verified during preflight, alongside the
   existing `ensureProductionPreflight()`/`ensureProductionDiskLayout()`
   checks in `services/production/preflight.ts`) rather than assuming the
   conventional default? Leaning toward the latter (explicit > assumed) but
   not decided here.
3. Exact bootstrap process-replacement mechanism in Node (`execve`-equivalent
   vs. spawn-and-proxy-exit-code) needs a concrete implementation spike
   before coding — both are plausible, but the trade-off (one fewer process
   in the tree vs. simpler Node-side implementation) is not resolved here.
4. Whether `generatedSecretNames` should be visible on the public
   `BackendRuntime`/`FullStackPreview` shape (names only, for a future UI to
   show "this backend has a session secret configured") is left to product
   judgment, not a security question — no value ever crosses that boundary
   either way.
