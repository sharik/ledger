import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import type { Vault } from '../../src/model/types'
import { compare } from '../../src/analytics/compare'
import { buildRateBook } from '../../src/import/fx'
import { budgetScopeSpent } from '../../src/analytics/budgets'
import { budget, buildVault, catId, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const TODAY = '2026-07-12'
const JULY = { period: { month: '2026-07' as const } } // in-progress: 12 days elapsed
const JUNE = { period: { month: '2026-06' as const } } // complete: 30 days
const THIS = { period: { rel: 'thisMonth' as const } }
const LAST = { period: { rel: 'lastMonth' as const } }

function seed(): Vault {
  const v = buildVault()
  // July (elapsed 12 days): Groceries 100 (day 2), Restaurants 50 (day 9) → raw 150
  txn(v, '2026-07-03', 'Groceries', 'Groceries', -100)
  txn(v, '2026-07-10', 'Cafe', 'Dining out', -50)
  // June (full 30 days): Groceries 80 (day 4), Restaurants 60 (day 19) → raw 140; first-12-days raw 80
  txn(v, '2026-06-05', 'Groceries', 'Groceries', -80)
  txn(v, '2026-06-20', 'Cafe', 'Dining out', -60)
  return v
}

describe('compare — arithmetic core (§5.3, §5.4-1)', () => {
  it('same-point-in-time truncates the completed side to the in-progress elapsed length', () => {
    const v = seed()
    const r = compare(v, THIS, LAST, TODAY) // total, samePoint (defaults)
    expect(r.a.daysCounted).toBe(12)
    expect(r.a.totalRaw).toBe(150)
    expect(r.b.daysCounted).toBe(12) // June truncated to 12 days
    expect(r.b.totalRaw).toBe(80) // only the day-4 grocery row falls inside
    expect(r.delta).toBe(70)
  })

  it('the full-period switch removes the truncation', () => {
    const v = seed()
    const r = compare(v, JULY, JUNE, TODAY, { mode: 'full' })
    expect(r.b.daysCounted).toBe(30)
    expect(r.b.totalRaw).toBe(140)
  })

  it("movers' Δs sum to totalA − totalB across all categories", () => {
    const v = seed()
    const r = compare(v, THIS, LAST, TODAY)
    const sum = r.byCategory.reduce((s, m) => s + m.delta, 0)
    expect(round(sum)).toBe(round(r.a.total - r.b.total))
    // sorted by |Δ| desc → Restaurants (Δ 50) before Groceries (Δ 20)
    expect(r.byCategory[0]!.delta).toBe(50)
  })

  it('the last cumulative point equals the raw total', () => {
    const v = seed()
    const r = compare(v, THIS, LAST, TODAY)
    expect(r.a.cumulative[r.a.cumulative.length - 1]).toBe(r.a.totalRaw)
    expect(r.b.cumulative[r.b.cumulative.length - 1]).toBe(r.b.totalRaw)
  })

  it('per-day normalization divides by elapsed length; per-month by elapsed ÷ 30.44', () => {
    const v = seed()
    const perDay = compare(v, THIS, LAST, TODAY, { normalize: 'perDay' })
    expect(round(perDay.a.total * perDay.a.daysCounted)).toBe(150)
    const perMonth = compare(v, THIS, LAST, TODAY, { normalize: 'perMonth' })
    expect(round(perMonth.a.total)).toBe(round((150 / 12) * 30.44))
  })

  it('swapping A/B is symmetric under same-point truncation', () => {
    const v = seed()
    const ab = compare(v, THIS, LAST, TODAY)
    const ba = compare(v, LAST, THIS, TODAY)
    expect(ba.a.totalRaw).toBe(ab.b.totalRaw)
    expect(ba.b.totalRaw).toBe(ab.a.totalRaw)
    expect(round(ba.delta)).toBe(round(-ab.delta))
  })

  // The Dashboard headline renders `netLbl(delta)` beside `pctDelta(a.totalRaw, b.totalRaw)`.
  // Those agree only while this identity holds, so it is pinned rather than assumed.
  it('delta is exactly a.totalRaw − b.totalRaw under the default normalization', () => {
    const v = seed()
    const r = compare(v, THIS, LAST, TODAY)
    expect(round(r.delta)).toBe(round(r.a.totalRaw - r.b.totalRaw))
  })

  // ANALYTICS §10.4: on the 31st there is no 31 June to align to, so B keeps its own 30
  // days and the two sides are NOT the same length. A caption saying "same point last
  // month" would be false here; it has to be driven by daysCounted (DashboardScreen `basis`).
  it('a 31-day in-progress month against a 30-day one counts 31 vs 30, not 31 vs 31', () => {
    const v = seed()
    const r = compare(v, JULY, JUNE, '2026-07-31')
    expect(r.a.daysCounted).toBe(31)
    expect(r.b.daysCounted).toBe(30)
    expect(r.b.totalRaw).toBe(140) // all of June, including the day-20 row
  })

  // Consequence of sourcing the headline figure from `a` rather than a whole-month reduce:
  // a row value-dated later in the current month is not yet "spend so far".
  it('rows dated after today are outside the in-progress window', () => {
    const v = seed()
    txn(v, '2026-07-28', 'Rent', 'Housing', -900)
    const r = compare(v, THIS, LAST, TODAY)
    expect(r.a.totalRaw).toBe(150) // the day-28 row is not counted on the 12th
    expect(compare(v, JULY, JUNE, '2026-07-31').a.totalRaw).toBe(1050) // it is by the 31st
  })

  it('non-base-currency rows are excluded and counted when no RateBook is supplied', () => {
    const v = seed()
    const j = txn(v, '2026-07-04', 'Tokyo', 'Shopping', -20)
    j.currency = 'JPY'
    const r = compare(v, THIS, LAST, TODAY)
    expect(r.a.excludedCount).toBe(1)
    expect(r.a.totalRaw).toBe(150) // JPY row not summed
  })

  /**
   * The gross/net split: `compare.spend()` counted a refund as 0 while `budgets.expense()` netted
   * it, so the Dashboard headline and a Plan budget row for one category could legitimately
   * disagree — and no test exercised it, because the demo seed has no refunds. Both are net now.
   */
  it('a refund nets down its category, and compare agrees with the budget readout', () => {
    const v = seed()
    txn(v, '2026-07-06', 'Pharmacie', 'Health', -100)
    txn(v, '2026-07-09', 'CPAM', 'Health', 74.59) // reimbursement, filed on the category it offsets
    const health = catId(v, 'Health')
    budget(v, 'Health', 200)
    const r = compare(v, THIS, LAST, TODAY)
    expect(round(r.byCategory.find((c) => c.categoryId === health)!.a)).toBe(25.41)
    expect(r.a.totalRaw).toBe(175.41) // 150 + 100 − 74.59
    // …the same figure the Plan row prints for that category, which is the point of the change.
    expect(round(budgetScopeSpent(v, v.budgets[0]!, '2026-07'))).toBe(25.41)
  })

  it('a salary in the Income category is income, not negative spend', () => {
    const v = seed()
    txn(v, '2026-07-02', 'ACME PAYROLL', 'Income', 3000)
    const r = compare(v, THIS, LAST, TODAY)
    expect(r.a.totalRaw).toBe(150) // untouched by the inflow
    expect(r.byCategory.find((c) => c.categoryId === catId(v, 'Income'))?.a ?? 0).toBe(0)
  })

  it('a category whose refunds exceed its spend floors at 0 rather than inverting its bar', () => {
    const v = seed()
    txn(v, '2026-07-05', 'Zara', 'Shopping', -40)
    txn(v, '2026-07-06', 'Zara', 'Shopping', 120) // returned more than was bought this month
    const r = compare(v, THIS, LAST, TODAY)
    expect(r.byCategory.find((c) => c.categoryId === catId(v, 'Shopping'))!.a).toBe(0)
    expect(r.a.totalRaw).toBe(70) // the side total stays honest: 150 − 80 net credit
  })

  it('Phase E: a RateBook converts foreign rows into the total (nearest-earlier ⇒ approxCount)', () => {
    const v = seed()
    v.fxOverrides.push({ id: 'o', updatedAt: '2026-07-01T00:00:00Z', from: 'JPY', to: 'EUR', date: '2026-07-01', rate: 0.5 })
    const j = txn(v, '2026-07-04', 'Tokyo', 'Shopping', -20)
    j.currency = 'JPY'
    const rates = buildRateBook(v) // no API tables ⇒ override at 2026-07-01 is nearest-earlier
    const r = compare(v, THIS, LAST, TODAY, { rates })
    expect(r.a.excludedCount).toBe(0)
    expect(r.a.totalRaw).toBe(160) // 150 EUR + 20 JPY × 0.5 = 10 EUR
    expect(r.a.approxCount).toBe(0) // an override is exact, not approximate
  })
})

const round = (n: number): number => Math.round(n * 1000) / 1000
