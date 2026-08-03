import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import type { Vault } from '../src/model/types'
import { RemoteAuthError, RemoteTransientError, RevisionConflictError } from '../src/sync/adapter'
import { GoogleDriveAdapter, VAULT_FILE_NAME, VAULT_FOLDER_NAME } from '../src/sync/googleDriveAdapter'
import { FakeDrive } from './helpers/fakeDrive'
import { makePair, stripIds } from './helpers/fakeDevice'
import { acc, budget, buildVault, catId, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

function baseVault(): Vault {
  return buildVault((v) => {
    acc(v, { name: 'Checking', liquid: true })
    budget(v, 'Dining out', 300)
    txn(v, '2026-07-01', 'Rent', 'Housing', -1650)
  })
}

const addTxnOp = (v: Vault, merchant: string, amount = -10) =>
  ({
    kind: 'addTransaction' as const,
    txn: { date: '2026-07-08', merchant, categoryId: catId(v, 'Dining out'), amount },
  })

async function connected(drive: FakeDrive) {
  const { fileId } = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())
  return new GoogleDriveAdapter(drive.auth(), fileId, VAULT_FILE_NAME, drive.deps())
}

describe('find — the "is there a vault to open?" question', () => {
  it('answers no without leaving anything behind', async () => {
    const drive = new FakeDrive()

    expect(await GoogleDriveAdapter.find(drive.auth(), drive.deps())).toBeNull()
    // Creating a placeholder here would litter the user's Drive *and* make the
    // same question answer "yes" next time — which is exactly what shipped once.
    expect(drive.files.size).toBe(0)
  })

  it('answers yes only once a vault has actually been written', async () => {
    const drive = new FakeDrive()
    const { fileId } = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())

    // The placeholder connect() leaves is not a vault: it reads as "nothing stored yet".
    const found = await GoogleDriveAdapter.find(drive.auth(), drive.deps())
    expect(found?.fileId).toBe(fileId)
    const adapter = new GoogleDriveAdapter(drive.auth(), fileId, VAULT_FILE_NAME, drive.deps())
    expect(await adapter.getMetadata()).toBeNull()

    await adapter.write(new Uint8Array([1, 2, 3]), {})
    expect(await adapter.getMetadata()).not.toBeNull()
  })
})

describe('connect', () => {
  it('creates the folder and an empty vault file, which reads as "nothing stored yet"', async () => {
    const drive = new FakeDrive()
    const { fileId, fileName } = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())

    expect(fileName).toBe(VAULT_FILE_NAME)
    const names = [...drive.files.values()].map((f) => f.name).sort()
    expect(names).toEqual([VAULT_FOLDER_NAME, VAULT_FILE_NAME].sort())

    // The placeholder must not look like a vault, or the engine would skip its
    // create path and the first push would have nothing to compare against.
    const adapter = new GoogleDriveAdapter(drive.auth(), fileId, VAULT_FILE_NAME, drive.deps())
    expect(await adapter.getMetadata()).toBeNull()
  })

  it('reuses the existing vault on a second device rather than making another', async () => {
    const drive = new FakeDrive()
    const first = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())
    const second = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())

    expect(second.fileId).toBe(first.fileId)
    expect([...drive.files.values()].filter((f) => f.name === VAULT_FILE_NAME)).toHaveLength(1)
  })

  it('settles on the same vault from every device if two ever raced into existence', async () => {
    const drive = new FakeDrive()
    const { fileId: first } = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())
    // A second device that connected before the first one's create was visible.
    const dup = await GoogleDriveAdapter.connect(
      drive.auth(),
      { ...drive.deps(), fetch: async (i, init) => (/\/files\?/.test(String(i)) ? new Response('{"files":[]}') : drive.fetch(i, init)) },
    )
    expect(dup.fileId).not.toBe(first)

    // Every later connect picks the older one, so the devices reconverge.
    expect((await GoogleDriveAdapter.connect(drive.auth(), drive.deps())).fileId).toBe(first)
  })

  it('finds the vault even when the user moved it out of the Ledger folder', async () => {
    const drive = new FakeDrive()
    const { fileId } = await GoogleDriveAdapter.connect(drive.auth(), drive.deps())
    drive.files.get(fileId)!.parents = []

    expect((await GoogleDriveAdapter.connect(drive.auth(), drive.deps())).fileId).toBe(fileId)
  })
})

