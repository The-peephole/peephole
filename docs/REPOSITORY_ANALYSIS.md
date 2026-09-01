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
  name: string
  defaultBranch: string
  commitSha: string
}
```

All analysis is pinned to `commitSha`. Owner, repository, or branch alone is not an immutable input.

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
- `.github/workflows/*.yml` only through a bounded metadata strategy

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

v0.1 may narrow actual runner support even when the analyzer recognizes more managers.

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

For native v0.1 builds:

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

Confirmed means a plausible deployment URL is known from authoritative repository metadata or a provider/API check and passes URL safety validation. A config file alone yields `configured`, not `confirmed`.

GitHub Pages, repository homepage, Vercel, and Netlify evidence may be inspected. Reachability and framing permission are presentation concerns and do not change source-build eligibility.

## 9. README Inspection

README inspection is lightweight supporting evidence for:

- documented install/start/build commands,
- required environment variables,
- demo links,
- backend/database requirements,
- monorepo application paths.

README claims do not override machine-readable contradictions and are never executed as instructions.

## 10. External Service Hints

Flag dependencies and configuration that suggest required services, including database clients, hosted backend SDKs, authentication providers, server-only frameworks, and runtime API URLs.

These are evidence, not proof. A blocker requires a rule tied to the v0.1 contract, such as `build requires secret environment value` or `preview requires persistent server process`.

## 11. Monorepos

Detect workspace declarations and common monorepo tools. v0.1 returns `unsupported` when:

- more than one likely application exists,
- the build requires choosing a workspace,
- root scripts delegate through unsupported orchestration,
- output location cannot be resolved deterministically.

A repository is not treated as a simple root application merely because the root has a `package.json`.

## 12. Preview Eligibility

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

`native-static-build` requires all relevant v0.1 compatibility checks to pass. `existing-deployment` requires a confirmed safe URL. All other cases return `unsupported`; no StackBlitz fallback exists.

Common blocker codes:

- `PRIVATE_REPOSITORY`
- `UNSUPPORTED_FRAMEWORK`
- `UNKNOWN_PACKAGE_MANAGER`
- `CONFLICTING_LOCKFILES`
- `MISSING_BUILD_COMMAND`
- `UNKNOWN_OUTPUT_DIRECTORY`
- `SECRET_ENV_REQUIRED`
- `PERSISTENT_SERVER_REQUIRED`
- `BACKEND_REQUIRED`
- `AMBIGUOUS_WORKSPACE`
- `REPOSITORY_TOO_LARGE`

## 13. Analysis Output

```ts
interface RepositoryAnalysis {
  repository: RepositoryRef
  analyzerVersion: string
  technologies: {
    framework: string
    typescript: boolean
    evidence: string[]
  }
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
  preview: PreviewEligibility
  warnings: string[]
}
```

The analyzer output is safe to display and cache. It contains variable names and evidence, never secret values or executed output.
