import {
  clearStoredPreviewSession,
  setStoredPreviewSession,
  type StoredPreviewSession,
} from "./sessionStorage"

const MAX_RESPONSE_BYTES = 32 * 1024

interface GitHubConnectionDependencies {
  fetcher?: typeof globalThis.fetch
  getRedirectUrl?: (path: string) => string
  launchWebAuthFlow?: (details: {
    url: string
    interactive: boolean
  }) => Promise<string | undefined>
  randomBytes?: (length: number) => Uint8Array
  saveSession?: (session: StoredPreviewSession) => Promise<void>
}

export class GitHubConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitHubConnectionError"
  }
}

export async function connectGitHub(
  previewApiBaseUrl: string,
  dependencies: GitHubConnectionDependencies = {},
): Promise<StoredPreviewSession> {
  const fetcher = (dependencies.fetcher ?? globalThis.fetch).bind(globalThis)
  const getRedirectUrl =
    dependencies.getRedirectUrl ??
    ((path) => browser.identity.getRedirectURL(path))
  const launchWebAuthFlow =
    dependencies.launchWebAuthFlow ??
    ((details) => browser.identity.launchWebAuthFlow(details))
  const randomBytes = dependencies.randomBytes ?? secureRandomBytes
  const saveSession = dependencies.saveSession ?? setStoredPreviewSession
  const redirectUrl = getRedirectUrl("github")
  const clientState = toBase64Url(randomBytes(32))
  const codeVerifier = toBase64Url(randomBytes(32))
  const codeChallenge = await createCodeChallenge(codeVerifier)
  const startUrl = new URL("v1/auth/github/start", previewApiBaseUrl)
  startUrl.searchParams.set("redirect_uri", redirectUrl)
  startUrl.searchParams.set("client_state", clientState)
  startUrl.searchParams.set("code_challenge", codeChallenge)

  let callbackUrl: string | undefined
  try {
    callbackUrl = await launchWebAuthFlow({
      url: startUrl.href,
      interactive: true,
    })
  } catch {
    throw new GitHubConnectionError("GitHub sign-in was cancelled or blocked.")
  }

  if (!callbackUrl) {
    throw new GitHubConnectionError("GitHub sign-in was not completed.")
  }

  const callback = validateCallbackUrl(callbackUrl, redirectUrl)
  const fragment = new URLSearchParams(callback.hash.slice(1))
  if (fragment.get("client_state") !== clientState) {
    throw new GitHubConnectionError("GitHub sign-in state did not match.")
  }
  if (fragment.has("error")) {
    throw new GitHubConnectionError(
      fragment.get("error") === "access_denied"
        ? "GitHub sign-in was cancelled."
        : "GitHub could not complete sign-in.",
    )
  }

  const code = fragment.get("code")
  const state = fragment.get("state")
  if (!code || !state) {
    throw new GitHubConnectionError("GitHub returned an invalid callback.")
  }

  let response: Response
  try {
    response = await fetcher(new URL("v1/auth/session", previewApiBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state, codeVerifier }),
      credentials: "omit",
      cache: "no-store",
    })
  } catch {
    throw new GitHubConnectionError(
      "The Peephole preview service could not be reached.",
    )
  }

  const body = await readJson(response)
  if (!response.ok) {
    throw new GitHubConnectionError(readErrorMessage(body))
  }
  if (!isSession(body) || Date.parse(body.expiresAt) <= Date.now()) {
    throw new GitHubConnectionError("Peephole returned an invalid session.")
  }

  await saveSession(body)
  return body
}

export async function disconnectGitHub(): Promise<void> {
  await clearStoredPreviewSession()
}

function validateCallbackUrl(callbackUrl: string, expectedUrl: string): URL {
  let callback: URL
  let expected: URL
  try {
    callback = new URL(callbackUrl)
    expected = new URL(expectedUrl)
  } catch {
    throw new GitHubConnectionError("GitHub returned an invalid callback URL.")
  }
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.search
  ) {
    throw new GitHubConnectionError("GitHub returned to an unexpected URL.")
  }
  return callback
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  return toBase64Url(new Uint8Array(digest))
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new GitHubConnectionError("Peephole returned an invalid response.")
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GitHubConnectionError("Peephole returned an invalid response.")
  }
}

function readErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message
  }
  return "GitHub sign-in could not be completed."
}

function isSession(value: unknown): value is StoredPreviewSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    typeof value.token === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  )
}
