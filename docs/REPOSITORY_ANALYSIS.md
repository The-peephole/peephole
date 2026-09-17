# Repository Analysis Specification

## 1. Objective

Repository analysis gathers bounded evidence from a public GitHub repository and produces two separate outputs:

1. a human-readable repository analysis,
2. a machine-readable preview-eligibility decision.

Analysis never installs dependencies or executes repository code.

## 2. Inputs

```ts
interface RepositoryRef {
  repositoryId: number
  owner: string
  repo: string
  defaultBranch: string
  commitSha: string
}
```

All analysis is pinned to `commitSha`. Owner, repository, or branch alone is not
an immutable input.

Analysis is requested with a `RepositoryRevisionTarget`, which keeps three
concepts distinct:

```ts
interface RepositoryRevisionTarget {
  repository: { owner: string; repo: string }
  ref: { kind: "default" } | { kind: "branch"; name: string }
}
```

The Side Panel lets the user pick any branch from a bounded list; the analysis
loader resolves the selected `ref` to a full 40-character commit SHA
(`GitHubClient.getRepositoryMetadataAtBranch` for a branch, or
`getRepositoryMetadata` for the repository's default branch) before any
analysis runs. `defaultBranch` on the resulting `RepositoryRef` always names
the repository's actual default branch; it is never overwritten by the
selected branch. The analysis cache key remains
`repositoryId + commitSha + analyzerVersion`, so two different branches that
resolve to the same commit share one cached analysis.

Additional inputs:

- GitHub repository metadata,
- a bounded map of requested text files,
- analyzer version,
- compatibility-contract version.

## 3. Files to Inspect

Attempt only known paths and enforce per-file and total-byte limits.

### Core

- `package.json`
- `index.html`
- `README.md`

### Lock and workspace files

- `package-lock.json`
- `npm-shrinkwrap.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- `bun.lock`
- `bun.lockb`
- `pnpm-workspace.yaml`

### Environment templates

- `.env.example`
- `.env.sample`
- `.env.template`
- `.env.local.example`

### Framework and build config

- `vite.config.js`, `.mjs`, `.ts`, `.mts`
- `next.config.js`, `.mjs`, `.ts`
- `svelte.config.js`, `.mjs`
- `vue.config.js`, `.ts`
- `tsconfig.json`

### Deployment config

- `vercel.json`
- `netlify.toml`

### Workspace indicators

- `turbo.json`
- `nx.json`
- `lerna.json`

Do not recursively download the repository during analysis.

## 4. Framework Detection

Framework detection returns evidence, not only a label.

Examples:

- `vite` plus `react` dependency -> `react-vite`
- `vite` plus `vue` dependency -> `vue-vite`
- `vite` plus `svelte` and a Svelte plugin -> `svelte-vite`
- `next` dependency plus matching scripts -> `next`
- root `index.html` with no package manifest -> `static`

Config filenames strengthen evidence but do not override contradictory package data. Multiple application frameworks or workspace roots may create an ambiguity blocker.

## 5. Package Manager Detection

Priority:

1. valid `packageManager` field,
2. exactly one recognized lock file,
3. package-manager-specific metadata,
4. otherwise `unknown`.

Conflicting lock files produce a warning or blocker; they are never resolved by arbitrary precedence for native builds.

Frozen install commands:

```text
npm  -> npm ci
pnpm -> pnpm install --frozen-lockfile
yarn -> version-specific immutable/frozen install
bun  -> bun install --frozen-lockfile
```

The Build Adapter registry narrows actual support to npm with a root
`package-lock.json`, even though the analyzer recognizes more managers.

## 6. Runtime and Build Detection

Inspect `scripts` in `package.json` and known framework defaults.

Output:

```ts
interface RuntimeEvidence {
  installCommand: string | null
  devCommand: string | null
  buildCommand: string | null
  outputDirectory: string | null
  evidence: string[]
  warnings: string[]
}
```

For current native builds:

- an explicit `build` script is preferred,
- arbitrary script composition is not guessed,
- recognized Vite output defaults to `dist` unless config evidence says otherwise,
- output paths must be repository-relative and pass runner validation,
- development-server commands are informational only.

## 7. Environment Detection

Parse variable names from environment templates without retaining values. Ignore blank lines and comments. Record whether names are public-client style (`VITE_*`, `NEXT_PUBLIC_*`) or likely secret.

Potential runtime blockers include:

- required variables without safe fixture values,
- secret-like names such as tokens, private keys, passwords, and database URLs,
- code/config evidence of an external backend required at startup.

Never fetch `.env`, `.env.local`, or secret values from repository history.

## 8. Deployment Detection

This section covers local, immutable, per-commit deployment *evidence* only
-- the bounded live-evidence hierarchy that feeds
`RepositoryAnalysis.deployment`. It never proves an actual live deployment.

```ts
type DeploymentStatus = "declared" | "configured" | "unknown"
```

`declared` means the repository's GitHub metadata declares a homepage URL
that normalizes to HTTP(S). This is evidence of intent, not proof of a live
deployment: a homepage can be a marketing site, documentation, or (as with
this repository) a Chrome Web Store listing. `configured` means a
`vercel.json` or `netlify.toml` file was found with no known URL. Neither
value is ever treated as "confirmed" within this analysis.

A genuinely confirmed live deployment requires a separate, bounded GitHub
Deployments API lookup -- see section 15 below. That lookup's result is
mutable, short-TTL state kept entirely out of this immutable,
`repositoryId:commitSha:analyzerVersion`-keyed analysis.

## 9. README Inspection

`README.md` is fetched within the known-file and byte bounds, but the current
analyzer does not parse README prose into eligibility evidence. Future structure
or backend detection may add explicit, tested rules; README text must never be
executed as instructions or allowed to override machine-readable
contradictions.

## 10. External Service Hints

The current bounded rules flag a fixed set of server/database dependencies,
selected hosted backend clients, and API-like environment-variable names. This
is an early hint set, not general backend detection.

These are evidence, not proof. A blocker requires a rule tied to the v0.1 contract, such as `build requires secret environment value` or `preview requires persistent server process`.

## 11. Monorepos

The current detector marks any `package.json` `workspaces` field or root
`pnpm-workspace.yaml`, `turbo.json`, `nx.json`, or `lerna.json` as both
`monorepo` and `ambiguous`. The current contract returns `unsupported`; it does
not enumerate applications or select a frontend target.

Repository/application structure detection (below) now enumerates the
applications this section previously only flagged, but the blocker applies
exactly as before when:

- more than one likely application exists,
- the build requires choosing a workspace,
- root scripts delegate through unsupported orchestration,
- output location cannot be resolved deterministically.

A repository is not treated as a simple root application merely because the root has a `package.json`.

## 12. Repository Structure Detection

Structure detection is a bounded, detection-only layer: it describes the
repository's layout and lists project candidates without selecting or
building any of them.

```ts
type RepositoryStructureLayout =
  | "single-project"
  | "workspace"
  | "multi-project"
  | "unknown"

type ProjectCandidateRole =
  | "project-candidate"
  | "package-candidate"
  | "unknown"

interface RepositoryProjectCandidate {
  path: string // repository-relative; "." for the root
  isRoot: boolean
  role: ProjectCandidateRole
  hasPackageJson: boolean
  packageName: string | null
  evidence: string[]
  warnings: string[]
}

interface RepositoryStructure {
  layout: RepositoryStructureLayout
  projects: RepositoryProjectCandidate[]
  workspaceEvidence: string[]
  warnings: string[]
  complete: boolean
  truncated: boolean
}
```

`role` is deliberately conservative: a directory is `project-candidate` only
when it has frontend-framework evidence (a `vite`/`react`/`vue`/`svelte`/`next`
dependency, mirroring framework detection) or is the repository root with
recognized evidence; a directory conventionally named `packages` or nested
under it is `package-candidate` (it may be a shared library, not an
application); everything else with a package.json but no such evidence is
`unknown`. Directory names such as `backend` never imply backend execution
support -- that classification stays `unknown` until a later roadmap stage
adds real backend detection.

Candidate discovery combines two sources, both bounded:

1. **Declared workspace patterns** -- `package.json` `workspaces` (array form
   or `{ packages: [...] }` object form) and a bounded subset of
   `pnpm-workspace.yaml`'s `packages:` list (not a YAML parser). Only an exact
   1-2 segment literal path (`"frontend"`, `"apps/web"`) or a single-level
   `dir/*` wildcard is supported; negation, `**`, mid-pattern wildcards,
   absolute paths, and `..` are reported as a warning, never guessed.
2. **Conventional root directory names**, read from the same bounded root
   directory listing analysis already performs, split into two kinds:
   - **Direct** (`frontend`, `backend`, `client`, `web`) -- probed for their
     own `package.json` directly, exactly like a declared literal path. A
     directory name alone is never sufficient; a candidate is only surfaced
     once a `package.json` is actually found at that path.
   - **Container** (`apps`, `packages`) -- never probed for their own
     `package.json`. Instead they are bounded-listed exactly like a declared
     `dir/*` wildcard, so `apps/web` or `packages/ui` can be discovered even
     when no workspace tool declares them. A workspace pattern that already
     declares the same directory as a wildcard (e.g. `apps/*`) shares the
     same listing rather than listing it twice.

A `dir/*` wildcard or container directory is resolved with exactly one
bounded directory listing of `dir` (`GitHubClient.getRepositoryDirectoryEntries`,
a fixed, validated, path-checked operation); only `type: "dir"` entries
become candidates, so symlinks and submodules are never recursively followed,
and no listing is ever performed on a discovered subdirectory (`apps/web` is
never itself listed). Every read uses the same resolved `commitSha` as the
rest of analysis, never a mutable branch name.

Bounds: at most 8 directory listings (wildcard and container parents share
this budget), 200 entries considered per listing, 20 candidate `package.json`
probes, and 512 KB of nested `package.json` bytes read in total, strictly
enforced -- each nested read's byte cap is `min(256 KB, bytes remaining in
the 512 KB budget)`, so no single read can push the total past the bound; once
the remaining budget reaches zero, no further candidate is read at all.
Hitting any of these bounds sets `truncated: true` rather than silently
returning a partial result as complete. A per-candidate GitHub read failure
(including a candidate that no longer fits the remaining byte budget) or a
directory listing failure is recorded as a warning and sets `complete: false`
for the whole result -- distinct from `truncated`, which means a bound was
reached by design, not that a read failed -- but does not fail analysis;
sibling candidates and listings are still discovered normally. A malformed
nested `package.json` is kept as an `unknown`-role candidate carrying its
parse error as a warning.

Detecting `frontend`/`backend`-shaped candidates never changes preview
eligibility by itself. The repository root remains blocked when workspace
selection is ambiguous. A user may explicitly select a non-root
`project-candidate`; that path then receives a separate bounded exact-SHA
`BuildTargetAnalysis`. Backend/unknown/package candidates are not offered as
frontend targets, and discovery evidence alone never makes a target runnable.

## 13. Preview Eligibility

```ts
interface PreviewEligibility {
  contractVersion: string
  mode: "existing-deployment" | "native-static-build" | "unsupported"
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none" | "unknown"
  installCommand: string | null
  buildCommand: string | null
  outputDirectory: string | null
  evidence: string[]
  blockers: Array<{
    code: string
    message: string
  }>
}
```

`native-static-build` requires all compatibility checks plus a match in the
`core/preview/buildAdapters.ts` registry. `runnerSupport.ts` derives analyzer
blockers from that same registry rather than maintaining a second capability
table. This check is evaluated first and always wins: local deployment
evidence (a declared homepage or provider configuration) never overrides a
genuinely buildable target, since it is not proof of an actual deployment.
`existing-deployment` is only the fallback shown when a build is not
possible but `deployment.status` is `"declared"` or `"configured"`. All other
cases (no build and no local deployment evidence) return `unsupported`; no
StackBlitz fallback exists.

Common blocker codes:

- `UNSUPPORTED_FRAMEWORK`
- `RUNNER_TARGET_UNAVAILABLE`
- `UNKNOWN_PACKAGE_MANAGER`
- `CONFLICTING_LOCKFILES`
- `MALFORMED_PACKAGE_JSON`
- `MISSING_BUILD_COMMAND`
- `UNKNOWN_OUTPUT_DIRECTORY`
- `SECRET_ENV_REQUIRED`
- `PERSISTENT_SERVER_REQUIRED`
- `BACKEND_REQUIRED`
- `AMBIGUOUS_WORKSPACE`
- `ANALYSIS_INCOMPLETE`

## 14. Analysis Output

```ts
interface RepositoryAnalysis {
  repository: RepositoryRef
  analyzerVersion: string
  technologies: {
    framework: string
    typescript: boolean
    evidence: string[]
  }
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none" | "unknown"
  runtime: RuntimeEvidence
  environment: {
    templateFound: boolean
    variables: string[]
    secretLikeVariables: string[]
  }
  deployment: {
    status: "declared" | "configured" | "unknown"
    provider: string | null
    url: string | null
    evidence: string[]
  }
  workspace: {
    monorepo: boolean
    ambiguous: boolean
    evidence: string[]
  }
  structure: RepositoryStructure
  preview: PreviewEligibility
  inspectedFiles: string[]
  warnings: string[]
}
```

Target selection changes analysis behavior, so `ANALYZER_VERSION` is `0.1.4`
(bumped from `0.1.3` when `deployment.status` dropped its misleading
`"confirmed"` value); target-scoped results have their own version and cache
identity of repository id + exact commit SHA + source root + target analyzer
version. `PREVIEW_CONTRACT_VERSION` is `static-v2`. Legacy `static-v1` remains
accepted only when the target is omitted and therefore implicitly the
repository root. Existing deployed-site Live Preview does not touch either
version: it never changes the build contract.

The analyzer output is safe to display and cache. It contains variable names and evidence, never secret values or executed output.

The analyzer is intentionally broader than the current runner. Vue/Svelte and
non-npm evidence may appear in this output while
`RUNNER_TARGET_UNAVAILABLE` prevents a preview build.

Build Adapter resolution occurs after target analysis. `static-html-v1`
remains root-only. `vite-react-npm-v1` accepts root or safe nested targets only
when the selected directory is independently installable with its own
`package.json` and `package-lock.json`. Zero matches is unsupported; multiple
matches are an explicit configuration error. Shared-root npm workspaces and
pnpm/yarn/bun orchestration remain unsupported.

## 15. Live Deployment Discovery (Mutable, Separate From Analysis)

Unlike everything above, live deployment discovery is not part of
`RepositoryAnalysis` and does not use its cache. It answers a different
question -- "does this repository currently have an actual deployed site,
and where" -- using mutable, short-lived state keyed by repository identity
only (`types/deployment.ts`, `core/github/liveDeploymentCache.ts`, 45-second
TTL). Folding it into the immutable `repositoryId:commitSha:analyzerVersion`
analysis cache would leak stale live-deployment state across an unrelated
axis (a repository's current deployment can change independently of any
particular analyzed commit).

```ts
type LiveDeploymentStatus = "confirmed" | "not-detected"

interface LiveDeploymentCandidate {
  environment: string
  productionEnvironment: boolean
  url: string // already validated by core/github/externalUrlPolicy.ts
  ref: string | null
  sha: string | null
  state: string
}

interface RepositoryLiveDeployment {
  status: LiveDeploymentStatus
  candidate: LiveDeploymentCandidate | null // non-null only when confirmed
  candidateCount: number
  truncated: boolean
  evidence: string[]
}
```

`"confirmed"` means the bounded lookup below found at least one deployment
whose most recent status is `success` and whose `environment_url` passed the
shared external-URL safety check. `"not-detected"` means the lookup
completed with no such candidate -- it never means the lookup failed. A
failed lookup (GitHub rate-limited, unreachable, or returning a malformed
response) is instead a rejected loader promise / background message error,
so the Side Panel's "Deployment" section can show "Deployment information is
currently unavailable" without that state ever being confused with a
genuine, verified absence of a live deployment.

### Bounded GitHub reads

`GitHubClient.listRepositoryDeployments` fetches `GET
/repos/{owner}/{repo}/deployments?per_page=10&page=1` -- exactly one page,
never paginated further; `truncated` is set when the page came back full.
`GitHubClient.listDeploymentStatuses` fetches `GET
.../deployments/{id}/statuses?per_page=30&page=1` for one deployment --
again exactly one page. GitHub does not guarantee a particular status order,
so the loader always picks the status with the latest `createdAt` from
whatever the page returns rather than assuming position; `truncated` is set
when that page came back full too. At most `MAX_DEPLOYMENT_STATUS_LOOKUPS`
(5) deployments ever receive a status lookup, chosen by
`core/analyzer/liveDeploymentSelector.ts#rankDeploymentsForStatusLookup`:
`production_environment` deployments first, then an environment name that
reads as production (matches `/prod/i`), then everything else, each tier
keeping the GitHub API's relative order. A single deployment's status lookup
failing (anything other than an abort) is recorded as an unknown status for
that one deployment and does not fail the whole lookup; only an abort
propagates.

### Selection rule

`core/analyzer/liveDeploymentSelector.ts#selectLiveDeployment` never guesses:
a deployment is only ever actionable when its resolved status state is
exactly `"success"` and it has a non-null `environment_url` that passes
`core/github/externalUrlPolicy.ts#isSafeExternalUrl` (HTTPS only for this
path -- see below). A `failure`/`error`/`inactive`/`pending`/`in_progress`/
`queued` status, or a missing/unsafe URL, is never selected regardless of
environment name. Among actionable candidates, the same tiering used for
lookup ranking picks the single result: `production_environment` first, then
a production-like environment name, then anything else. Ambiguous or
multiple candidates are not surfaced as a list in this stage; only the
single highest-tier actionable candidate is returned, with `candidateCount`
and `evidence` describing how many deployments were actually inspected.

### URL safety

`isSafeExternalUrl` is the single validator shared by the repository homepage
link and the live-deployment URL. For live deployments it requires `https:`
strictly (no `allowHttp` override); for the pre-existing homepage link it
additionally accepts `http:` to preserve that field's existing "normalized
HTTP(S)" contract. In both modes it rejects: embedded credentials; loopback,
RFC 1918 private, link-local, and CGNAT (100.64.0.0/10) IPv4 literals;
loopback, link-local (`fe80::/10`), and unique-local (`fc00::/7`) IPv6
literals (including an IPv4-mapped IPv6 literal resolving to one of the
above); `localhost`/`*.localhost`; control characters; and an excessively
long URL. Every other scheme (`javascript:`, `data:`, `file:`, `blob:`,
`chrome-extension:`, and anything else) is rejected implicitly by the
`https:`/`http:` allowlist rather than a scheme blocklist. GitHub Pages-style
or local-development hosts receive no special allowance: this stage targets
public deployed sites only.

### Comparison to the selected preview commit

The live deployment's `candidate.sha` (when GitHub reports one) is compared
against the currently selected preview commit (`RepositoryAnalysis.repository.commitSha`)
purely for display -- "Matches selected commit" or "Deployment commit differs
from selected preview commit" -- never as a correctness signal for Build
Preview. When `candidate.sha` is absent, the comparison reads "Deployment
commit unknown" rather than assuming the repository's default branch HEAD is
the deployment's commit. Selecting a different branch only ever changes which
analyzed commit this comparison is made against; it does not retrigger the
deployment lookup itself, and it never implies the live deployment belongs to
that branch.

### Why this is not an embedded preview

The Side Panel never fetches, proxies, or renders the live deployment's HTML.
"Open live site" is a plain `target="_blank"` anchor to the validated URL,
identical in trust posture to the pre-existing homepage link. Building a
generic trusted-iframe contract for arbitrary third-party origins would
require relaxing the manifest CSP's `frame-src` beyond the Peephole-owned
artifact origin (see [Architecture](ARCHITECTURE.md#8-delivery-plane-and-origins))
and would run into the deployment's own `frame-ancestors`/`X-Frame-Options`/
authentication cookies -- none of which this stage attempts to solve. No
manifest permission or CSP change was made to support this feature.
