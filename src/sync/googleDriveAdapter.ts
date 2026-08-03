import { RemoteAdapter, RemoteAuthError, RemoteTransientError, RevisionConflictError } from './adapter'
import type { GoogleAuth } from './googleAuth'

/**
 * L2 = a vault file in the user's Google Drive, reached with the `drive.file`
 * scope (per-file: we only ever see what this app created).
 *
 * Revision = `headRevisionId`. Drive v3 has no write precondition, so write()
 * emulates compare-and-swap the same way LocalFileAdapter does — stat, compare,
 * upload — and then verifies afterwards that the revision we landed on follows
 * the one we based it on (SYNC §3.4). A lost race throws RevisionConflictError
 * and the engine's retry re-pulls and merges.
 */

export const VAULT_FILE_NAME = 'ledger.vault'
export const VAULT_FOLDER_NAME = 'Ledger'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface DriveDeps {
  fetch?: typeof fetch
  apiBase?: string
  uploadBase?: string
}

/** All the adapter needs of GoogleAuth — so tests can hand it a canned token. */
export type DriveAuth = Pick<GoogleAuth, 'getAccessToken'>

interface FileMeta {
  headRevisionId?: string
  size?: string
  trashed?: boolean
}

export class GoogleDriveAdapter implements RemoteAdapter {
  private readonly fetch: typeof fetch
  private readonly apiBase: string
  private readonly uploadBase: string

  constructor(
    private auth: DriveAuth,
    readonly fileId: string,
    readonly name: string = VAULT_FILE_NAME,
    deps: DriveDeps = {},
  ) {
    this.fetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
    this.apiBase = deps.apiBase ?? 'https://www.googleapis.com/drive/v3'
    this.uploadBase = deps.uploadBase ?? 'https://www.googleapis.com/upload/drive/v3'
  }

  /**
   * Look for the vault, creating nothing. This is what the "open from Drive"
   * boot path needs: it is asking whether a vault is there, and answering by
   * leaving an empty file behind would both litter the user's Drive and make
   * the next question ("is a vault there?") answer itself wrongly.
   */
  static async find(auth: DriveAuth, deps: DriveDeps = {}): Promise<{ fileId: string; fileName: string } | null> {
    const probe = new GoogleDriveAdapter(auth, '', VAULT_FILE_NAME, deps)
    // drive.file only ever lists our own files, so a name match is unambiguous —
    // and it still finds the vault if the user moved it out of the folder.
    const found = (await probe.listFiles(`name = '${VAULT_FILE_NAME}' and trashed = false`))[0]
    return found ? { fileId: found.id, fileName: found.name } : null
  }

  /**
   * Find or create the vault file, so the caller can persist its id. Creating it
   * empty is what lets getMetadata() report "nothing stored yet" and the engine
   * take its ordinary create path — the same dance LocalFileAdapter does with a
   * freshly picked zero-byte file.
   */
  static async connect(auth: DriveAuth, deps: DriveDeps = {}): Promise<{ fileId: string; fileName: string }> {
    const found = await GoogleDriveAdapter.find(auth, deps)
    if (found) return found

    const probe = new GoogleDriveAdapter(auth, '', VAULT_FILE_NAME, deps)
    const folders = await probe.listFiles(`name = '${VAULT_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`)
    const folderId =
      folders[0]?.id ?? (await probe.createFile({ name: VAULT_FOLDER_NAME, mimeType: FOLDER_MIME })).id
    const created = await probe.createFile({ name: VAULT_FILE_NAME, parents: [folderId] })
    return { fileId: created.id, fileName: created.name }
  }

  async getMetadata() {
    const meta = await this.stat()
    if (!meta || meta.trashed) return null
    // A freshly created file is a placeholder, not a vault (cf. LocalFileAdapter's
    // size-0 check). Only an explicit '0' counts — treating an absent size as
    // empty would let a create-path write clobber a real vault.
    if (meta.size === '0' || !meta.headRevisionId) return null
    return { revision: meta.headRevisionId }
  }

  async read() {
    const meta = await this.getMetadata()
    if (!meta) throw new RemoteTransientError('vault file is empty')
    // Read the exact revision we just stat'd, so bytes and revision cannot
    // disagree even if someone writes between the two calls.
    const res = await this.request(`${this.apiBase}/files/${this.fileId}/revisions/${meta.revision}?alt=media`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { bytes, revision: meta.revision }
  }

  async write(bytes: Uint8Array, opts: { ifRevision?: string }) {
    const before = await this.getMetadata()
    if (opts.ifRevision === undefined) {
      if (before !== null) throw new RevisionConflictError()
    } else if (before === null || before.revision !== opts.ifRevision) {
      throw new RevisionConflictError()
    }

    const res = await this.request(
      `${this.uploadBase}/files/${this.fileId}?uploadType=media&fields=headRevisionId`,
      { method: 'PATCH', body: bytes as unknown as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } },
    )
    const { headRevisionId } = (await res.json()) as FileMeta
    if (!headRevisionId) throw new RemoteTransientError('upload returned no revision')

    if (opts.ifRevision !== undefined) await this.verifyParent(headRevisionId, opts.ifRevision)
    return { revision: headRevisionId }
  }

