// Phase-1 correctness: derive() converts foreign rows/balances into base via the
// FX chain (same policy as compare/trips), resolving a row's currency through its
// account when the row doesn't carry one (model/types Transaction.currency:
// "defaults to account's").
import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import { derive, emergencyFundMonths, flowOf, trailingAvg } from '../src/model/selectors'
import { buildRateBook } from '../src/import/fx'
import { MIN_PACE_DAYS, monthEndProjection, pace } from '../src/analytics/project'
import { acc, buildVault, snap, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

function usdTable(rate: number) {
  // Provider tables are "units of cur per 1 base": 1 EUR = 1/rate USD ⇒ USD→EUR multiply by `rate`.
  return { usd: 1 / rate }
}

describe('derive: multi-currency flows', () => {
  it('converts a row with an explicit foreign currency into base', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
    })
    const d = derive(v, buildRateBook(v, new Map([['2026-07-03', usdTable(0.9)]])))
    expect(flowOf(d, '2026-07').expense).toBeCloseTo(90)
    expect(d.fxApprox).toBe(0)
  })

  it("resolves a currency-less row through its ACCOUNT's currency (the USD-account bug)", () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Revolut USD', currency: 'USD', liquid: true })
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.accountId = a.id // row currency omitted — the import writes it that way
    })
    const d = derive(v, buildRateBook(v, new Map([['2026-07-03', usdTable(0.9)]])))
    expect(flowOf(d, '2026-07').expense).toBeCloseTo(90) // NOT 100
  })

  it('excludes rows with no resolvable rate and counts them', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
      txn(v, '2026-07-04', 'Bakery', 'Groceries', -10)
    })
    const d = derive(v, buildRateBook(v)) // no tables, no bank-derived rate
    expect(flowOf(d, '2026-07').expense).toBe(10)
    expect(d.fxExcluded).toBe(1)
  })

  it('flags nearest-earlier conversions as approx', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-05', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
    })
    const d = derive(v, buildRateBook(v, new Map([['2026-07-01', usdTable(0.9)]])))
    expect(flowOf(d, '2026-07').expense).toBeCloseTo(90)
    expect(d.fxApprox).toBe(1)
  })

  it('converts foreign-account balances into base for assets/net worth', () => {
    const v = buildVault((v) => {
      const eur = acc(v, { name: 'Main', liquid: true })
      const usd = acc(v, { name: 'Revolut USD', currency: 'USD', liquid: true })
      snap(v, eur.id, '2026-07-01', 1000)
      snap(v, usd.id, '2026-07-01', 500)
    })
    const d = derive(v, buildRateBook(v, new Map([['2026-07-01', usdTable(0.9)]])))
    expect(d.assets).toBeCloseTo(1000 + 450)
    expect(d.netWorth).toBeCloseTo(1450)
    expect(d.netWorthByMonth.at(-1)!.nw).toBeCloseTo(1450)
  })
})

describe('pace guard: no blowup in the first days of a period', () => {
  it('returns the partial total while under MIN_PACE_DAYS', () => {
    expect(pace(1500, 1, 31)).toBe(1500) // day-1 rent no longer projects 31×
    expect(pace(1500, MIN_PACE_DAYS, 30)).toBeCloseTo((1500 / MIN_PACE_DAYS) * 30)
  })

  it('still projects full 1-day windows (single-day trips)', () => {
    expect(pace(120, 1, 1)).toBe(120)
  })

  it('monthEndProjection on the 1st equals spend so far', () => {
    expect(monthEndProjection(1500, '2026-07', '2026-07-01')).toBe(1500)
    expect(monthEndProjection(1500, '2026-07', '2026-07-15')).toBeCloseTo((1500 / 15) * 31)
  })
})

describe('trailing averages: young vaults', () => {
  it('skips months with no cash-flow data instead of averaging fake zeros', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Main', liquid: true })
      snap(v, a.id, '2025-01-15', 9000) // old snapshot widens monthsTracked
      txn(v, '2026-06-10', 'Rent', 'Housing', -1000)
      txn(v, '2026-05-10', 'Rent', 'Housing', -1000)
    })
    const d = derive(v)
    // Only 2 months have data → average is 1000, not 2000/12.
    expect(trailingAvg(d, 12, (f) => f.expense)).toBe(1000)
  })

  it('emergencyFundMonths is null (not 0) with cash but no expense history', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Main', liquid: true })
      snap(v, a.id, '2026-07-01', 40000)
    })
    expect(emergencyFundMonths(derive(v))).toBeNull()
  })
})
