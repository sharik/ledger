import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow } from '../src/model/clock'
import { applyOp, type Op } from '../src/model/mutations'
import { visibleVault } from '../src/model/selectors'
import type { Vault } from '../src/model/types'
import { CAT_TRANSFERS } from '../src/model/types'
import { acc, budget, buildVault, catId, goal, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

function roundtrip(vault: Vault, op: Op): { after: Vault; undone: Vault } {
  const r1 = applyOp(vault, op)
  expect(r1.inverse, `inverse for ${op.kind}`).toBeDefined()
  const r2 = applyOp(r1.vault, r1.inverse!)
  return { after: r1.vault, undone: r2.vault }
}

const stripVolatile = (v: Vault) =>
  JSON.stringify(v, (k, val) => (k === 'updatedAt' || k === 'id' || k === 'deletedAt' ? undefined : val))

describe('applyOp', () => {
  it('addTransaction adds a stamped record; inverse deletes it', () => {
    const v = buildVault()
    const { after, undone } = roundtrip(v, {
      kind: 'addTransaction',
      txn: { date: '2026-07-05', merchant: 'X', categoryId: catId(v, 'Other'), amount: -5 },
    })
    expect(after.transactions).toHaveLength(1)
    expect(after.transactions[0]!.updatedAt).toMatch(/^2026-07-09T12:00:0/)
    expect(undone.transactions).toHaveLength(0)
  })

  it('delete writes tombstones; restore clears them and re-adds records', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'A', 'Other', -1)
    })
    const id = v.transactions[0]!.id
    const del = applyOp(v, { kind: 'delete', collection: 'transactions', ids: [id] })
    expect(del.vault.transactions).toHaveLength(0)
    expect(del.vault.tombstones).toEqual([
      expect.objectContaining({ id, collection: 'transactions' }),
    ])
    const restored = applyOp(del.vault, del.inverse!)
    expect(restored.vault.transactions.map((t) => t.id)).toEqual([id])
    expect(restored.vault.tombstones).toHaveLength(0)
  })

  it('immutability: the input vault is never mutated', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'A', 'Other', -1)
    })
    const before = stripVolatile(v)
    applyOp(v, { kind: 'delete', collection: 'transactions', ids: [v.transactions[0]!.id] })
    expect(stripVolatile(v)).toBe(before)
  })

  it('updateBudget roundtrips the amount', () => {
    const v = buildVault()
    const b = budget(v, 'Groceries', 300)
    const { after, undone } = roundtrip(v, { kind: 'updateBudget', id: b.id, categoryId: b.categoryId, amount: 325 })
    expect(after.budgets[0]!.amount).toBe(325)
    expect(undone.budgets[0]!.amount).toBe(300)
  })

  // The dialog can turn a plain category budget into a multi-category one in a single gesture,
  // so name, scope and categoryId have to travel — and come back — together.
  it('updateBudget roundtrips name, scope and categoryId together', () => {
    const v = buildVault()
    const b = budget(v, 'Groceries', 300)
    const groceries = b.categoryId
    const { after, undone } = roundtrip(v, {
      kind: 'updateBudget',
      id: b.id,
      categoryId: CAT_TRANSFERS,
      amount: 800,
      name: 'Fun',
      scope: { kind: 'group', categoryIds: [groceries, 'cat-din'] },
    })
    expect(after.budgets[0]).toMatchObject({ categoryId: CAT_TRANSFERS, amount: 800, name: 'Fun' })
    expect(after.budgets[0]!.scope).toEqual({ kind: 'group', categoryIds: [groceries, 'cat-din'] })
    // Absent → present → undo must restore ABSENCE, not leave 'Fun' behind.
    expect(undone.budgets[0]!.name).toBeUndefined()
    expect(undone.budgets[0]!.scope).toBeUndefined()
    expect(undone.budgets[0]!.categoryId).toBe(groceries)
  })

  it('updateGoal roundtrips name/target/monthly', () => {
    const v = buildVault()
    const g = goal(v, { name: 'Bike', target: 1000, saved: 0, monthly: 50 })
    const { after, undone } = roundtrip(v, { kind: 'updateGoal', id: g.id, name: 'Bike II', target: 1500, monthly: 75 })
    expect(after.goals[0]).toMatchObject({ name: 'Bike II', target: 1500, monthly: 75 })
    expect(undone.goals[0]).toMatchObject({ name: 'Bike', target: 1000, monthly: 50 })
  })

  it('appendSnapshots inverse deletes exactly those snapshots', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Checking' })
    const { after, undone } = roundtrip(v, {
      kind: 'appendSnapshots',
      snapshots: [{ accountId: a.id, date: '2026-07-09', amount: 500 }],
    })
    expect(after.snapshots).toHaveLength(1)
    expect(after.snapshots[0]!.createdAt).toBeDefined()
    expect(undone.snapshots).toHaveLength(0)
  })

  it('setParam / setSaveMode / setGoalMonthly / setField roundtrip', () => {
    const v = buildVault((v) => {
      goal(v, { name: 'G', target: 100, saved: 0, monthly: 10 })
      acc(v, { name: 'A' })
    })
    const g = v.goals[0]!
    const a = v.accounts[0]!

    let r = roundtrip(v, { kind: 'setParam', key: 'srTarget', value: 25 })
    expect(r.after.params.srTarget).toBe(25)
    expect(r.undone.params.srTarget).toBe(20)

    r = roundtrip(v, { kind: 'setSaveMode', saveMode: 'manual' })
    expect(r.after.settings.saveMode).toBe('manual')
    expect(r.undone.settings.saveMode).toBe('onChange')

    r = roundtrip(v, { kind: 'setGoalMonthly', id: g.id, monthly: 75 })
    expect(r.after.goals[0]!.monthly).toBe(75)
    expect(r.undone.goals[0]!.monthly).toBe(10)

    r = roundtrip(v, { kind: 'setField', collection: 'accounts', id: a.id, field: 'name', value: 'B' })
    expect(r.after.accounts[0]!.name).toBe('B')
    expect(r.undone.accounts[0]!.name).toBe('A')
  })

  it('hiding an account undoes back to ABSENT, not to hidden:false', () => {
    // The projection keys off truthiness, but a lingering `hidden: false` would be a dead key
    // in the persisted record and would make `visibleVault` allocate for nothing.
    const v = buildVault((v) => { acc(v, { name: 'Dead' }) })
    const a = v.accounts[0]!
    const r = roundtrip(v, { kind: 'setField', collection: 'accounts', id: a.id, field: 'hidden', value: true })
    expect(r.after.accounts[0]!.hidden).toBe(true)
    expect(visibleVault(r.after).accounts).toHaveLength(0)

    expect('hidden' in r.undone.accounts[0]!).toBe(true)
    expect(r.undone.accounts[0]!.hidden).toBeUndefined()
    // Identity restored ⇒ the projection is a no-op again, exactly as before the hide.
    expect(visibleVault(r.undone)).toBe(r.undone)
    expect(JSON.parse(JSON.stringify(r.undone)).accounts[0].hidden).toBeUndefined()
  })

  it('useOtherValue applies the discarded value and marks the note reviewed', () => {
    const v = buildVault()
    const b = budget(v, 'Dining out', 350)
    v.syncNotes.push({
      id: 'n1',
      createdAt: '2026-07-09T10:00:00Z',
      collection: 'budgets',
      recordId: b.id,
      recordLabel: 'Dining out budget',
      field: 'amount',
      keptValue: 350,
      discardedValue: 325,
      keptFrom: 'local',
      keptAt: '2026-07-09T10:00:00Z',
      discardedAt: '2026-07-09T09:59:00Z',
      kind: 'field-lww',
    })
    const r = applyOp(v, { kind: 'useOtherValue', noteId: 'n1' })
    expect(r.vault.budgets[0]!.amount).toBe(325)
    expect(r.vault.syncNotes[0]!.reviewedAt).toBeDefined()
    // inverse restores the kept value
    const r2 = applyOp(r.vault, r.inverse!)
    expect(r2.vault.budgets[0]!.amount).toBe(350)
  })

  it('markNoteReviewed has no inverse and is idempotent-ish', () => {
    const v = buildVault()
    v.syncNotes.push({
      id: 'n1', createdAt: '2026-07-09T10:00:00Z', collection: 'budgets', recordId: 'x',
      recordLabel: 'x', keptFrom: 'local', keptAt: '2026-07-09T10:00:00Z',
      discardedAt: '2026-07-09T10:00:00Z', kind: 'dup-budget',
    })
    const r = applyOp(v, { kind: 'markNoteReviewed', noteId: 'n1' })
    expect(r.vault.syncNotes[0]!.reviewedAt).toBeDefined()
    expect(r.inverse).toBeUndefined()
  })

  it('ops on missing records are no-ops returning the same vault', () => {
    const v = buildVault()
    expect(applyOp(v, { kind: 'updateBudget', id: 'nope', categoryId: 'c', amount: 1 }).vault).toBe(v)
    expect(applyOp(v, { kind: 'delete', collection: 'goals', ids: ['nope'] }).vault).toBe(v)
  })
})

