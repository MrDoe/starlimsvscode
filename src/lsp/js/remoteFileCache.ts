export interface CachedRemoteFile {
  sourceText: string;
  version: number;
}

export class RemoteFileCache {
  private files = new Map<string, CachedRemoteFile>();

  get(uri: string): CachedRemoteFile | undefined {
    return this.files.get(uri);
  }

  set(uri: string, sourceText: string): void {
    const existing = this.files.get(uri);
    if (existing) {
      existing.sourceText = sourceText;
      existing.version++;
    } else {
      this.files.set(uri, { sourceText, version: 1 });
    }
  }

  delete(uri: string): void {
    this.files.delete(uri);
  }

  has(uri: string): boolean {
    return this.files.has(uri);
  }

  getVersion(uri: string): number {
    return this.files.get(uri)?.version ?? 0;
  }

  clear(): void {
    this.files.clear();
  }
}
