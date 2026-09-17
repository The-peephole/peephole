import { useEffect, useId, useMemo, useState, type ReactNode } from "react"

import { resolveBackendExecutionSupport } from "../core/analyzer/backendRuntimeAdapter"
import { isSafeExternalUrl } from "../core/github/externalUrlPolicy"
import { DEFAULT_REPOSITORY_REF } from "../core/github/repositoryRef"
import { toRootBuildTargetAnalysis } from "../core/preview/buildAdapters"
import type {
  BuildTargetAnalysis,
  BuildTargetAnalysisLoader,
  Framework,
  PreviewMode,
  RepositoryAnalysis,
  RepositoryAnalysisLoader,
} from "../types/analysis"
import type { BackendCandidate, BackendDetection } from "../types/backend"
import type {
  LiveDeploymentCandidate,
  RepositoryLiveDeployment,
  RepositoryLiveDeploymentLoader,
} from "../types/deployment"
import type { EnvironmentRequirement } from "../types/environment"
import type {
  RepositoryBranchList,
  RepositoryBranchesLoader,
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryRefSelection,
} from "../types/repository"
import type { RepositoryStructureLayout } from "../types/structure"

interface RepositoryAnalysisViewProps {
  repository: RepositoryIdentity
  loadRepositoryAnalysis: RepositoryAnalysisLoader
  loadBuildTargetAnalysis?: BuildTargetAnalysisLoader
  loadRepositoryBranches: RepositoryBranchesLoader
  loadRepositoryLiveDeployment?: RepositoryLiveDeploymentLoader
  renderPreviewControls?: (
    analysis: BuildTargetAnalysis & RepositoryAnalysis,
  ) => ReactNode
  /**
   * Rendered only for a candidate `resolveBackendExecutionSupport` reports
   * as supported -- an unsupported candidate always keeps the plain
   * "Execution: Not supported yet" detail exactly as before, with no call
   * here at all. This view never owns a `BackendRuntimeApi` client or a
   * URL of any kind; the caller (see entrypoints/sidepanel) is responsible
   * for Start/Stop and status polling.
   */
  renderBackendRuntimeControls?: (input: {
    candidate: BackendCandidate
    repository: RepositoryMetadata
  }) => ReactNode
}

type AnalysisState =
  | { status: "loading"; previous: RepositoryAnalysis | null }
  | { status: "ready"; value: RepositoryAnalysis }
  | {
      status: "error"
      message: string
      previous: RepositoryAnalysis | null
    }

type BranchState =
  | { status: "loading" }
  | { status: "ready"; value: RepositoryBranchList }
  | { status: "error"; message: string }

export function RepositoryAnalysisView(props: RepositoryAnalysisViewProps) {
  const repositoryKey = `${props.repository.owner.toLowerCase()}/${props.repository.repo.toLowerCase()}`

  return <RepositoryAnalysisSession key={repositoryKey} {...props} />
}

