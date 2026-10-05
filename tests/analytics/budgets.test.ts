import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow, uuidv7, now } from '../../src/model/clock'
import { acc, buildVault, catId, txn } from '../helpers/build'
import type { Tracking, Vault } from '../../src/model/types'
import {
  budgetAmountAt,
  budgetNativePeriod,
  budgetPeriodHistory,
  budgetRollup,
  budgetScopeLabel,
  budgetScopeSpent,
  budgetScopeTxns,
  budgetSpentAt,
  monthlyEquivalent,
  periodKeyBounds,
  periodWindow,
  recurringBreakdown,
  scopeTrailingAvg,
} from '../../src/analytics/budgets'
import { visibleVault } from '../../src/model/selectors'

beforeAll(() => setFixedNow('2026-07-12T00:00:00Z'))

function trip(v: Vault, name: string, from: string, to: string): Tracking {
  const t: Tracking = { id: uuidv7(), updatedAt: now(), name, kind: 'trip', dateFrom: from, dateTo: to }
  v.trackings.push(t)
  return t
}

describe('budgetScopeSpent', () => {
  it('legacy scope: one category, one month', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'A', 'Groceries', -50)
    txn(v, '2026-07-10', 'B', 'Groceries', -30)
    txn(v, '2026-06-30', 'C', 'Groceries', -999) // other month
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 200 }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(80)
    expect(budgetScopeLabel(v, b)).toBe('monthly')
  })

  it('category-period year scope: the calendar year containing the viewed month, evergreen', () => {
    const v = buildVault()
    txn(v, '2026-02-01', 'A', 'Shopping', -100)
    txn(v, '2026-11-01', 'B', 'Shopping', -200)
    txn(v, '2025-11-01', 'C', 'Shopping', -999) // other year
    const gid = catId(v, 'Shopping')
    const b = { id: 'b', updatedAt: now(), categoryId: gid, amount: 4000, scope: { kind: 'category-period' as const, categoryId: gid, period: 'year' as const } }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(300)
    // Evergreen: the SAME budget viewed inside 2025 measures 2025.
    expect(budgetScopeSpent(v, b, '2025-07')).toBe(999)
    expect(budgetScopeLabel(v, b)).toBe('annual')
  })

  it('category-period quarter scope: the calendar quarter containing the viewed month', () => {
    const v = buildVault()
    txn(v, '2026-07-05', 'A', 'Shopping', -100) // Q3
    txn(v, '2026-09-20', 'B', 'Shopping', -50) // Q3
    txn(v, '2026-06-30', 'C', 'Shopping', -999) // Q2
    const gid = catId(v, 'Shopping')
    const b = { id: 'b', updatedAt: now(), categoryId: gid, amount: 350, scope: { kind: 'category-period' as const, categoryId: gid, period: 'quarter' as const } }
    expect(budgetScopeSpent(v, b, '2026-08')).toBe(150) // any month of Q3 reads the quarter
    expect(budgetScopeSpent(v, b, '2026-04')).toBe(999) // Q2
    expect(budgetScopeLabel(v, b)).toBe('quarterly')
  })

  it('tracking scope: lifetime spend of the members', () => {
    const v = buildVault()
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300)
    txn(v, '2026-06-03', 'Food', 'Dining out', -120)
    txn(v, '2026-05-20', 'Outside', 'Shopping', -50) // out of window → not a member
    const b = { id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 1500, scope: { kind: 'tracking' as const, trackingId: t.id } }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(420)
    expect(budgetScopeLabel(v, b)).toBe('Poland · per-event')
  })

  it('every scope narrows through visibleVault when an account is hidden', () => {
    // budgets.ts takes `vault` and iterates it directly, so it is filtered purely by being
    // handed the projection — no edit to any of the four scopes.
    const v = buildVault()
    const live = acc(v, { name: 'Live' })
    const dead = acc(v, { name: 'Dead', hidden: true })
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300).accountId = live.id
    txn(v, '2026-06-03', 'Hotel B', 'Shopping', -100).accountId = dead.id
    txn(v, '2026-07-03', 'Shop', 'Groceries', -50).accountId = live.id
    txn(v, '2026-07-04', 'Shop B', 'Groceries', -20).accountId = dead.id
    const rec = txn(v, '2026-07-05', 'Netflix', 'Entertainment', -14)
    rec.accountId = dead.id
    rec.recurring = 'monthly'
    const vv = visibleVault(v)
    const gro = catId(v, 'Groceries')
    const shop = catId(v, 'Shopping')

    // legacy monthly
    expect(budgetScopeSpent(vv, { id: 'b', updatedAt: now(), categoryId: gro, amount: 200 }, '2026-07')).toBe(50)
    // category-period (year)
    expect(budgetScopeSpent(vv, { id: 'b', updatedAt: now(), categoryId: shop, amount: 4000, scope: { kind: 'category-period', categoryId: shop, period: 'year' } }, '2026-07')).toBe(300)
    // tracking — the sharp one: the assignment record survives, but members() goes inert
    expect(budgetScopeSpent(vv, { id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 1500, scope: { kind: 'tracking', trackingId: t.id } }, '2026-07')).toBe(300)
    // recurring
    expect(budgetScopeSpent(vv, { id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 100, scope: { kind: 'recurring', cadence: 'monthly' } }, '2026-07')).toBe(0)
    expect(recurringBreakdown(vv, 'monthly', '2026-07').reduce((n, r) => n + r.spent, 0)).toBe(0)
  })

  it('recurring scope: cross-category, this cadence, minus excluded categories', () => {
    const v = buildVault()
    const rec = (t: ReturnType<typeof txn>, c: 'monthly' | 'yearly') => (t.recurring = c)
    rec(txn(v, '2026-07-02', 'Netflix', 'Entertainment', -14), 'monthly')
    rec(txn(v, '2026-07-04', 'Internet', 'Utilities', -30), 'monthly')
    rec(txn(v, '2026-07-05', 'Rent', 'Housing', -980), 'monthly') // excluded below
    txn(v, '2026-07-06', 'Bread', 'Groceries', -10) // not recurring → ignored
    rec(txn(v, '2026-07-08', 'Domain', 'Shopping', -120), 'yearly') // wrong cadence for a monthly budget
    rec(txn(v, '2026-06-09', 'Netflix', 'Entertainment', -14), 'monthly') // other month

    const housing = catId(v, 'Housing')
    const b = { id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 70, scope: { kind: 'recurring' as const, cadence: 'monthly' as const, excludeCategoryIds: [housing] } }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(44) // 14 + 30; Housing excluded, yearly + other-month ignored
    expect(budgetScopeLabel(v, b)).toBe('monthly · recurring')

    const rows = recurringBreakdown(v, 'monthly', '2026-07', [housing])
    expect(rows).toEqual([
      { categoryId: catId(v, 'Utilities'), spent: 30 },
      { categoryId: catId(v, 'Entertainment'), spent: 14 },
    ])
    // At a coarser viewing horizon the breakdown spans the same window as the row's bar (Q3 =
    // Jul–Sep): August joins, June stays out. The month view is unchanged.
    rec(txn(v, '2026-08-02', 'Netflix', 'Entertainment', -14), 'monthly')
    expect(recurringBreakdown(v, 'monthly', '2026-07', [housing])).toEqual(rows)
    expect(recurringBreakdown(v, 'monthly', '2026-07', [housing], undefined, 'quarter')).toEqual([
      { categoryId: catId(v, 'Utilities'), spent: 30 },
      { categoryId: catId(v, 'Entertainment'), spent: 28 },
    ])
  })

  // #12c: a recurring scope with a categoryId targets that one category's recurring spend.
  it('recurring scope with a categoryId targets only that category', () => {
    const v = buildVault()
    const rec = (t: ReturnType<typeof txn>, c: 'monthly' | 'yearly') => (t.recurring = c)
    rec(txn(v, '2026-07-02', 'Netflix', 'Entertainment', -14), 'monthly')
    rec(txn(v, '2026-07-03', 'Spotify', 'Entertainment', -11), 'monthly')
    rec(txn(v, '2026-07-04', 'Internet', 'Utilities', -30), 'monthly') // other category → ignored
    rec(txn(v, '2026-07-08', 'Prime', 'Entertainment', -70), 'yearly') // wrong cadence → ignored
    const ent = catId(v, 'Entertainment')
    const b = { id: 'b', updatedAt: now(), categoryId: ent, amount: 40, scope: { kind: 'recurring' as const, cadence: 'monthly' as const, categoryId: ent } }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(25) // 14 + 11 only
  })

  it('a refund nets the budget spend; legacy and category-period agree, and both floor at 0', () => {
    const v = buildVault()
    txn(v, '2026-03-04', 'Doctor', 'Health', -120)
    txn(v, '2026-03-20', 'Reimbursement', 'Health', 74.59) // refund, same month/year
    const gid = catId(v, 'Health')
    const legacy = { id: 'l', updatedAt: now(), categoryId: gid, amount: 200 }
    const yearly = { id: 'y', updatedAt: now(), categoryId: gid, amount: 2000, scope: { kind: 'category-period' as const, categoryId: gid, period: 'year' as const } }
    expect(budgetScopeSpent(v, legacy, '2026-03')).toBeCloseTo(45.41, 2)
    expect(budgetScopeSpent(v, yearly, '2026-03')).toBeCloseTo(45.41, 2) // same netted total → readouts agree

    txn(v, '2026-03-25', 'Over-refund', 'Health', 200) // refunds now exceed spend
    expect(budgetScopeSpent(v, legacy, '2026-03')).toBe(0) // floored, never negative
  })

  it('group scope: several categories, one month', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'Bistro', 'Dining out', -40)
    txn(v, '2026-07-05', 'Cinema', 'Entertainment', -25)
    txn(v, '2026-07-06', 'Bread', 'Groceries', -10) // not a member
    txn(v, '2026-06-30', 'Bistro', 'Dining out', -999) // other month
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 200, name: 'Fun',
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')] },
    }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(65)
    expect(budgetScopeLabel(v, b)).toBe('monthly · 2 categories')
  })

  it('group scope with a period: the calendar year of the members, evergreen', () => {
    const v = buildVault()
    txn(v, '2026-02-01', 'Bistro', 'Dining out', -40)
    txn(v, '2026-11-01', 'Cinema', 'Entertainment', -25)
    txn(v, '2025-11-01', 'Cinema', 'Entertainment', -999) // other year
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 2400, name: 'Fun',
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')], period: 'year' as const },
    }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(65)
    expect(budgetScopeSpent(v, b, '2025-07')).toBe(999) // evergreen: 2025's window
    expect(budgetScopeLabel(v, b)).toBe('annual · 2 categories')
  })

  it('a group nets refunds across the whole group and floors once, not per category', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'Bistro', 'Dining out', -40)
    txn(v, '2026-07-04', 'Refund', 'Entertainment', 60) // over-refund in ONE member
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 200,
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')] },
    }
    // −40 + 60 nets to a credit for the group as a whole, so the floor applies once: 0, not 40.
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(0)
  })

  it('a group member deleted out from under it contributes 0 and does not throw', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'Bistro', 'Dining out', -40)
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 200,
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), 'cat-gone'] },
    }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(40)
  })

  it('a group narrows through visibleVault like every other scope', () => {
    const v = buildVault()
    const live = acc(v, { name: 'Live' })
    const dead = acc(v, { name: 'Dead', hidden: true })
    txn(v, '2026-07-03', 'Bistro', 'Dining out', -40).accountId = live.id
    txn(v, '2026-07-04', 'Cinema', 'Entertainment', -25).accountId = dead.id
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 200,
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')] },
    }
    expect(budgetScopeSpent(visibleVault(v), b, '2026-07')).toBe(40)
  })
})

