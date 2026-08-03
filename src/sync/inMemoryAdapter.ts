import { RemoteAdapter, RemoteTransientError, RevisionConflictError } from './adapter'

/**
 * In-memory remote: the integration-test backend (two fakeDevices share one
 * instance) and the "no remote configured" placeholder.
 */
export class InMemoryAdapter implements RemoteAdapter {
  bytes: Uint8Array | null = null
  rev = 0
  aux = new Map<string, Uint8Array>()

  // test hooks
  private failWrites = 0
  private failReads = 0
  private thirdWriter: Uint8Array | null = null
  writes = 0
  metadataCalls = 0

  private revStr(): string {
    return `r${this.rev}`
  }

  async getMetadata() {
    this.metadataCalls++
    if (this.failReads > 0) {
      this.failReads--
      throw new RemoteTransientError()
    }
    return this.bytes === null ? null : { revision: this.revStr() }
  }

  async read() {
    if (this.failReads > 0) {
      this.failReads--
      throw new RemoteTransientError()
    }
    if (this.bytes === null) throw new RemoteTransientError('nothing to read')
    return { bytes: this.bytes, revision: this.revStr() }
  }

  async write(bytes: Uint8Array, opts: { ifRevision?: string }) {
    if (this.failWrites > 0) {
      this.failWrites--
      throw new RemoteTransientError()
    }
    // a "third device" landing a write in the caller's read→write window
    if (this.thirdWriter) {
      const tw = this.thirdWriter
      this.thirdWriter = null
      this.bytes = tw
      this.rev++
    }
    if (opts.ifRevision === undefined) {
      if (this.bytes !== null) throw new RevisionConflictError()
    } else if (opts.ifRevision !== this.revStr()) {
      throw new RevisionConflictError()
    }
    this.bytes = bytes
    this.rev++
    this.writes++
    return { revision: this.revStr() }
  }

  async writeAux(name: string, bytes: Uint8Array) {
    this.aux.set(name, bytes)
  }

  // ---- hooks ----
  failNextWrites(n: number): void {
    this.failWrites = n
  }
  failNextReads(n: number): void {
    this.failReads = n
  }
  /** Injects `bytes` as a competing write just before the next write lands. */
  injectThirdWriter(bytes: Uint8Array): void {
    this.thirdWriter = bytes
  }
  corruptInPlace(): void {
    if (!this.bytes) return
    const b = new Uint8Array(this.bytes)
    b[b.length - 20]! ^= 0xff
    this.bytes = b
    this.rev++
  }
}
