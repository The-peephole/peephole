# User-Provided Preview Environment (M12) — Design and Status

**Status (2026-10-11): M12-A and M12-B implemented behind two default-off
flags; portable tests pass; NOT deployed; real Linux/gVisor and Chrome E2E
NOT_RUN.** M12-C (external API keys and other secrets) is design-only and
not implemented. See D-035.

| Flag | Side | Default | Effect when off |
| --- | --- | --- | --- |
| `PEEPHOLE_USER_ENVIRONMENT` (`0`/`1`) | Server | off | Any backend that declares user-configurable names is `UNSUPPORTED_BACKEND` at full-stack admission, exactly as before M12; startup still reaps leftover files under `PEEPHOLE_USER_ENVIRONMENT_ROOT` |
| `WXT_USER_ENVIRONMENT_ENABLED` (`true`) | Extension build | off | Side Panel UI is identical to pre-M12; such backends stay "not eligible" |

## 1. Problem

Repositories declare variables in `.env.example` (for example `PORT`,
`SESSION_SECRET`, `DATABASE_URL`, `OPENAI_API_KEY`, `APP_GREETING`). Peephole
already provides `PORT`/`HOST`/`NODE_ENV` (platform), the four M10 generated
secrets, and M11's `DATABASE_URL`. Every other declared name made a backend
ineligible. M12 lets a requester supply values for a narrow class of those
other names and deliver them only to that preview's runtime.

Two problems are kept apart:

1. **Accepting a value and delivering it to the right runtime without
   leaving it behind** — solved here for non-sensitive configuration.
2. **Keeping a secret secret from untrusted repository code and from public
   preview visitors** — not solvable by storage discipline, and therefore
   not claimed (section 3). That is why secrets are out of scope (M12-C).

## 2. What exists (audit summary)

- **Detection** (`core/analyzer/environmentRequirements.ts`): reads only
  names from `.env.example`, `.env.local.example`, `.env.sample`,
  `.env.template` (never `.env`, never values), per bounded source root, and
  classifies `exposure`, `requirementKind`, `sensitivity`. A name with no
  other evidence is `unknown`/`server`. Values are never read, so a
  template default (`FEATURE_MODE=demo`) is never used.
- **Plan** (`core/analyzer/backendRuntimeAdapter.ts`): the server re-derives
  `BackendRuntimePlan` at the exact commit. Before M12 any requirement other
  than platform, the four generated names, and M11's exact shape made the
  plan `null`.
- **Lifecycle**: the full-stack parent and its queue row are durable
  (PostgreSQL) and contain identity only; the backend runtime store, queue,
  and plan are process memory only; production is one Node process with
  backend/full-stack concurrency 1 (EPHEMERAL_SECRETS.md section 8).
- **Delivery**: M10 writes `/run/peephole/secrets/<id>/env` (tmpfs, fixed
  `NAME=value` grammar, base64url values only) bound onto
  `/run/secrets/env`; M11 writes the raw URL to
  `/run/peephole/db-credentials/<id>/database-url` bound onto
  `/run/secrets/database-url`; the trusted bootstrap
  (`/opt/peephole/secret-bootstrap.mjs`) reads both and spawns the entrypoint
  with them in its environment. `config.json` (persistent ext4) carries only
  `PORT`/`HOST`/`NODE_ENV`.
- **Network**: the running backend is ingress-only (no default route,
  unconditional egress `DROP`); public visitors reach it through the
  full-stack origin's `/api` route.

## 3. Threat model

| Boundary | Holds a value? | Stored / serialized? | Visible to others? | Survives restart? | Survives failed cleanup? |
| --- | --- | --- | --- | --- | --- |
| 1. Repository `.env.example` | Names only | Git | Public | n/a | n/a |
| 2. Side Panel UI (React state) | Yes, until admission succeeds or target changes | No browser storage | Same browser profile / DevTools / extensions with page access | No | No |
| 3. Background service worker | No (full-stack calls go from the Side Panel) | — | — | — | — |
| 4. HTTPS Preview API | In transit (TLS) | Request body is parsed in memory, never logged | No | No | No |
| 5. Session auth | No; runs before admission | — | — | — | — |
| 6. Control plane | In memory during `create()` | Never in fingerprint (names only), store row, or queue payload | Never echoed; errors name variables, never values | No | No |
| 7. Queue / durable store | **No** | Identity only (unchanged schema) | — | Row yes, values no | — |
| 8. Process-local broker | Yes, until START, cancel, failure, run end, or TTL | `OpaqueSecretValue` closures; HMAC digest under a per-process random key | Bound to preview id + requester + repo + commit + source root + names | **No** (fail closed) | Bounded by TTL and capacity |
| 9. Supervisor → process starter | Yes, one call | No | No | No | No |
| 10. Host tmpfs `/run/peephole/user-env/<runtime>/user-env` | Yes, from start to exit/stop | tmpfs only (verified with `findmnt` on every create), 0700/0600, sandbox-owned | No | No (memory-backed; startup reaps) | Periodic + startup reaper |
| 11. gVisor runtime | Yes: child `process.env` | Read-only `noexec` bind of one file; never `config.json`, never argv | **Repository code can read it** | No | Container deleted |
| 12. Preview HTTP endpoint | Only if the app echoes it | — | **Public visitors** | — | — |
| 13. Logs / errors / storage | No | Backend stdout/stderr never logged (unchanged); no Peephole log site added | — | — | — |

