import { useEffect, useState } from "react"

import type { RepositoryIdentity } from "../types/repository"

interface PeepholeAppProps {
  repository: RepositoryIdentity
  openSidePanel: (repository: RepositoryIdentity) => Promise<void>
}

export function PeepholeApp({ repository, openSidePanel }: PeepholeAppProps) {
  const [isOpening, setIsOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setIsOpening(false)
    setError(null)
  }, [repository.owner, repository.repo])

  return (
    <div className="peephole" onClick={(event) => event.stopPropagation()}>
      <button
        aria-label={`Open Peephole for ${repository.owner}/${repository.repo}`}
        aria-haspopup="dialog"
        className="peephole__trigger"
        disabled={isOpening}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setError(null)
          setIsOpening(true)

          void openSidePanel(repository).then(
            () => setIsOpening(false),
            (reason: unknown) => {
              setIsOpening(false)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Peephole could not open the side panel.",
              )
            },
          )
        }}
        title={
          error ?? `Open Peephole for ${repository.owner}/${repository.repo}`
        }
        type="button"
      >
        <span aria-hidden="true" className="peephole__mark">
          P
        </span>
        {isOpening ? "Opening..." : "Peephole"}
      </button>
      {error && (
        <span className="peephole__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
