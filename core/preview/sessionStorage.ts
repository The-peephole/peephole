export interface StoredPreviewSession {
  token: string
  expiresAt: string
}

const STORAGE_KEY = "peepholePreviewSession"

export async function getStoredPreviewSession(): Promise<StoredPreviewSession | null> {
  const stored = await browser.storage.session.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY]

  if (!isStoredPreviewSession(value)) return null
  return value
}

export async function setStoredPreviewSession(
  session: StoredPreviewSession,
): Promise<void> {
  if (!isStoredPreviewSession(session)) {
    throw new Error("Peephole returned an invalid session.")
  }
  await browser.storage.session.set({ [STORAGE_KEY]: session })
}

export async function clearStoredPreviewSession(): Promise<void> {
  await browser.storage.session.remove(STORAGE_KEY)
}

export function isStoredPreviewSession(
  value: unknown,
): value is StoredPreviewSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    candidate.token.length <= 4_096 &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt))
  )
}