Critical findings:

- **A. Untrusted code.** The backend process necessarily sees every value it
  is given and can do anything with it.
- **B. Public preview.** The full-stack origin is public. A malicious app can
  return `process.env` from `/api`. No storage design prevents that.
- **C. No egress.** `backend-v1` is ingress-only, so an external API key
  would be useless anyway; relaxing egress is out of scope.
- **D. Persistence.** Handled by boundaries 6–10 above.
- **E. Browser.** Values typed into a page are visible to the user's own
  browser profile, DevTools, and possibly other extensions. Peephole keeps
  them out of persistent storage and clears them after admission; it does
  not claim absolute browser non-exposure.

**Consequence:** values are treated as **public configuration**. Only names
that are not secret-like are eligible (section 5), and the UI says plainly
that values may be visible to anyone with the preview link.

## 4. Alternatives

| | A: values in the create request (chosen) | B: separate configuration session + opaque handle | C: separate secret broker service |
| --- | --- | --- | --- |
| Ingress | One authenticated request | Two requests; handle must be bound and expire | New service |
| Binding | Server-minted preview id, bound at admission | Handle bound to user/repo/commit/target; then to preview | Runtime id |
| Idempotency | Names in fingerprint; values compared by keyed HMAC in memory | Handle replay rules needed | Same as A |
| Restart | Values lost → fail closed | Handle store lost → fail closed (same) | Needs its own durability story |
| New surface | One optional field | New endpoint, handle lifecycle, sweeper | New process, IPC, deployment |
| Benefit | Smallest; reuses M10's broker pattern | Lets values be entered before admission — not needed: admission is one step | Only if multi-process; production is single-process |

**Chosen:** A for ingress combined with C's *responsibility split* inside
the same process: a dedicated `InMemoryUserEnvironmentBroker`, separate from
M10's broker and M11's provisioner. B adds a second lifecycle without a
security property A lacks, because admission and value submission are the
same authenticated step. No Redis, Vault, secret manager, new table, new
worker, or new background job was introduced.

## 5. Name and value policy (`core/userEnvironment/userEnvironmentPolicy.ts`)

A name is user-configurable only if all hold:

1. declared in a bounded template **at the exact commit**, as re-derived by
   the server (`GitHubBackendRuntimePlanResolver`); the client list is only
   checked against it;
2. matches `^[A-Z][A-Z0-9_]{0,63}$` (lowercase/mixed case rejected — no case
   folding);
3. not `PORT`/`HOST`/`NODE_ENV`, not `JWT_SECRET`/`SESSION_SECRET`/
   `COOKIE_SECRET`/`CSRF_SECRET`, not `DATABASE_URL`;