function RepositoryAnalysisSession({
  repository,
  loadRepositoryAnalysis,
  loadBuildTargetAnalysis = unavailableTargetLoader,
  loadRepositoryBranches,
  loadRepositoryLiveDeployment = unavailableLiveDeploymentLoader,
  renderPreviewControls,
  renderBackendRuntimeControls,
}: RepositoryAnalysisViewProps) {
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    status: "loading",
    previous: null,
  })
  const [analysisRequestVersion, setAnalysisRequestVersion] = useState(0)
  const [branchState, setBranchState] = useState<BranchState>({
    status: "loading",
  })
  const [branchRequestVersion, setBranchRequestVersion] = useState(0)
  const [selectedRef, setSelectedRef] = useState<RepositoryRefSelection>(
    DEFAULT_REPOSITORY_REF,
  )

  useEffect(() => {
    const abortController = new AbortController()
    setBranchState({ status: "loading" })

    const load = async () => {
      try {
        const value = await loadRepositoryBranches(repository, {
          signal: abortController.signal,
        })
        if (!abortController.signal.aborted) {
          setBranchState({ status: "ready", value })
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          setBranchState({
            status: "error",
            message: getErrorMessage(
              error,
              "Repository branches could not be loaded.",
            ),
          })
        }
      }
    }

    void load()
    return () => abortController.abort()
  }, [
    branchRequestVersion,
    loadRepositoryBranches,
    repository.owner,
    repository.repo,
  ])

  useEffect(() => {
    const abortController = new AbortController()
    setAnalysisState((current) => ({
      status: "loading",
      previous: getPreservedAnalysis(current),
    }))

    const load = async () => {
      try {
        const value = await loadRepositoryAnalysis(
          { repository, ref: selectedRef },
          { signal: abortController.signal },
        )
        if (!abortController.signal.aborted) {
          setAnalysisState({ status: "ready", value })
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          setAnalysisState((current) => ({
            status: "error",
            message: getErrorMessage(
              error,
              "Repository analysis could not be completed.",
            ),
            previous: getPreservedAnalysis(current),
          }))
        }
      }
    }

    void load()
    return () => abortController.abort()
  }, [
    analysisRequestVersion,
    loadRepositoryAnalysis,
    repository.owner,
    repository.repo,
    selectedRef.kind,
    selectedRef.kind === "branch" ? selectedRef.name : "",
  ])

  const preservedAnalysis = getPreservedAnalysis(analysisState)
  const visibleAnalysis =
    analysisState.status === "ready" ? analysisState.value : null
  const selectedBranch = getSelectedBranchName(
    selectedRef,
    branchState,
    preservedAnalysis,
  )

  return (
    <>
      <RepositoryIdentityDetails
        analysis={visibleAnalysis}
        repository={repository}
      />
      <BranchSelector
        branchState={branchState}
        onRetry={() => setBranchRequestVersion((version) => version + 1)}
        onSelect={(branchName) => {
          const defaultBranch =
            branchState.status === "ready"
              ? branchState.value.defaultBranch
              : preservedAnalysis?.repository.defaultBranch
          setSelectedRef(
            branchName === defaultBranch
              ? DEFAULT_REPOSITORY_REF
              : { kind: "branch", name: branchName },
          )
        }}
        selectedBranch={selectedBranch}
      />
      <DeploymentSection
        homepage={preservedAnalysis?.repository.homepage ?? null}
        loadRepositoryLiveDeployment={loadRepositoryLiveDeployment}
        localEvidence={preservedAnalysis?.deployment ?? null}
        repository={repository}
        selectedCommitSha={preservedAnalysis?.repository.commitSha ?? null}
      />
      <AnalysisContent
        analysisState={analysisState}
        onRetry={() => setAnalysisRequestVersion((version) => version + 1)}
        renderPreviewControls={renderPreviewControls}
        renderBackendRuntimeControls={renderBackendRuntimeControls}
        loadBuildTargetAnalysis={loadBuildTargetAnalysis}
        selectedBranch={selectedBranch}
      />
    </>
  )
}

