import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow, uuidv7 } from '../src/model/clock'
import { derive } from '../src/model/selectors'
import type { FxOverride, Rule, StatementRecord, Transaction, Vault } from '../src/model/types'
import { CAT_TRANSFERS } from '../src/model/types'
import { gcVault, threeWayMerge } from '../src/sync/merge'
import { acc, buildVault, budget, catId, snap, txn } from './helpers/build'

const mkStatement = (id: string, accountId: string): StatementRecord => ({
  id,
  updatedAt: now(),
  accountId,
  institutionId: 'revolut',
  variant: 'xlsx',
  fileName: 'f1.xlsx',
  fileHash: 'sha-' + id,
  periodFrom: '2026-02-04',
  periodTo: '2026-06-11',
  rowsTotal: 10,
  rowsImported: 10,
  rowsSkipped: { duplicate: 0, pending: 0, reverted: 0, unparsed: 0 },
  importedAt: now(),
})

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

describe('balance snapshots', () => {
  it('append-only: both sides’ snapshots union', () => {
    const base = buildVault((v) => {
      acc(v, { name: 'Checking' })
    })
    const accId = base.accounts[0]!.id
    const local = structuredClone(base)
    const remote = structuredClone(base)
    snap(local, accId, '2026-07-08', 100)
    snap(remote, accId, '2026-07-09', 200)
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.snapshots).toHaveLength(2)
    expect(conflicts).toHaveLength(0)
  })

  it('same account + same date from both sides → both kept, one flag, display picks later', () => {
    const base = buildVault((v) => {
      acc(v, { name: 'Checking' })
    })
    const accId = base.accounts[0]!.id
    const local = structuredClone(base)
    const remote = structuredClone(base)
    snap(local, accId, '2026-07-09', 6240, '2026-07-09T10:00:00Z')
    snap(remote, accId, '2026-07-09', 6300, '2026-07-09T11:00:00Z')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.snapshots).toHaveLength(2) // nothing destroyed
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'dup-snapshot', keptValue: 6300, discardedValue: 6240 })
    expect(derive(merged).currentBalance.get(accId)!.amount).toBe(6300)
  })

  it('same value typed twice on both devices is not flagged', () => {
    const base = buildVault((v) => {
      acc(v, { name: 'Checking' })
    })
    const accId = base.accounts[0]!.id
    const local = structuredClone(base)
    const remote = structuredClone(base)
    snap(local, accId, '2026-07-09', 6240)
    snap(remote, accId, '2026-07-09', 6240)
    expect(threeWayMerge(base, local, remote).conflicts).toHaveLength(0)
  })
})

describe('import dedupe', () => {
  it('same bank rows imported on two devices under different UUIDs → one survivor, one flag per file', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const mkImport = (v: Vault, hash: string): Transaction => {
      const t: Transaction = {
        id: uuidv7(),
        updatedAt: now(),
        date: '2026-07-04',
        merchant: 'Corner Cafe',
        categoryId: catId(v, 'Dining out'),
        amount: -12.4,
        importMeta: { hash, file: 'chase_jul.csv' },
      }
      v.transactions.push(t)
      return t
    }
    mkImport(local, 'h1')
    mkImport(local, 'h2')
    mkImport(remote, 'h1')
    mkImport(remote, 'h2')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions).toHaveLength(2) // one per hash
    expect(conflicts.filter((c) => c.kind === 'dup-import')).toHaveLength(1) // once per FILE, not per row
    expect(merged.tombstones.filter((t) => t.collection === 'transactions')).toHaveLength(2)
  })

  it('unique hashes are untouched', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.transactions.push({
      id: uuidv7(), updatedAt: now(), date: '2026-07-01', merchant: 'A',
      categoryId: catId(local, 'Other'), amount: -1, importMeta: { hash: 'x1' },
    })
    remote.transactions.push({
      id: uuidv7(), updatedAt: now(), date: '2026-07-02', merchant: 'B',
      categoryId: catId(remote, 'Other'), amount: -2, importMeta: { hash: 'x2' },
    })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions).toHaveLength(2)
    expect(conflicts).toHaveLength(0)
  })
})

