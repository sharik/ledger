import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import type { Vault } from '../src/model/types'
import { SCHEMA_VERSION } from '../src/model/types'
import { encodeVault, encryptBlob, makeHeader } from '../src/persist/crypto'
import { InMemoryAdapter } from '../src/sync/inMemoryAdapter'
import { FakeDevice, makeKeys, makePair, stripIds, TEST_KDF } from './helpers/fakeDevice'
import { acc, budget, buildVault, catId, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

function baseVault(): Vault {
  return buildVault((v) => {
    acc(v, { name: 'Checking', liquid: true })
    budget(v, 'Dining out', 300)
    budget(v, 'Insurance', 65, true)
    txn(v, '2026-07-01', 'Rent', 'Housing', -1650)
  })
}

const addTxnOp = (v: Vault, merchant: string, amount = -10) =>
  ({
    kind: 'addTransaction' as const,
    txn: { date: '2026-07-08', merchant, categoryId: catId(v, 'Dining out'), amount },
  })

describe('§5.1 the everyday case — phone logs lunch, laptop is open', () => {
  it('pure remote add reaches the other device without a push from it', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())
    const writesBefore = adapter.writes

    A.commit(addTxnOp(A.vault, 'Corner Cafe', -12.4)) // phone logs lunch
    await A.sync() // push

    await B.sync() // laptop focus → metadata mismatch → pull, merge, NO push needed
    expect(B.merchants()).toContain('Corner Cafe')
    expect(adapter.writes - writesBefore).toBe(1) // only the phone wrote
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })
})

describe('§5.2 the race — both devices save within the same second', () => {
  it('loser retries, merges, re-pushes; both edits survive', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    A.commit(addTxnOp(A.vault, 'From-A'))
    B.commit(addTxnOp(B.vault, 'From-B'))
    await A.sync() // wins the race
    await B.syncSettled() // conditional write rejected → RETRY → pull, merge, push

    await A.sync() // pick up B's merge
    expect(A.merchants()).toEqual(expect.arrayContaining(['From-A', 'From-B']))
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })

  it('a third writer landing mid-retry still converges', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    // C is a third device sharing the vault
    const C = await FakeDevice.create('C', adapter, A.keys, structuredClone(A.vault))
    C.markDirty()
    await C.sync()
    await A.sync()
    await B.sync()

    A.commit(addTxnOp(A.vault, 'From-A'))
    B.commit(addTxnOp(B.vault, 'From-B'))
    C.commit(addTxnOp(C.vault, 'From-C'))
    await A.sync()
    // arm the third-writer trap: C's blob lands right before B's conditional write
    await C.save()
    const cBlob = (await C.local.getBlob())!
    adapter.injectThirdWriter(new Uint8Array(cBlob))
    await B.syncSettled()

    await A.sync()
    await C.syncSettled()
    await B.sync()
    expect(B.merchants()).toEqual(expect.arrayContaining(['From-A', 'From-B', 'From-C']))
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
    expect(stripIds(B.vault)).toBe(stripIds(C.vault))
  })
})

describe('§5.3 the hard case — a week offline, edits on both sides', () => {
  it('mega-merge: adds union, same-field LWW + note, deletion propagates, snapshots union', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())
    const dining = (v: Vault) => v.budgets.find((b) => b.categoryId === catId(v, 'Dining out'))!
    const subs = (v: Vault) => v.budgets.find((b) => b.categoryId === catId(v, 'Insurance'))!
    const accId = A.vault.accounts[0]!.id

    // laptop (A) goes offline and accumulates a week of edits
    A.online = false
    A.commit(addTxnOp(A.vault, 'A-txn-1'))
    A.commit(addTxnOp(A.vault, 'A-txn-2'))
    A.commit({ kind: 'updateBudget', id: dining(A.vault).id, categoryId: dining(A.vault).categoryId, amount: 350 })
    A.vault.budgets = A.vault.budgets.map((b) =>
      b.id === dining(A.vault).id ? { ...b, updatedAt: '2026-07-09T14:02:00Z' } : b,
    )
    A.commit({ kind: 'addGoal', name: 'New goal', target: 1000, monthly: 100 })
    await A.sync()
    expect(A.lastState()).toBe('OFFLINE_PENDING')

    // phone (B) meanwhile pushes its own week
    B.commit(addTxnOp(B.vault, 'B-txn-1'))
    B.commit({ kind: 'updateBudget', id: dining(B.vault).id, categoryId: dining(B.vault).categoryId, amount: 325 })
    B.vault.budgets = B.vault.budgets.map((b) =>
      b.id === dining(B.vault).id ? { ...b, updatedAt: '2026-07-09T13:47:00Z' } : b,
    )
    B.commit({ kind: 'delete', collection: 'budgets', ids: [subs(B.vault).id] })
    B.commit({ kind: 'appendSnapshots', snapshots: [{ accountId: accId, date: '2026-07-09', amount: 5000 }] })
    await B.sync()

    // laptop reconnects
    A.online = true
    await A.syncSettled()
    await B.sync()

    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
    expect(A.merchants()).toEqual(expect.arrayContaining(['A-txn-1', 'A-txn-2', 'B-txn-1']))
    expect(dining(A.vault).amount).toBe(350) // newer edit won
    expect(A.vault.syncNotes.some((n) => n.kind === 'field-lww' && n.discardedValue === 325)).toBe(true)
    expect(A.vault.budgets.some((b) => b.categoryId === catId(A.vault, 'Insurance'))).toBe(false) // deletion propagated
    expect(A.vault.goals.some((g) => g.name === 'New goal')).toBe(true)
    expect(A.vault.snapshots.some((s) => s.amount === 5000)).toBe(true)
    // B sees the same review note
    expect(B.vault.syncNotes.some((n) => n.discardedValue === 325)).toBe(true)
  })
})

