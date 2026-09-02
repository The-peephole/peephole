export class ArchiveByteStore {
  private readonly byCommit = new Map<string, Uint8Array>()

  put(commitSha: string, data: Uint8Array): void {
    this.byCommit.set(commitSha.toLowerCase(), data)
  }

  take(commitSha: string): Uint8Array {
    const data = this.byCommit.get(commitSha.toLowerCase())

    if (!data) {
      throw new Error(`No archive bytes stored for commit ${commitSha}.`)
    }

    return data
  }

  delete(commitSha: string): void {
    this.byCommit.delete(commitSha.toLowerCase())
  }
}