  /** vault.corrupt.bak alongside the vault — the §6.2 forensics a file handle can't do. */
  async writeAux(name: string, bytes: Uint8Array): Promise<void> {
    const res = await this.request(`${this.apiBase}/files/${this.fileId}?fields=parents`)
    const { parents } = (await res.json()) as { parents?: string[] }
    await this.createFile({ name, ...(parents?.[0] ? { parents: [parents[0]] } : {}) }, bytes)
  }

  /**
   * SYNC §3.4's third step. Drive can't reject our upload, so we check
   * afterwards that nobody slipped a revision in between the one we based on
   * and the one we produced. If they did, we treat ourselves as the loser: the
   * engine re-pulls and merges, and their bytes survive both in Drive's revision
   * history and on the device that wrote them, which re-pushes on its next cycle.
   */
  private async verifyParent(newRevision: string, ifRevision: string): Promise<void> {
    let ids: string[]
    try {
      const res = await this.request(`${this.apiBase}/files/${this.fileId}/revisions?fields=revisions(id)`)
      const { revisions } = (await res.json()) as { revisions?: { id: string }[] }
      ids = revisions?.map((r) => r.id) ?? []
    } catch {
      // Revision history can be pruned or unavailable; the pre-write check still
      // stood, and a missed race costs a merge, not data. Don't fail the write.
      return
    }
    const i = ids.indexOf(newRevision)
    if (i < 1) return // can't tell — see above
    if (ids[i - 1] !== ifRevision) throw new RevisionConflictError()
  }

  private async stat(): Promise<FileMeta | null> {
    const res = await this.request(`${this.apiBase}/files/${this.fileId}?fields=headRevisionId,size,trashed`, {}, [404])
    if (res.status === 404) return null // deleted in Drive; the next push recreates
    return (await res.json()) as FileMeta
  }

  private async listFiles(q: string): Promise<{ id: string; name: string }[]> {
    // Oldest first, so that if two devices ever raced and each created a vault,
    // every device afterwards picks the same one instead of syncing to different
    // files forever. The loser's own copy is still intact locally and merges in.
    const url =
      `${this.apiBase}/files?q=${encodeURIComponent(q)}` +
      `&orderBy=createdTime&fields=${encodeURIComponent('files(id,name)')}`
    const res = await this.request(url)
    const { files } = (await res.json()) as { files?: { id: string; name: string }[] }
    return files ?? []
  }

  private async createFile(meta: Record<string, unknown>, bytes?: Uint8Array): Promise<{ id: string; name: string }> {
    if (!bytes) {
      const res = await this.request(`${this.apiBase}/files?fields=id,name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
      return (await res.json()) as { id: string; name: string }
    }
    const boundary = `ledger${base16(crypto.getRandomValues(new Uint8Array(8)))}`
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    const body = new Blob([head, bytes as unknown as BlobPart, `\r\n--${boundary}--\r\n`])
    const res = await this.request(`${this.uploadBase}/files?uploadType=multipart&fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    return (await res.json()) as { id: string; name: string }
  }

  /** Authorized fetch with the error vocabulary the engine understands. */
  private async request(url: string, init: RequestInit = {}, passStatuses: number[] = []): Promise<Response> {
    const token = await this.auth.getAccessToken()
    let res: Response
    try {
      res = await this.fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
      })
    } catch (e) {
      throw new RemoteTransientError(String(e))
    }
    if (res.ok || passStatuses.includes(res.status)) return res

    const body = await res.text().catch(() => '')
    if (res.status === 401) throw new RemoteAuthError()
    if (res.status === 403) {
      // Quota pushback recovers on its own; a permission problem needs the user.
      if (/rateLimitExceeded|userRateLimitExceeded|backendError/.test(body)) throw new RemoteTransientError(body)
      throw new RemoteAuthError()
    }
    if (res.status === 429 || res.status >= 500) throw new RemoteTransientError(`drive ${res.status}`)
    throw new Error(`drive ${res.status}: ${body}`)
  }
}

function base16(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