describe('budget uniqueness', () => {
  it('both devices created a budget for the same category → newer kept, other tombstoned, flagged', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const bl = budget(local, 'Groceries', 500)
    bl.updatedAt = '2026-07-09T10:00:00Z'
    const br = budget(remote, 'Groceries', 550)
    br.updatedAt = '2026-07-09T11:00:00Z'
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.budgets).toHaveLength(1)
    expect(merged.budgets[0]!.amount).toBe(550)
    expect(conflicts.some((c) => c.kind === 'dup-budget' && c.discardedValue === 500)).toBe(true)
    expect(merged.tombstones.some((t) => t.id === bl.id)).toBe(true)
  })

  // `budgetKey` had no `recurring` arm, so every recurring budget fell through to
  // `cat|${categoryId}`. Both collisions below are reachable from the Plan form, and the
  // post-pass answer to a collision is a TOMBSTONE THAT SYNCS BACK — silent data loss.
  it('two cross-category recurring budgets of different cadence are not duplicates', () => {
    const base = buildVault()
    const local = structuredClone(base)
    // Both park categoryId on CAT_TRANSFERS, which is what made them collide.
    local.budgets.push(
      { id: uuidv7(), updatedAt: now(), categoryId: CAT_TRANSFERS, amount: 70, scope: { kind: 'recurring', cadence: 'monthly' } },
      { id: uuidv7(), updatedAt: now(), categoryId: CAT_TRANSFERS, amount: 310, scope: { kind: 'recurring', cadence: 'yearly' } },
    )
    const { merged, conflicts } = threeWayMerge(base, local, structuredClone(base))
    expect(merged.budgets).toHaveLength(2)
    expect(merged.tombstones.filter((t) => t.collection === 'budgets')).toHaveLength(0)
    expect(conflicts.some((c) => c.kind === 'dup-budget')).toBe(false)
  })

  it('a per-category recurring budget does not collide with that category’s monthly budget', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const plain = budget(local, 'Groceries', 500)
    local.budgets.push({
      id: uuidv7(), updatedAt: now(), categoryId: catId(local, 'Groceries'), amount: 60,
      scope: { kind: 'recurring', cadence: 'monthly', categoryId: catId(local, 'Groceries') },
    })
    const { merged, conflicts } = threeWayMerge(base, local, structuredClone(base))
    expect(merged.budgets).toHaveLength(2)
    expect(merged.budgets.some((b) => b.id === plain.id)).toBe(true)
    expect(conflicts.some((c) => c.kind === 'dup-budget')).toBe(false)
  })

  it('two recurring budgets of the same cadence and category still are duplicates', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const mk = (v: Vault, amount: number, updatedAt: string) => {
      const b = {
        id: uuidv7(), updatedAt, categoryId: catId(v, 'Groceries'), amount,
        scope: { kind: 'recurring' as const, cadence: 'monthly' as const, categoryId: catId(v, 'Groceries') },
      }
      v.budgets.push(b)
      return b
    }
    const loser = mk(local, 60, '2026-07-09T10:00:00Z')
    mk(remote, 75, '2026-07-09T11:00:00Z')
    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.budgets).toHaveLength(1)
    expect(merged.budgets[0]!.amount).toBe(75)
    expect(merged.tombstones.some((t) => t.id === loser.id)).toBe(true)
  })
})

describe('tombstone & note retention', () => {
  it('tombstones survive 364 days, purge after 366', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.tombstones.push(
      { id: 'young', collection: 'transactions', deletedAt: '2025-07-11T12:00:00Z', updatedAt: '2025-07-11T12:00:00Z' }, // 363d
      { id: 'old', collection: 'transactions', deletedAt: '2025-07-07T12:00:00Z', updatedAt: '2025-07-07T12:00:00Z' }, // 367d
    )
    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.tombstones.map((t) => t.id)).toContain('young')
    expect(merged.tombstones.map((t) => t.id)).not.toContain('old')
  })

  it('sync notes expire after 30 days or when reviewed', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const noteBase = {
      collection: 'budgets' as const, recordId: 'x', recordLabel: 'X',
      keptFrom: 'local' as const, keptAt: now(), discardedAt: now(), kind: 'field-lww' as const,
    }
    local.syncNotes.push(
      { ...noteBase, id: 'fresh', createdAt: '2026-07-01T00:00:00Z' },
      { ...noteBase, id: 'stale', createdAt: '2026-06-01T00:00:00Z' }, // 38 days
      { ...noteBase, id: 'reviewed', createdAt: '2026-07-05T00:00:00Z', reviewedAt: now() },
    )
    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.syncNotes.map((n) => n.id)).toEqual(['fresh'])
  })

  it('gcVault applies the same retention outside a merge', () => {
    const v = buildVault()
    v.tombstones.push({ id: 'old', collection: 'goals', deletedAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' })
    v.syncNotes.push({
      id: 'stale', createdAt: '2026-05-01T00:00:00Z', collection: 'budgets', recordId: 'x', recordLabel: 'X',
      keptFrom: 'local', keptAt: now(), discardedAt: now(), kind: 'field-lww',
    })
    const out = gcVault(v)
    expect(out.tombstones).toHaveLength(0)
    expect(out.syncNotes).toHaveLength(0)
  })
})