describe('applyOp — batch', () => {
  /** The shape the Transactions screen commits for *Always*: mint a rule + settle its rows. */
  function ruleAndRows(v: Vault): Op {
    return {
      kind: 'batch',
      ops: [
        {
          kind: 'restore',
          collection: 'rules',
          records: [{ id: 'r1', updatedAt: now(), categoryId: catId(v, 'Transport'), priority: 50, source: 'learned', enabled: true, match: { field: 'merchant', op: 'equals', value: 'VINCI' } }],
        },
        { kind: 'recategorizeBatch', txnIds: v.transactions.map((t) => t.id), categoryId: catId(v, 'Transport') },
      ],
    }
  }

  it('applies every sub-op, and one inverse undoes all of them', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'VINCI', 'Other', -2)
      txn(v, '2026-07-02', 'VINCI', 'Other', -3)
    })
    const { after, undone } = roundtrip(v, ruleAndRows(v))

    expect(after.rules).toHaveLength(1)
    expect(after.transactions.every((t) => t.categoryId === catId(v, 'Transport'))).toBe(true)

    // Both halves come back — the failure this guards against is an undo that reverses only
    // the sub-op that ran last, leaving the rule behind after the rows are restored.
    expect(undone.rules).toHaveLength(0)
    expect(undone.transactions.every((t) => t.categoryId === catId(v, 'Other'))).toBe(true)
  })

  it('undoes in reverse order, so sub-ops that touch the same rows unwind correctly', () => {
    const v = buildVault((v) => txn(v, '2026-07-01', 'A', 'Other', -1))
    const id = v.transactions[0]!.id
    const { undone } = roundtrip(v, {
      kind: 'batch',
      ops: [
        { kind: 'recategorizeBatch', txnIds: [id], categoryId: catId(v, 'Transport') },
        { kind: 'recategorizeBatch', txnIds: [id], categoryId: catId(v, 'Groceries') },
      ],
    })
    expect(undone.transactions[0]!.categoryId).toBe(catId(v, 'Other'))
  })

  it('a batch whose sub-ops all no-op leaves the vault identical and offers no inverse', () => {
    const v = buildVault()
    const r = applyOp(v, { kind: 'batch', ops: [{ kind: 'delete', collection: 'transactions', ids: ['nope'] }] })
    expect(r.vault).toBe(v)
    expect(r.inverse).toBeUndefined()
  })
})

