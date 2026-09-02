export interface ParsedPackageJson {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
  packageManager: string | null
  workspaces: unknown
}

export interface PackageJsonParseResult {
  value: ParsedPackageJson | null
  error: string | null
}

export function parsePackageJson(
  content: string | undefined,
): PackageJsonParseResult {
  if (content === undefined) {
    return { value: null, error: null }
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(content)
  } catch {
    return { value: null, error: "package.json contains invalid JSON." }
  }

  if (!isObject(parsed)) {
    return { value: null, error: "package.json must contain a JSON object." }
  }

  return {
    value: {
      dependencies: readStringRecord(parsed.dependencies),
      devDependencies: readStringRecord(parsed.devDependencies),
      scripts: readStringRecord(parsed.scripts),
      packageManager:
        typeof parsed.packageManager === "string"
          ? parsed.packageManager
          : null,
      workspaces: parsed.workspaces,
    },
    error: null,
  }
}

export function getAllDependencies(
  packageJson: ParsedPackageJson | null,
): Record<string, string> {
  if (!packageJson) {
    return {}
  }

  return {
    ...packageJson.devDependencies,
    ...packageJson.dependencies,
  }
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