describe('budgetScopeTxns', () => {
  it('agrees with budgetScopeSpent for every scope kind', () => {
    const v = buildVault()
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300)
    txn(v, '2026-07-03', 'Shop', 'Groceries', -50)
    const rec = txn(v, '2026-07-05', 'Netflix', 'Entertainment', -14)
    rec.recurring = 'monthly'
    txn(v, '2026-07-06', 'Bistro', 'Dining out', -40)
    const gro = catId(v, 'Groceries')
    const ent = catId(v, 'Entertainment')

    const budgets = [
      { id: '1', updatedAt: now(), categoryId: gro, amount: 200 },
      { id: '2', updatedAt: now(), categoryId: gro, amount: 200, scope: { kind: 'category-period' as const, categoryId: gro, period: 'year' as const } },
      { id: '3', updatedAt: now(), categoryId: 'cat-transfers', amount: 70, scope: { kind: 'recurring' as const, cadence: 'monthly' as const } },
      { id: '4', updatedAt: now(), categoryId: ent, amount: 70, scope: { kind: 'recurring' as const, cadence: 'monthly' as const, categoryId: ent } },
      { id: '5', updatedAt: now(), categoryId: 'cat-transfers', amount: 900, scope: { kind: 'tracking' as const, trackingId: t.id } },
      { id: '6', updatedAt: now(), categoryId: 'cat-transfers', amount: 200, scope: { kind: 'group' as const, categoryIds: [ent, catId(v, 'Dining out')] } },
    ]
    const byId = new Map(v.transactions.map((x) => [x.id, x]))
    for (const b of budgets) {
      const viaSet = [...budgetScopeTxns(v, b, '2026-07')].reduce((s, id) => s + -byId.get(id)!.amount, 0)
      expect(Math.max(0, Math.round(viaSet * 100) / 100)).toBe(budgetScopeSpent(v, b, '2026-07'))
    }
  })
})

