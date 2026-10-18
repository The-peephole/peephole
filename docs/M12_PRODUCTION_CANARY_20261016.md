# M12 Production Canary closure and release readiness — 2026-10-16

**CANARY_FUNCTIONAL_SUCCESS · RESOURCE_CLEANUP_PASS · ROLLED_BACK_TO_STABLE.**
M12-A/B has limited Production functional acceptance; formal M12 ON rollout
is **not complete**. Stage 12 remains unchecked. The current release decision
is **HOLD_FOR_RELEASE_GATES**, not permission to deploy main or repeat a Canary.
M12-C external keys/secrets remain out of scope.

This is a documentation/evidence review. No Production SSH, SQL, service/AWS
change, new preview, Chrome change, rootfs deletion or new runtime test was
performed for this closure. Production statements below describe the saved
observations, not a new live-state query.

## Identity and chronology

| Item | Recorded identity |
| --- | --- |
| Canary backend source | `aa26a11f0f00d4e78dd8ccb199cc0d7280fcb082` |
| Stable source restored by B | `87d691e5f712f00022bceaea3986fbc64feb992b` |
| Rootfs-hardening main merge, PR #60 | `7e64a5611975225fe852b442341e5a3c1cff918b` |
| Fixture | `The-peephole/peephole-fixture-fullstack@90afaa0c3f650744300afc5d8fed00fd4a0ef5c8` |
| Preview | `fullstack-7d0bba48-6962-4a29-aea4-29ee706110c8` |
| Canary rootfs | `/var/lib/peephole/base-rootfs-aa26a11f0f00d4e78dd8ccb199cc0d7280fcb082-m12` |
| Stable rootfs | `/var/lib/peephole/base-rootfs-83f1d1b6392cfa04b36e087c6930ae5ab8ede25a` |
| Canary bootstrap SHA256 | `3b69f061073e57fee41c32f7f8b96c2bdbef100778285862eadff4af0122a539` |
| Canary Node executable SHA256 | `89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7` |
| Canary Node 24.20.0 linux-x64 archive SHA256 | `2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2` |
| Canary extension artifact | 14 files, version 0.2.0, tree `6d2f1d0edfbc1a07968d6e86b9642bde87c054fef1bf24936f7c14a14188e777` |

The Stable rootfs directory's embedded SHA is an image identifier; it is not
the restored service source SHA. The Canary used the reviewed extracted
builder copy (SHA256 `5aa99cb551c9daa39fa295a1454a2d56fa2a640893b05aefb006dbd50034c6a7`),
not the subsequently merged PR #60 script. PR #60 has its own local WSL build
evidence in [ROOTFS_BUILD.md](ROOTFS_BUILD.md); merging it did not deploy it.
The extension is identified by its artifact tree, not assumed to have the
backend's source SHA.

Recorded times are UTC, with KST where noted:

- 12:27:47: corrected rootfs preparation completed (`rootfs-2`). The preceding
  `rootfs-1` failed during package installation with a host-only TMPDIR; the
  partial image was preserved, then removed only by the separately approved
  second preparation operation. Neither was a preview retry.
- 12:35:23: activation committed, Canary PID 404830, M12 ON, two Node runtime
  processes, invocation `13e40f0c203a4571840ea227ae3c01e6`.
- 12:42:56: operator's recorded Canary start; the parent was created at
  12:43:04.939. One pinned Fullstack Preview was used.
- 12:46:55.296: parent updated to stopped. The 12:48:11 context receipt records
  stopped, errorCode null and ownership revoked with the same service identity.
- 12:56:28–12:56:35: tenant and host/control-plane inventories completed.
- 13:12:26 (**22:12:26 KST**): B rollback committed with exitCode 0.

## Verified outcome and evidence boundaries

