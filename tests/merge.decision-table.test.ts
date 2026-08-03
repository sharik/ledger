import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import { applyOp } from '../src/model/mutations'
import type { Transaction, Vault } from '../src/model/types'
import { threeWayMerge } from '../src/sync/merge'
import { buildVault, catId, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

/** base vault with one transaction, and independent local/remote copies. */
function fixture() {
  const base = buildVault((v) => {
    txn(v, '2026-07-01', 'Corner Cafe', 'Dining out', -12.4)
  })
  const local: Vault = structuredClone(base)
  const remote: Vault = structuredClone(base)
  const id = base.transactions[0]!.id
  return { base, local, remote, id }
}

function editTxn(v: Vault, id: string, patch: Partial<Transaction>, updatedAt: string): void {
  v.transactions = v.transactions.map((t) => (t.id === id ? { ...t, ...patch, updatedAt } : t))
}

function del(v: Vault, id: string): Vault {
  return applyOp(v, { kind: 'delete', collection: 'transactions', ids: [id] }).vault
}

const merchants = (v: Vault) => v.transactions.map((t) => t.merchant).sort()

describe('SYNC §4.2 decision table', () => {
  it('row 1: local add is kept', () => {
    const { base, local, remote } = fixture()
    txn(local, '2026-07-05', 'LocalAdd', 'Other', -1)
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merchants(merged)).toEqual(['Corner Cafe', 'LocalAdd'])
    expect(conflicts).toHaveLength(0)
  })

  it('row 2: remote add is kept', () => {
    const { base, local, remote } = fixture()
    txn(remote, '2026-07-05', 'RemoteAdd', 'Other', -1)
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merchants(merged)).toEqual(['Corner Cafe', 'RemoteAdd'])
    expect(conflicts).toHaveLength(0)
  })

  it('row 3: added/added with the same id field-merges', () => {
    const { base, local, remote } = fixture()
    const shared: Transaction = {
      id: '01900000-0000-7000-8000-000000000001',
      updatedAt: '2026-07-09T10:00:00Z',
      date: '2026-07-08',
      merchant: 'Same',
      categoryId: catId(local, 'Other'),
      amount: -5,
    }
    local.transactions.push({ ...shared, note: 'from local' })
    remote.transactions.push({ ...shared, updatedAt: '2026-07-09T11:00:00Z' })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    const m = merged.transactions.find((t) => t.id === shared.id)!
    expect(merged.transactions).toHaveLength(2)
    // note differs with no base to arbitrate → LWW slot (remote is newer) + flagged
    expect(m.note).toBeUndefined()
    expect(conflicts.some((c) => c.field === 'note')).toBe(true)
  })

  it('row 4: unchanged/unchanged keeps base', () => {
    const { base, local, remote } = fixture()
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merchants(merged)).toEqual(['Corner Cafe'])
    expect(conflicts).toHaveLength(0)
  })

  it('row 5: local edit wins over unchanged remote', () => {
    const { base, local, remote, id } = fixture()
    editTxn(local, id, { merchant: 'Renamed' }, '2026-07-09T10:00:00Z')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions[0]!.merchant).toBe('Renamed')
    expect(conflicts).toHaveLength(0)
  })

  it('row 6: remote edit wins over unchanged local', () => {
    const { base, local, remote, id } = fixture()
    editTxn(remote, id, { amount: -15 }, '2026-07-09T10:00:00Z')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions[0]!.amount).toBe(-15)
    expect(conflicts).toHaveLength(0)
  })

  it('row 7: edited/edited goes to field-level merge', () => {
    const { base, local, remote, id } = fixture()
    editTxn(local, id, { note: 'lunch with sam' }, '2026-07-09T10:00:00Z')
    editTxn(remote, id, { categoryId: catId(remote, 'Groceries') }, '2026-07-09T10:30:00Z')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    const m = merged.transactions[0]!
    expect(m.note).toBe('lunch with sam')
    expect(m.categoryId).toBe(catId(remote, 'Groceries'))
    expect(conflicts).toHaveLength(0) // disjoint fields — perfect merge
  })

  it('row 8: local delete, remote unchanged → deleted with tombstone', () => {
    const { base, local, remote, id } = fixture()
    const localDel = del(local, id)
    const { merged } = threeWayMerge(base, localDel, remote)
    expect(merged.transactions).toHaveLength(0)
    expect(merged.tombstones.some((t) => t.id === id)).toBe(true)
  })

  it('row 9: remote delete, local unchanged → deleted', () => {
    const { base, local, remote, id } = fixture()
    const remoteDel = del(remote, id)
    const { merged } = threeWayMerge(base, local, remoteDel)
    expect(merged.transactions).toHaveLength(0)
    expect(merged.tombstones.some((t) => t.id === id)).toBe(true)
  })

  it('row 10: deleted/deleted → single tombstone', () => {
    const { base, local, remote, id } = fixture()
    const { merged, conflicts } = threeWayMerge(base, del(local, id), del(remote, id))
    expect(merged.transactions).toHaveLength(0)
    expect(merged.tombstones.filter((t) => t.id === id)).toHaveLength(1)
    expect(conflicts).toHaveLength(0)
  })

  it('row 11: local edit vs remote delete → the edit survives, flagged', () => {
    const { base, local, remote, id } = fixture()
    editTxn(local, id, { amount: -20 }, '2026-07-09T10:00:00Z')
    const { merged, conflicts } = threeWayMerge(base, local, del(remote, id))
    expect(merged.transactions[0]!.amount).toBe(-20)
    expect(merged.tombstones.some((t) => t.id === id)).toBe(false) // resurrection removes the tombstone
    expect(conflicts.some((c) => c.kind === 'edit-delete')).toBe(true)
  })

  it('row 12: local delete vs remote edit → the edit survives, flagged', () => {
    const { base, local, remote, id } = fixture()
    editTxn(remote, id, { merchant: 'Edited elsewhere' }, '2026-07-09T10:00:00Z')
    const { merged, conflicts } = threeWayMerge(base, del(local, id), remote)
    expect(merged.transactions[0]!.merchant).toBe('Edited elsewhere')
    expect(merged.tombstones.some((t) => t.id === id)).toBe(false)
    expect(conflicts.some((c) => c.kind === 'edit-delete')).toBe(true)
  })

  it('null base treats everything as adds (first-ever sync)', () => {
    const { local, remote } = fixture()
    txn(remote, '2026-07-06', 'RemoteOnly', 'Other', -2)
    const { merged } = threeWayMerge(null, local, remote)
    expect(merchants(merged)).toContain('RemoteOnly')
    expect(merchants(merged)).toContain('Corner Cafe')
    // same-id record present in both (from the shared fixture) survives exactly once
    expect(merged.transactions.filter((t) => t.merchant === 'Corner Cafe')).toHaveLength(1)
  })
})
