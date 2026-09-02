export interface ArchiveEntry {
  path: string
  bytes: number
  isSymlink: boolean
}

export interface FetchedArchive {
  compressedBytes: number
  entries: ArchiveEntry[]
}

export interface ResolvedOutput {
  entries: ArchiveEntry[]
}
