import type { Plugin } from 'vite'

interface Slot {
  bytes: Buffer | null
  rev: number
  failCount: number
}

/**
 * Dev/test-only in-memory mini-WebDAV: GET/HEAD/PUT /__remote/:name with
 * ETag / If-Match conditional-write semantics, so cross-device sync is
 * E2E-testable across isolated browser contexts. Test hooks:
 *   POST /__remote/:name/corrupt   — flip bytes in the stored blob
 *   POST /__remote/:name/fail?n=2  — next n requests answer 503
 *   POST /__remote/:name/reset     — clear the slot
 */
export function devRemote(): Plugin {
  const slots = new Map<string, Slot>()
  const slot = (name: string): Slot => {
    let s = slots.get(name)
    if (!s) {
      s = { bytes: null, rev: 0, failCount: 0 }
      slots.set(name, s)
    }
    return s
  }

  return {
    name: 'ledger-dev-remote',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__remote', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parts = url.pathname.split('/').filter(Boolean)
        const name = parts[0]
        const hook = parts[1]
        if (!name) {
          res.statusCode = 400
          res.end('missing name')
          return
        }
        const s = slot(name)

        if (req.method === 'POST' && hook) {
          if (hook === 'corrupt' && s.bytes) {
            // flip a byte well inside the ciphertext, keep header intact
            const i = Math.min(s.bytes.length - 1, 200)
            const flipped = Buffer.from(s.bytes)
            flipped[i] = flipped[i]! ^ 0xff
            s.bytes = flipped
            s.rev += 1
          } else if (hook === 'fail') {
            s.failCount = Number(url.searchParams.get('n') ?? '1')
          } else if (hook === 'reset') {
            slots.delete(name)
          }
          res.statusCode = 204
          res.end()
          return
        }

        if (s.failCount > 0) {
          s.failCount -= 1
          res.statusCode = 503
          res.end('injected failure')
          return
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
          if (s.bytes === null) {
            res.statusCode = 404
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('ETag', `"r${s.rev}"`)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Length', String(s.bytes.length))
          res.end(req.method === 'HEAD' ? undefined : s.bytes)
          return
        }

        if (req.method === 'PUT') {
          const ifMatch = req.headers['if-match']
          const ifNoneMatch = req.headers['if-none-match']
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            if (ifNoneMatch === '*' && s.bytes !== null) {
              res.statusCode = 412
              res.end()
              return
            }
            if (ifMatch !== undefined && ifMatch !== `"r${s.rev}"`) {
              res.statusCode = 412
              res.end()
              return
            }
            s.bytes = Buffer.concat(chunks)
            s.rev += 1
            res.statusCode = 200
            res.setHeader('ETag', `"r${s.rev}"`)
            res.end()
          })
          return
        }

        res.statusCode = 405
        res.end()
      })

      server.middlewares.use('/__drive', driveDouble())
    },
  }
}

interface DriveFile {
  id: string
  name: string
  mimeType?: string
  parents: string[]
  revisions: { id: string; bytes: Buffer }[]
}

interface DriveSlot {
  files: Map<string, DriveFile>
  nextId: number
  nextRev: number
  fail: { status: number; n: number }
}

/**
 * Dev/test-only stand-in for the slice of Drive v3 that GoogleDriveAdapter uses,
 * plus a token endpoint so the real OAuth code path runs against something.
 * One slot per `?drive=test:<slot>` so parallel specs don't share a Drive.
 * Test hooks:
 *   POST /__drive/:slot/reset            — empty the slot
 *   POST /__drive/:slot/fail?n=2&status= — next n requests answer status (default 503)
 */
