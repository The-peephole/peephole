import type { PreviewApiErrorCode } from "../../types/preview"
import type {
  IssuedPreviewSession,
  PreviewSessionIssuer,
} from "./previewSession"
import type { GitHubAppOAuthConfig } from "./githubAppOAuthConfig"

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
const TOKEN_URL = "https://github.com/login/oauth/access_token"
const USER_URL = "https://api.github.com/user"
const GITHUB_API_VERSION = "2026-03-10"
const DEFAULT_STATE_TTL_MS = 10 * 60_000
const MAX_UPSTREAM_RESPONSE_BYTES = 32 * 1024
const CLIENT_STATE_PATTERN = /^[A-Za-z\d_-]{32,128}$/
const CODE_CHALLENGE_PATTERN = /^[A-Za-z\d_-]{43}$/
const CODE_VERIFIER_PATTERN = /^[A-Za-z\d._~-]{43,128}$/

interface OAuthStatePayload {
  version: 1
  redirectUri: string
  clientState: string
  codeChallenge: string
  expiresAtSeconds: number
}

interface GitHubAppOAuthOptions extends GitHubAppOAuthConfig {
  fetcher?: typeof globalThis.fetch
  now?: () => Date
  stateTtlMs?: number
}

interface SessionRequestBody {
  code: string
  state: string
  codeVerifier: string
}

export class GitHubAppOAuth {
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly stateTtlMs: number
  private readonly stateKey: Promise<CryptoKey>

  constructor(private readonly options: GitHubAppOAuthOptions) {
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis)
    this.now = options.now ?? (() => new Date())
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS
    this.stateKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(options.stateSigningSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
  }

  async createAuthorizationUrl(requestUrl: string): Promise<string> {
    const request = parseRequestUrl(requestUrl)
    const redirectUri = request.searchParams.get("redirect_uri")
    const clientState = request.searchParams.get("client_state") ?? ""
    const codeChallenge = request.searchParams.get("code_challenge") ?? ""

    const approvedRedirectUri = redirectUri
      ? validateExtensionRedirectUri(
          redirectUri,
          this.options.allowedExtensionIds,
        )
      : null
    if (!approvedRedirectUri) {
      throw invalidRequest("The extension redirect URL is not approved.")
    }
    if (!CLIENT_STATE_PATTERN.test(clientState)) {
      throw invalidRequest("OAuth client state is invalid.")
    }
    if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
      throw invalidRequest("OAuth PKCE challenge is invalid.")
    }

