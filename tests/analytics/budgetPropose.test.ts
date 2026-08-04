import { describe, expect, it } from 'vitest'
import { setFixedNow, now } from '../../src/model/clock'
import { derive } from '../../src/model/selectors'
import { proposeBudgets, proposalYear } from '../../src/analytics/budgetPropose'
import { scopeTrailingAvg } from '../../src/analytics/budgets'
import { typicalMonth } from '../../src/analytics/trends'
import type { Vault } from '../../src/model/types'
import { buildVault, catId, txn } from '../helpers/build'

// Fixed before the first derive() — pins the memo key; every call passes an explicit anchor.
setFixedNow('2026-07-09T12:00:00Z')

const ANCHOR = '2026-07'

/** One small cash-flow row per month so each month counts as complete. */
function fillMonths(v: Vault, months: string[], amount = -1): void {
  for (const mk of months) txn(v, `${mk}-15`, 'filler', 'Other', amount)
}

/** 'YYYY-MM' keys from `from` inclusive, `count` months forward. */
function monthRange(from: string, count: number): string[] {
  const y0 = Number(from.slice(0, 4))
  const m0 = Number(from.slice(5, 7)) - 1
  return Array.from({ length: count }, (_, i) => {
    const m = m0 + i
    return `${y0 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`
  })
}

const YEAR = monthRange('2025-07', 12) // the 12 complete months before ANCHOR

const of = (r: ReturnType<typeof proposeBudgets>, catIdStr: string) =>
  r.proposals.find((p) => p.categoryId === catIdStr)
const skippedAs = (r: ReturnType<typeof proposeBudgets>, catIdStr: string) =>
  r.skipped.find((s) => s.categoryId === catIdStr)?.reason