describe('schema-2 collections merge generically', () => {
  it('statements union append-only (both sides’ imports survive)', () => {
    const base = buildVault((v) => {
      acc(v, { name: 'Revolut', fingerprint: 'revolut:eur' })
    })
    const accId = base.accounts[0]!.id
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.statements.push(mkStatement('stmt-l', accId))
    remote.statements.push(mkStatement('stmt-r', accId))
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.statements.map((s) => s.id).sort()).toEqual(['stmt-l', 'stmt-r'])
    expect(conflicts).toHaveLength(0)
  })

  it('rules field-LWW on edits, tombstone on delete', () => {
    const base = buildVault((v) => {
      const rule: Rule = {
        id: 'rule-1',
        updatedAt: '2026-07-01T00:00:00Z',
        categoryId: catId(v, 'Groceries'),
        priority: 50,
        source: 'learned',
        match: { field: 'merchant', op: 'contains', value: 'ALDI' },
      }
      v.rules.push(rule)
    })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    // local edits priority; remote deletes
    local.rules[0] = { ...local.rules[0]!, priority: 100, updatedAt: '2026-07-09T10:00:00Z' }
    remote.rules = []
    remote.tombstones.push({ id: 'rule-1', collection: 'rules', deletedAt: now(), updatedAt: now() })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    // edit-vs-delete → the edit survives, flagged
    expect(merged.rules.map((r) => r.id)).toEqual(['rule-1'])
    expect(merged.rules[0]!.priority).toBe(100)
    expect(conflicts.some((c) => c.kind === 'edit-delete')).toBe(true)
  })

  it('fxOverrides are single-value field-LWW records', () => {
    const base = buildVault((v) => {
      const fx: FxOverride = { id: 'fx-1', updatedAt: '2026-07-01T00:00:00Z', from: 'JPY', to: 'EUR', date: '2026-06-01', rate: 0.006 }
      v.fxOverrides.push(fx)
    })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.fxOverrides[0] = { ...local.fxOverrides[0]!, rate: 0.0061, updatedAt: '2026-07-09T10:00:00Z' }
    remote.fxOverrides[0] = { ...remote.fxOverrides[0]!, rate: 0.0062, updatedAt: '2026-07-09T11:00:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.fxOverrides).toHaveLength(1)
    expect(merged.fxOverrides[0]!.rate).toBe(0.0062) // remote newer wins
    expect(conflicts.some((c) => c.kind === 'field-lww' && c.field === 'rate')).toBe(true)
  })
})