describe('budgetPeriodHistory', () => {
  it('returns one entry per month for a monthly scope, oldest first', () => {
    const v = buildVault()
    txn(v, '2026-05-03', 'A', 'Groceries', -100)
    txn(v, '2026-07-03', 'B', 'Groceries', -50)
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 200 }
    const h = budgetPeriodHistory(v, b, '2026-07', 3)
    expect(h.map((p) => [p.key, p.spent])).toEqual([['2026-05', 100], ['2026-06', 0], ['2026-07', 50]])
    expect(h.map((p) => p.label)).toEqual(['May', 'Jun', 'Jul'])
    expect(h.every((p) => p.budget === 200)).toBe(true)
  })

  it('returns one entry per YEAR for an annual scope', () => {
    const v = buildVault()
    txn(v, '2025-04-03', 'A', 'Shopping', -300)
    txn(v, '2026-04-03', 'B', 'Shopping', -400)
    const gid = catId(v, 'Shopping')
    const b = { id: 'b', updatedAt: now(), categoryId: gid, amount: 4000, scope: { kind: 'category-period' as const, categoryId: gid, period: 'year' as const } }
    expect(budgetPeriodHistory(v, b, '2026-07', 2).map((p) => [p.key, p.spent])).toEqual([['2025', 300], ['2026', 400]])
  })

  it('walks a group-with-period across years too', () => {
    const v = buildVault()
    txn(v, '2025-04-03', 'A', 'Dining out', -300)
    txn(v, '2026-04-03', 'B', 'Entertainment', -400)
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 4000,
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')], period: 'year' as const },
    }
    expect(budgetPeriodHistory(v, b, '2026-07', 2).map((p) => [p.key, p.spent])).toEqual([['2025', 300], ['2026', 400]])
  })

  it('returns one entry per QUARTER for a quarterly scope, keyed for the drill', () => {
    const v = buildVault()
    txn(v, '2026-02-10', 'A', 'Shopping', -120) // Q1
    txn(v, '2026-05-10', 'B', 'Shopping', -80) // Q2
    const gid = catId(v, 'Shopping')
    const b = { id: 'b', updatedAt: now(), categoryId: gid, amount: 150, scope: { kind: 'category-period' as const, categoryId: gid, period: 'quarter' as const } }
    const h = budgetPeriodHistory(v, b, '2026-07', 3)
    expect(h.map((p) => [p.key, p.spent])).toEqual([['2026-Q1', 120], ['2026-Q2', 80], ['2026-Q3', 0]])
    expect(h.map((p) => p.label)).toEqual(['Q1 2026', 'Q2 2026', 'Q3 2026'])
  })

  it('a per-trip budget has one lifetime span, so there is no series to draw', () => {
    const v = buildVault()
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    const b = { id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 900, scope: { kind: 'tracking' as const, trackingId: t.id } }
    expect(budgetPeriodHistory(v, b, '2026-07', 6)).toEqual([])
  })
})