describe('applyOp — import ops', () => {
  const stmt = {
    institutionId: 'revolut', variant: 'xlsx', fileName: 'f.xlsx', fileHash: 'abc',
    periodFrom: '2026-06-01', periodTo: '2026-06-30', openingBalance: 100, closingBalance: 90,
    rowsTotal: 1, rowsImported: 1,
    rowsSkipped: { duplicate: 0, pending: 0, reverted: 0, unparsed: 0 }, importedAt: '2026-07-09T12:00:00Z',
  }
  const newTxn = (over = {}) => ({
    date: '2026-06-15', merchant: 'Shop', categoryId: 'cat-other', amount: -10, accountId: '',
    importMeta: { hash: 'h1' }, ...over,
  })

  it('applyImport with a new account creates account+statement+txns+snapshots; inverse reverts', () => {
    const v = buildVault()
    const r = applyOp(v, {
      kind: 'applyImport', statement: stmt, txns: [newTxn()],
      snapshots: [{ accountId: '', date: '2026-06-01', amount: 100 }],
      newAccount: { name: 'Revolut EUR', liab: false, liquid: true, institutionId: 'revolut', fingerprint: 'revolut:current:eur', currency: 'EUR' },
    })
    expect(r.vault.accounts).toHaveLength(1)
    expect(r.vault.transactions).toHaveLength(1)
    expect(r.vault.transactions[0]!.isNew).toBe(true)
    expect(r.vault.transactions[0]!.importMeta!.statementId).toBe(r.vault.statements[0]!.id)
    expect(r.vault.snapshots).toHaveLength(1)
    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.accounts).toHaveLength(0)
    expect(back.transactions).toHaveLength(0)
    expect(back.snapshots).toHaveLength(0)
    expect(back.statements).toHaveLength(0)
  })

  it('applyImport with transferLinks flips an existing leg to Transfers; inverse restores its category', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Spouse' })
    const leg = txn(v, '2026-06-14', 'Wire', 'Other', -500)
    const r = applyOp(v, {
      kind: 'applyImport', statement: stmt,
      txns: [newTxn({ amount: 500, transferGroupId: 'g1' })],
      snapshots: [], accountId: a.id,
      transferLinks: [{ existingTxnId: leg.id, transferGroupId: 'g1' }],
    })
    const flipped = r.vault.transactions.find((t) => t.id === leg.id)!
    expect(flipped.transferGroupId).toBe('g1')
    expect(flipped.categoryId).toBe('cat-transfers')
    const back = applyOp(r.vault, r.inverse!).vault
    const restored = back.transactions.find((t) => t.id === leg.id)!
    expect(restored.transferGroupId).toBeUndefined()
    expect(restored.categoryId).toBe(catId(v, 'Other'))
  })

  it('applyImport records balances-only (zero txns) and dedups snapshots on re-commit (#18)', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Rev' })
    const op = {
      kind: 'applyImport' as const,
      statement: { ...stmt, rowsTotal: 21, rowsImported: 0, rowsSkipped: { duplicate: 21, pending: 0, reverted: 0, unparsed: 0 } },
      txns: [],
      snapshots: [{ accountId: a.id, date: '2026-06-01', amount: 100 }, { accountId: a.id, date: '2026-06-30', amount: 90 }],
      accountId: a.id,
    }
    const r = applyOp(v, op)
    expect(r.vault.transactions).toHaveLength(0)
    expect(r.vault.snapshots).toHaveLength(2)
    expect(r.vault.statements).toHaveLength(1)
    // Re-committing the same anchors adds nothing (dedup on apply).
    const r2 = applyOp(r.vault, op)
    expect(r2.vault.snapshots).toHaveLength(2)
    // The dedup'd commit's inverse removes only what it added — the anchors survive.
    const back = applyOp(r2.vault, r2.inverse!).vault
    expect(back.snapshots).toHaveLength(2)
  })

  it('recategorizeBatch + inverse restores each prior category', () => {
    const v = buildVault()
    const t1 = txn(v, '2026-06-01', 'A', 'Other', -5)
    const t2 = txn(v, '2026-06-02', 'B', 'Groceries', -6)
    const r = applyOp(v, { kind: 'recategorizeBatch', txnIds: [t1.id, t2.id], categoryId: catId(v, 'Shopping') })
    expect(r.vault.transactions.every((t) => t.categoryId === catId(v, 'Shopping'))).toBe(true)
    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.transactions.find((t) => t.id === t1.id)!.categoryId).toBe(catId(v, 'Other'))
    expect(back.transactions.find((t) => t.id === t2.id)!.categoryId).toBe(catId(v, 'Groceries'))
  })

  // Issue 11f: a hand pick has to overwrite the ladder's verdict, or the AI filter decays
  // into "rows the model ever touched" — the rot that made the IMPORTED badge meaningless.
  it('recategorizeBatch marks rows manual; the inverse restores prior provenance exactly', () => {
    const v = buildVault()
    const guessed = txn(v, '2026-06-01', 'A', 'Other', -5)
    guessed.provenance = 'ai'
    const legacy = txn(v, '2026-06-02', 'B', 'Groceries', -6) // no provenance at all
    const r = applyOp(v, { kind: 'recategorizeBatch', txnIds: [guessed.id, legacy.id], categoryId: catId(v, 'Shopping') })
    expect(r.vault.transactions.every((t) => t.provenance === 'manual')).toBe(true)

    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.transactions.find((t) => t.id === guessed.id)!.provenance).toBe('ai')
    // absence is a value too — undo must not leave a legacy row reading `manual`
    expect(back.transactions.find((t) => t.id === legacy.id)!.provenance).toBeUndefined()
  })

  it('resolveTransferPair / unlinkTransferPair are inverse of each other', () => {
    const v = buildVault()
    const t1 = txn(v, '2026-06-01', 'A', 'Other', 500)
    const t2 = txn(v, '2026-06-02', 'B', 'Other', -500)
    const r = applyOp(v, { kind: 'resolveTransferPair', txnIds: [t1.id, t2.id], transferGroupId: 'g9' })
    expect(r.vault.transactions.every((t) => t.transferGroupId === 'g9' && t.categoryId === 'cat-transfers')).toBe(true)
    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.transactions.every((t) => t.transferGroupId === undefined)).toBe(true)
    // undo must RESTORE the prior categories, not strand the legs in Transfers
    expect(back.transactions.every((t) => t.categoryId === catId(v, 'Other'))).toBe(true)
  })

  it('unlinkTransferPair with restore returns legs to a non-Transfers category', () => {
    const v = buildVault()
    const t1 = txn(v, '2026-06-01', 'A', 'Other', 500)
    const t2 = txn(v, '2026-06-02', 'B', 'Other', -500)
    const paired = applyOp(v, { kind: 'resolveTransferPair', txnIds: [t1.id, t2.id], transferGroupId: 'g9' }).vault
    const other = catId(v, 'Other')
    const unlinked = applyOp(paired, { kind: 'unlinkTransferPair', transferGroupId: 'g9', restore: [{ id: t1.id, categoryId: other }, { id: t2.id, categoryId: other }] }).vault
    expect(unlinked.transactions.every((t) => t.transferGroupId === undefined && t.categoryId === other)).toBe(true)
  })

  it('applyImport with trackingAssignments tags rows by index; inverse removes them', () => {
    const v = buildVault((v) => { v.trackings.push({ id: 'trip1', updatedAt: '2026-07-09T12:00:00Z', name: 'Italy', kind: 'trip' }) })
    const r = applyOp(v, {
      kind: 'applyImport', statement: stmt, snapshots: [], accountId: undefined,
      newAccount: { name: 'Revolut', liab: false, liquid: true, currency: 'EUR' },
      txns: [newTxn({ importMeta: { hash: 'a' } }), newTxn({ importMeta: { hash: 'b' } })],
      trackingAssignments: [{ rowIndex: 1, trackingId: 'trip1', dir: 'include' }],
    })
    expect(r.vault.trackingAssignments).toHaveLength(1)
    const tagged = r.vault.trackingAssignments[0]!
    expect(tagged.trackingId).toBe('trip1')
    expect(tagged.txnId).toBe(r.vault.transactions[1]!.id) // rowIndex 1
    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.trackingAssignments).toHaveLength(0)
  })
})

