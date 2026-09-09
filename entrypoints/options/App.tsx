import { useEffect, useState } from "react"

import {
  connectGitHub,
  disconnectGitHub,
} from "../../core/preview/githubConnection"
import { getStoredPreviewSession } from "../../core/preview/sessionStorage"

type ConnectionStatus = "loading" | "connected" | "disconnected" | "connecting"

interface OptionsAppProps {
  previewApiBaseUrl: string | null
  configurationError?: string | null
  connect?: typeof connectGitHub
  disconnect?: typeof disconnectGitHub
  getSession?: typeof getStoredPreviewSession
}

export function OptionsApp({
  previewApiBaseUrl,
  configurationError = null,
  connect = connectGitHub,
  disconnect = disconnectGitHub,
  getSession = getStoredPreviewSession,
}: OptionsAppProps) {
  const [status, setStatus] = useState<ConnectionStatus>("loading")
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void getSession().then((session) => {
      setStatus(
        session && Date.parse(session.expiresAt) > Date.now()
          ? "connected"
          : "disconnected",
      )
    })
  }, [getSession])

  const beginConnection = async (): Promise<void> => {
    if (!previewApiBaseUrl) return
    setStatus("connecting")
    setMessage(null)
    try {
      const session = await connect(previewApiBaseUrl)
      setStatus("connected")
      setMessage(
        `Connected. This browser-session credential expires at ${new Date(session.expiresAt).toLocaleTimeString()}.`,
      )
    } catch (error) {
      setStatus("disconnected")
      setMessage(
        error instanceof Error ? error.message : "Could not connect GitHub.",
      )
    }
  }

  const endConnection = async (): Promise<void> => {
    await disconnect()
    setStatus("disconnected")
    setMessage("Disconnected from GitHub.")
  }

  const unavailable = !previewApiBaseUrl || Boolean(configurationError)

  return (
    <main className="peephole-options">
      <h1>Peephole settings</h1>

      <section>
        <h2>GitHub connection</h2>
        <p>
          Connect through the Peephole GitHub App to verify your GitHub
          identity. You do not need to create or paste a personal access token.
        </p>
        <p>
          GitHub credentials are exchanged and verified only by the Preview API.
          The Extension stores only a short-lived Peephole access session in{" "}
          <code>browser.storage.session</code>, so it is removed when the
          browser session ends.
        </p>
        <p>
          Repository analysis remains limited to public GitHub data. Private
          repository access and Installation Access Tokens are not part of this
          authentication step.
        </p>

        <p className="peephole-options__status">
          Status: <strong>{formatStatus(status)}</strong>
        </p>

        <div className="peephole-options__actions">
          <button
            className="peephole-options__primary"
            disabled={unavailable || status === "connecting"}
            onClick={() => void beginConnection()}
            type="button"
          >
            {status === "connecting"
              ? "Connecting..."
              : status === "connected"
                ? "Reconnect GitHub"
                : "Connect GitHub"}
          </button>
          <button
            className="peephole-options__secondary"
            disabled={status !== "connected"}
            onClick={() => void endConnection()}
            type="button"
          >
            Disconnect
          </button>
        </div>

        {configurationError && (
          <p className="peephole-options__message peephole-options__message--error">
            {configurationError}
          </p>
        )}
        {message && (
          <p className="peephole-options__message" role="status">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}

function formatStatus(status: ConnectionStatus): string {
  if (status === "loading") return "checking..."
  if (status === "connecting") return "connecting..."
  return status
}
