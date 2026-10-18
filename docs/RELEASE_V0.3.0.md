# Peephole v0.3.0 release record

| Channel | Status |
| --- | --- |
| GitHub release | **PENDING.** No `v0.3.0` tag or GitHub Release exists yet. The version metadata was merged by PR #69 as `d88219b2bd751ba064a8be28dffecefdc4b7432c`. |
| Chrome Web Store submission | **PENDING.** v0.3.0 has not been uploaded or submitted. |
| Chrome Web Store public version | **UNKNOWN.** The last repository record ([RELEASE_V0.2.0.md](RELEASE_V0.2.0.md)) says v0.2.0 was submitted and under review while the public version was 0.1.0. No later observation of the public listing version is recorded here. |
| Production backend | **Stable, M12 OFF (last recorded state).** The 2026-10-16 record is Stable `87d691e5f712f00022bceaea3986fbc64feb992b` with M12 OFF after the Canary rollback. No later Production observation was made for this record. |
| Formal M12 activation | **PENDING.** Not performed. |

This record was written while v0.3.0 is a release candidate. The v0.1.0 and
v0.2.0 records are kept unchanged in [RELEASE_V0.1.0.md](RELEASE_V0.1.0.md)
and [RELEASE_V0.2.0.md](RELEASE_V0.2.0.md). The M12 Canary evidence is kept
in [M12_PRODUCTION_CANARY_20261016.md](M12_PRODUCTION_CANARY_20261016.md).
This record refers to those documents instead of copying their evidence.

Status meanings:

- **PASS:** the named fact was directly verified for the stated revision or
  artifact.
- **RECORDED:** an earlier, dated result reused here. It is not re-verified
  for the merged release commit.
- **NOT_RUN:** the check was not executed.
- **PENDING:** not yet done.
- **UNKNOWN:** no evidence either way.
- **MANUAL:** requires the owner, the release owner, or the live Developer
  Dashboard.

## Scope

v0.2.0 (`c0de1208c9273b8123c44d329823437cbc1edabd`) to the merged release
commit (`d88219b2bd751ba064a8be28dffecefdc4b7432c`) is 25 commits and 165
changed files. Of those, 37 changed files are under the extension source
paths (`entrypoints/`, `components/`, `core/`, `types/`, `utils/`, `public/`
and `wxt.config.ts`). The rest are server/runtime, tests, docs and tooling.

A minor version is used because the extension gains user-facing
functionality.

### User-facing extension changes since v0.2.0