function BranchSelector({
  branchState,
  onRetry,
  onSelect,
  selectedBranch,
}: {
  branchState: BranchState
  onRetry: () => void
  onSelect: (branchName: string) => void
  selectedBranch: string
}) {
  const descriptionId = useId()
  const options =
    branchState.status === "ready"
      ? includeSelectedBranch(branchState.value.branches, selectedBranch)
      : selectedBranch
        ? [selectedBranch]
        : []
  const disabled = branchState.status !== "ready"

  return (
    <section className="peephole__branch">
      <label className="peephole__branch-label" htmlFor="peephole-branch">
        Preview branch
      </label>
      <select
        aria-describedby={descriptionId}
        className="peephole__branch-select"
        disabled={disabled}
        id="peephole-branch"
        name="branch"
        onChange={(event) => onSelect(event.currentTarget.value)}
        value={selectedBranch}
      >
        {options.length > 0 ? (
          options.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))
        ) : (
          <option value="">Loading branches...</option>
        )}
      </select>
      <div className="peephole__branch-help" id={descriptionId}>
        {branchState.status === "loading" &&
          "Loading the bounded GitHub branch list. Default-branch analysis continues independently."}
        {branchState.status === "ready" &&
          branchState.value.truncated &&
          "Showing up to 100 branches, including the default branch. More branches may exist."}
        {branchState.status === "ready" &&
          !branchState.value.truncated &&
          "Each selection is resolved to its current full commit SHA before analysis."}
        {branchState.status === "error" && (
          <>
            <span>{branchState.message}</span>{" "}
            <button
              className="peephole__inline-retry"
              onClick={onRetry}
              type="button"
            >
              Retry branch list
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function RepositoryIdentityDetails({
  repository,
  analysis,
}: {
  repository: RepositoryIdentity
  analysis: RepositoryAnalysis | null
}) {
  return (
    <dl className="peephole__details">
      <Detail label="Owner" value={repository.owner} />
      <Detail label="Repository" value={repository.repo} />
      {analysis && (
        <div className="peephole__detail">
          <dt>Commit</dt>
          <dd>
            <code title={analysis.repository.commitSha}>
              {analysis.repository.commitSha.slice(0, 7)}
            </code>
          </dd>
        </div>
      )}
    </dl>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="peephole__detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function AnalysisContent({
  analysisState,
  onRetry,
  renderPreviewControls,
  renderBackendRuntimeControls,
  loadBuildTargetAnalysis,
  selectedBranch,
}: {
  analysisState: AnalysisState
  onRetry: () => void
  renderPreviewControls?: (
    analysis: BuildTargetAnalysis & RepositoryAnalysis,
  ) => ReactNode
  renderBackendRuntimeControls?: (input: {
    candidate: BackendCandidate
    repository: RepositoryMetadata
  }) => ReactNode
  loadBuildTargetAnalysis: BuildTargetAnalysisLoader
  selectedBranch: string
}) {
  const preservedAnalysis = getPreservedAnalysis(analysisState)
  const ready = analysisState.status === "ready"

  return (
    <>
      {analysisState.status === "loading" && (
        <div aria-live="polite" className="peephole__status">
          <span aria-hidden="true" className="peephole__spinner" />
          Resolving and inspecting {selectedBranch || "the default branch"}...
        </div>
      )}

      {analysisState.status === "error" && (
        <div className="peephole__status peephole__status--error" role="alert">
          <p>{analysisState.message}</p>
          <button className="peephole__retry" onClick={onRetry} type="button">
            Retry analysis
          </button>
        </div>
      )}

      {preservedAnalysis && (
        <div hidden={!ready}>
          <AnalysisResults
            analysis={preservedAnalysis}
            key={`${preservedAnalysis.repository.repositoryId}:${preservedAnalysis.repository.commitSha}:${selectedBranch}`}
            loadBuildTargetAnalysis={loadBuildTargetAnalysis}
            renderPreviewControls={renderPreviewControls}
            renderBackendRuntimeControls={renderBackendRuntimeControls}
          />
        </div>
      )}
    </>
  )
}

function AnalysisResults({
  analysis,
  loadBuildTargetAnalysis,
  renderPreviewControls,
  renderBackendRuntimeControls,
}: {
  analysis: RepositoryAnalysis
  loadBuildTargetAnalysis: BuildTargetAnalysisLoader
  renderPreviewControls?: (
    analysis: BuildTargetAnalysis & RepositoryAnalysis,
  ) => ReactNode
  renderBackendRuntimeControls?: (input: {
    candidate: BackendCandidate
    repository: RepositoryMetadata
  }) => ReactNode
}) {
  const rootAnalysis = useMemo(
    () => toRootBuildTargetAnalysis(analysis),
    [analysis],
  )
  const targets = analysis.structure.projects.filter(
    (project) => !project.isRoot && project.role === "project-candidate",
  )
  const [selectedSourceRoot, setSelectedSourceRoot] = useState(".")
  const [targetState, setTargetState] = useState<
    | { status: "ready"; value: BuildTargetAnalysis }
    | { status: "loading" }
    | { status: "error"; message: string }
  >({ status: "ready", value: rootAnalysis })
  const [targetRequestVersion, setTargetRequestVersion] = useState(0)

  useEffect(() => {
    if (selectedSourceRoot === ".") {
      setTargetState({ status: "ready", value: rootAnalysis })
      return
    }

    const abortController = new AbortController()
    setTargetState({ status: "loading" })
    void loadBuildTargetAnalysis(
      analysis.repository,
      { sourceRoot: selectedSourceRoot },
      { signal: abortController.signal },
    ).then(
      (value) => {
        if (!abortController.signal.aborted) {
          setTargetState({ status: "ready", value })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setTargetState({
            status: "error",
            message: getErrorMessage(
              error,
              "The selected preview target could not be analyzed.",
            ),
          })
        }
      },
    )
    return () => abortController.abort()
  }, [
    analysis.repository,
    loadBuildTargetAnalysis,
    rootAnalysis,
    selectedSourceRoot,
    targetRequestVersion,
  ])

  const targetAnalysis =
    targetState.status === "ready" ? targetState.value : null

  return (
    <div className="peephole__analysis">
      {targets.length > 0 && (
        <TargetSelector
          onSelect={setSelectedSourceRoot}
          selectedSourceRoot={selectedSourceRoot}
          targets={targets}
        />
      )}
      {targetState.status === "loading" && (
        <div className="peephole__status" role="status">
          <span aria-hidden="true" className="peephole__spinner" />
          Inspecting selected preview target...
        </div>
      )}
      {targetState.status === "error" && (
        <div className="peephole__status peephole__status--error" role="alert">
          <p>{targetState.message}</p>
          <button
            className="peephole__retry"
            onClick={() => setTargetRequestVersion((version) => version + 1)}
            type="button"
          >
            Retry target analysis
          </button>
        </div>
      )}
      {targetAnalysis && (
        <>
          <PreviewStatus mode={targetAnalysis.preview.mode} />
          {renderPreviewControls?.({ ...analysis, ...targetAnalysis })}

          <section className="peephole__section">
            <h3>Stack</h3>
            <dl className="peephole__facts">
              <Detail
                label="Framework"
                value={formatFramework(targetAnalysis.technologies.framework)}
              />
              <Detail
                label="TypeScript"
                value={
                  targetAnalysis.technologies.typescript
                    ? "Detected"
                    : "Not detected"
                }
              />
              <Detail label="Package" value={targetAnalysis.packageManager} />
            </dl>
          </section>

          <section className="peephole__section">
            <h3>Build plan</h3>
            <dl className="peephole__facts">
              <Detail
                label="Native build"
                value={
                  targetAnalysis.preview.blockers.length === 0
                    ? "Compatible"
                    : "Blocked"
                }
              />
              <Detail
                label="Install"
                value={targetAnalysis.runtime.installCommand ?? "Not required"}
              />
              <Detail
                label="Build"
                value={targetAnalysis.runtime.buildCommand ?? "Not required"}
              />
              <Detail
                label="Output"
                value={targetAnalysis.runtime.outputDirectory ?? "Unknown"}
              />
            </dl>
          </section>

          <section className="peephole__section">
            <h3>Structure</h3>
            <dl className="peephole__facts">
              <Detail
                label="Layout"
                value={formatStructureLayout(analysis.structure.layout)}
              />
            </dl>
            {analysis.structure.projects.length > 0 && (
              <ul aria-label="Detected projects" className="peephole__list">
                {analysis.structure.projects.map((project) => (
                  <li key={project.path}>
                    <code>{project.path}</code>
                    {project.packageName ? ` — ${project.packageName}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {(analysis.structure.truncated || !analysis.structure.complete) && (
              <p className="peephole__muted">
                {!analysis.structure.complete &&
                  "Structure analysis is incomplete. "}
                {analysis.structure.truncated &&
                  "Additional projects may exist beyond Peephole's bounded scan."}
              </p>
            )}
          </section>

          <BackendSection
            backend={analysis.backend}
            renderBackendRuntimeControls={renderBackendRuntimeControls}
            repository={analysis.repository}
          />

          <section className="peephole__section">
            <h3>Environment</h3>
            <EnvironmentRequirementGroup
              requirements={targetAnalysis.environmentRequirements}
              sourceRoot={targetAnalysis.target.sourceRoot}
            />
            {analysis.backend.candidates.map((candidate) => (
              <EnvironmentRequirementGroup
                key={candidate.sourceRoot}
                requirements={candidate.environmentRequirements}
                sourceRoot={candidate.sourceRoot}
              />
            ))}
            {targetAnalysis.environmentRequirements.length === 0 &&
              analysis.backend.candidates.every(
                (candidate) => candidate.environmentRequirements.length === 0,
              ) && (
                <p className="peephole__muted">
                  No template variables detected.
                </p>
              )}
          </section>

          {targetAnalysis.preview.blockers.length > 0 && (
            <section className="peephole__section peephole__section--blocked">
              <h3>Blockers</h3>
              <ul className="peephole__list">
                {targetAnalysis.preview.blockers.map((blocker) => (
                  <li key={`${blocker.code}:${blocker.message}`}>
                    {blocker.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {targetAnalysis.warnings.length > 0 && (
            <section className="peephole__section">
              <h3>Warnings</h3>
              <ul className="peephole__list">
                {targetAnalysis.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <details className="peephole__evidence">
            <summary>
              Evidence ({targetAnalysis.preview.evidence.length})
            </summary>
            <ul className="peephole__list">
              {targetAnalysis.preview.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>{targetAnalysis.inspectedFiles.length} known files detected</p>
          </details>
        </>
      )}
    </div>
  )
}

function TargetSelector({
  onSelect,
  selectedSourceRoot,
  targets,
}: {
  onSelect: (sourceRoot: string) => void
  selectedSourceRoot: string
  targets: RepositoryAnalysis["structure"]["projects"]
}) {
  const selectId = useId()
  const descriptionId = useId()
  return (
    <section className="peephole__branch">
      <label className="peephole__branch-label" htmlFor={selectId}>
        Preview target
      </label>
      <select
        aria-describedby={descriptionId}
        className="peephole__branch-select"
        id={selectId}
        name="preview-target"
        onChange={(event) => onSelect(event.currentTarget.value)}
        value={selectedSourceRoot}
      >
        <option value=".">Repository root</option>
        {targets.map((target) => (
          <option key={target.path} value={target.path}>
            {target.path}
          </option>
        ))}
      </select>
      <p className="peephole__branch-help" id={descriptionId}>
        Detected application candidates are re-analyzed before a build is
        offered.
      </p>
    </section>
  )
}

/**
 * Detection only for an unsupported candidate: no build/run/start control is
 * ever offered for it, and a backend candidate is never selectable as a
 * preview target (see `TargetSelector`, which only lists structure
 * `project-candidate` entries). A candidate `resolveBackendExecutionSupport`
 * reports as supported may show Start/Stop controls via
 * `renderBackendRuntimeControls` -- still never a URL, never a preview-target
 * option, and never a frontend/backend connection. See
 * docs/PREVIEW_RUNTIME.md's "Backend Runtime (backend-v1)".
 */
function BackendSection({
  backend,
  renderBackendRuntimeControls,
  repository,
}: {
  backend: BackendDetection
  renderBackendRuntimeControls?: (input: {
    candidate: BackendCandidate
    repository: RepositoryMetadata
  }) => ReactNode
  repository: RepositoryMetadata
}) {
  return (
    <section className="peephole__section">
      <h3>Backend</h3>
      {backend.candidates.length === 0 ? (
        <p className="peephole__muted">No backend detected.</p>
      ) : (
        <ul aria-label="Detected backend candidates" className="peephole__list">
          {backend.candidates.map((candidate) => {
            const support = resolveBackendExecutionSupport(candidate)
            return (
              <li key={candidate.sourceRoot}>
                <dl className="peephole__facts">
                  <Detail
                    label="Source"
                    value={
                      candidate.sourceRoot === "."
                        ? "Repository root"
                        : candidate.sourceRoot
                    }
                  />
                  <Detail
                    label="Framework"
                    value={formatBackendFramework(candidate.framework)}
                  />
                  <Detail label="Runtime" value="Node.js" />
                  <Detail
                    label="Execution"
                    value={
                      support.supported
                        ? `Supported (${support.adapterId})`
                        : "Not supported yet"
                    }
                  />
                </dl>
                {support.supported &&
                  renderBackendRuntimeControls?.({ candidate, repository })}
                {candidate.evidence.length > 0 && (
                  <ul className="peephole__list">
                    {candidate.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {candidate.warnings.length > 0 && (
                  <ul className="peephole__list">
                    {candidate.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {backend.warnings.length > 0 && (
        <p className="peephole__muted">{backend.warnings.join(" ")}</p>
      )}
      {(backend.truncated || !backend.complete) && (
        <p className="peephole__muted">
          {!backend.complete && "Backend discovery is incomplete. "}
          {backend.truncated &&
            "Additional backend candidates may exist beyond Peephole's bounded scan."}
        </p>
      )}
    </section>
  )
}

function formatBackendFramework(
  framework: BackendDetection["candidates"][number]["framework"],
): string {
  return (
    {
      express: "Express",
      nestjs: "NestJS",
      fastify: "Fastify",
      koa: "Koa",
      hapi: "Hapi",
      unknown: "Unrecognized framework",
    } satisfies Record<
      BackendDetection["candidates"][number]["framework"],
      string
    >
  )[framework]
}

/**
 * Renders one source root's environment requirement classifications.
 * Detection only: only variable *names* and their classification are ever
 * shown, never a value from the underlying template file.
 */
function EnvironmentRequirementGroup({
  requirements,
  sourceRoot,
}: {
  requirements: EnvironmentRequirement[]
  sourceRoot: string
}) {
  if (requirements.length === 0) return null

  return (
    <div>
      <p className="peephole__branch-label">
        {sourceRoot === "." ? "Repository root" : sourceRoot}
      </p>
      <dl className="peephole__facts">
        {requirements.map((requirement) => (
          <Detail
            key={requirement.name}
            label={requirement.name}
            value={formatEnvironmentRequirement(requirement)}
          />
        ))}
      </dl>
      {requirements.some((requirement) => requirement.warnings.length > 0) && (
        <ul className="peephole__list">
          {requirements.flatMap((requirement) =>
            requirement.warnings.map((warning) => (
              <li key={`${requirement.name}:${warning}`}>{warning}</li>
            )),
          )}
        </ul>
      )}
    </div>
  )
}

function formatEnvironmentRequirement(
  requirement: EnvironmentRequirement,
): string {
  const label = {
    "auto-configurable": "Auto-configurable candidate",
    "preview-generated-candidate": "Preview-generated secret candidate",
    "external-routing-candidate": "External/routing requirement",
    "database-requirement": "User/database requirement",
    "user-required": "User-required",
    unknown: "Unknown",
  }[requirement.requirementKind]
  // Only add the sensitivity suffix when the label itself does not already
  // say so (preview-generated/database requirements are secret-like by
  // definition).
  const showsSensitivitySeparately =
    requirement.requirementKind === "user-required" ||
    requirement.requirementKind === "unknown"
  const sensitivitySuffix =
    showsSensitivitySeparately && requirement.sensitivity === "secret-like"
      ? " (secret-like)"
      : ""
  const exposurePrefix =
    requirement.exposure === "client-public" ? "Client-public " : ""

  return `${exposurePrefix}${label}${sensitivitySuffix}`
}

function PreviewStatus({ mode }: { mode: PreviewMode }) {
  const content = {
    "native-static-build": {
      title: "Native preview compatible",
      description: "The selected target matches Peephole's static-v2 contract.",
      modifier: "ready",
    },
    "existing-deployment": {
      title: "Native preview not available",
      description:
        "This target cannot be natively built, but declared deployment evidence exists below.",
      modifier: "info",
    },
    unsupported: {
      title: "Native preview blocked",
      description: "Review the blockers before creating a preview job.",
      modifier: "blocked",
    },
  }[mode]

  return (
    <div
      className={`peephole__status peephole__status--${content.modifier}`}
      role="status"
    >
      <strong>{content.title}</strong>
      <span>{content.description}</span>
    </div>
  )
}

type LiveDeploymentState =
  | { status: "loading" }
  | { status: "ready"; value: RepositoryLiveDeployment }
  | { status: "error"; message: string }

/**
 * Shows the repository's Live Deployment (from the separate, mutable
 * GitHub Deployments API lookup), local deployment configuration evidence,
 * and the repository homepage -- kept entirely separate from Build Preview.
 * A lookup failure here never affects the rest of the panel: it renders its
 * own local error message instead of throwing.
 */
function DeploymentSection({
  repository,
  loadRepositoryLiveDeployment,
  homepage,
  selectedCommitSha,
  localEvidence,
}: {
  repository: RepositoryIdentity
  loadRepositoryLiveDeployment: RepositoryLiveDeploymentLoader
  homepage: string | null
  selectedCommitSha: string | null
  localEvidence: RepositoryAnalysis["deployment"] | null
}) {
  const [state, setState] = useState<LiveDeploymentState>({ status: "loading" })

  useEffect(() => {
    const abortController = new AbortController()
    setState({ status: "loading" })

    void loadRepositoryLiveDeployment(repository, {
      signal: abortController.signal,
    }).then(
      (value) => {
        if (!abortController.signal.aborted)
          setState({ status: "ready", value })
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setState({
            status: "error",
            message: getErrorMessage(
              error,
              "Deployment information is currently unavailable.",
            ),
          })
        }
      },
    )

    return () => abortController.abort()
    // Repository identity is fixed for this component's lifetime: the parent
    // `RepositoryAnalysisView` remounts this whole subtree on repository
    // change, so branch/commit selection must not re-trigger this lookup.
  }, [loadRepositoryLiveDeployment, repository.owner, repository.repo])

  const homepageHref = isSafeExternalUrl(homepage, { allowHttp: true })
    ? homepage
    : null

  return (
    <section className="peephole__section">
      <h3>Deployment</h3>

      <div className="peephole__detail">
        <dt>Live deployment</dt>
        <dd>
          {state.status === "loading" &&
            "Checking recent GitHub deployments..."}
          {state.status === "error" && state.message}
          {state.status === "ready" &&
            (state.value.status === "confirmed" ? "Confirmed" : "Not detected")}
        </dd>
      </div>

      {state.status === "ready" &&
        state.value.status === "confirmed" &&
        state.value.candidate && (
          <LiveDeploymentDetails
            candidate={state.value.candidate}
            selectedCommitSha={selectedCommitSha}
            truncated={state.value.truncated}
          />
        )}

      {localEvidence && localEvidence.status === "configured" && (
        <div className="peephole__detail">
          <dt>Deployment configuration</dt>
          <dd>{formatConfiguredProvider(localEvidence.provider)}</dd>
        </div>
      )}

      <div className="peephole__detail">
        <dt>Repository homepage</dt>
        <dd>
          {homepage ? (
            homepageHref ? (
              <a
                className="peephole__link"
                href={homepageHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open homepage
              </a>
            ) : (
              <span>{homepage}</span>
            )
          ) : (
            "Not declared"
          )}
        </dd>
      </div>
    </section>
  )
}

function LiveDeploymentDetails({
  candidate,
  selectedCommitSha,
  truncated,
}: {
  candidate: LiveDeploymentCandidate
  selectedCommitSha: string | null
  truncated: boolean
}) {
  return (
    <>
      <dl className="peephole__facts">
        <Detail
          label="Environment"
          value={
            candidate.productionEnvironment
              ? `${candidate.environment} (production)`
              : candidate.environment
          }
        />
        <Detail label="Live URL" value={candidate.url} />
        {candidate.ref && (
          <Detail label="Deployment ref" value={candidate.ref} />
        )}
        {candidate.sha && (
          <Detail label="Deployment commit" value={candidate.sha.slice(0, 7)} />
        )}
        <Detail
          label="Comparison"
          value={formatShaComparison(candidate.sha, selectedCommitSha)}
        />
      </dl>
      <a
        className="peephole__link"
        href={candidate.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        Open live site
      </a>
      {truncated && (
        <p className="peephole__muted">
          Peephole checked a bounded set of recent deployments; more may exist.
        </p>
      )}
    </>
  )
}

function formatShaComparison(
  deploymentSha: string | null,
  selectedSha: string | null,
): string {
  if (!deploymentSha) return "Deployment commit unknown"
  if (!selectedSha) return "Selected commit unknown"
  return deploymentSha.toLowerCase() === selectedSha.toLowerCase()
    ? "Matches selected commit"
    : "Deployment commit differs from selected preview commit"
}

function formatConfiguredProvider(
  provider: RepositoryAnalysis["deployment"]["provider"],
): string {
  if (provider === "vercel") return "Vercel configuration detected"
  if (provider === "netlify") return "Netlify configuration detected"
  return "Deployment configuration detected"
}

const unavailableLiveDeploymentLoader: RepositoryLiveDeploymentLoader =
  async () => {
    throw new Error("Live deployment discovery is unavailable.")
  }

function getSelectedBranchName(
  selectedRef: RepositoryRefSelection,
  branchState: BranchState,
  analysis: RepositoryAnalysis | null,
): string {
  if (selectedRef.kind === "branch") return selectedRef.name
  if (branchState.status === "ready") return branchState.value.defaultBranch
  return analysis?.repository.defaultBranch ?? ""
}

function includeSelectedBranch(
  branches: string[],
  selectedBranch: string,
): string[] {
  return selectedBranch && !branches.includes(selectedBranch)
    ? [selectedBranch, ...branches]
    : branches
}

function getPreservedAnalysis(state: AnalysisState): RepositoryAnalysis | null {
  return state.status === "ready" ? state.value : state.previous
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

const unavailableTargetLoader: BuildTargetAnalysisLoader = async () => {
  throw new Error("Preview target analysis is unavailable.")
}

function formatStructureLayout(layout: RepositoryStructureLayout): string {
  return (
    {
      "single-project": "Single project",
      workspace: "Workspace",
      "multi-project": "Multiple projects",
      unknown: "Unknown",
    } satisfies Record<RepositoryStructureLayout, string>
  )[layout]
}

function formatFramework(framework: Framework): string {
  return (
    {
      static: "Static HTML",
      "react-vite": "React + Vite",
      "vue-vite": "Vue + Vite",
      "svelte-vite": "Svelte + Vite",
      wxt: "WXT",
      next: "Next.js",
      react: "React",
      unknown: "Unknown",
    } satisfies Record<Framework, string>
  )[framework]
}
