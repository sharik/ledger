import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { CAT_TRANSFERS } from '../../src/model/types'
import { addDays, daysBetween, rebasePeriod, rebaseSelection, resolvePeriod, resolveSelection } from '../../src/analytics/selections'
import type { PeriodRef } from '../../src/model/types'
import { buildVault, catId, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const TODAY = '2026-07-12'

describe('resolvePeriod — every PeriodRef arm (§5.2)', () => {
  it('relative refs resolve against today', () => {
    expect(resolvePeriod({ rel: 'thisMonth' }, TODAY)).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(resolvePeriod({ rel: 'lastMonth' }, TODAY)).toEqual({ from: '2026-06-01', to: '2026-06-30' })
    expect(resolvePeriod({ rel: 'thisYear' }, TODAY)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(resolvePeriod({ rel: 'lastYear' }, TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(resolvePeriod({ rel: 'sameMonthLastYear' }, TODAY)).toEqual({ from: '2025-07-01', to: '2025-07-31' })
  })

  it('absolute refs: month (Feb leap year), year, explicit range', () => {
    expect(resolvePeriod({ month: '2024-02' }, TODAY)).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(resolvePeriod({ year: 2025 }, TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(resolvePeriod({ from: '2026-03-05', to: '2026-03-20' }, TODAY)).toEqual({ from: '2026-03-05', to: '2026-03-20' })
  })

  it('month rollover across a year boundary for sameMonthLastYear', () => {
    expect(resolvePeriod({ rel: 'sameMonthLastYear' }, '2026-01-15')).toEqual({ from: '2025-01-01', to: '2025-01-31' })
  })
})

describe('rebasePeriod — reading a ref against an anchor instead of today', () => {
  const RELS: PeriodRef[] = [
    { rel: 'thisMonth' },
    { rel: 'lastMonth' },
    { rel: 'thisYear' },
    { rel: 'lastYear' },
    { rel: 'sameMonthLastYear' },
  ]

  // The keystone: anchored to the current month, rebasing changes nothing. This is what makes
  // the Dashboard at its default anchor behaviourally identical to before the period switcher.
  it('is the identity when the anchor IS the current month', () => {
    for (const p of RELS) {
      expect(resolvePeriod(rebasePeriod(p, '2026-07'), TODAY)).toEqual(resolvePeriod(p, TODAY))
    }
  })

  it('moves every relative to the anchor', () => {
    expect(rebasePeriod({ rel: 'thisMonth' }, '2026-03')).toEqual({ month: '2026-03' })
    expect(rebasePeriod({ rel: 'lastMonth' }, '2026-03')).toEqual({ month: '2026-02' })
    expect(rebasePeriod({ rel: 'sameMonthLastYear' }, '2026-03')).toEqual({ month: '2025-03' })
    expect(rebasePeriod({ rel: 'thisYear' }, '2026-03')).toEqual({ year: 2026 })
    expect(rebasePeriod({ rel: 'lastYear' }, '2026-03')).toEqual({ year: 2025 })
  })

  it('rolls back across a year boundary', () => {
    expect(rebasePeriod({ rel: 'lastMonth' }, '2026-01')).toEqual({ month: '2025-12' })
    expect(rebasePeriod({ rel: 'sameMonthLastYear' }, '2026-01')).toEqual({ month: '2025-01' })
  })

  // A pin built as "2026 vs 2025" must still read 2026 vs 2025 while the header sits on March.
  it('leaves absolute refs untouched', () => {
    const abs: PeriodRef[] = [{ month: '2024-02' }, { year: 2025 }, { from: '2026-03-05', to: '2026-03-20' }]
    for (const p of abs) expect(rebasePeriod(p, '2026-03')).toBe(p)
  })

  it('rebaseSelection keeps the other fields and leaves an unscoped selection unscoped', () => {
    const sel = { period: { rel: 'thisMonth' as const }, categoryIds: ['cat-1'], merchantQuery: 'uber' }
    expect(rebaseSelection(sel, '2026-03')).toEqual({ period: { month: '2026-03' }, categoryIds: ['cat-1'], merchantQuery: 'uber' })
    const unscoped = { categoryIds: ['cat-1'] }
    expect(rebaseSelection(unscoped, '2026-03')).toBe(unscoped)
  })
})

describe('date arithmetic', () => {
  it('daysBetween and addDays are inverse and leap-day safe', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2) // through Feb 29
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(daysBetween('2026-07-12', '2026-07-12')).toBe(0)
  })
})

describe('resolveSelection — intersection & cashflow (§5.1)', () => {
  it('intersects period ∩ category and drops transfer legs unless includeNonCashflow', () => {
    const v = buildVault()
    txn(v, '2026-07-05', 'Groceries', 'Groceries', -40)
    txn(v, '2026-06-30', 'Old', 'Groceries', -10) // out of period
    const transfer = txn(v, '2026-07-06', 'Move', 'Groceries', -500)
    transfer.transferGroupId = 'g1' // non-cashflow

    const sel = { period: { month: '2026-07' as const }, categoryIds: [catId(v, 'Groceries')] }
    const got = resolveSelection(sel, v, TODAY)
    expect(got.map((t) => t.merchant)).toEqual(['Groceries'])

    const withTransfers = resolveSelection({ ...sel, includeNonCashflow: true }, v, TODAY)
    expect(withTransfers.map((t) => t.merchant).sort()).toEqual(['Groceries', 'Move'])
  })

  it('Transfers-category rows are non-cashflow', () => {
    const v = buildVault()
    const t = txn(v, '2026-07-05', 'X', 'Groceries', -20)
    t.categoryId = CAT_TRANSFERS
    expect(resolveSelection({ period: { month: '2026-07' } }, v, TODAY)).toHaveLength(0)
    expect(resolveSelection({ period: { month: '2026-07' }, includeNonCashflow: true }, v, TODAY)).toHaveLength(1)
  })

  it('merchant query is a normalized contains-match', () => {
    const v = buildVault()
    txn(v, '2026-07-05', 'Île-de-France Mobilités', 'Transport', -20)
    txn(v, '2026-07-06', 'Uber', 'Transport', -12)
    const got = resolveSelection({ period: { month: '2026-07' }, merchantQuery: 'mobilit' }, v, TODAY)
    expect(got.map((t) => t.merchant)).toEqual(['Île-de-France Mobilités'])
  })
})
