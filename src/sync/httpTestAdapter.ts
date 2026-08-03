import { RemoteAdapter, RemoteTransientError, RevisionConflictError } from './adapter'

/**
 * Dev/test-only adapter speaking to the Vite `devRemote` middleware
 * (GET/HEAD/PUT /__remote/:name with ETag / If-Match). Shape-identical to a
 * future WebDAV adapter. Excluded from production by the DEV guard at connect.
 */
export class HttpTestAdapter implements RemoteAdapter {
  constructor(readonly name: string) {}

  private url(): string {
    return `/__remote/${encodeURIComponent(this.name)}`
  }

  async getMetadata() {
    const res = await fetch(this.url(), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) throw new RemoteTransientError(`HEAD ${res.status}`)
    return { revision: res.headers.get('ETag') ?? '' }
  }

  async read() {
    const res = await fetch(this.url())
    if (!res.ok) throw new RemoteTransientError(`GET ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), revision: res.headers.get('ETag') ?? '' }
  }

  async write(bytes: Uint8Array, opts: { ifRevision?: string }) {
    const headers: Record<string, string> =
      opts.ifRevision === undefined ? { 'If-None-Match': '*' } : { 'If-Match': opts.ifRevision }
    const res = await fetch(this.url(), { method: 'PUT', headers, body: bytes as unknown as BodyInit })
    if (res.status === 412) throw new RevisionConflictError()
    if (!res.ok) throw new RemoteTransientError(`PUT ${res.status}`)
    return { revision: res.headers.get('ETag') ?? '' }
  }

  async writeAux(name: string, bytes: Uint8Array) {
    await fetch(`/__remote/${encodeURIComponent(`${this.name}.${name}`)}`, { method: 'PUT', body: bytes as unknown as BodyInit })
  }
}