| Area | Outcome | Basis and limit |
| --- | --- | --- |
| Chrome -> Production Fullstack | Frontend SUCCESS, Backend SUCCESS, APP_GREETING delivered and displayed as expected | Operator observation recorded in the handoff and confirmed by the user; the reviewed packet has no independent browser/HAR capture of those assertions. No value or request body is reproduced here. |
| Ordinary Stop | stopped, errorCode null, ownership revoked | Parent-specific structured context receipt; not an injected crash. |
| Tenant cleanup | pv_* databases 0, roles 0; unexpected names 0 | Separate read-only tenant inventory, not application SQL-connectivity evidence. |
| Control-plane cleanup | Active Preview/Fullstack/Queue 0; nonterminal ownership 0 | Structured inventory; 10 historical revoked ownership rows are expected, not active residue. |
| Host cleanup | runsc 0, netns 0, leases 0, job bundles/workspaces 0, generated-secret/db-credential/user-env material 0; leftoverTotal 0 | Host inventory; same Canary PID/invocation, NRestarts 0. This is resource absence, not a whole-host non-exposure audit. |
| Stable rollback | ROLLBACK_COMMITTED / ROLLED_BACK_TO_STABLE, exitCode 0, no retry | One approved SSH invocation; executed script SHA256 `d1dc29de393a8c9a60d4c413678b1d026c8b4e1effdb45c1c406b98a2bdf3723`. |
| Post-rollback service | Stable SHA/rootfs above, M12 OFF, PID 406935, two Node processes, NRestarts 0; healthz/readyz, host smoke PASS; 70 s stable | Passed assertions in the hash-pinned B payload and its received labels; 65 s minimum, 70 s observed. Dependent service PIDs unchanged; idle/tenant checks passed. Both images were kept. No second SSH verification was made. |
| Stage3A restoration | 14 files; version 0.2.0; M12 input UI build flag OFF; Production API configuration retained | Local file/tree checks only. Actual Reload, ID, login and live connection remain PENDING USER CONFIRMATION. |

The restored extension tree is
`bc8fc1a4f75cf434f1412b93695a9ae111482454c83494a053fd21d8a7600573`.
The original loaded directory and byte-identical manifest were retained;
expected extension ID is `aojbhoelemgfhnpaojnljminpchlhman`. This does not
attest to its current in-browser state. The full Canary artifact was separately
preserved. Tree digests use sorted relative POSIX paths, concatenating
`path + NUL + sha256(file bytes) + LF`, then SHA256 over UTF-8 bytes.

## Difference from the earlier failure

The 2026-10-14 `Backend Failed` cause remains **UNCONFIRMED**. D1 was absent
for those earlier failed runs and cannot reconstruct them retroactively.
The later Canary included D1/Stage E instrumentation and a rebuilt,
root-owned `/usr/local` image, and succeeded. That observation does not isolate
which change mattered or prove ownership caused the old failure.

The new preparation's host TMPDIR leak and Ubuntu 26.04 verifier chroot-path
issue were reproduced separately; see the retained `local-repro.json` and
[rootfs build policy](ROOTFS_BUILD.md). They must not be relabeled as the
original backend failure's root cause.

No failure event was expected from the successful preview. Actual D1/Stage E
failure-event collection, journal flush/retention and restart survival are
still UNVERIFIED. A missing event from a failed or killed run would not prove
success; the portable diagnostic tests do not close that gap.

## Evidence inventory and SHA256

Artifacts remain local under the operator's `Peephole` workspace, not committed
to this repository. Prefix `P` below means
`peephole-m12-recanary-aa26a11/`; prefix `C` means
`peephole-chrome-stage3a-restore-20261016/`. The first six hashes were checked
against the historical handoff; B and Chrome hashes were checked against their
execution/restoration reports. Handoff/summary hashes are additionally recorded
here from the actual files. Every file was read locally; none was altered.