describe('emulated CAS (SYNC §3.4)', () => {
  it('create-only write lands, then refuses to create twice', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)

    const { revision } = await adapter.write(new Uint8Array([1, 2, 3]), {})
    expect(await adapter.getMetadata()).toEqual({ revision })
    expect(drive.bytesOf(adapter.fileId)).toEqual(new Uint8Array([1, 2, 3]))

    await expect(adapter.write(new Uint8Array([9]), {})).rejects.toBeInstanceOf(RevisionConflictError)
  })

  it('round-trips bytes through the exact revision it stat’d', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const written = await adapter.write(new Uint8Array([7, 7, 7]), {})

    const got = await adapter.read()
    expect(got.bytes).toEqual(new Uint8Array([7, 7, 7]))
    expect(got.revision).toBe(written.revision)
  })

  it('rejects a write based on a stale revision', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const first = await adapter.write(new Uint8Array([1]), {})
    await adapter.write(new Uint8Array([2]), { ifRevision: first.revision })

    await expect(adapter.write(new Uint8Array([3]), { ifRevision: first.revision })).rejects.toBeInstanceOf(
      RevisionConflictError,
    )
  })

  it('the lost race: a third writer inside the check-to-write window is caught after the fact', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const first = await adapter.write(new Uint8Array([1]), {})

    // Drive cannot reject our upload, so it succeeds and *then* the parent check
    // shows a revision we never saw sitting between ours and the one we based on.
    drive.injectThirdWriter(new Uint8Array([99]))
    await expect(adapter.write(new Uint8Array([2]), { ifRevision: first.revision })).rejects.toBeInstanceOf(
      RevisionConflictError,
    )

    // Nothing is lost: the interloper's bytes are still a revision in Drive.
    expect(drive.revisionIds(adapter.fileId)).toHaveLength(4) // placeholder, first, third-writer, ours
  })

  it('does not fail the write when revision history is unavailable to verify against', async () => {
    const drive = new FakeDrive()
    // Only the revisions listing is broken; the upload itself already committed,
    // so refusing here would report a failure for a write that actually landed.
    const deps = {
      ...drive.deps(),
      fetch: (async (input, init) =>
        /\/revisions\?/.test(String(input))
          ? new Response('{}', { status: 500 })
          : drive.fetch(input, init)) as typeof fetch,
    }
    const { fileId } = await GoogleDriveAdapter.connect(drive.auth(), deps)
    const adapter = new GoogleDriveAdapter(drive.auth(), fileId, VAULT_FILE_NAME, deps)
    const first = await adapter.write(new Uint8Array([1]), {})

    const second = await adapter.write(new Uint8Array([2]), { ifRevision: first.revision })
    expect(second.revision).toBeTruthy()
    expect(drive.bytesOf(adapter.fileId)).toEqual(new Uint8Array([2]))
  })
})

describe('error vocabulary the engine reads', () => {
  it('401 → RemoteAuthError (REAUTH_NEEDED)', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    drive.failNext(401)
    await expect(adapter.getMetadata()).rejects.toBeInstanceOf(RemoteAuthError)
  })

  it('403 for a permission problem → RemoteAuthError, but a rate limit → RemoteTransientError', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)

    drive.failNext(403)
    await expect(adapter.getMetadata()).rejects.toBeInstanceOf(RemoteAuthError)

    const rateLimited = new GoogleDriveAdapter(drive.auth(), adapter.fileId, VAULT_FILE_NAME, {
      ...drive.deps(),
      fetch: async () => new Response(JSON.stringify({ error: { reason: 'rateLimitExceeded' } }), { status: 403 }),
    })
    await expect(rateLimited.getMetadata()).rejects.toBeInstanceOf(RemoteTransientError)
  })

  it('429 and 5xx → RemoteTransientError (ERROR_BACKOFF, not data loss)', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)

    drive.failNext(429)
    await expect(adapter.getMetadata()).rejects.toBeInstanceOf(RemoteTransientError)
    drive.failNext(503)
    await expect(adapter.getMetadata()).rejects.toBeInstanceOf(RemoteTransientError)
  })

  it('a network throw → RemoteTransientError', async () => {
    const drive = new FakeDrive()
    const adapter = new GoogleDriveAdapter(drive.auth(), 'x', VAULT_FILE_NAME, {
      ...drive.deps(),
      fetch: async () => {
        throw new TypeError('failed to fetch')
      },
    })
    await expect(adapter.getMetadata()).rejects.toBeInstanceOf(RemoteTransientError)
  })

  it('a vault deleted in Drive reads as "nothing stored yet", not an error', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    await adapter.write(new Uint8Array([1]), {})

    drive.files.delete(adapter.fileId)
    expect(await adapter.getMetadata()).toBeNull()
  })

  it('a trashed vault reads as "nothing stored yet"', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    await adapter.write(new Uint8Array([1]), {})

    drive.files.get(adapter.fileId)!.trashed = true
    expect(await adapter.getMetadata()).toBeNull()
  })
})

describe('writeAux', () => {
  it('drops vault.corrupt.bak beside the vault — the §6.2 forensics a file handle cannot do', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const folderId = drive.files.get(adapter.fileId)!.parents[0]

    await adapter.writeAux('vault.corrupt.bak', new Uint8Array([4, 5, 6]))

    const bak = [...drive.files.values()].find((f) => f.name === 'vault.corrupt.bak')
    expect(bak).toBeDefined()
    expect(bak!.parents).toEqual([folderId])
    expect(drive.bytesOf(bak!.id)).toEqual(new Uint8Array([4, 5, 6]))
  })
})

describe('two devices over one Drive file', () => {
  it('converge through the ordinary engine path', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const { A, B } = await makePair(adapter, baseVault())

    A.commit(addTxnOp(A.vault, 'From-A'))
    B.commit(addTxnOp(B.vault, 'From-B'))
    await A.syncSettled()
    await B.syncSettled()
    await A.syncSettled()

    expect(A.merchants()).toEqual(expect.arrayContaining(['From-A', 'From-B']))
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })

  it('a lost race resolves into a merge rather than a clobber', async () => {
    const drive = new FakeDrive()
    const adapter = await connected(drive)
    const { A, B } = await makePair(adapter, baseVault())

    B.commit(addTxnOp(B.vault, 'From-B'))
    await B.syncSettled()

    // A is stale and its upload will land after B's, so the parent check fires.
    A.commit(addTxnOp(A.vault, 'From-A'))
    await A.syncSettled()

    expect(A.merchants()).toEqual(expect.arrayContaining(['From-A', 'From-B']))
    await B.syncSettled()
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })
})
