import { useEffect, useId, useState } from "react"

import type {
  RepositoryIdentity,
  RepositoryMetadata,
  RepositoryMetadataLoader,
} from "../types/repository"

interface PeepholeAppProps {
  repository: RepositoryIdentity
  loadRepositoryMetadata: RepositoryMetadataLoader
}

type MetadataState =
  | { status: "idle" | "loading" }
  | { status: "ready"; value: RepositoryMetadata }
  | { status: "error"; message: string }

export function PeepholeApp({
  repository,
  loadRepositoryMetadata,
}: PeepholeAppProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [metadataState, setMetadataState] = useState<MetadataState>({
    status: "idle",
  })
  const [requestVersion, setRequestVersion] = useState(0)
  const panelId = useId()

  useEffect(() => {
    setIsOpen(false)
    setMetadataState({ status: "idle" })
    setRequestVersion(0)
  }, [repository.owner, repository.repo])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const abortController = new AbortController()
    setMetadataState({ status: "loading" })

    void loadRepositoryMetadata(repository, {
      signal: abortController.signal,
    }).then(
      (metadata) => {
        if (!abortController.signal.aborted) {
          setMetadataState({ status: "ready", value: metadata })
        }
      },
      (error: unknown) => {
        if (!abortController.signal.aborted) {
          setMetadataState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Repository metadata could not be loaded.",
          })
        }
      },
    )

    return () => abortController.abort()
  }, [
    isOpen,
    loadRepositoryMetadata,
    repository.owner,
    repository.repo,
    requestVersion,
  ])

  return (
    <div className="peephole" onClick={(event) => event.stopPropagation()}>
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        className="peephole__trigger"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen((open) => !open)
        }}
        type="button"
      >
        <span aria-hidden="true" className="peephole__mark">
          P
        </span>
        Peephole
      </button>

      {isOpen && (
        <section
          aria-label="Peephole repository preview"
          className="peephole__panel"
          id={panelId}
        >
          <header className="peephole__header">
            <div>
              <p className="peephole__eyebrow">Repository preview</p>
              <h2 className="peephole__title">Peephole</h2>
            </div>
            <button
              aria-label="Close Peephole panel"
              className="peephole__close"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setIsOpen(false)
              }}
              type="button"
            >
              &times;
            </button>
          </header>

          <dl className="peephole__details">
            <div className="peephole__detail">
              <dt>Owner</dt>
              <dd>{repository.owner}</dd>
            </div>
            <div className="peephole__detail">
              <dt>Repository</dt>
              <dd>{repository.repo}</dd>
            </div>
            {metadataState.status === "ready" && (
              <>
                <div className="peephole__detail">
                  <dt>Branch</dt>
                  <dd>{metadataState.value.defaultBranch}</dd>
                </div>
                <div className="peephole__detail">
                  <dt>Commit</dt>
                  <dd>
                    <code title={metadataState.value.commitSha}>
                      {metadataState.value.commitSha.slice(0, 7)}
                    </code>
                  </dd>
                </div>
                <div className="peephole__detail">
                  <dt>Homepage</dt>
                  <dd>
                    {metadataState.value.homepage ? (
                      <a
                        className="peephole__link"
                        href={metadataState.value.homepage}
                        onClick={(event) => event.stopPropagation()}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Open site
                      </a>
                    ) : (
                      "Not declared"
                    )}
                  </dd>
                </div>
              </>
            )}
          </dl>

          <MetadataStatus
            metadataState={metadataState}
            onRetry={() => setRequestVersion((version) => version + 1)}
          />
        </section>
      )}
    </div>
  )
}

interface MetadataStatusProps {
  metadataState: MetadataState
  onRetry: () => void
}

function MetadataStatus({ metadataState, onRetry }: MetadataStatusProps) {
  if (metadataState.status === "loading") {
    return (
      <div aria-live="polite" className="peephole__status">
        <span aria-hidden="true" className="peephole__spinner" />
        Loading repository metadata...
      </div>
    )
  }

  if (metadataState.status === "error") {
    return (
      <div className="peephole__status peephole__status--error" role="alert">
        <p>{metadataState.message}</p>
        <button
          className="peephole__retry"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRetry()
          }}
          type="button"
        >
          Retry
        </button>
      </div>
    )
  }

  if (metadataState.status === "ready") {
    return (
      <div className="peephole__status peephole__status--ready">
        <strong>Repository metadata ready</strong>
        <span>Native preview analysis is the next milestone.</span>
      </div>
    )
  }

  return null
}