describe('applyOp — tracking ops (Phase E)', () => {
  it('addTracking mints the tracking + assignments; inverse removes both', () => {
    const v = buildVault()
    const t1 = txn(v, '2026-06-05', 'A', 'Other', -10)
    const r = applyOp(v, { kind: 'addTracking', tracking: { name: 'Italy', kind: 'trip', dateFrom: '2026-06-01', dateTo: '2026-06-10' }, assignments: [{ txnId: t1.id, dir: 'exclude' }] })
    expect(r.vault.trackings).toHaveLength(1)
    expect(r.vault.trackingAssignments).toHaveLength(1)
    expect(r.vault.trackingAssignments[0]!.dir).toBe('exclude')
    const back = applyOp(r.vault, r.inverse!).vault
    expect(back.trackings).toHaveLength(0)
    expect(back.trackingAssignments).toHaveLength(0)
  })

  it('addTracking → removeTracking → restoreTracking cycles back to identical state', () => {
    const v = buildVault()
    const added = applyOp(v, { kind: 'addTracking', tracking: { name: 'Japan', kind: 'trip' }, assignments: [] }).vault
    const trackingId = added.trackings[0]!.id
    const removed = applyOp(added, { kind: 'removeTracking', trackingId })
    expect(removed.vault.trackings).toHaveLength(0)
    expect(removed.vault.tombstones.some((ts) => ts.id === trackingId)).toBe(true)
    const restored = applyOp(removed.vault, removed.inverse!).vault
    expect(restored.trackings.map((t) => t.id)).toEqual([trackingId])
    expect(restored.tombstones.some((ts) => ts.id === trackingId)).toBe(false)
  })

  it('setAssignment enforces one-live-assignment and roundtrips its inverse', () => {
    const v = buildVault((v) => { v.trackings.push({ id: 'tr', updatedAt: now(), name: 'T', kind: 'trip' }) })
    const t1 = txn(v, '2026-06-05', 'A', 'Other', -10)
    // add an include
    const r1 = applyOp(v, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'include' })
    expect(r1.vault.trackingAssignments.filter((a) => a.txnId === t1.id)).toHaveLength(1)
    // flip to exclude — still exactly one live assignment
    const r2 = applyOp(r1.vault, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'exclude' })
    const live = r2.vault.trackingAssignments.filter((a) => a.txnId === t1.id)
    expect(live).toHaveLength(1)
    expect(live[0]!.dir).toBe('exclude')
    // inverse of the flip restores 'include'
    const back = applyOp(r2.vault, r2.inverse!).vault
    const restored = back.trackingAssignments.filter((a) => a.txnId === t1.id)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.dir).toBe('include')
  })

  it('setAssignment clear removes the live assignment', () => {
    const v = buildVault((v) => { v.trackings.push({ id: 'tr', updatedAt: now(), name: 'T', kind: 'trip' }) })
    const t1 = txn(v, '2026-06-05', 'A', 'Other', -10)
    const added = applyOp(v, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'include' }).vault
    const cleared = applyOp(added, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'clear' }).vault
    expect(cleared.trackingAssignments.filter((a) => a.txnId === t1.id)).toHaveLength(0)
  })

  it('setAssignments tags a batch, keeps one live row each, and roundtrips mixed prior state', () => {
    const v = buildVault((v) => { v.trackings.push({ id: 'tr', updatedAt: now(), name: 'T', kind: 'trip' }) })
    const t1 = txn(v, '2026-06-05', 'A', 'Other', -10)
    const t2 = txn(v, '2026-06-06', 'B', 'Other', -20)
    const t3 = txn(v, '2026-06-07', 'C', 'Other', -30)
    // t1 starts excluded, t2 already included, t3 untouched — one batch include covers all three.
    const seeded = applyOp(
      applyOp(v, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'exclude' }).vault,
      { kind: 'setAssignment', trackingId: 'tr', txnId: t2.id, dir: 'include' },
    ).vault

    const batch = applyOp(seeded, {
      kind: 'setAssignments',
      trackingId: 'tr',
      entries: [t1, t2, t3].map((t) => ({ txnId: t.id, dir: 'include' as const })),
    })
    const live = batch.vault.trackingAssignments.filter((a) => a.trackingId === 'tr')
    expect(live).toHaveLength(3)
    expect(live.every((a) => a.dir === 'include')).toBe(true)
    // t2 was already 'include' — untouched, so no tombstone for it
    expect(batch.vault.tombstones.filter((ts) => ts.collection === 'trackingAssignments')).toHaveLength(1)

    // inverse restores each row's own prior direction, not a blanket clear
    const back = applyOp(batch.vault, batch.inverse!).vault
    const byTxn = new Map(back.trackingAssignments.filter((a) => a.trackingId === 'tr').map((a) => [a.txnId, a.dir]))
    expect(byTxn.get(t1.id)).toBe('exclude')
    expect(byTxn.get(t2.id)).toBe('include')
    expect(byTxn.has(t3.id)).toBe(false)
  })

  it('setAssignments is a no-op when every entry already holds that direction', () => {
    const v = buildVault((v) => { v.trackings.push({ id: 'tr', updatedAt: now(), name: 'T', kind: 'trip' }) })
    const t1 = txn(v, '2026-06-05', 'A', 'Other', -10)
    const added = applyOp(v, { kind: 'setAssignment', trackingId: 'tr', txnId: t1.id, dir: 'include' }).vault
    const again = applyOp(added, { kind: 'setAssignments', trackingId: 'tr', entries: [{ txnId: t1.id, dir: 'include' }] })
    expect(again.vault).toBe(added)
    expect(again.inverse).toBeUndefined()
  })
})
