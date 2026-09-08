const DEFAULT_TTL_MS = 30 * 60_000

export interface PreviewSessionIssuerOptions {
  ttlMs?: number
  now?: () => Date
}

export interface IssuedPreviewSession {
  token: string
  expiresAt: string
}

/**
 * Issues and verifies short-lived, stateless Peephole session tokens
 * (HMAC-SHA256 signed: `base64url(subject).expiresAtSeconds.base64url(sig)`,
 * no server-side session store to manage or leak). A caller authenticates
 * once with a real credential -- currently a GitHub personal access token,
 * verified by GitHubRequesterAuth -- and exchanges it for one of these;
 * every other preview API request then presents the session token
 * instead of the original credential. That is the entire point: a
 * compromised Preview API only ever sees Peephole-scoped tokens that
 * expire on their own and are useless anywhere else, never the caller's
 * actual GitHub credential repeated on every request.
 *
 * The signing secret must be at least 32 bytes, matching
 * HmacPreviewArtifactSigner's own requirement -- see that class for the
 * sibling pattern this one is modeled on (same HMAC-SHA256 + base64url
 * approach, applied to a session token instead of a signed artifact URL).
 */
export class PreviewSessionIssuer {
  private readonly key: Promise<CryptoKey>
  private readonly ttlMs: number
  private readonly now: () => Date

  constructor(
    signingSecret: string,
    options: PreviewSessionIssuerOptions = {},
  ) {
    if (new TextEncoder().encode(signingSecret).byteLength < 32) {
      throw new Error("Session signing secret must be at least 32 bytes.")
    }

    this.key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? (() => new Date())
  }

  async issue(subject: string): Promise<IssuedPreviewSession> {
    const expiresAtSeconds = Math.floor(
      (this.now().getTime() + this.ttlMs) / 1_000,
    )
    const payload = `${toBase64Url(new TextEncoder().encode(subject))}.${expiresAtSeconds}`
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.key,
      new TextEncoder().encode(payload),
    )

    return {
      token: `${payload}.${toBase64Url(new Uint8Array(signature))}`,
      expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    }
  }

  /** Returns the subject the token was issued for, or null if the token
   * is malformed, expired, or its signature does not verify. */
  async verify(token: string): Promise<string | null> {
    const parts = token.split(".")

    if (parts.length !== 3) {
      return null
    }

    const [encodedSubject, expiresRaw, encodedSignature] = parts as [
      string,
      string,
      string,
    ]
    const expiresAtSeconds = Number(expiresRaw)

    if (!Number.isInteger(expiresAtSeconds)) {
      return null
    }

    if (expiresAtSeconds * 1_000 <= this.now().getTime()) {
      return null
    }

    const signatureBytes = fromBase64Url(encodedSignature)

    if (!signatureBytes) {
      return null
    }

    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.key,
      signatureBytes as BufferSource,
      new TextEncoder().encode(`${encodedSubject}.${expiresRaw}`),
    )

    if (!valid) {
      return null
    }

    const subjectBytes = fromBase64Url(encodedSubject)
    return subjectBytes ? new TextDecoder().decode(subjectBytes) : null
  }
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }

  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=")
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}