describe('scopeTrailingAvg', () => {
  it('averages complete months only — never the partial current one', () => {
    const v = buildVault()
    txn(v, '2026-05-03', 'A', 'Groceries', -100)
    txn(v, '2026-06-03', 'B', 'Groceries', -200)
    txn(v, '2026-07-03', 'C', 'Groceries', -9999) // current month: must not drag the mean
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 200 }
    expect(scopeTrailingAvg(v, b, 3, '2026-07')).toBe(150)
  })

  it('skips months with no data instead of averaging them as €0', () => {
    const v = buildVault()
    txn(v, '2026-06-03', 'B', 'Groceries', -200)
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 200 }
    // One month of history: the answer is 200, not 200/6.
    expect(scopeTrailingAvg(v, b, 6, '2026-07')).toBe(200)
  })

  it('is null with no history at all, so nothing suggests €0', () => {
    const v = buildVault()
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 200 }
    expect(scopeTrailingAvg(v, b, 6, '2026-07')).toBeNull()
  })

  // A vault WITH history where this scope never cost anything: the mean is a true €0, and a €0
  // budget suggestion is worse than saying there is nothing to go on.
  it('is null when the scope has never cost anything, even in a vault with data', () => {
    const v = buildVault()
    txn(v, '2026-06-03', 'Bread', 'Groceries', -200)
    const health = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Health'), amount: 100 }
    expect(scopeTrailingAvg(v, health, 6, '2026-07')).toBeNull()
  })

  it('averages COMPLETE NATIVE WINDOWS for a coarser period, and is null for per-trip', () => {
    const v = buildVault()
    txn(v, '2026-01-10', 'A', 'Shopping', -120) // Q1 — complete before Q3
    txn(v, '2026-05-10', 'B', 'Shopping', -80) // Q2 — complete before Q3
    const gid = catId(v, 'Shopping')
    const quarterly = { id: 'b', updatedAt: now(), categoryId: gid, amount: 150, scope: { kind: 'category-period' as const, categoryId: gid, period: 'quarter' as const } }
    expect(scopeTrailingAvg(v, quarterly, 3, '2026-07')).toBe(100) // mean of Q1 (120) and Q2 (80)
    // An annual scope with data only inside the CURRENT year has no complete prior year to average.
    const annual = { id: 'y', updatedAt: now(), categoryId: gid, amount: 4000, scope: { kind: 'category-period' as const, categoryId: gid, period: 'year' as const } }
    expect(scopeTrailingAvg(v, annual, 6, '2026-07')).toBeNull()
    const trip1 = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    const perTrip = { id: 'c', updatedAt: now(), categoryId: 'cat-transfers', amount: 900, scope: { kind: 'tracking' as const, trackingId: trip1.id } }
    expect(scopeTrailingAvg(v, perTrip, 6, '2026-07')).toBeNull()
  })

  // CodeRabbit review: one transaction anywhere in a coarse window marked it covered, so a year the
  // vault holds only two months of was averaged as a full year — about a sixth of the real figure.
  it('skips a coarse window that starts before the vault’s first month', () => {
    const v = buildVault()
    const gid = catId(v, 'Shopping')
    txn(v, '2025-11-10', 'A', 'Shopping', -100) // the vault starts mid-Q4 / late in 2025
    txn(v, '2025-12-10', 'B', 'Shopping', -100)
    txn(v, '2026-02-10', 'C', 'Shopping', -300) // Q1 2026, fully inside the vault's span
    txn(v, '2026-04-10', 'D', 'Groceries', -50) // Q2 2026 is covered; Shopping really cost €0 in it
    const annual = { id: 'y', updatedAt: now(), categoryId: gid, amount: 4000, scope: { kind: 'category-period' as const, categoryId: gid, period: 'year' as const } }
    expect(scopeTrailingAvg(v, annual, 3, '2026-07')).toBeNull() // 2025 is not a complete year here
    const quarterly = { id: 'q', updatedAt: now(), categoryId: gid, amount: 300, scope: { kind: 'category-period' as const, categoryId: gid, period: 'quarter' as const } }
    // Q1 2026 (300) and Q2 2026 (0) count; Q4 2025 began in October, before the vault did.
    expect(scopeTrailingAvg(v, quarterly, 3, '2026-07')).toBe(150)
  })

  it('averages a group by its own scope, not by any one member', () => {
    const v = buildVault()
    txn(v, '2026-06-03', 'A', 'Dining out', -100)
    txn(v, '2026-06-04', 'B', 'Entertainment', -50)
    const b = {
      id: 'b', updatedAt: now(), categoryId: 'cat-transfers', amount: 200,
      scope: { kind: 'group' as const, categoryIds: [catId(v, 'Dining out'), catId(v, 'Entertainment')] },
    }
    expect(scopeTrailingAvg(v, b, 3, '2026-07')).toBe(150)
  })
})