describe('§5.4 password changed elsewhere', () => {
  it('re-key detected; after adopting the new key, local edits merge in', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    // A has local, unsynced edits
    A.commit(addTxnOp(A.vault, 'A-unsynced'))
    await A.save()

    // B re-keys the vault and pushes
    const { makeKeys } = await import('./helpers/fakeDevice')
    const newKeys = await makeKeys('new-password')
    B.keys = newKeys
    B.markDirty()
    await B.sync()

    // A pulls → salt differs → rekey prompt, nothing lost, nothing pushed
    const writesBefore = adapter.writes
    await A.sync()
    expect(A.rekeyHeaders).toHaveLength(1)
    expect(A.lastState()).toBe('REKEY_NEEDED')
    expect(adapter.writes).toBe(writesBefore)

    // user types the new password → adopt (keys + re-encrypted base) + resume
    await A.adoptKeys(newKeys)
    A.engine.resume()
    await A.syncSettled()
    await B.sync()
    expect(B.merchants()).toContain('A-unsynced')
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })
})

describe('§6.2 corruption', () => {
  it('damaged remote is never overwritten blind; restore keeps forensics', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    adapter.corruptInPlace()
    A.commit(addTxnOp(A.vault, 'A-local'))
    const writesBefore = adapter.writes
    await A.sync()
    expect(A.corruptSignals).toBe(1)
    expect(A.lastState()).toBe('CORRUPT_REMOTE')
    expect(adapter.writes).toBe(writesBefore) // no blind push

    await A.engine.restoreLocalOverRemote()
    expect(adapter.aux.has('vault.corrupt.bak')).toBe(true)
    expect(A.lastState()).toBe('IDLE_CLEAN')

    await B.sync()
    expect(B.merchants()).toContain('A-local')
  })
})

describe('§6.3 schema forward-compatibility', () => {
  it('a newer-schema remote parks the engine read-only; nothing is pushed', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    // B "upgrades" and writes a future-schema vault
    const future = { ...structuredClone(B.vault), schema: SCHEMA_VERSION + 1 }
    const blob = await encryptBlob(encodeVault(future), B.keys.key, makeHeader(future.vaultId, B.keys.salt, TEST_KDF))
    await adapter.write(blob, { ifRevision: `r${adapter.rev}` })

    A.commit(addTxnOp(A.vault, 'A-newer'))
    const writesBefore = adapter.writes
    await A.sync()
    expect(A.lastState()).toBe('READONLY_SCHEMA')
    expect(adapter.writes).toBe(writesBefore)
    // pendingWrite survives for when the app updates
    expect(await A.local.getPendingWrite()).toBe(true)
  })
})