| Artifact | SHA256 |
| --- | --- |
| P evidence/rootfs-1/step-result.json | `939712368710a065aa39cf447f1e3f67f653909d79830c14569f3482e5d3f013` |
| P evidence/rootfs-2/step-result.json | `b5afde1ab42fc258d33ef2e0015b1ad24d6f318a0766f7b8103d1d76aca1418d` |
| P evidence/activate-1/step-result.json | `3c7ad894a8ad1507254bb53f6318e283c42ceb20c4ee57b95ce6d357a1a37f78` |
| P evidence/context-1/step-result.json | `7507eebe15addfa02d7488d8c78b867acb9bcc2bf681f60ac600a592e4178459` |
| P evidence/tenant-inventory-1/tenant-preflight.json | `96f35f376c604288f17ef9c4e0f5ee2487d9d53b1838bd5f61fd28d4c2f64908` |
| P evidence/inventory-1/step-result.json | `f8b3432cf1505299ae6ac136837a5093954b2916bc25439016032ccdd4990cb1` |
| P evidence/rollback-1/step-result.json | `82c93e5aa3e6732728f9458e3695480ab65de962219f52262aa5919981a50b2a` |
| P evidence/rollback-1/rollback-log.received.jsonl | `789124331a094df6fa9a8129721656c216690b5450cad9aa10826c12e5de385d` |
| P evidence/rollback-1/completion-summary.json | `fcd83884cb848b0a6aef7d4e147f0ac0bf63f98d3f5ef68f30280a5444a4ff13` |
| P HANDOFF-B-20261016.md | `db0b7dfbf87ed50c54ed8d5816968b4e6aa22aad4e9e2921720501ad1fa055dc` |
| C restore-result.json | `8da0eba16acb40f0131e0d25eed644fb9329f3542858df4f58c2d778e245ff17` |

The received rollback log is a reconstruction of this invocation's received
JSON labels using the approved serializer. It is **not** a directly measured
hash of the host append file
`/var/backups/peephole/recanary-aa26a11/rollback-log.jsonl`; that host-file hash
was not returned by the executor. The Chrome hash identifies `restore-result.json`,
not `RESTORE-RESULT.md`.

`HANDOFF-B-20261016.md` and `artifact-manifest.json` retain pre-B approval/status
text and historical hashes. They are not current service-state manifests. The
later approved B payload and `rollback-1/step-result.json` establish the actual
rollback; old approval text is not evidence that B was unexecuted. Do not edit
or rerun the archived package to make the labels current. Existing local
evidence retention is 14 days from first save, user-only access; deletion needs
approval. This repository index neither extends retention nor authorizes export.

## Release readiness