describe('multi-currency (FX chain, not 1:1)', () => {
  const withRate = (v: Vault) =>
    v.fxOverrides.push({ id: 'o-uah', updatedAt: now(), from: 'UAH', to: 'EUR', date: '2026-01-01', rate: 0.022 })

  it('a UAH row converts to base instead of counting hryvnias as euros', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Privat', currency: 'UAH' })
    const t = txn(v, '2026-07-03', 'Silpo', 'Groceries', -2400)
    t.accountId = a.id
    withRate(v)
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 400 }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(52.8) // 2400 × 0.022, not 2400
  })

  it('a foreign row with no resolvable rate is excluded honestly', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Privat', currency: 'UAH' })
    const t = txn(v, '2026-07-03', 'Silpo', 'Groceries', -2400)
    t.accountId = a.id
    txn(v, '2026-07-05', 'Carrefour', 'Groceries', -60) // base-currency row
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 400 }
    expect(budgetScopeSpent(v, b, '2026-07')).toBe(60) // never 2460
  })

  it('the roll-up total converts the union the same way', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Privat', currency: 'UAH' })
    const t = txn(v, '2026-07-03', 'Silpo', 'Groceries', -1000)
    t.accountId = a.id
    txn(v, '2026-07-05', 'Carrefour', 'Groceries', -40)
    withRate(v)
    v.budgets.push({ id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 400 })
    const roll = budgetRollup(v, '2026-07', 'month', (s) => s)
    expect(roll.totalSpent).toBe(62) // 1000 × 0.022 + 40
  })
})

