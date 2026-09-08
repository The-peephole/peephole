export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()

  return token ? token : null
}
