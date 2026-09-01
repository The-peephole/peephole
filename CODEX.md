# Codex Implementation Guide

This is the primary implementation brief for Peephole. Read all Markdown documents in the repository before changing production code.

## Mission

Implement Peephole v0.1: a Chrome extension plus an isolated preview service that can analyze and preview a deliberately limited class of public GitHub frontend repositories without cloning locally or depending on StackBlitz.

Do not imply universal repository support. A safe, evidence-based unsupported result is a valid outcome.

## Required Technology

Extension:

- WXT
- React
- TypeScript
- Manifest V3
- Chrome Side Panel for the full preview experience
- GitHub REST API where needed

Preview service:

- a control API and asynchronous job model,
- disposable isolated build workers,
- static artifact storage,
- a dedicated preview origin separate from extension and API origins.

Prefer browser-native APIs and small dependencies. Do not select a sandbox implementation until its isolation, resource-control, and network model has been reviewed.

## Architecture Constraints

Keep these boundaries explicit:

```text
GitHub DOM adapter
        |
        v
Extension application + UI
        |
        +--> Repository analysis client
        |
        +--> Preview orchestration client
                    |
                    v
             Isolated build runner
                    |
                    v
             Static preview origin
```

- The repository analyzer must not depend on GitHub DOM structure.
- GitHub DOM selectors and navigation behavior belong only in the GitHub adapter.
- Cross-origin GitHub API requests must run in the extension background service worker through a fixed, validated message contract.
- Preview eligibility is a pure decision over analysis evidence where possible.
- The extension must never install dependencies, evaluate source, or run build commands.
- Runner credentials, job state, and infrastructure details must not leak into extension UI state.
- Repository content is untrusted even when the repository is popular or public.

## Milestone 1: Extension Shell

The first milestone is intentionally limited to:

1. WXT + React + TypeScript extension setup,
2. execution on `https://github.com/*/*`,
3. valid repository-page detection,
4. exactly one visible `Peephole` action,
5. a panel opened by that action,
6. owner/repository display,
7. correct behavior across GitHub client-side navigation.

The transitional StackBlitz action has been removed. Do not reintroduce an external IDE fallback.

## Implementation Order

### Phase 1 - Extension shell

Maintain the existing repository parser, GitHub action insertion, panel, and SPA navigation behavior. Injection must remain idempotent and UI state must reset when repository identity changes.

### Phase 2 - Repository metadata

Fetch only the metadata and known files required by the analyzer:

- repository id and immutable commit SHA,
- default branch and homepage,
- `package.json`, lock files, environment templates,
- selected framework, deployment, and documentation files.

### Phase 3 - Analysis and eligibility

Detect framework, package manager, commands, environment requirements, deployment evidence, and monorepo blockers. Produce a separate preview-eligibility result:

- `existing-deployment`,
- `native-static-build`,
- `unsupported`.

Every result must include evidence and blockers. Do not convert uncertainty into a positive runnable decision.

### Phase 4 - Preview control plane

Implement a commit-pinned asynchronous job API with idempotency, status polling, cancellation, expiry, and artifact URLs. The API schedules work; it does not execute builds in the request process.

### Phase 5 - Native static runner

Support only the v0.1 compatibility contract:

- static repositories,
- root-level Vite React/Vue/Svelte applications,
- deterministic installs and builds without secrets,
- known static output directories.

Run each job in a fresh restricted sandbox, publish only static artifacts, and destroy the writable workspace after completion.

### Phase 6 - Side-panel preview

Add native Peephole preview controls. Show analysis, eligibility, build progress, errors, and the isolated preview in a Chrome side panel.

### Phase 7 - Hardening

Add job quotas, controlled dependency-registry egress, abuse controls, cache invalidation, observability, malicious fixtures, and cross-origin security tests before declaring v0.1 complete.

## Suggested Project Structure

```text
peephole/
  entrypoints/
    github.content/
    sidepanel/
    background.ts
  components/
  core/
    github-dom/
    github/
    analyzer/
    preview/
  services/
    preview-api/
    preview-worker/
  types/
  utils/
```

The service directories may become separate deployable packages. Shared domain contracts must not import extension DOM code or runner implementation details.

## Domain Model

```ts
export interface RepositoryRef {
  repositoryId: number
  owner: string
  name: string
  commitSha: string
}

export interface PreviewEligibility {
  mode: "existing-deployment" | "native-static-build" | "unsupported"
  buildCommand: string | null
  outputDirectory: string | null
  evidence: string[]
  blockers: string[]
}

export interface PreviewJob {
  id: string
  repository: RepositoryRef
  status: "queued" | "fetching" | "installing" | "building" | "publishing" | "ready" | "failed" | "expired"
  previewUrl: string | null
  errorCode: string | null
  expiresAt: string
}
```

Use precise types instead of `Record<string, any>` application state. See the repository-analysis and preview-runtime documents for complete contracts.

## GitHub Navigation

GitHub uses client-side navigation. The extension must handle repository-to-repository, repository-to-subpage, and repository-to-non-repository transitions without a reload, duplicate actions, stale owner/repository state, or stale preview jobs.

## Performance Requirements

- Fetch only known analysis files before a build is requested.
- Pin analysis and preview jobs to a commit SHA.
- Cache analysis by repository id plus commit SHA.
- Cache build artifacts by repository id, commit SHA, runner version, and normalized build plan.
- Start expensive work only after explicit user action.
- Stream or poll meaningful job phases rather than showing indefinite loading.

## Security Requirements

Never:

- execute repository code in an extension, content script, background worker, or control API process,
- inject arbitrary remote scripts into privileged extension pages,
- use `eval` for repository content,
- expose GitHub or infrastructure credentials to a build,
- mount host filesystems or a container socket into a runner,
- allow access to private networks or cloud metadata endpoints,
- store or display secret environment values.

Every build must be non-root, disposable, resource-limited, time-limited, and isolated from other jobs. Dependency downloads must use an explicit allow policy. Preview content must be served from a separate registrable domain with restrictive response headers.

## UX Requirements

Clearly distinguish confirmed facts, configuration evidence, warnings, build phases, and unsupported states. Show actionable blockers such as `secret environment variables required` or `workspace selection is ambiguous` rather than a generic failure.

## Error Handling

The panel must remain usable after GitHub rate limits, missing files, malformed JSON, network errors, job timeouts, install failures, build failures, unavailable artifacts, and repository navigation during a job. Stale job results must never attach to a newly visited repository.

## Testing

At minimum, cover:

- GitHub URL parsing and DOM integration,
- framework/package manager/environment detectors,
- preview eligibility,
- preview API state transitions and idempotency,
- runner timeout/resource/network policy,
- preview-origin isolation,
- GitHub SPA navigation while jobs are active.

Unit tests must not depend on live GitHub APIs. Use fixtures and a fake runner for integration tests.

## Explicit Non-goals for v0.1

- private repository authentication,
- arbitrary repository execution,
- persistent SSR or backend processes,
- database and external service provisioning,
- user-provided secret injection,
- Docker-compose projects,
- automatic monorepo application selection,
- support for every language or package manager,
- AI-generated analysis,
- numeric previewability scores.

## Completion Definition

Peephole v0.1 is complete when a user can install the unpacked extension, open a supported public repository, inspect evidence, start a commit-pinned isolated build, and view the resulting static application inside the Peephole experience. Unsupported repositories must explain why, GitHub navigation must remain correct, and no preview path may depend on StackBlitz.
