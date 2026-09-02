const ENV_TEMPLATE_PATHS = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.local.example",
])

const SECRET_NAME_PATTERN =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PAT|PASSWORD|PASSWD|PRIVATE_KEY|DATABASE_URL)(?:_|$)/i
const PUBLIC_CLIENT_NAME_PATTERN = /^(?:VITE_|NEXT_PUBLIC_)/

export interface EnvironmentDetection {
  templateFound: boolean
  variables: string[]
  publicClientVariables: string[]
  secretLikeVariables: string[]
}

export function detectEnvironment(
  presentPaths: readonly string[],
  textFiles: Readonly<Record<string, string>>,
): EnvironmentDetection {
  const variables = new Set<string>()

  for (const path of presentPaths) {
    if (!ENV_TEMPLATE_PATHS.has(path)) {
      continue
    }

    const content = textFiles[path]

    if (!content) {
      continue
    }

    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z\d_]*)\s*=/)

      if (match?.[1]) {
        variables.add(match[1])
      }
    }
  }

  const sortedVariables = Array.from(variables).sort()

  return {
    templateFound: presentPaths.some((path) => ENV_TEMPLATE_PATHS.has(path)),
    variables: sortedVariables,
    publicClientVariables: sortedVariables.filter((name) =>
      PUBLIC_CLIENT_NAME_PATTERN.test(name),
    ),
    secretLikeVariables: sortedVariables.filter((name) =>
      SECRET_NAME_PATTERN.test(name),
    ),
  }
}
