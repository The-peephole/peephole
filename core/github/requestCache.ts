const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

interface CacheEntry {
  value: unknown
  size: number
  expiresAt: number | null
}

interface PendingRequest {
  controller: AbortController
  promise: Promise<unknown>
  subscribers: number
}

export interface GitHubRequestCacheOptions {
  maxEntries?: number
  maxBytes?: number
  now?: () => number
}

export interface GitHubRequestLoadOptions {
  signal?: AbortSignal
  /** Zero deduplicates only concurrent calls and does not retain the result. */
  ttlMs: number | null | ((value: unknown) => number | null)
  sizeOf: (value: unknown) => number
}

/**
 * Process-local bounded LRU for GitHub responses. It is deliberately only an
 * optimization: an MV3 service-worker restart may discard every entry.
 *
 * Concurrent callers share the underlying fetch, but each caller owns its
 * cancellation. The shared fetch is aborted only after every subscriber has
 * cancelled, so one stale UI request cannot terminate another active one.
 */
export class GitHubRequestCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly now: () => number
  private totalBytes = 0

  constructor(options: GitHubRequestCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? Date.now
  }

  async load<T>(
    key: string,
    loader: (signal: AbortSignal) => Promise<T>,
    options: GitHubRequestLoadOptions,
  ): Promise<T> {
    const cached = this.get<T>(key)
    if (cached.found) return cached.value

    let pending = this.pending.get(key)
    if (!pending || pending.controller.signal.aborted) {
      pending = this.start(key, loader, options)
    }

    return this.subscribe<T>(pending, options.signal)
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  private get<T>(key: string): { found: true; value: T } | { found: false } {
    const entry = this.entries.get(key)
    if (!entry) return { found: false }

    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.deleteEntry(key, entry)
      return { found: false }
    }

    this.entries.delete(key)
    this.entries.set(key, entry)
    return { found: true, value: entry.value as T }
  }

  private start<T>(
    key: string,
    loader: (signal: AbortSignal) => Promise<T>,
    options: GitHubRequestLoadOptions,
  ): PendingRequest {
    const controller = new AbortController()
    const pending: PendingRequest = {
      controller,
      subscribers: 0,
      promise: Promise.resolve(),
    }
    pending.promise = loader(controller.signal)
      .then((value) => {
        const ttlMs =
          typeof options.ttlMs === "function"
            ? options.ttlMs(value)
            : options.ttlMs
        if (ttlMs !== 0) {
          this.set(key, value, options.sizeOf(value), ttlMs)
        }
        return value
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key)
      })
    this.pending.set(key, pending)
    return pending
  }

  private subscribe<T>(
    pending: PendingRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      this.abortIfUnused(pending)
      return Promise.reject(createAbortError())
    }

    pending.subscribers += 1

    return new Promise<T>((resolve, reject) => {
      let settled = false

      const finish = () => {
        if (settled) return false
        settled = true
        signal?.removeEventListener("abort", onAbort)
        pending.subscribers -= 1
        return true
      }
      const onAbort = () => {
        if (!finish()) return
        this.abortIfUnused(pending)
        reject(createAbortError())
      }

      signal?.addEventListener("abort", onAbort, { once: true })
      pending.promise.then(
        (value) => {
          if (finish()) resolve(value as T)
        },
        (error: unknown) => {
          if (finish()) reject(error)
        },
      )
    })
  }

  private abortIfUnused(pending: PendingRequest): void {
    if (pending.subscribers === 0 && !pending.controller.signal.aborted) {
      pending.controller.abort()
    }
  }

  private set(
    key: string,
    value: unknown,
    size: number,
    ttlMs: number | null,
  ): void {
    if (
      this.maxEntries <= 0 ||
      this.maxBytes <= 0 ||
      size < 0 ||
      size > this.maxBytes
    ) {
      return
    }

    const previous = this.entries.get(key)
    if (previous) this.deleteEntry(key, previous)

    const entry: CacheEntry = {
      value,
      size,
      expiresAt: ttlMs === null ? null : this.now() + ttlMs,
    }
    this.entries.set(key, entry)
    this.totalBytes += size

    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.entries().next().value as
        [string, CacheEntry] | undefined
      if (!oldest) break
      this.deleteEntry(oldest[0], oldest[1])
    }
  }

  private deleteEntry(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return
    this.totalBytes -= entry.size
  }
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError")
}