These are present in the candidate build described below. Full-stack preview
and non-sensitive configuration depend on build flags and on the Production
server configuration, which are separate release decisions (see
[Feature flags and Production configuration](#feature-flags-and-production-configuration)).

- **Full-stack preview** (PR #47, #48, #62). A separate **Full-stack
  preview** section in the Side Panel. The user selects a supported frontend
  and one backend, then chooses **Run full-stack preview** or **Stop
  full-stack preview**. Full-stack candidates can be found from the
  repository root when the frontend and backend live in separate directories.
- **Temporary PostgreSQL (M11) through the full-stack preview.** When the
  selected backend declares exactly a `pg` dependency and `DATABASE_URL`,
  the server provides one temporary database for that preview. The user
  never enters `DATABASE_URL`; with the M12 UI enabled, the list below shows
  it as provided by Peephole.
- **Non-sensitive configuration (M12-A/B)** (PR #52). The **Environment
  variables** list shows every name the backend declares in a bounded
  `.env.example`-family template, with its source (Peephole, the user, or
  unsupported). Text inputs appear only for names that pass the M12 policy.
  The user must confirm that the values are not kept secret before running.
- **Static preview Close/Show** (PR #63). A ready static preview frame can be
  closed and shown again without creating a new job. **Build again** remains
  available.
- **Side Panel tab context across navigation (R3)** (PR #64). The panel stays
  bound to the repository and tab it was opened for. Navigating away hides it
  without starting jobs or reopening it automatically. An admitted full-stack
  preview's controls survive a panel or page reload in session storage, so
  **Stop** remains available.
- **Repository action placement (R2)** (PR #65). The Peephole button appears
  only on a verified repository overview page, next to GitHub's Watch, Star
  and Fork actions. Repository subpages still provide Side Panel context.
- **Fewer duplicate GitHub API requests** (PR #49).

### Supported shapes

| Area | Supported in v0.3.0 | Not supported |
| --- | --- | --- |
| Static preview | Package-free root static HTML; root or selected nested Vite + React with npm and a target-local `package-lock.json` (unchanged from v0.2.0) | Vue/Svelte, pnpm/yarn/bun, shared-root workspaces, Next.js |
| Full-stack frontend | The same Vite + React + npm frontend shape | Any other frontend |
| Full-stack backend | Exactly `express-node-npm-v1`: Express, npm, committed `package-lock.json`, entrypoint started as `node <file>` | Other frameworks, other package managers, Docker, arbitrary commands |
| Backend routing | One HTTPS origin; only `/api` and `/api/*` go to the backend | A separate public backend URL; backend routes outside `/api` |
| Backend network | Ingress only; outbound traffic is dropped (M11 adds one route to its tenant database) | General egress, external APIs |
| Generated secrets (M10) | Exactly `JWT_SECRET`, `SESSION_SECRET`, `COOKIE_SECRET`, `CSRF_SECRET`, generated by the server | User-supplied secrets |
| Database (M11) | One temporary PostgreSQL database per full-stack preview, `pg` + `DATABASE_URL` only | Other engines/clients, user database credentials, standalone `backend-v1` databases |
| User configuration (M12-A/B) | Non-secret-like names declared at the exact commit, up to 16 names, 1,024 bytes per value, 6,144 bytes total | API keys, passwords, tokens, URLs, hosts, ports, database or client-public names (`VITE_` etc.) |
| External secrets (M12-C) | Not implemented; design only | — |

Policy details are in [USER_PROVIDED_ENVIRONMENT.md](USER_PROVIDED_ENVIRONMENT.md),
[TEMPORARY_DATABASES.md](TEMPORARY_DATABASES.md),
[EPHEMERAL_SECRETS.md](EPHEMERAL_SECRETS.md) and
[PREVIEW_RUNTIME.md](PREVIEW_RUNTIME.md).

### Technical limits

- Values entered for M12 reach the repository's own, untrusted backend code.
  That code can return them through the public preview URL. The UI says so,
  and values are therefore treated as public configuration.
- Server-side M12 values are held in one process's memory until the backend
  starts. A server restart before that point fails the preview with
  `CONFIGURATION_UNAVAILABLE`, and the user must enter the values again.
- A server restart while a full-stack preview runs fails that preview. It is
  not reconstructed.
- Production runs one Node process with full-stack concurrency 1.

### Not included

- The server-side GitHub read gateway (PR #51, D-034). Its extension path is
  off unless `WXT_GITHUB_GATEWAY_ENABLED=true`. That variable is unset in the
  candidate build, and the bundle contains no gateway path.
- Standalone `backend-v1` UI (`WXT_BACKEND_RUNTIME_ENABLED` is not `true`; no
  backend-runtime endpoint path is in the bundle).
- M12-C external API keys or secrets.

## Feature flags and Production configuration

| Flag | Side | Candidate / last recorded value | Effect |
| --- | --- | --- | --- |
| `WXT_FULLSTACK_PREVIEW_ENABLED` | Extension build | `true` in the candidate build | Shows the Full-stack preview section |
| `WXT_USER_ENVIRONMENT_ENABLED` | Extension build | `true` in the candidate build | Shows M12 inputs; requires the full-stack flag |
| `WXT_BACKEND_RUNTIME_ENABLED` | Extension build | `false` | Standalone backend UI stays hidden |
| `WXT_GITHUB_GATEWAY_ENABLED` | Extension build | unset | Gateway transport not built in |
| `PEEPHOLE_TEMPORARY_DATABASES` | Server | `1` in Production since M11 (2026-10-07 record) | Enables M11 |
| `PEEPHOLE_USER_ENVIRONMENT` | Server | `0`/off in Production (2026-10-16 record) | With it off, a backend that declares user-configurable names is rejected as `UNSUPPORTED_BACKEND` at admission |

**Pairing requirement.** If the v0.3.0 extension is published with
`WXT_USER_ENVIRONMENT_ENABLED=true` while Production keeps M12 OFF, users can
enter values for an eligible backend, but the server will reject that
preview. Full-stack previews that need no user configuration are not
affected. Choose one before submission:

1. activate M12 in Production first, after the gates below; or
2. publish an extension build with `WXT_USER_ENVIRONMENT_ENABLED` unset. That
   build is a different artifact and needs its own build record.

This record does not choose between them.

## Build record

| Item | Status | Evidence |
| --- | --- | --- |
| Release PR | PASS | PR #69 squash-merged as `d88219b2bd751ba064a8be28dffecefdc4b7432c` on 2026-10-18. |
| Package version | PASS | `package.json` and the `package-lock.json` root package are `0.3.0` at the merged commit. |
| Manifest version | PASS | `wxt.config.ts` is `0.3.0` at the merged commit. |
| Candidate extension source | RECORDED | Built locally from release branch commit `1768d57` (base `dc2381f93ddb2ea4751ab2d73ef8b7eb13a0d50c` plus the version bump), on Windows 11, Node `v24.12.0`, npm `11.6.2`, WXT `0.21.4`. |
| Candidate source vs merged commit | PASS (source comparison only) | `git diff 1768d57 d88219b` changes only `README.md` and `README.ko.md`, which are not extension build inputs. This is a source comparison, not a rebuild of the merged commit. |
| Public build configuration | RECORDED | `WXT_PREVIEW_API_BASE_URL=https://api.3.34.33.24.sslip.io/`, `WXT_PREVIEW_ARTIFACT_BASE_DOMAIN=3.34.33.24.nip.io`, and the flags in the table above. No server secret is a `WXT_` value. |
| Candidate tree digest | RECORDED | 14 files; `cf40511c72c0226d269a9eceba8efdb44a500b5858b507306100f514b57a730e` (sorted relative POSIX paths, `path + NUL + sha256 + LF`, then SHA-256; same method as the Canary record). |
| Candidate ZIP | RECORDED | `peephole-0.3.0-chrome.zip`, 234,353 bytes, SHA-256 `593d621292442ef7da11a02a8aa7fb4672d9166617130c39cc7e21ed09023fe4`. A clean rebuild from the same source reproduced the same tree digest and ZIP hash. The ZIP is kept outside the repository and is not committed. |
| Bundle flag check | RECORDED | Full-stack endpoint paths and the M12/Close-preview UI strings are present; backend-runtime and gateway paths are absent. A flags-off build lacks the full-stack paths. |
| Bundle secret scan | RECORDED | No secret-shaped strings were found in the candidate bundle. |
| Final release build from `d88219b` | **PENDING** | Required before tagging, as in v0.2.0: a clean worktree at the merged commit, `npm ci`, format, lint, typecheck, tests, build and zip with the same variables. Expected result is the recorded tree digest and ZIP hash. Do not attach or submit the candidate ZIP until this matches. |
| Production deploy/rollback package | **PENDING** | A local package exists with the release SHA unpinned (`PENDING_MERGE`). It must be pinned to `d88219b` with its own checks before any Production use. Not part of this repository. |

### Generated manifest comparison with v0.2.0

From the candidate `manifest.json`:

| Field | v0.2.0 → v0.3.0 candidate |
| --- | --- |
| `version` | `0.2.0` → `0.3.0` (**only difference**) |
| `manifest_version`, `name`, `description`, `icons`, `minimum_chrome_version` (`116`) | same |
| `permissions` | `identity`, `sidePanel`, `storage` (same) |
| `host_permissions` | `https://api.github.com/*`, `https://api.3.34.33.24.sslip.io/*` (same) |
| `content_scripts` | `https://github.com/*/*`, `document_idle` (same) |
| `web_accessible_resources` | `icons/peephole-32.png` for `https://github.com/*` (same) |
| `content_security_policy.extension_pages` | same `script-src 'self'` and `frame-src 'self' http://127.0.0.1:* https://*.3.34.33.24.nip.io` |

The full-stack preview loads from the same artifact domain, so no new host
or frame source was needed. Repeat this comparison on the final release
build.

## CI and local verification

| Item | Status | Evidence |
| --- | --- | --- |
| CI on the merged commit | PASS | `CI` run 39111770451 on `d88219b`, success. |
| CI on the PR #69 head | PASS | `CI` run 39111181844 on `5010e83`, both jobs success. |
| Candidate format, lint, typecheck, build, zip, `git diff --check` | RECORDED | PASS on the release branch before merge. |
| Real-host M12 lifecycle (gVisor) | RECORDED (`5ed0f92` only) | REAL_GVISOR_VERIFIED on 2026-10-13: 306 host checks, 12/12 cases. See [M12_REAL_GVISOR_VERIFICATION.md](M12_REAL_GVISOR_VERIFICATION.md). Later lifecycle corrections are verified by portable tests only. |
| B1/B2 real-host harnesses | NOT_RUN | The pending-signal boundary test (PR #66), the isolated journal non-leakage harness (PR #67) and the owned server crash/startup recovery harness (PR #68) are merged. None has been run on a real host. |
| Combined M10/M11/M12 real SQL query | NOT_RUN | See [M12_COMBINED_INTEGRATION.md](M12_COMBINED_INTEGRATION.md). |

## Production verification

### 2026-10-16 limited M12 Canary

Full evidence, hashes and limits are in
[M12_PRODUCTION_CANARY_20261016.md](M12_PRODUCTION_CANARY_20261016.md).

| Item | Status | Evidence and limit |
| --- | --- | --- |
| Backend source | RECORDED | `aa26a11f0f00d4e78dd8ccb199cc0d7280fcb082`, M12 ON for the Canary only. |
| Extension used | RECORDED | A test build reporting version 0.2.0 (tree `6d2f1d0e…e777`), loaded unpacked under extension ID `aojbhoelemgfhnpaojnljminpchlhman`. **It is not the v0.3.0 candidate artifact.** |
| Full-stack frontend and backend | RECORDED: SUCCESS | One pinned fixture, `The-peephole/peephole-fixture-fullstack@90afaa0c3f650744300afc5d8fed00fd4a0ef5c8`. Operator observation; no independent browser capture. |
| Synthetic configuration delivery | RECORDED: SUCCESS | `APP_GREETING` delivered and displayed as expected. No value is reproduced here. |
| Ordinary Stop | RECORDED: PASS | stopped, `errorCode` null, ownership revoked. |
| Resource residue | RECORDED: 0 | Tenant databases/roles, active control-plane rows and host resources (runsc, netns, leases, workspaces, credential and user-env material) all 0. This is resource absence, not a whole-host non-exposure audit. |
| Stable rollback | RECORDED: PASS | `ROLLBACK_COMMITTED`, exit code 0; Stable `87d691e`, M12 OFF, health/readiness/host smoke PASS, 70 s stable. |

### v0.3.0 candidate in Production

| Item | Status |
| --- | --- |
| v0.3.0 candidate extension against Production (static and full-stack) | **NOT_RUN** |
| Connect GitHub from the v0.3.0 package under the published ID | **NOT_RUN — PENDING (post-publication)**. An unpacked build has a different ID; Production allowlists were not widened. |
| Production smoke for the deployed v0.3.0 backend | **NOT_RUN** |

## Remaining gates and approvals

The Canary record lists B1–B5 as release blockers for formal M12 activation.
The owner has decided not to run additional B1/B2 verification or a B3
credential rotation for this release. That decision does not turn those
gates into PASS. Because the Canary record states that a missing B3
disposition keeps M12 ON blocked, skipping them requires a **written risk
acceptance by the release owner** before M12 is activated.

| Gate | State | Required before formal M12 ON |
| --- | --- | --- |
| B1 — current-candidate Linux lifecycle | NOT_RUN | Run it, or record risk acceptance: false stop failure or incomplete cleanup under concurrent-exit interleavings that only portable tests cover. |
| B2 — actual server crash and startup recovery | NOT_RUN | Run it, or record risk acceptance: stale M12 material or resources after an ungraceful server exit. |
| B3 — provisioning-credential incident | UNREMEDIATED | Record a secret-free disposition. If no rotation is done, the acceptance must state that an earlier exposed credential may keep its privileges. Never copy a credential value into any record. |
| B4 — candidate, artifacts, deployment and rollback approval | PENDING | Pin `d88219b` (or the approved final SHA) in the deploy/rollback package; compare with the Canary; separate Production approval. |
| B5 — browser artifact confirmation | PENDING | Confirm the extension ID, version, flags and login of the artifact actually used. |
| Final v0.3.0 Chrome E2E | NOT_RUN | Static and full-stack preview from the final artifact against the configured Production backend. |
| Formal M12 ON | PENDING | Only after the above and separate approval. |
| `PRIVACY.md` coverage | PASS (repository) | Updated for full-stack preview, temporary PostgreSQL and M12 in this documentation change. Goes live when merged, because the policy URL tracks `main`. |
| Chrome Web Store Dashboard answers | MANUAL | Re-check against [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md#v030-submission-review). |
| GitHub Release v0.3.0 | PENDING | Tag the merged commit and attach the ZIP from the final release build. |
| Chrome Web Store submission and publication | PENDING | Not performed. |

Suggested risk-acceptance record (fill in, do not store secrets): owner name,
date, the gates accepted (B1/B2/B3), the accepted residual risk for each, the
compensating controls relied on (Canary cleanup evidence, portable tests,
rollback package), and whether M12 ON is approved.

## Deployment and rollback targets

| Target | Identity |
| --- | --- |
| Release source | `d88219b2bd751ba064a8be28dffecefdc4b7432c` (PENDING final build) |
| Production Stable (rollback target) | `87d691e5f712f00022bceaea3986fbc64feb992b`, Stable rootfs `/var/lib/peephole/base-rootfs-83f1d1b6392cfa04b36e087c6930ae5ab8ede25a`, M12 OFF |
| M12-compatible rootfs (reuse candidate) | `/var/lib/peephole/base-rootfs-aa26a11f0f00d4e78dd8ccb199cc0d7280fcb082-m12`, bootstrap SHA-256 `3b69f061073e57fee41c32f7f8b96c2bdbef100778285862eadff4af0122a539` (kept after the Canary, last record) |
| Extension ID | `fieofkhijgngfoflgpkbghbkaidhdgel` (unchanged) |

Production state after 2026-10-16 is taken from the Canary record and was not
re-observed for this document.

## Remaining controlled steps

1. Run the final release build from `d88219b` and compare it with the
   recorded tree digest and ZIP hash.
2. Decide the M12 pairing option above.
3. Record the release owner's B1/B2/B3 risk acceptance, or run the gates.
4. Pin the deploy/rollback package and obtain separate Production approval
   for any backend change or M12 activation.
5. Run the final v0.3.0 Chrome E2E.
6. Create the `v0.3.0` tag and GitHub Release with the verified ZIP.
7. Re-check the Dashboard privacy answers and screenshots, then submit to the
   Chrome Web Store.
8. After publication, confirm the published version, Connect GitHub and an
   authenticated preview, and update this record without rewriting the
   candidate evidence.

Release state: **release candidate merged; final build, Production
activation, GitHub Release and Chrome Web Store submission all PENDING.**