This assessment applies to **x86_64 M12-A/B non-sensitive configuration**.
D-035 defines delivery and fail-closed behavior; it does not expand D-033's
database contract or admit external secrets. Required crash evidence follows
[deployment preconditions §12](USER_PROVIDED_ENVIRONMENT.md#12-deployment-preconditions-limited-canary-completed-general-rollout-pending).
The historical [Linux runbook](M12_REAL_GVISOR_VERIFICATION.md) explicitly
requires the later G/H recheck. Tests merely present in source, CI skips and
ordinary Production Stop cannot substitute for that evidence.

### RELEASE_BLOCKER

**B1 — Current-candidate Linux lifecycle correction.**

- Evidence/gap: the 12/12 real-host result is at `5ed0f92`; later
  concurrent-exit/SIGTERM regressions are portable only. Canary Stop proves
  its one normal path, not the pending-signal interleavings in
  `tests/backendRuntimeProcess.test.ts`.
- Risk/minimum: false stop failure or incomplete independent cleanup. Reuse
  G's six cases then H2/H3's one case on a dedicated host at the release SHA.
  Require evidence of the corrected pending-signal boundary; if the existing
  scenarios do not reach it, add only a narrowly controlled real-boundary case
  in a separately reviewed test change, not a replacement harness.
- Production: **no**. Burden: **medium**, isolated Linux/runsc/rootfs/tmpfs/
  network setup and seven existing scenarios, plus that boundary if missing.
- Pass/stop: scenario assertions, owned resource absence, decoy preservation
  and readable clean parent status all pass, including required material
  non-persistence checks. Section 12 also requires journal non-leakage;
  the existing real harness explicitly reports that scan NOT_RUN. Supply a
  narrow bounded synthetic-sentinel check on an isolated journal, or keep
  that gate open; do not infer it from portable tests or inventory counts.
  FAIL/SKIP/INCOMPLETE, ambiguous ownership or cleanup error blocks release;
  preserve evidence/resources.

**B2 — Actual server-process crash and startup recovery.**

- Evidence/gap: H2/H3 models abandoned ownership, not actual SIGKILL. H1 is
  not implemented in the 12-case harness. D-032/D-033 prior crash acceptance
  does not prove the new M12 broker/material recovery; §12 still requires it.
- Risk/minimum: stale material/routes/resources after ungraceful exit or
  accidental reuse of unavailable configuration. In an isolated environment,
  exercise one pre-START loss and one running-process crash, targeting the
  positively owned actual server child, never the tsx wrapper or a name match.
  Reuse existing composition, startup reconcilers and resource inventories.
- Production: **no**; no reason to kill Production to obtain this evidence.
  Burden: **medium/high**, a small owned-process test addition is needed before
  execution; do not describe it as an existing executable H1 test.
- Pass/stop: no graceful shutdown handler runs; the fresh process cannot
  recover broker values, fails closed appropriately, reaps M12/M10/M11 and
  sandbox resources before listeners, invalidates old routing and leaves
  zero owned residue. Wrong PID, graceful shutdown or missing inventory means
  INVALID/INCONCLUSIVE, not PASS; no blind retries or broad cleanup.

**B3 — Security approval item.**

- Details are managed in a private operational record, not in this
  repository (release owner decision, 2026-10-18).
- Status: open. It is not passed, remediated or verified safe, and a
  functional Canary cannot clear it.
- Pass/stop: the release owner's separate security sign-off. Without it,
  M12 ON stays blocked.

**B4 — Explicit candidate, artifacts, deployment and rollback approval.**

- Evidence/gap: Canary source is `aa26a11`; rootfs hardening merged later at
  `7e64a56`. Production remains at the recorded Stable SHA/M12 OFF. Rootfs
  preparation and rollback were tested, but no general rollout was approved.
- Risk/minimum: deploying a moving main or mismatched bootstrap/UI. Pin the
  actual reviewed 40-character candidate and compare runtime changes with
  the Canary. The `aa26a11..7e64a56` delta is builder/tests/docs only. Reuse
  compatible image/extension bytes after identity review, or prepare a new
  image only if needed. Pin flags, backups and the scoped rollback procedure.
- Production: **later, yes**, only an explicitly approved current idle/state/
  backup/readiness precheck and activation/observation. Burden: **low/medium**
  if identities are unchanged; no new deployment system or blanket Canary rerun.
- Pass/stop: candidate/image/bootstrap/UI agreement, intact rollback backup,
  idle preconditions and explicit approval. After activation require bounded
  health/readiness, stable runtime flags/PID/restart count and resource checks.
  Mismatch, unexpected resources, timeout or unknown outcome stops the plan;
  do not auto-deploy, reconnect/retry or widen scope.

**B5 — Browser artifact and user confirmation at handoff.**

- Evidence/gap: restored Stage3A files/tree verified; current in-browser
  Reload, ID, version, login and Production connection are user-pending.
- Risk/minimum: stale loaded UI/session or wrong extension identity. User
  reloads the existing entry and confirms ID/version/login/connection. A
  future M12-enabled artifact requires its own approved identity/flag check;
  the Stage3A OFF artifact alone cannot provide M12 input UI.
- Production: **no SSH/SQL**; normal approved browser confirmation only.
  Burden: **low**. No Preview Create/Run again is needed for the restoration check.
- Pass/stop: expected ID/version/configuration and user confirmation recorded;
  new rollout UI flag matches the approved plan. An unconfirmed or mismatched
  browser state remains pending; never mark it verified from file hashes alone.

### RECOMMENDED

**R1 — Separate M10/M11/M12 real PostgreSQL query evidence.**

- Evidence/gap: D-033 already accepted the M11 database capability. E3/E4 use
  synthetic URLs; this Canary's packet proves cleanup, not a separately
  captured application SQL assertion. The existing combined test already
  performs the pinned backend's real `/api/db-check` (startup CREATE TABLE /
  SELECT 1) and ordinary Stop/reclamation; it has no supplied passing receipt.
- Risk/minimum: a combined delivery/auth/network regression could hide behind
  TCP readiness. Run only `tests/realCombinedEnvironmentRuntime.test.ts` using
  [its existing safety gates](M12_COMBINED_INTEGRATION.md) and a disposable PG18
  cluster. Reuse it; do not build a new PG harness or query Production.
- Production: **no**. Burden: **medium/high** for isolated PG18/network setup,
  then one existing scenario; may share B1/B2's approved dedicated host.
- Pass/stop: query/config/material assertions, revoked ownership and physical
  DB/role/sandbox absence pass. Unsafe host, query failure, incomplete cleanup
  or preserved resources stop with no force-DROP. This is recommended for
  narrow M12-A/B delivery, not an additional mandatory reacceptance of unchanged
  M11; it becomes a **claim-specific RELEASE_BLOCKER** before declaring the
  combined real SQL path verified or including it as a release guarantee.

