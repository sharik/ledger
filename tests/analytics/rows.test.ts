// `convertRows` is a fifth copy of a conversion loop that already exists in four places. The
// point of these tests is not just that it works, but that it agrees with the one the FX
// correctness core uses — so folding the others onto it later is mechanical rather than risky.
import { describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { convertRows, convertedById } from '../../src/analytics/rows'
import { compare } from '../../src/analytics/compare'
import { buildRateBook } from '../../src/import/fx'
import { resolveSelection } from '../../src/analytics/selections'
import { acc, buildVault, txn } from '../helpers/build'

setFixedNow('2026-07-12T14:32:00Z')
const TODAY = '2026-07-12'

/** Provider tables are "units of cur per 1 base": 1 EUR = 1/rate USD ⇒ USD→EUR multiplies by rate. */
const usdTable = (rate: number) => ({ usd: 1 / rate })

describe('convertRows', () => {
  it('passes base-currency rows through untouched', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-03', 'Bakery', 'Groceries', -10)
      txn(v, '2026-07-04', 'Pay', 'Income', 2000)
    })
    const r = convertRows(v.transactions, v, buildRateBook(v))
    expect(r.rows.map((x) => x.amount)).toEqual([-10, 2000])
    expect(r.excluded).toBe(0)
    expect(r.approx).toBe(0)
  })

  it('converts an explicit foreign currency, and keeps the sign', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
    })
    const r = convertRows(v.transactions, v, buildRateBook(v, new Map([['2026-07-03', usdTable(0.9)]])))
    expect(r.rows[0]!.amount).toBeCloseTo(-90)
  })

  it("resolves a currency-less row through its ACCOUNT's currency", () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Revolut USD', currency: 'USD', liquid: true })
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.accountId = a.id // the import writes the row without a currency of its own
    })
    const r = convertRows(v.transactions, v, buildRateBook(v, new Map([['2026-07-03', usdTable(0.9)]])))
    expect(r.rows[0]!.amount).toBeCloseTo(-90) // NOT -100
  })

  it('drops an unconvertible row and counts it, rather than entering it as zero', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
      txn(v, '2026-07-04', 'Bakery', 'Groceries', -10)
    })
    const r = convertRows(v.transactions, v, buildRateBook(v)) // no tables at all
    expect(r.rows.map((x) => x.amount)).toEqual([-10])
    expect(r.excluded).toBe(1)
  })

  it('counts a nearest-earlier conversion as approx', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-05', 'NYC Deli', 'Dining out', -100)
      t.currency = 'USD'
    })
    const r = convertRows(v.transactions, v, buildRateBook(v, new Map([['2026-07-01', usdTable(0.9)]])))
    expect(r.approx).toBe(1)
    expect(r.rows[0]!.amount).toBeCloseTo(-90)
  })

  it('applies no semantics — a transfer leg comes back like any other row', () => {
    const v = buildVault((v) => {
      const t = txn(v, '2026-07-03', 'Move', 'Groceries', -500)
      t.transferGroupId = 'g1'
    })
    // `compare()` would drop this row; this layer does not, because Transactions shows it.
    expect(convertRows(v.transactions, v, buildRateBook(v)).rows).toHaveLength(1)
  })

  it('convertedById keys the base amounts by transaction id', () => {
    const v = buildVault((v) => txn(v, '2026-07-03', 'Bakery', 'Groceries', -10))
    const byId = convertedById(convertRows(v.transactions, v, buildRateBook(v)))
    expect(byId.get(v.transactions[0]!.id)).toBe(-10)
  })
})

// The contract. If these two ever disagree, one screen's totals are wrong and the other's are not.
describe('cross-check: convertRows agrees with the loop inside compare()', () => {
  function multiCurrencyVault() {
    return buildVault((v) => {
      const usdAcc = acc(v, { name: 'Revolut USD', currency: 'USD', liquid: true })
      txn(v, '2026-07-02', 'Bakery', 'Groceries', -40) // base
      const explicit = txn(v, '2026-07-03', 'NYC Deli', 'Dining out', -100)
      explicit.currency = 'USD' // exact-date rate
      const viaAccount = txn(v, '2026-07-05', 'Brooklyn Bar', 'Dining out', -60)
      viaAccount.accountId = usdAcc.id // nearest-earlier rate ⇒ approx
      const noRate = txn(v, '2026-07-06', 'Tokyo Ramen', 'Dining out', -3000)
      noRate.currency = 'JPY' // no table anywhere ⇒ excluded
      txn(v, '2026-07-07', 'Pay', 'Income', 2500) // base, positive
    })
  }

  it('produces the same converted amounts, and the same excluded/approx counts', () => {
    const v = multiCurrencyVault()
    const rates = buildRateBook(v, new Map([['2026-07-03', usdTable(0.9)], ['2026-07-01', usdTable(0.8)]]))
    const sel = { period: { month: '2026-07' as const } }

    const side = compare(v, sel, sel, TODAY, { rates }).a
    const mine = convertRows(resolveSelection(sel, v, TODAY), v, rates)

    expect(mine.excluded).toBe(side.excludedCount)
    expect(mine.approx).toBe(side.approxCount)
    expect(mine.excluded).toBe(1) // the JPY row
    expect(mine.approx).toBe(1) // the account-currency row, on a nearest-earlier rate

    // `compare` sums spend (sign-flipped, income floored out), so the two are reconciled through
    // that rule rather than compared raw — what has to match is the per-row CONVERTED amount.
    const incomeCat = v.categories.find((c) => c.role === 'income')!.id
    const spend = mine.rows.reduce((s, { t, amount }) => s + (amount > 0 && t.categoryId === incomeCat ? 0 : -amount), 0)
    expect(spend).toBeCloseTo(side.totalRaw, 6)
  })

  it('agrees when nothing is convertible at all', () => {
    const v = multiCurrencyVault()
    const rates = buildRateBook(v) // no tables
    const sel = { period: { month: '2026-07' as const } }
    const side = compare(v, sel, sel, TODAY, { rates }).a
    const mine = convertRows(resolveSelection(sel, v, TODAY), v, rates)
    expect(mine.excluded).toBe(side.excludedCount)
    expect(mine.approx).toBe(side.approxCount)
  })
})