describe('dup-account unification (IMPORT §4.3)', () => {
  it('same fingerprint on two devices → older id kept, refs rewritten, loser tombstoned, one note', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const t = now()
    // winner (older id) on local, with a snapshot
    local.accounts.push({ id: 'acc-aaa', updatedAt: t, name: 'Revolut', fingerprint: 'revolut:eur', liab: false, liquid: true })
    local.snapshots.push({ id: 'snap-w', updatedAt: t, accountId: 'acc-aaa', date: '2026-06-11', amount: 2738.89, createdAt: t })
    // loser (newer id) on remote, same fingerprint, with a txn + statement pointing at it
    remote.accounts.push({ id: 'acc-bbb', updatedAt: t, name: 'Revolut EUR', fingerprint: 'revolut:eur', liab: false, liquid: true })
    remote.transactions.push({
      id: 'txn-loser', updatedAt: t, date: '2026-06-10', merchant: 'POP MART',
      categoryId: catId(remote, 'Shopping'), amount: -27.96, accountId: 'acc-bbb',
    })
    remote.statements.push(mkStatement('stmt-loser', 'acc-bbb'))

    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.accounts.map((a) => a.id)).toEqual(['acc-aaa']) // only the winner survives
    expect(merged.transactions.find((x) => x.id === 'txn-loser')!.accountId).toBe('acc-aaa')
    expect(merged.statements.find((s) => s.id === 'stmt-loser')!.accountId).toBe('acc-aaa')
    expect(merged.snapshots.find((s) => s.id === 'snap-w')!.accountId).toBe('acc-aaa')
    expect(merged.tombstones.some((ts) => ts.id === 'acc-bbb' && ts.collection === 'accounts')).toBe(true)
    expect(conflicts.filter((c) => c.kind === 'dup-account')).toHaveLength(1)
  })

  it('goals and saved comparisons follow the winner too — no dangling accountId', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const t = now()
    local.accounts.push({ id: 'acc-aaa', updatedAt: t, name: 'Revolut', fingerprint: 'revolut:eur', liab: false, liquid: true })
    remote.accounts.push({ id: 'acc-bbb', updatedAt: t, name: 'Revolut EUR', fingerprint: 'revolut:eur', liab: false, liquid: true })
    // The phone created a goal and a comparison against the account that will lose.
    remote.goals.push({
      id: 'g-em', updatedAt: t, name: 'Emergency fund', target: 5000, monthly: 0, saved: 0,
      source: { kind: 'balance', accountId: 'acc-bbb', direction: 'up', target: 5000 },
    })
    remote.savedComparisons.push({ id: 'cmp-1', updatedAt: t, selections: [{ accountIds: ['acc-bbb'] }] })

    const { merged } = threeWayMerge(base, local, remote)
    const g = merged.goals.find((x) => x.id === 'g-em')!
    expect(g.source).toMatchObject({ kind: 'balance', accountId: 'acc-aaa' })
    expect(merged.savedComparisons.find((c) => c.id === 'cmp-1')!.selections[0]!.accountIds).toEqual(['acc-aaa'])
  })

  it('trip-scoped budgets and flow goals follow a unified tracking', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const t = now()
    local.trackings.push({ id: 'trk-aaa', updatedAt: t, name: 'Japan · Apr 2025', kind: 'trip', dateFrom: '2025-04-01', dateTo: '2025-04-20' })
    remote.trackings.push({ id: 'trk-bbb', updatedAt: t, name: 'Japan · Apr 2025', kind: 'trip', dateFrom: '2025-04-02', dateTo: '2025-04-19' })
    remote.budgets.push({ id: 'b-trip', updatedAt: t, categoryId: 'cat-travel', amount: 2000, scope: { kind: 'tracking', trackingId: 'trk-bbb' } })
    remote.goals.push({
      id: 'g-trip', updatedAt: t, name: 'Japan fund', target: 2000, monthly: 0, saved: 0,
      source: { kind: 'flow', trackingId: 'trk-bbb' },
    })

    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.trackings.map((x) => x.id)).toEqual(['trk-aaa'])
    expect(merged.budgets.find((b) => b.id === 'b-trip')!.scope).toMatchObject({ kind: 'tracking', trackingId: 'trk-aaa' })
    expect(merged.goals.find((g) => g.id === 'g-trip')!.source).toMatchObject({ kind: 'flow', trackingId: 'trk-aaa' })
  })

  it('distinct fingerprints are never unified', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const t = now()
    local.accounts.push({ id: 'acc-a', updatedAt: t, name: 'Revolut', fingerprint: 'revolut:eur', liab: false, liquid: true })
    remote.accounts.push({ id: 'acc-b', updatedAt: t, name: 'BNP', fingerprint: 'bnp:99999-x', liab: false, liquid: true })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.accounts.map((a) => a.id).sort()).toEqual(['acc-a', 'acc-b'])
    expect(conflicts.filter((c) => c.kind === 'dup-account')).toHaveLength(0)
  })

  it('fingerprint-less accounts are never unified', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const t = now()
    local.accounts.push({ id: 'acc-a', updatedAt: t, name: 'Checking', liab: false, liquid: true })
    remote.accounts.push({ id: 'acc-b', updatedAt: t, name: 'Checking', liab: false, liquid: true })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.accounts).toHaveLength(2)
    expect(conflicts.filter((c) => c.kind === 'dup-account')).toHaveLength(0)
  })
})

describe('convergence sanity', () => {
  it('merge is symmetric up to conflict attribution', () => {
    const base = buildVault((v) => {
      budget(v, 'Dining out', 300)
      txn(v, '2026-07-01', 'Cafe', 'Dining out', -10)
    })
    const A = structuredClone(base)
    const B = structuredClone(base)
    A.budgets[0] = { ...A.budgets[0]!, amount: 350, updatedAt: '2026-07-09T10:00:00Z' }
    txn(B, '2026-07-05', 'B-add', 'Other', -5)
    const ab = threeWayMerge(base, A, B).merged
    const ba = threeWayMerge(base, B, A).merged
    const strip = (v: Vault) =>
      JSON.stringify({
        b: v.budgets.map((x) => [x.categoryId, x.amount]).sort(),
        t: v.transactions.map((x) => [x.merchant, x.amount]).sort(),
      })
    expect(strip(ab)).toBe(strip(ba))
  })
})