    const state = await this.signState({
      version: 1,
      redirectUri: approvedRedirectUri,
      clientState,
      codeChallenge,
      expiresAtSeconds: Math.floor(
        (this.now().getTime() + this.stateTtlMs) / 1_000,
      ),
    })
    const authorizationUrl = new URL(AUTHORIZE_URL)
    authorizationUrl.searchParams.set("client_id", this.options.clientId)
    authorizationUrl.searchParams.set("redirect_uri", this.options.callbackUrl)
    authorizationUrl.searchParams.set("state", state)
    authorizationUrl.searchParams.set("code_challenge", codeChallenge)
    authorizationUrl.searchParams.set("code_challenge_method", "S256")
    authorizationUrl.searchParams.set("allow_signup", "false")
    return authorizationUrl.href
  }

  async completeCallback(requestUrl: string): Promise<string> {
    const request = parseRequestUrl(requestUrl)
    const state = request.searchParams.get("state") ?? ""
    const payload = await this.verifyState(state)
    const redirect = new URL(payload.redirectUri)
    const fragment = new URLSearchParams({ client_state: payload.clientState })
    const oauthError = request.searchParams.get("error")

    if (oauthError) {
      fragment.set("error", normalizeOAuthError(oauthError))
    } else {
      const code = request.searchParams.get("code")
      if (!code || code.length > 1_024 || hasControlCharacters(code)) {
        throw invalidRequest("GitHub authorization code is missing or invalid.")
      }
      fragment.set("code", code)
      fragment.set("state", state)
    }

    redirect.hash = fragment.toString()
    return redirect.href
  }

  async issueSession(
    body: unknown,
    issuer: PreviewSessionIssuer,
  ): Promise<IssuedPreviewSession> {
    const request = parseSessionRequest(body)
    const payload = await this.verifyState(request.state)
    const challenge = await createCodeChallenge(request.codeVerifier)

    if (challenge !== payload.codeChallenge) {
      throw unauthorized(
        "GitHub sign-in could not be verified. Please try again.",
      )
    }

    const accessToken = await this.exchangeCode(request)
    const githubUserId = await this.resolveGitHubUserId(accessToken)
    return issuer.issue(`github:${String(githubUserId)}`)
  }

  private async exchangeCode(request: SessionRequestBody): Promise<string> {
    let response: Response

    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Peephole",
        },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code: request.code,
          redirect_uri: this.options.callbackUrl,
          code_verifier: request.codeVerifier,
        }),
        cache: "no-store",
      })
    } catch {
      throw upstreamError("GitHub sign-in is temporarily unavailable.")
    }

    const body = await readUpstreamJson(response)
    if (
      !response.ok ||
      !isObject(body) ||
      typeof body.access_token !== "string" ||
      !body.access_token
    ) {
      throw unauthorized("GitHub authorization expired or was already used.")
    }
    return body.access_token
  }

  private async resolveGitHubUserId(accessToken: string): Promise<number> {
    let response: Response

    try {
      response = await this.fetcher(USER_URL, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "Peephole",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        cache: "no-store",
      })
    } catch {
      throw upstreamError(
        "GitHub identity verification is temporarily unavailable.",
      )
    }

    const body = await readUpstreamJson(response)
    if (
      !response.ok ||
      !isObject(body) ||
      !Number.isSafeInteger(body.id) ||
      Number(body.id) <= 0
    ) {
      throw unauthorized("GitHub did not return a valid user identity.")
    }
    return Number(body.id)
  }

  private async signState(payload: OAuthStatePayload): Promise<string> {
    const encodedPayload = toBase64Url(
      new TextEncoder().encode(JSON.stringify(payload)),
    )
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.stateKey,
      new TextEncoder().encode(encodedPayload),
    )
    return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`
  }

  private async verifyState(state: string): Promise<OAuthStatePayload> {
    const [encodedPayload, encodedSignature, extra] = state.split(".")
    const signature = encodedSignature ? fromBase64Url(encodedSignature) : null

    if (!encodedPayload || !signature || extra !== undefined) {
      throw invalidRequest("OAuth state is invalid.")
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.stateKey,
      signature as BufferSource,
      new TextEncoder().encode(encodedPayload),
    )
    if (!valid) {
      throw invalidRequest("OAuth state is invalid.")
    }

    const decoded = fromBase64Url(encodedPayload)
    let payload: unknown
    try {
      payload = decoded
        ? (JSON.parse(new TextDecoder().decode(decoded)) as unknown)
        : null
    } catch {
      payload = null
    }

    if (
      !isObject(payload) ||
      payload.version !== 1 ||
      typeof payload.redirectUri !== "string" ||
      !validateExtensionRedirectUri(
        payload.redirectUri,
        this.options.allowedExtensionIds,
      ) ||
      typeof payload.clientState !== "string" ||
      !CLIENT_STATE_PATTERN.test(payload.clientState) ||
      typeof payload.codeChallenge !== "string" ||
      !CODE_CHALLENGE_PATTERN.test(payload.codeChallenge) ||
      !Number.isSafeInteger(payload.expiresAtSeconds) ||
      Number(payload.expiresAtSeconds) * 1_000 <= this.now().getTime()
    ) {
      throw invalidRequest("OAuth state is invalid or expired.")
    }

    return payload as unknown as OAuthStatePayload
  }
}

export class GitHubAppOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: PreviewApiErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "GitHubAppOAuthError"
  }
}

function parseSessionRequest(body: unknown): SessionRequestBody {
  if (
    !isObject(body) ||
    typeof body.code !== "string" ||
    !body.code ||
    body.code.length > 1_024 ||
    typeof body.state !== "string" ||
    !body.state ||
    body.state.length > 2_048 ||
    typeof body.codeVerifier !== "string" ||
    !CODE_VERIFIER_PATTERN.test(body.codeVerifier)
  ) {
    throw invalidRequest("GitHub session request is invalid.")
  }
  return body as unknown as SessionRequestBody
}

async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  return toBase64Url(new Uint8Array(digest))
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw upstreamError("GitHub returned an invalid response.")
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw upstreamError("GitHub returned an invalid response.")
  }
}

function parseRequestUrl(value: string): URL {
  try {
    return new URL(value, "http://localhost")
  } catch {
    throw invalidRequest("OAuth request URL is invalid.")
  }
}

function normalizeOAuthError(value: string): string {
  return value === "access_denied" ? value : "authorization_failed"
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true
  }
  return false
}

function validateExtensionRedirectUri(
  value: string,
  allowedExtensionIds: readonly string[],
): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  const suffix = ".chromiumapp.org"
  const extensionId = url.hostname.endsWith(suffix)
    ? url.hostname.slice(0, -suffix.length)
    : ""
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/github" ||
    url.search ||
    url.hash ||
    !allowedExtensionIds.includes(extensionId)
  ) {
    return null
  }
  return url.href
}

function invalidRequest(message: string): GitHubAppOAuthError {
  return new GitHubAppOAuthError(400, "INVALID_REQUEST", message)
}

function unauthorized(message: string): GitHubAppOAuthError {
  return new GitHubAppOAuthError(401, "UNAUTHORIZED", message)
}

function upstreamError(message: string): GitHubAppOAuthError {
  return new GitHubAppOAuthError(502, "INTERNAL_ERROR", message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z\d_-]+$/.test(value)) return null
  try {
    return new Uint8Array(Buffer.from(value, "base64url"))
  } catch {
    return null
  }
}
