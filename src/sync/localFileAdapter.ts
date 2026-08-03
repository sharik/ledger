import { RemoteAdapter, RemoteTransientError, RevisionConflictError } from './adapter'

/**
 * L2 = a vault file on disk (File System Access API), e.g. inside a
 * Dropbox/Drive-synced folder. Revision = SHA-256 of the file bytes — mtime is
 * too coarse for CAS. write() is an emulated compare-and-swap (read, compare,
 * write), the same shape a Google Drive adapter needs (SYNC §3.4).
 */
export class LocalFileAdapter implements RemoteAdapter {
  private hashCache: { mtime: number; size: number; hash: string } | null = null

  constructor(private handle: FileSystemFileHandle) {}

  static supported(): boolean {
    return typeof window !== 'undefined' && 'showSaveFilePicker' in window
  }

  get name(): string {
    return this.handle.name
  }

  /** 'granted' | 'prompt' | 'denied' — 'prompt' needs a user-gesture requestPermission. */
  async permission(): Promise<PermissionState> {
    return this.handle.queryPermission({ mode: 'readwrite' })
  }

  async requestPermission(): Promise<PermissionState> {
    return this.handle.requestPermission({ mode: 'readwrite' })
  }

  private async currentFile(): Promise<{ file: File; hash: string } | null> {
    let file: File
    try {
      file = await this.handle.getFile()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') return null
      throw new RemoteTransientError(String(e))
    }
    if (file.size === 0) return null
    if (this.hashCache && this.hashCache.mtime === file.lastModified && this.hashCache.size === file.size) {
      return { file, hash: this.hashCache.hash }
    }
    const bytes = await file.arrayBuffer()
    const hash = await sha256(new Uint8Array(bytes))
    this.hashCache = { mtime: file.lastModified, size: file.size, hash }
    return { file, hash }
  }

  async getMetadata() {
    const cur = await this.currentFile()
    return cur === null ? null : { revision: cur.hash }
  }

  async read() {
    const cur = await this.currentFile()
    if (!cur) throw new RemoteTransientError('vault file is empty')
    const bytes = new Uint8Array(await cur.file.arrayBuffer())
    return { bytes, revision: cur.hash }
  }

  async write(bytes: Uint8Array, opts: { ifRevision?: string }) {
    const cur = await this.currentFile()
    if (opts.ifRevision === undefined) {
      if (cur !== null) throw new RevisionConflictError()
    } else if (cur === null || cur.hash !== opts.ifRevision) {
      throw new RevisionConflictError()
    }
    const writable = await this.handle.createWritable() // atomic: temp file + move on close
    await writable.write(bytes as unknown as ArrayBuffer)
    await writable.close()
    const hash = await sha256(bytes)
    const file = await this.handle.getFile()
    this.hashCache = { mtime: file.lastModified, size: file.size, hash }
    return { revision: hash }
  }

  // corrupt.bak lands next to nothing — FSA has no sibling-file access from a file
  // handle, so aux forensics are kept in IndexedDB instead (see engine wiring).
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