4. not client-public (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`,
   `EXPO_PUBLIC_`, `GATSBY_`, `PUBLIC_`);
5. not reserved: `PATH`, `HOME`, `SHELL`, `ENV`, `BASH_ENV`, `IFS`, `PS4`,
   `PROMPT_COMMAND`, `USER`, `LOGNAME`, `PWD`, `OLDPWD`, `HOSTNAME`,
   `TMPDIR`, `TMP`, `TEMP`, `GCONV_PATH`, `LOCPATH`, `HOSTALIASES`,
   `RES_OPTIONS`, `LOCALDOMAIN`, `*_PROXY`, and prefixes `NODE_`, `NPM_`,
   `LD_`, `DYLD_`, `PEEPHOLE_`, `UV_`, `V8_`, `OPENSSL_`, `SSL_`, `GLIBC_`,
   `MALLOC_`, `COREPACK_`, `YARN_`, `PNPM_`, `BUN_`, `DENO_`;
6. no `_`-separated token reads as secret-like (`KEY`, `SECRET`, `TOKEN`,
   `PAT`, `PASSWORD`, `PASS`, `CREDENTIAL(S)`, `AUTH`, `PRIVATE`, `CERT`,
   `SALT`, `SIGNING`, `DSN`, `WEBHOOK`, `SESSION`, `COOKIE`, `JWT`, `CSRF`,
   `OAUTH`, ...), a database (`DATABASE`, `DB`, `POSTGRES`, `PG`, `REDIS`,
   `MONGO`, ...), or an endpoint/network coordinate (`URL`, `URI`,
   `ENDPOINT`, `HOST`, `PORT`, `DOMAIN`, `ORIGIN`, `PROXY`, `ADDR`, ...);
7. the analyzer agrees: `exposure: "server"`, `requirementKind: "unknown"`,
   `sensitivity` not `secret-like`.

At most 16 names per backend; a commit declaring more is unsupported, never
truncated. Values: non-empty, at most 1,024 UTF-8 bytes each and 8,192 in
total; no C0/C1 controls (NUL, CR, LF, TAB, ...), DEL, U+2028/U+2029, BOM, or
lone surrogates; any other Unicode is allowed. Submissions are an array of
`{name, value}` (an object map would let `JSON.parse` silently collapse
duplicates); duplicates and extra fields are rejected. Values are never
concatenated into a shell command, never parsed by an env-file parser, and
never `eval`/`source`d.

This is not "arbitrary environment variables": eligible names are what is
left after excluding everything above, and secrets are excluded by design.

## 6. Lifecycle

```
Side Panel (React state)
  └─ POST /v1/fullstack-previews  {..., userEnvironment: [{name, value}]}
       ├─ PreviewSessionAuth (401 before any admission)
       ├─ parseUserEnvironmentEntries (shape, grammar, eligibility, bounds) → 400
       ├─ idempotency lookup: fingerprint includes NAMES only;
       │    replay with same names + different values → broker.compare → 409
       ├─ quota, frontend + backend plan re-derivation at the exact commit
       ├─ names must equal plan.userEnvironmentNames exactly → 400;
       │    no broker configured → 422 UNSUPPORTED_BACKEND
       ├─ broker.register(previewId (freshly minted), requester, repo, commit,
       │    backendSourceRoot, names, values, expiresAt = provisioning TTL)
       ├─ durable row + queue row (no values)        ── failure → discard
       └─ lost concurrent race / enqueue failure    ── discard
FullStack worker → backend.createForOrchestration (plan re-derived again)
Backend supervisor
  ├─ before sandbox allocation: names present but no broker / no
  │    orchestration key → CONFIGURATION_UNAVAILABLE
  ├─ FETCH → INSTALL (values never in the install sandbox)
  ├─ START: broker.take(previewId, {runtimeId, repo, commit, sourceRoot,
  │    names}) — single use; any mismatch destroys the values; null →
  │    CONFIGURATION_UNAVAILABLE (before database provisioning)
  └─ GVisorBackendRuntimeProcess.start(..., userEnvironment)
       ├─ TmpfsUserEnvironmentFilesystem.create → /run/peephole/user-env/<runtime>/user-env
       │    (one compact JSON object + "\n", validated again at write)
       ├─ OCI mount: that file → /run/secrets/user-env (ro,nosuid,nodev,noexec)
       ├─ args: node /opt/peephole/secret-bootstrap.mjs --peephole-require-user-environment <entry>
       └─ bootstrap: flag ⇔ non-empty file, independent re-validation,
            no collision with platform/generated/database names, then
            spawn(entry, {env: base + user + generated + database, shell:false})
Cleanup: file removed on exit/stop (independently of M10/M11 cleanup);
  broker discard on every supervisor exit path, full-stack run end, cancel,
  worker failure; TTL sweep; startup + periodic tmpfs reaper.
```

`/run/secrets/env` and `/run/secrets/database-url` keep their exact formats
and meaning; the new file is a third sibling placeholder.

## 7. Failure semantics

| Situation | Result |
| --- | --- |
| Server restart before START | Broker empty → `CONFIGURATION_UNAVAILABLE` (backend) → full-stack `CONFIGURATION_UNAVAILABLE`, "enter them again" |
| Restart while running | Existing M9 reconciliation fails the parent `ORCHESTRATION_UNAVAILABLE`; tmpfs file reaped at startup |
| Binding mismatch (commit, root, names) | Values destroyed, fail closed |
| Retried START | `take` already consumed → fail closed, never a default |
| Same Idempotency-Key, different values | 409 `CONFLICT` while the digest is retained (until discard/TTL); afterwards the existing replay returns the original preview unchanged |
| Lost response, browser retry | Same key + same values → same preview |
| Browser closed | Nothing stored client-side; server lifecycle unchanged |
| Pre-M12 rootfs with flag on | Preflight refuses startup (placeholder + bootstrap marker check). Defense in depth: an old bootstrap forwards the flag to Node, which rejects the unknown option |

Public errors name variables, never values, and reuse the existing safe
error codes plus `CONFIGURATION_UNAVAILABLE`.

## 8. Extension UI

Behind `WXT_USER_ENVIRONMENT_ENABLED`, the Full-stack preview section lists
every declared name with its source (Peephole / You / Unsupported) and
reason, shows text inputs only for user-configurable names, requires every
value plus an explicit acknowledgement ("not kept secret from the preview")
before Run, keeps values in React state only (no `localStorage`/
`chrome.storage`), clears them on repository/commit/target change and after
admission, issues a new Idempotency-Key when a value changes, and shows no
input for secret-like names such as `OPENAI_API_KEY` (the backend stays
ineligible). Inputs are plain text, not masked: masking would suggest
secrecy the design explicitly does not provide.

## 9. Verification status

| Area | Status |
| --- | --- |
| Policy, broker, admission, HTTP auth (missing/forged/expired session), ownership, idempotency, non-leakage of a synthetic sentinel (`PEEPHOLE_E2E_SYNTHETIC_VALUE_2026`) through responses, errors, durable row, queue payload, fingerprint, `config.json`, argv, runsc calls | PASS (portable unit/integration tests) |
| Supervisor take/fail-closed/discard paths, process starter mount/cleanup, tmpfs writer + reaper, bootstrap parser and flag semantics, production config/preflight/composition | PASS (portable; tmpfs check and chown stubbed) |
| Side Panel UI | PASS (jsdom) |
| PostgreSQL integration | No schema change; existing suite environment-gated, NOT_RUN locally |
| Real Linux root + gVisor (actual child env, tmpfs lifetime, `/proc` and `runsc --root` non-persistence, rootfs placeholder) | **NOT_RUN** |
| Chrome E2E | **NOT_RUN** |

Portable tests with stubs do not prove whole-host non-exposure.

## 10. Performance and complexity

- No new table, queue, worker, background job, or service. One in-memory
  map (≤256 entries, TTL-swept on access), one tmpfs file per runtime that
  needs it, one more reaper sweep in the existing maintenance tick (only when
  enabled; the startup sweep is a no-op `lstat` when the root is absent).
- Previews without user configuration: identical request body, fingerprint,
  plan contents (empty `userEnvironmentNames`), OCI spec, and bootstrap path.
- Simpler alternatives considered: reusing the M10 file would require
  widening its fixed grammar and allowlist (rejected); putting values in
  `platformEnvironment` would put them in persistent `config.json`
  (rejected).

## 11. Remaining risks

- Repository code and public visitors can read the values (by design; why
  only non-sensitive names are eligible). A user may still type a secret
  into a non-secret-looking name; the UI warns, the server cannot detect it.
- Name classification is a heuristic deny-list plus analyzer agreement; it
  errs toward "unsupported".
- Replay conflict detection lasts only while the digest is retained.
- Single-process assumption: a multi-process deployment would make `take`
  fail closed (safe, but the feature would not work).
- Real-host properties are unverified until the NOT_RUN items run.

## 12. Deployment preconditions (not performed)

1. Rebuild the base rootfs with the current `scripts/gvisor/build-base-rootfs.sh`
   (new `/run/secrets/user-env` placeholder and M12-aware bootstrap).
2. Ensure `PEEPHOLE_USER_ENVIRONMENT_ROOT` (default `/run/peephole/user-env`)
   is on tmpfs; startup preflight enforces it.
3. Run the real-gVisor verification: a fixture backend declaring a
   non-sensitive name that reports only a SHA-256 digest of the value;
   assert child env delivery, `config.json`/argv/journal non-leakage, file
   removal on stop/crash, startup reap after `SIGKILL` of the actual server
   PID (not the tsx wrapper — see D-032's correction), and `CONFIGURATION_UNAVAILABLE`
   after a restart before START.
4. Then set `PEEPHOLE_USER_ENVIRONMENT=1`, and build the extension with
   `WXT_USER_ENVIRONMENT_ENABLED=true` (requires
   `WXT_FULLSTACK_PREVIEW_ENABLED=true`).

## 13. Future: external API credentials (M12-C, not implemented)

Prerequisites before any secret value is accepted:

1. **Egress policy per service** (e.g. an authenticated forward proxy that
   allows only `api.openai.com:443` for a preview that opted in), replacing
   today's unconditional egress `DROP` only for that preview.
2. **Public exposure**: either previews that carry user secrets are not
   publicly reachable (requester-only access to the full-stack origin), or
   the secret never enters the sandbox (a host-side proxy injects the
   credential into outbound requests so the app never sees it).
3. **Consent and revocation**: explicit per-preview consent, guidance to use
   restricted/test keys, and immediate destruction on stop.
4. **Abuse prevention**: quotas and destinations bound per requester so a
   preview cannot become a credential-laundering relay.
5. Then: a separate secret-name class, masked input, and the same
   tmpfs/bootstrap delivery, with M10's values-never-hashed-durably rule.