describe('failure handling', () => {
  it('persistent transient failures cap at 8 retries → ERROR_BACKOFF', async () => {
    const adapter = new InMemoryAdapter()
    const { A } = await makePair(adapter, baseVault())
    A.commit(addTxnOp(A.vault, 'A-x'))
    adapter.failNextWrites(100)
    await A.syncSettled(5000)
    expect(A.lastState()).toBe('ERROR_BACKOFF')
    // recovery: failures clear, next trigger succeeds
    adapter.failNextWrites(0)
    await A.syncSettled()
    expect(A.lastState()).toBe('IDLE_CLEAN')
  })

  it('offline queues; the online trigger flushes pendingWrite', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())
    A.online = false
    A.commit(addTxnOp(A.vault, 'Offline-add'))
    await A.save() // autosave runs regardless of connectivity — L1 write-ahead
    await A.sync()
    expect(A.lastState()).toBe('OFFLINE_PENDING')
    expect(await A.local.getPendingWrite()).toBe(true)

    A.online = true
    await A.syncSettled() // the 'online' event handler calls exactly this
    expect(A.lastState()).toBe('IDLE_CLEAN')
    await B.sync()
    expect(B.merchants()).toContain('Offline-add')
  })

  it('idempotent no-op sync: clean model + unmoved remote does not write', async () => {
    const adapter = new InMemoryAdapter()
    const { A } = await makePair(adapter, baseVault())
    const writes = adapter.writes
    await A.sync()
    await A.sync()
    expect(adapter.writes).toBe(writes)
  })
})

describe('emulated-CAS lost race (LocalFile/Drive adapter shape)', () => {
  it('hash-compare adapter loses a race → RevisionConflict → retry converges', async () => {
    // The InMemoryAdapter's ifRevision behaves exactly like the hash-compare CAS;
    // this exercises the same code path with a mid-flight competing write.
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())
    A.commit(addTxnOp(A.vault, 'A-1'))
    B.commit(addTxnOp(B.vault, 'B-1'))
    await B.save()
    const bBlob = new Uint8Array((await B.local.getBlob())!)
    adapter.injectThirdWriter(bBlob) // lands between A's metadata check and write
    await A.syncSettled()
    await B.syncSettled()
    await A.sync()
    expect(A.merchants()).toEqual(expect.arrayContaining(['A-1', 'B-1']))
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })
})

/** Pass-through adapter that lets a test act right before a device's write lands. */
class HookedAdapter {
  onBeforeWrite: (() => void) | null = null
  constructor(private inner: InMemoryAdapter) {}
  getMetadata() {
    return this.inner.getMetadata()
  }
  read() {
    return this.inner.read()
  }
  write(bytes: Uint8Array, opts: { ifRevision?: string }) {
    this.onBeforeWrite?.()
    this.onBeforeWrite = null
    return this.inner.write(bytes, opts)
  }
}

describe('base = pushed bytes, not the live vault', () => {
  it('an edit landing while a push is in flight survives the next merge', async () => {
    const shared = new InMemoryAdapter()
    const keys = await makeKeys()
    const hooked = new HookedAdapter(shared)
    const initial = baseVault()
    const A = await FakeDevice.create('A', hooked, keys, structuredClone(initial))
    const B = await FakeDevice.create('B', shared, keys, structuredClone(initial))
    A.markDirty()
    await A.sync()
    B.markDirty()
    await B.sync()
    await A.sync()

    A.commit(addTxnOp(A.vault, 'Flushed-edit'))
    // While A's write is in flight, another edit lands in L0 — after the flush,
    // so it is NOT in the pushed blob. It must not enter the recorded base.
    hooked.onBeforeWrite = () => A.commit(addTxnOp(A.vault, 'In-flight-edit'))
    await A.sync()

    // B moves the remote with an unrelated edit.
    await B.sync()
    B.commit(addTxnOp(B.vault, 'From-B'))
    await B.sync()

    // A merges: the in-flight edit is a LOCAL change vs base and must survive.
    await A.syncSettled()
    expect(A.merchants()).toContain('In-flight-edit')
    await B.sync()
    expect(stripIds(A.vault)).toBe(stripIds(B.vault))
  })
})

describe('undecryptable base refuses to merge', () => {
  it('parks in ERROR_BACKOFF instead of union-merging without a base', async () => {
    const adapter = new InMemoryAdapter()
    const { A, B } = await makePair(adapter, baseVault())

    // A's stored base rots (or a re-key is caught mid-flight).
    await A.local.setLastSyncedBase(new Uint8Array([1, 2, 3, 4]))
    B.commit(addTxnOp(B.vault, 'From-B'))
    await B.sync()

    const before = stripIds(A.vault)
    await A.syncSettled(5000)
    expect(A.lastState()).toBe('ERROR_BACKOFF') // no silent two-way union
    expect(stripIds(A.vault)).toBe(before) // nothing merged, nothing resurrected
  })
})
