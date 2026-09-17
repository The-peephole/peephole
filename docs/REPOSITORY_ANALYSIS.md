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

The current runner narrows actual support to npm with a root
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

Deployment states:

```ts
type DeploymentStatus = "confirmed" | "configured" | "unknown"
```

`confirmed` currently means that GitHub repository metadata contains a URL that
normalizes to HTTP(S). It does not mean Peephole checked reachability, content,
or framing policy. A `vercel.json` or `netlify.toml` file alone yields
`configured`, not `confirmed`.

The implemented detector uses repository homepage metadata, `vercel.json`, and
`netlify.toml`. Existing-site Live Preview, reachability checks, and framing
checks are future work.

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
eligibility by itself: the existing `AMBIGUOUS_WORKSPACE` blocker still
applies when `workspace.ambiguous` is true, and no nested candidate is ever
passed to the build plan or Preview API.

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

`native-static-build` requires all compatibility checks plus
`core/preview/runnerSupport.ts` to admit the framework/package-manager pair.
`existing-deployment` currently requires normalized HTTP(S) homepage metadata.
All other cases return `unsupported`; no StackBlitz fallback exists.

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
    status: "confirmed" | "configured" | "unknown"
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

Adding `structure` changed the analysis schema, so `ANALYZER_VERSION` moved
to `0.1.2`; an analysis cached under the previous version is never reused as
this shape. `PREVIEW_CONTRACT_VERSION` (`static-v1`) is unchanged because the
runner/build contract did not change.

The analyzer output is safe to display and cache. It contains variable names and evidence, never secret values or executed output.

The analyzer is intentionally broader than the current runner. Vue/Svelte and
non-npm evidence may appear in this output while
`RUNNER_TARGET_UNAVAILABLE` prevents a preview build.
