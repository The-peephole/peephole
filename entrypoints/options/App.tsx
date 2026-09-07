import { useEffect, useState } from "react"

import {
  clearStoredGitHubToken,
  getStoredGitHubToken,
  setStoredGitHubToken,
} from "../../core/github/tokenStorage"

type TokenStatus = "loading" | "set" | "unset"

export function OptionsApp() {
  const [status, setStatus] = useState<TokenStatus>("loading")
  const [draft, setDraft] = useState("")
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void getStoredGitHubToken().then((token) =>
      setStatus(token ? "set" : "unset"),
    )
  }, [])

  const save = async (): Promise<void> => {
    try {
      await setStoredGitHubToken(draft)
      setDraft("")
      setStatus("set")
      setMessage("Token saved.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not save the token.",
      )
    }
  }

  const clear = async (): Promise<void> => {
    await clearStoredGitHubToken()
    setDraft("")
    setStatus("unset")
    setMessage("Token cleared.")
  }

  return (
    <main className="peephole-options">
      <h1>Peephole settings</h1>

      <section>
        <h2>GitHub personal access token</h2>
        <p>
          Optional. Peephole calls the public GitHub REST API to analyze
          repositories. Without a token, GitHub limits unauthenticated requests
          to 60 per hour per IP address -- easy to exhaust after a few
          repositories. A token with no scopes (or just <code>public_repo</code>
          ) raises that to 5,000 per hour.
        </p>
        <p>
          This token is stored only in this browser profile&apos;s local
          extension storage. It is never synced, never built into the extension
          package, and only ever sent to <code>https://api.github.com</code>.
        </p>

        <p className="peephole-options__status">
          Status:{" "}
          <strong>
            {status === "loading"
              ? "checking..."
              : status === "set"
                ? "token is set"
                : "no token set"}
          </strong>
        </p>

        <label className="peephole-options__field" htmlFor="github-token">
          New token
        </label>
        <input
          autoComplete="off"
          id="github-token"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="ghp_..."
          spellCheck={false}
          type="password"
          value={draft}
        />

        <div className="peephole-options__actions">
          <button
            className="peephole-options__primary"
            disabled={!draft.trim()}
            onClick={() => void save()}
            type="button"
          >
            Save
          </button>
          <button
            className="peephole-options__secondary"
            disabled={status !== "set"}
            onClick={() => void clear()}
            type="button"
          >
            Clear
          </button>
        </div>

        {message && (
          <p className="peephole-options__message" role="status">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}
