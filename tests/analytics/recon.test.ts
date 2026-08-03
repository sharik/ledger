import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow } from '../../src/model/clock'
import type { BalanceSnapshot, Vault } from '../../src/model/types'
import { coverage, driftHints } from '../../src/analytics/recon'
import { acc, buildVault, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const snapAt = (v: Vault, accountId: string, date: string, amount: number, origin?: BalanceSnapshot['origin']) => {
  v.snapshots.push({ id: 'snap-' + date, updatedAt: now(), accountId, date, amount, createdAt: now(), origin })
}
const acctTxn = (v: Vault, accountId: string, date: string, amount: number) => {
  const t = txn(v, date, 'X', 'Other', amount)
  t.accountId = accountId
}

describe('reconciliation drift (§7)', () => {
  it('no hint when transactions explain the snapshot delta', () => {
    const v = buildVault()
    const a = acc(v, { name: 'BNP' })
    snapAt(v, a.id, '2026-06-01', 1000, { kind: 'anchor', statementId: 's1' })
    snapAt(v, a.id, '2026-07-01', 1500, { kind: 'anchor', statementId: 's2' })
    acctTxn(v, a.id, '2026-06-15', 500)
    expect(driftHints(v, a.id)).toHaveLength(0)
  })

  it('anchor-to-anchor drift suggests a missing statement', () => {
    const v = buildVault()
    const a = acc(v, { name: 'BNP' })
    snapAt(v, a.id, '2026-06-01', 1000, { kind: 'anchor', statementId: 's1' })
    snapAt(v, a.id, '2026-07-01', 1500, { kind: 'anchor', statementId: 's2' })
    // no transactions → 500 unexplained
    const hints = driftHints(v, a.id)
    expect(hints).toHaveLength(1)
    expect(hints[0]!.delta).toBe(500)
    expect(hints[0]!.message).toContain('statement may be missing')
    expect(hints[0]!.message).not.toContain('typed balance')
  })

  it('a manual snapshot in the window points at the typed balance', () => {
    const v = buildVault()
    const a = acc(v, { name: 'BNP' })
    snapAt(v, a.id, '2026-06-01', 1000, { kind: 'anchor', statementId: 's1' })
    snapAt(v, a.id, '2026-07-01', 1500, { kind: 'manual' })
    expect(driftHints(v, a.id)[0]!.message).toContain('typed balance')
  })

  it('respects the tolerance boundary and self-heals when the data completes', () => {
    const v = buildVault()
    const a = acc(v, { name: 'BNP' })
    snapAt(v, a.id, '2026-06-01', 1000, { kind: 'anchor', statementId: 's1' })
    snapAt(v, a.id, '2026-07-01', 1001, { kind: 'anchor', statementId: 's2' })
    expect(driftHints(v, a.id)).toHaveLength(0) // €1.00 drift == default tolerance, within

    // widen the gap beyond tolerance → a hint appears
    v.snapshots.find((s) => s.date === '2026-07-01')!.amount = 1500
    expect(driftHints(v, a.id)).toHaveLength(1)

    // the missing statement arrives (a transaction that explains it) → hint clears
    acctTxn(v, a.id, '2026-06-15', 500)
    expect(driftHints(v, a.id)).toHaveLength(0)
  })

  // An implied opening is the balance BEFORE its day's first row. Counting that day's rows
  // against it invented drift equal to the day's net: a real vault showed "off by €3749.13"
  // across two anchors reading €6.27 and €6.27, because a €3749.13 exchange landed on the
  // opening's own date.
  describe('an opening anchor is a before-the-day figure', () => {
    const open = (statementId: string) => ({ kind: 'anchor' as const, statementId, at: 'open' as const })
    const close = (statementId: string) => ({ kind: 'anchor' as const, statementId, at: 'close' as const })

    it('as the later snapshot, its own day’s transactions are not charged against it', () => {
      const v = buildVault()
      const a = acc(v, { name: 'Revolut' })
      snapAt(v, a.id, '2026-06-01', 100, close('s1'))
      snapAt(v, a.id, '2026-07-01', 100, open('s2')) // the two balances agree exactly
      acctTxn(v, a.id, '2026-07-01', 3749.13) // …and this lands after the opening was read
      expect(driftHints(v, a.id)).toHaveLength(0)
    })

    it('as the earlier snapshot, its own day’s transactions ARE in the window', () => {
      const v = buildVault()
      const a = acc(v, { name: 'Revolut' })
      snapAt(v, a.id, '2026-06-01', 100, open('s1'))
      acctTxn(v, a.id, '2026-06-01', 500) // happens after the opening was read
      snapAt(v, a.id, '2026-07-01', 600, close('s2'))
      expect(driftHints(v, a.id)).toHaveLength(0)
    })

    it('a closing anchor still owns its own day, and drift on an opening still reports', () => {
      const v = buildVault()
      const a = acc(v, { name: 'Revolut' })
      snapAt(v, a.id, '2026-06-01', 100, close('s1'))
      acctTxn(v, a.id, '2026-06-01', 999) // s1 already accounts for this — must NOT be counted
      snapAt(v, a.id, '2026-07-01', 600, open('s2'))
      expect(driftHints(v, a.id)[0]!.delta).toBe(500) // 600 − 100, nothing in between explains it
    })

    it('a legacy snapshot with no origin keeps the end-of-day reading', () => {
      const v = buildVault()
      const a = acc(v, { name: 'Revolut' })
      snapAt(v, a.id, '2026-06-01', 100, { kind: 'anchor', statementId: 's1' }) // no `at`
      snapAt(v, a.id, '2026-07-01', 600, { kind: 'anchor', statementId: 's2' })
      acctTxn(v, a.id, '2026-07-01', 500)
      expect(driftHints(v, a.id)).toHaveLength(0)
    })
  })
})

const stmt = (v: Vault, accountId: string, from: string, to: string, fileName = `${from}.xlsx`, rows = 10) => {
  v.statements.push({
    id: `st-${from}-${to}`, updatedAt: now(), accountId, institutionId: 'revolut', variant: 'xlsx',
    fileName, fileHash: from, periodFrom: from, periodTo: to, rowsTotal: rows, rowsImported: rows,
    rowsSkipped: { duplicate: 0, pending: 0, reverted: 0, unparsed: 0 }, importedAt: now(),
  })
}

describe('statement coverage', () => {
  it('reports the hole between two statements, and nothing where they abut', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Revolut' })
    stmt(v, a.id, '2026-01-01', '2026-01-31')
    stmt(v, a.id, '2026-02-01', '2026-02-28') // abuts — not a gap
    stmt(v, a.id, '2026-05-01', '2026-05-31')
    const spans = coverage(v, a.id, '2026-05-31')
    expect(spans.map((s) => [s.kind, s.from, s.to])).toEqual([
      ['covered', '2026-01-01', '2026-02-28'],
      ['gap', '2026-03-01', '2026-04-30'],
      ['covered', '2026-05-01', '2026-05-31'],
    ])
    expect(spans[1]!.days).toBe(61)
  })

  it('merges overlapping imports instead of reading the overlap as a gap', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Revolut' })
    // Consecutive bank exports normally share their edges — f1 and f2 do exactly this.
    stmt(v, a.id, '2026-02-05', '2026-06-11', 'f1.xlsx')
    stmt(v, a.id, '2026-05-01', '2026-07-09', 'f2.xlsx')
    const spans = coverage(v, a.id, '2026-07-09')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ kind: 'covered', from: '2026-02-05', to: '2026-07-09' })
    expect(spans[0]!.files).toHaveLength(2)
  })

  /** The case drift detection is structurally blind to: no anchor after the hole. */
  it('reports a trailing gap when nothing has been imported for a while', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Revolut' })
    stmt(v, a.id, '2026-01-01', '2026-03-31')
    const spans = coverage(v, a.id, '2026-07-12')
    expect(spans[1]).toMatchObject({ kind: 'gap', from: '2026-04-01', to: '2026-07-12', trailing: true })
    expect(spans[1]!.days).toBe(103)
  })

  it('no trailing gap when the latest statement runs to today', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Revolut' })
    stmt(v, a.id, '2026-01-01', '2026-07-12')
    expect(coverage(v, a.id, '2026-07-12')).toHaveLength(1)
  })

  it('an account with no statements has no coverage to report', () => {
    const v = buildVault()
    expect(coverage(v, acc(v, { name: 'Cash' }).id, '2026-07-12')).toEqual([])
  })
})
