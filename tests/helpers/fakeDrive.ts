import type { DriveAuth, DriveDeps } from '../../src/sync/googleDriveAdapter'

/**
 * The slice of the Drive v3 API GoogleDriveAdapter actually calls, in memory,
 * behind a fetch-shaped function. Files keep a real revision chain, because
 * that chain is what the emulated CAS verifies against (SYNC §3.4).
 */

export const API = 'https://drive.test/drive/v3'
export const UPLOAD = 'https://drive.test/upload/drive/v3'

interface FakeFile {
  id: string
  name: string
  mimeType?: string
  parents: string[]
  trashed: boolean
  revisions: { id: string; bytes: Uint8Array }[]
}

export class FakeDrive {
  files = new Map<string, FakeFile>()
  requests: string[] = []

  private nextId = 1
  private nextRev = 1
  private failures: { status: number; n: number } = { status: 0, n: 0 }
  private thirdWriter: Uint8Array | null = null

  /** Deps to hand GoogleDriveAdapter, plus a stub auth. */
  deps(): DriveDeps {
    return { fetch: this.fetch, apiBase: API, uploadBase: UPLOAD }
  }

  auth(token = 'test-token'): DriveAuth {
    return { getAccessToken: async () => token }
  }

  // ---- hooks ----
  /** Next `n` requests answer with `status`. */
  failNext(status: number, n = 1): void {
    this.failures = { status, n }
  }

  /** Lands a competing revision just before the next media upload commits. */
  injectThirdWriter(bytes: Uint8Array): void {
    this.thirdWriter = bytes
  }

  bytesOf(fileId: string): Uint8Array | null {
    const revs = this.files.get(fileId)?.revisions
    return revs?.[revs.length - 1]?.bytes ?? null
  }

  revisionIds(fileId: string): string[] {
    return this.files.get(fileId)?.revisions.map((r) => r.id) ?? []
  }

  private commit(file: FakeFile, bytes: Uint8Array): string {
    const id = `rev${this.nextRev++}`
    file.revisions.push({ id, bytes })
    return id
  }

  private head(file: FakeFile) {
    return file.revisions[file.revisions.length - 1]!
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    this.requests.push(`${method} ${url.pathname}${url.search}`)

    if (this.failures.n > 0) {
      this.failures.n--
      return json({ error: { message: 'injected' } }, this.failures.status)
    }

    const path = url.pathname.replace('/drive/v3', '').replace('/upload', '')
    const isUpload = url.pathname.startsWith('/upload')

    // POST /files — metadata-only create, or multipart create with content
    if (path === '/files' && method === 'POST') {
      const body = await readBody(init?.body)
      const meta = isUpload ? parseMultipartMeta(body.text) : (JSON.parse(body.text) as Record<string, unknown>)
      const file: FakeFile = {
        id: `file${this.nextId++}`,
        name: String(meta.name ?? ''),
        ...(meta.mimeType ? { mimeType: String(meta.mimeType) } : {}),
        parents: (meta.parents as string[] | undefined) ?? [],
        trashed: false,
        revisions: [],
      }
      this.commit(file, isUpload ? parseMultipartBytes(body.bytes) : new Uint8Array(0))
      this.files.set(file.id, file)
      return json({ id: file.id, name: file.name })
    }

    // GET /files?q=... — drive.file only ever lists what the app made, so does this
    if (path === '/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const name = /name\s*=\s*'([^']*)'/.exec(q)?.[1]
      const mime = /mimeType\s*=\s*'([^']*)'/.exec(q)?.[1]
      const files = [...this.files.values()]
        .filter((f) => !f.trashed && (!name || f.name === name) && (mime ? f.mimeType === mime : !f.mimeType))
        .map((f) => ({ id: f.id, name: f.name }))
      return json({ files })
    }

    const fileMatch = /^\/files\/([^/]+)(\/revisions(?:\/([^/]+))?)?$/.exec(path)
    if (!fileMatch) return json({ error: { message: 'no route' } }, 404)
    const file = this.files.get(fileMatch[1]!)
    if (!file) return json({ error: { message: 'not found' } }, 404)

    // GET /files/{id}/revisions/{rev}?alt=media
    if (fileMatch[3]) {
      const rev = file.revisions.find((r) => r.id === fileMatch[3])
      if (!rev) return json({ error: { message: 'no revision' } }, 404)
      return new Response(rev.bytes as unknown as BodyInit, { status: 200 })
    }

    // GET /files/{id}/revisions
    if (fileMatch[2]) return json({ revisions: file.revisions.map((r) => ({ id: r.id })) })

    // PATCH /upload/files/{id}?uploadType=media
    if (method === 'PATCH') {
      if (this.thirdWriter) {
        this.commit(file, this.thirdWriter)
        this.thirdWriter = null
      }
      const body = await readBody(init?.body)
      return json({ headRevisionId: this.commit(file, body.bytes) })
    }

    // GET /files/{id}?fields=...
    const fields = url.searchParams.get('fields') ?? ''
    if (fields.includes('parents')) return json({ parents: file.parents })
    return json({
      headRevisionId: this.head(file).id,
      size: String(this.head(file).bytes.byteLength),
      trashed: file.trashed,
    })
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

async function readBody(body: BodyInit | null | undefined): Promise<{ bytes: Uint8Array; text: string }> {
  if (body == null) return { bytes: new Uint8Array(0), text: '' }
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), text: body }
  const bytes =
    body instanceof Uint8Array ? body : new Uint8Array(await new Response(body as BodyInit).arrayBuffer())
  return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
}

/** The JSON part of a multipart/related create. */
function parseMultipartMeta(text: string): Record<string, unknown> {
  const m = /\r\n\r\n(\{[\s\S]*?\})\r\n--/.exec(text)
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {}
}

/** The binary part — everything between the second header break and the closing boundary. */
function parseMultipartBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes)
  const start = text.indexOf('\r\n\r\n', text.indexOf('\r\n\r\n') + 4) + 4
  const end = text.lastIndexOf('\r\n--')
  if (start < 4 || end < start) return new Uint8Array(0)
  return bytes.slice(start, end)
}