describe('proposeBudgets — monthly rhythm', () => {
  it('steady category → monthly default stating the same figure as the 6-month chip, annual = year total', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-03`, 'Store', 'Groceries', -100)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const gro = catId(v, 'Groceries')
    const p = of(r, gro)!
    expect(p.kind).toBe('monthly')
    expect(p.cadence).toBe('monthly')
    expect(p.mixed).toBe(false)
    expect(p.monthsWithSpend).toBe(12)
    const chip = scopeTrailingAvg(v, { id: 'probe', updatedAt: now(), categoryId: gro, amount: 0 }, 6, ANCHOR)!
    expect(p.monthly).toBe(Math.round(chip))
    expect(p.monthly).toBe(100)
    expect(p.annual).toBe(1200) // both periods carried, so the row can switch
    expect(p.median).toBeUndefined() // identical to the monthly amount → omitted
  })

  it('the partial anchor month never contributes', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      txn(v, '2026-07-02', 'Store', 'Groceries', -500) // anchor month only
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(of(r, catId(v, 'Groceries'))).toBeUndefined()
    expect(skippedAs(r, catId(v, 'Groceries'))).toBe('no-spend')
  })
})

describe('proposeBudgets — lumps on a monthly base default to annual', () => {
  it('small monthly charges + a yearly premium → annual default, mixed, both figures carried', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-05`, 'Insurer', 'Insurance', -23)
      txn(v, `${YEAR[9]}-10`, 'Insurer', 'Insurance', -2400) // premium inside the 6-mo window
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const p = of(r, catId(v, 'Insurance'))!
    expect(p.kind).toBe('annual')
    expect(p.cadence).toBe('yearly') // one spike month in twelve
    expect(p.mixed).toBe(true)
    expect(p.annual).toBe(12 * 23 + 2400)
    expect(p.monthly).toBe(Math.round((6 * 23 + 2400) / 6)) // the /mo switch shows the honest mean
    expect(p.median).toBe(23)
  })

  it('a premium OUTSIDE the 6-month window still defaults to annual — detection is by the 12-month mean', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-05`, 'Insurer', 'Insurance', -23)
      txn(v, `${YEAR[2]}-10`, 'Insurer', 'Insurance', -2400) // premium 10 months back
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const p = of(r, catId(v, 'Insurance'))!
    expect(p.kind).toBe('annual')
    expect(p.cadence).toBe('yearly')
    expect(p.mixed).toBe(true)
    expect(p.annual).toBe(12 * 23 + 2400)
    expect(p.monthly).toBe(23) // the /mo switch still shows the honest recent mean
  })

  it('quarterly top-ups on a monthly base read as quarterly lumps', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-05`, 'Broker', 'Groceries', -50)
      for (const i of [2, 5, 8, 11]) txn(v, `${YEAR[i]}-20`, 'Broker', 'Groceries', -600)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const p = of(r, catId(v, 'Groceries'))!
    expect(p.kind).toBe('annual')
    expect(p.cadence).toBe('quarterly')
    expect(p.mixed).toBe(true)
  })

  it('a lump needs a full year of complete months — under that, the row stays monthly', () => {
    const v = buildVault((v) => {
      const eight = monthRange('2025-11', 8)
      fillMonths(v, eight)
      for (const mk of eight) txn(v, `${mk}-05`, 'Insurer', 'Insurance', -23)
      txn(v, `${eight[6]}-10`, 'Insurer', 'Insurance', -2400)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const p = of(r, catId(v, 'Insurance'))!
    expect(p.kind).toBe('monthly')
    expect(p.annual).toBeNull() // and the /yr switch has nothing to offer
  })

  it('mean close to median stays monthly — no lump to flag', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-03`, 'Store', 'Groceries', -200)
      txn(v, `${YEAR[10]}-20`, 'Store', 'Groceries', -40) // mild wobble, ratio < 1.5
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(of(r, catId(v, 'Groceries'))!.kind).toBe('monthly')
  })
})

describe('proposeBudgets — lumpy cadences alone in a category', () => {
  it('quarterly payer → annual default, cadence stated, amount = 12-month total', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const i of [2, 5, 8, 11]) txn(v, `${YEAR[i]}-10`, 'Insurer', 'Insurance', -90)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const p = of(r, catId(v, 'Insurance'))!
    expect(p.kind).toBe('annual')
    expect(p.cadence).toBe('quarterly')
    expect(p.mixed).toBe(false)
    expect(p.annual).toBe(360)
    expect(proposalYear(ANCHOR)).toBe(2026)
  })

  it('twice-a-year → semiannual; a single yearly charge → yearly', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const i of [1, 7]) txn(v, `${YEAR[i]}-10`, 'Insurer', 'Insurance', -300)
      txn(v, `${YEAR[3]}-10`, 'Registrar', 'Taxes & fees', -120)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(of(r, catId(v, 'Insurance'))!.cadence).toBe('semiannual')
    expect(of(r, catId(v, 'Insurance'))!.annual).toBe(600)
    expect(of(r, catId(v, 'Taxes & fees'))!.cadence).toBe('yearly')
    expect(of(r, catId(v, 'Taxes & fees'))!.annual).toBe(120)
  })

  it('lumpy spend without a full year of complete months → irregular, never a guessed total', () => {
    const v = buildVault((v) => {
      const eight = monthRange('2025-11', 8)
      fillMonths(v, eight)
      txn(v, `${eight[1]}-10`, 'Insurer', 'Insurance', -90)
      txn(v, `${eight[4]}-10`, 'Insurer', 'Insurance', -90)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(r.basis).toBe('ok')
    expect(of(r, catId(v, 'Insurance'))).toBeUndefined()
    expect(skippedAs(r, catId(v, 'Insurance'))).toBe('irregular')
  })

  it('a recent consecutive burst is irregular, not a yearly budget', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const i of [8, 9, 10, 11]) txn(v, `${YEAR[i]}-10`, 'Gym', 'Health', -40)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(of(r, catId(v, 'Health'))).toBeUndefined()
    expect(skippedAs(r, catId(v, 'Health'))).toBe('irregular')
  })
})

describe('proposeBudgets — dedupe against existing budgets', () => {
  it('legacy budget → already-budgeted; an annual-only budget does not block a monthly proposal', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) {
        txn(v, `${mk}-03`, 'Store', 'Groceries', -100)
        txn(v, `${mk}-04`, 'Cafe', 'Dining out', -50)
      }
      const gro = catId(v, 'Groceries')
      const din = catId(v, 'Dining out')
      v.budgets.push({ id: 'b1', updatedAt: now(), categoryId: gro, amount: 120 })
      v.budgets.push({
        id: 'b2', updatedAt: now(), categoryId: din, amount: 700,
        scope: { kind: 'category-year', categoryId: din, year: 2026 },
      })
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(skippedAs(r, catId(v, 'Groceries'))).toBe('already-budgeted')
    expect(of(r, catId(v, 'Dining out'))!.kind).toBe('monthly')
  })

  it('an annual-default proposal dedupes against the same category-year', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const i of [2, 5, 8, 11]) txn(v, `${YEAR[i]}-10`, 'Insurer', 'Insurance', -90)
      const ins = catId(v, 'Insurance')
      v.budgets.push({
        id: 'b1', updatedAt: now(), categoryId: ins, amount: 400,
        scope: { kind: 'category-year', categoryId: ins, year: 2026 },
      })
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(skippedAs(r, catId(v, 'Insurance'))).toBe('already-budgeted')
  })
})

describe('proposeBudgets — basis and honesty', () => {
  it('empty vault → empty basis, no proposals; two complete months → thin, no proposals', () => {
    const empty = proposeBudgets(derive(buildVault()), ANCHOR)
    expect(empty.basis).toBe('empty')
    expect(empty.proposals).toEqual([])

    const v = buildVault((v) => {
      fillMonths(v, ['2026-05', '2026-06'])
      for (const mk of ['2026-05', '2026-06']) txn(v, `${mk}-03`, 'Store', 'Groceries', -100)
    })
    const thin = proposeBudgets(derive(v), ANCHOR)
    expect(thin.basis).toBe('thin')
    expect(thin.proposals).toEqual([])
  })

  it('no proposal ever carries a €0 default; income and transfers never appear', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-01`, 'Employer', 'Income', 3000)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    expect(r.proposals.every((p) => (p.kind === 'monthly' ? p.monthly! : p.annual!) > 0)).toBe(true)
    const inc = catId(v, 'Income')
    expect(of(r, inc)).toBeUndefined()
    expect(skippedAs(r, inc)).toBeUndefined()
  })

  it('typicalIncome mirrors typicalMonth().incomeMedian', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) txn(v, `${mk}-01`, 'Employer', 'Income', 3000)
    })
    const d = derive(v)
    expect(proposeBudgets(d, ANCHOR).typicalIncome).toBe(typicalMonth(d, ANCHOR).incomeMedian)
  })

  it('monthly defaults sort before annual ones, default amount desc within each', () => {
    const v = buildVault((v) => {
      fillMonths(v, YEAR)
      for (const mk of YEAR) {
        txn(v, `${mk}-03`, 'Store', 'Groceries', -100)
        txn(v, `${mk}-04`, 'Cafe', 'Dining out', -40)
      }
      for (const i of [2, 5, 8, 11]) txn(v, `${YEAR[i]}-10`, 'Insurer', 'Insurance', -500)
    })
    const r = proposeBudgets(derive(v), ANCHOR)
    const kinds = r.proposals.map((p) => p.kind)
    expect(kinds.indexOf('annual')).toBeGreaterThan(kinds.lastIndexOf('monthly'))
    const monthly = r.proposals.filter((p) => p.kind === 'monthly').map((p) => p.monthly!)
    expect(monthly).toEqual([...monthly].sort((a, b) => b - a))
  })
})