**R2 — Failure telemetry capture and retention.**

- Evidence/gap: instrumentation was present, but the successful Canary did
  not exercise a D1/Stage E failure. Genuine failure-event capture/retention/
  restart survival remains unverified.
- Risk/minimum: future incidents lack usable cause evidence. Reuse failures
  from isolated lifecycle work to check the bounded allowlisted projection,
  identity correlation and retention across a test restart. Preserve only
  safe metadata; do not induce a second Production Canary failure for logging.
- Production: **no** for this validation. Burden: **low/medium** when combined
  with B1/B2. Pass: correlated primary/cleanup metadata and demonstrated
  retention without sensitive fields. Missing, malformed, leaked or ambiguous
  data stays UNVERIFIED and stops diagnostic acceptance, not retroactive
  functional Canary acceptance. This diagnostic retention recommendation is
  separate from B1's existing material non-leakage requirement.

**R3 — Bounded soak and operating watch.**

- Evidence/gap: one successful preview and 70 s Stable observation do not
  prove prolonged M12 ON stability.
- Risk/minimum: low-frequency leaks or operational drift. After release gates
  and explicit activation approval, agree a bounded watch window and reuse
  health/restarts/aggregate resource metrics and ordinary workload; do not
  demand an indefinite soak or repeatedly create Canary previews by default.
- Production: **yes, later and separately approved**. Burden: **low execution,
  elapsed observation time chosen by the owner**. Pass: agreed limits met;
  sustained readiness failure, restarts, rising unexplained residue or unknown
  state triggers the approved stop/rollback plan, not an automatic retry.

### FOLLOW_UP

**F1 — Earlier backend failure cause.** Existing failure is still unconfirmed;
the rebuilt image succeeded but is not a causal experiment. Keep that label
and use future genuine, safely captured evidence if available. Production is
not needed by default; effort is incident-dependent. Close only on correlated
evidence; absent evidence stops diagnosis, not the completed functional record.

**F2 — Native ARM64 / additional host compatibility.** PR #60 preserves the
arm64 branch and pins its verified archive digest; only x86_64 WSL full build
is recorded. Use an isolated native host before making an ARM64 operating
claim. No Production access; medium build/setup effort. Require real build,
Node/npm, ownership/bootstrap checks; failed/absent execution stays NOT_RUN.
This becomes a blocker if the chosen release target is ARM64, not for the
recorded x86_64 target.

**F3 — M12-C external keys/secrets.** Design only; public repository execution
cannot provide secrecy. Separate egress, credential handling, consent,
revocation and abuse-control design/review is required before implementation.
No Production access is authorized; effort is high and separately scoped.
There is no M12-A/B release dependency on M12-C. Stop any attempt to broaden
the current non-sensitive contract without a new decision and evidence.

## Recommended next sequence

1. Review this closure and obtain the B3 security sign-off through the
   private record while pinning the intended candidate. Confirm Stage3A browser handoff with the
   user; do not create another preview for that check.
2. The original recommendation was to execute B1, then B2, in an isolated
   Linux/gVisor environment before M12 ON. **Superseded for v0.3.0 only:** on
   2026-10-18 the release owner accepted the residual risk of not running
   them ([risk review](RELEASE_V0.3.0_RISK_REVIEW.md)). B1 and B2 remain
   NOT_RUN, and the acceptance is not a PASS. Ordinary Canary Stop and the
   PR #60 WSL rootfs build are still not substitutes for that verification.
3. R1 and R2 stay unverified unless run separately; a reviewed decision may
   defer the separate SQL guarantee.
4. Close B4/B5, obtain separate Production approval, then perform only the
   necessary fresh prechecks and controlled activation/watch. Reuse existing
   successful Canary evidence; repeat a preview only for a specific changed
   contract or evidence gap with separate authorization.

Release preparation can proceed now. Formal activation still needs the B3
security sign-off (a separate, private item that remains open), B4/B5 and its
own separate Production approval. This documentation PR can be reviewed/merged independently of release
approval; neither its merge nor PR #60's merge changes Production.