function driveDouble() {
  const slots = new Map<string, DriveSlot>()
  const slotOf = (name: string): DriveSlot => {
    let s = slots.get(name)
    if (!s) {
      s = { files: new Map(), nextId: 1, nextRev: 1, fail: { status: 0, n: 0 } }
      slots.set(name, s)
    }
    return s
  }

  return (req: { url?: string; method?: string; on: (e: string, cb: (c: Buffer) => void) => void }, res: import('http').ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const slotName = parts.shift()
    if (!slotName) return send(res, 400, { error: 'missing slot' })
    const slot = slotOf(slotName)
    const method = req.method ?? 'GET'
    const rest = '/' + parts.join('/')

    readAll(req, (body) => {
      if (method === 'POST' && rest === '/reset') {
        slots.delete(slotName)
        return send(res, 200, {})
      }
      if (method === 'POST' && rest === '/fail') {
        slot.fail = { status: Number(url.searchParams.get('status') ?? '503'), n: Number(url.searchParams.get('n') ?? '1') }
        return send(res, 200, {})
      }
      // The token endpoint: the adapter's auth is real, only Google is not.
      if (method === 'POST' && rest === '/token') {
        return send(res, 200, { access_token: 'test-at', refresh_token: 'test-rt', expires_in: 3600 })
      }

      if (slot.fail.n > 0) {
        slot.fail.n -= 1
        return send(res, slot.fail.status, { error: { message: 'injected' } })
      }

      const isUpload = rest.startsWith('/upload/')
      const path = rest.replace('/upload', '').replace('/drive/v3', '')
      const head = (f: DriveFile) => f.revisions[f.revisions.length - 1]!
      const commit = (f: DriveFile, bytes: Buffer) => {
        const id = `rev${slot.nextRev++}`
        f.revisions.push({ id, bytes })
        return id
      }

      if (path === '/files' && method === 'POST') {
        const meta = (isUpload ? parseMultipartMeta(body.toString('latin1')) : JSON.parse(body.toString() || '{}')) as {
          name?: string
          mimeType?: string
          parents?: string[]
        }
        const file: DriveFile = {
          id: `file${slot.nextId++}`,
          name: meta.name ?? '',
          ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
          parents: meta.parents ?? [],
          revisions: [],
        }
        commit(file, isUpload ? parseMultipartBytes(body) : Buffer.alloc(0))
        slot.files.set(file.id, file)
        return send(res, 200, { id: file.id, name: file.name })
      }

      if (path === '/files' && method === 'GET') {
        const q = url.searchParams.get('q') ?? ''
        const name = /name\s*=\s*'([^']*)'/.exec(q)?.[1]
        const mime = /mimeType\s*=\s*'([^']*)'/.exec(q)?.[1]
        const files = [...slot.files.values()]
          .filter((f) => (!name || f.name === name) && (mime ? f.mimeType === mime : !f.mimeType))
          .map((f) => ({ id: f.id, name: f.name }))
        return send(res, 200, { files })
      }

      const m = /^\/files\/([^/]+)(\/revisions(?:\/([^/]+))?)?$/.exec(path)
      if (!m) return send(res, 404, { error: { message: 'no route' } })
      const file = slot.files.get(m[1]!)
      if (!file) return send(res, 404, { error: { message: 'not found' } })

      if (m[3]) {
        const rev = file.revisions.find((r) => r.id === m[3])
        if (!rev) return send(res, 404, { error: { message: 'no revision' } })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(rev.bytes.length))
        return res.end(rev.bytes)
      }
      if (m[2]) return send(res, 200, { revisions: file.revisions.map((r) => ({ id: r.id })) })

      if (method === 'PATCH') return send(res, 200, { headRevisionId: commit(file, body) })

      if ((url.searchParams.get('fields') ?? '').includes('parents')) return send(res, 200, { parents: file.parents })
      return send(res, 200, { headRevisionId: head(file).id, size: String(head(file).bytes.length), trashed: false })
    })
  }
}

function send(res: import('http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readAll(req: { on: (e: string, cb: (c: Buffer) => void) => void }, cb: (body: Buffer) => void): void {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => cb(Buffer.concat(chunks)))
}

function parseMultipartMeta(text: string): Record<string, unknown> {
  const m = /\r\n\r\n(\{[\s\S]*?\})\r\n--/.exec(text)
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {}
}

function parseMultipartBytes(body: Buffer): Buffer {
  const text = body.toString('latin1')
  const start = text.indexOf('\r\n\r\n', text.indexOf('\r\n\r\n') + 4) + 4
  const end = text.lastIndexOf('\r\n--')
  return start < 4 || end < start ? Buffer.alloc(0) : body.subarray(start, end)
}
