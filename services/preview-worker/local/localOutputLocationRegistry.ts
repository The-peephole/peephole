export class LocalOutputLocationRegistry {
  private readonly dirsByJobId = new Map<string, string>()

  set(jobId: string, absoluteDir: string): void {
    this.dirsByJobId.set(jobId, absoluteDir)
  }

  take(jobId: string): string {
    const dir = this.dirsByJobId.get(jobId)

    if (!dir) {
      throw new Error(`No resolved output directory registered for job ${jobId}.`)
    }

    this.dirsByJobId.delete(jobId)
    return dir
  }
}
