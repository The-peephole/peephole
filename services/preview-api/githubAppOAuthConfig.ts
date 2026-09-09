export interface GitHubAppOAuthConfig {
  clientId: string
  clientSecret: string
  callbackUrl: string
  allowedExtensionIds: readonly string[]
  stateSigningSecret: string
}

export function readGitHubAppOAuthConfig(
  environment: NodeJS.ProcessEnv,
): GitHubAppOAuthConfig {
  return {
    clientId: readClientId(environment.PEEPHOLE_GITHUB_APP_CLIENT_ID),
    clientSecret: readSecret(
      "PEEPHOLE_GITHUB_APP_CLIENT_SECRET",
      environment.PEEPHOLE_GITHUB_APP_CLIENT_SECRET,
      20,
    ),
    callbackUrl: readCallbackUrl(environment.PEEPHOLE_GITHUB_APP_CALLBACK_URL),
    allowedExtensionIds: readAllowedExtensionIds(
      environment.PEEPHOLE_ALLOWED_EXTENSION_IDS,
    ),
    stateSigningSecret: readSecret(
      "PEEPHOLE_GITHUB_OAUTH_STATE_SECRET",
      environment.PEEPHOLE_GITHUB_OAUTH_STATE_SECRET,
      32,
    ),
  }
}

function readClientId(value: string | undefined): string {
  const clientId = value?.trim() ?? ""

  if (!/^[A-Za-z\d._-]{3,256}$/.test(clientId)) {
    throw new Error(
      "PEEPHOLE_GITHUB_APP_CLIENT_ID must be a valid GitHub App client ID.",
    )
  }

  return clientId
}

function readSecret(
  name: string,
  value: string | undefined,
  minimumBytes: number,
): string {
  const secret = value?.trim() ?? ""

  if (new TextEncoder().encode(secret).byteLength < minimumBytes) {
    throw new Error(`${name} must be at least ${String(minimumBytes)} bytes.`)
  }

  return secret
}

function readCallbackUrl(value: string | undefined): string {
  const url = readUrl("PEEPHOLE_GITHUB_APP_CALLBACK_URL", value)

  if (url.pathname !== "/v1/auth/github/callback") {
    throw new Error(
      "PEEPHOLE_GITHUB_APP_CALLBACK_URL must end at /v1/auth/github/callback.",
    )
  }

  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error(
      "PEEPHOLE_GITHUB_APP_CALLBACK_URL must use HTTPS outside loopback development.",
    )
  }

  return url.href
}

function readAllowedExtensionIds(value: string | undefined): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (
    ids.length === 0 ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-p]{32}$/.test(id))
  ) {
    throw new Error(
      "PEEPHOLE_ALLOWED_EXTENSION_IDS must be a comma-separated allowlist of Chrome Extension IDs.",
    )
  }
  return ids
}

function readUrl(name: string, value: string | undefined): URL {
  let url: URL

  try {
    url = new URL(value?.trim() ?? "")
  } catch {
    throw new Error(`${name} must be an absolute URL.`)
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.includes("..")
  ) {
    throw new Error(`${name} must not include credentials, query, or fragment.`)
  }

  return url
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  )
}