describe('periodWindow · periodKeyBounds', () => {
  it('windows are calendar-aligned with inclusive day bounds', () => {
    expect(periodWindow('month', '2026-07')).toMatchObject({ fromMk: '2026-07', toMk: '2026-07', from: '2026-07-01', to: '2026-07-31', key: '2026-07' })
    expect(periodWindow('quarter', '2026-08')).toMatchObject({ fromMk: '2026-07', toMk: '2026-09', from: '2026-07-01', to: '2026-09-30', key: '2026-Q3', label: 'Q3 2026' })
    expect(periodWindow('half', '2026-06')).toMatchObject({ fromMk: '2026-01', toMk: '2026-06', from: '2026-01-01', to: '2026-06-30', key: '2026-H1', label: 'H1 2026' })
    expect(periodWindow('half', '2026-07')).toMatchObject({ fromMk: '2026-07', toMk: '2026-12', key: '2026-H2' })
    expect(periodWindow('year', '2026-07')).toMatchObject({ fromMk: '2026-01', toMk: '2026-12', from: '2026-01-01', to: '2026-12-31', key: '2026', label: '2026' })
    // Leap February closes on the 29th.
    expect(periodWindow('month', '2024-02').to).toBe('2024-02-29')
  })

  it('periodKeyBounds inverts every key shape', () => {
    expect(periodKeyBounds('2026-07')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(periodKeyBounds('2026-Q3')).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(periodKeyBounds('2026-H2')).toEqual({ from: '2026-07-01', to: '2026-12-31' })
    expect(periodKeyBounds('2026')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })
})

describe('budgetNativePeriod · budgetSpentAt · budgetAmountAt · monthlyEquivalent', () => {
  const base = { id: 'b', updatedAt: '', categoryId: 'cat-groceries', amount: 2400 }

  it('native period per scope; tracking has none', () => {
    expect(budgetNativePeriod(base)).toBe('month')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'category-period', categoryId: 'x', period: 'quarter' } })).toBe('quarter')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'group', categoryIds: ['a'], period: 'half' } })).toBe('half')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'group', categoryIds: ['a'] } })).toBe('month')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'recurring', cadence: 'yearly' } })).toBe('year')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'recurring', cadence: 'monthly' } })).toBe('month')
    expect(budgetNativePeriod({ ...base, scope: { kind: 'tracking', trackingId: 't' } })).toBeNull()
  })

  it('a monthly budget reads at a coarser horizon: spend summed, amount scaled', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'A', 'Groceries', -50)
    txn(v, '2026-08-10', 'B', 'Groceries', -30)
    txn(v, '2026-06-30', 'C', 'Groceries', -999) // Q2 — outside Q3
    const b = { id: 'b', updatedAt: now(), categoryId: catId(v, 'Groceries'), amount: 400 }
    expect(budgetSpentAt(v, b, 'quarter', '2026-07')).toBe(80)
    expect(budgetAmountAt(b, 'quarter')).toBe(1200)
    expect(budgetAmountAt(b, 'year')).toBe(4800)
    // At its own native horizon nothing changes.
    expect(budgetSpentAt(v, b, 'month', '2026-07')).toBe(50)
    expect(budgetAmountAt(b, 'month')).toBe(400)
  })

  it('monthlyEquivalent is amount/months-of-period for coarser natives, null otherwise or at €0', () => {
    const annual = { ...base, scope: { kind: 'category-period' as const, categoryId: 'cat-groceries', period: 'year' as const } }
    expect(monthlyEquivalent(annual)).toBe(200)
    const quarterly = { ...base, amount: 300, scope: { kind: 'category-period' as const, categoryId: 'cat-groceries', period: 'quarter' as const } }
    expect(monthlyEquivalent(quarterly)).toBe(100)
    expect(monthlyEquivalent({ ...annual, amount: 0 })).toBeNull()
    expect(monthlyEquivalent(base)).toBeNull()
  })
})
