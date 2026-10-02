import { describe, expect, it } from 'vitest'
import { budgetRollup } from '../../src/analytics/budgets'
import { emptyVault } from '../../src/model/seed'
import type { Budget, Transaction, Vault } from '../../src/model/types'

const MK = '2026-07'
const noProj = (spent: number) => spent

function vaultWith(budgets: Partial<Budget>[], txns: Partial<Transaction>[] = []): Vault {
  const v = emptyVault()
  return {
    ...v,
    budgets: budgets.map((b, i) => ({ id: `b${i}`, updatedAt: '2026-07-01T00:00:00.000Z', categoryId: 'ent', amount: 100, ...b }) as Budget),
    transactions: txns.map((t, i) => ({ id: `t${i}`, updatedAt: '2026-07-01T00:00:00.000Z', date: '2026-07-05', merchant: 'M', categoryId: 'ent', amount: -10, ...t }) as Transaction),
  }
}

// Each transaction is counted ONCE, however many budgets match it. Before this rule the
// roll-up summed per-budget spend, so any overlap landed in the total twice — including a
// pairing the app already shipped (a category budget beside that category's own recurring
// budget) and every multi-category group.
describe('budgetRollup · no double count', () => {
  it('a category budget and that category’s recurring budget count their shared charge once', () => {
    const v = vaultWith(
      [
        { categoryId: 'ent', amount: 100 },
        { categoryId: 'ent', amount: 60, scope: { kind: 'recurring', cadence: 'monthly', categoryId: 'ent' } },
      ],
      [
        { id: 'netflix', categoryId: 'ent', amount: -15, recurring: 'monthly' },
        { id: 'cinema', categoryId: 'ent', amount: -25 },
      ],
    )
    const r = budgetRollup(v, MK, 'month', noProj)
    // €40 of Entertainment exists. The recurring row also covers the €15, so the naive sum
    // (40 + 15) reported €55 of spend that never happened.
    expect(r.totalSpent).toBe(40)
    // The recurring budget is a sub-limit inside the category budget, not another €60 of plan.
    expect(r.totalBudget).toBe(100)
    expect(r.rows.find((x) => x.budgetId === 'b1')!.subLimit).toBe(true)
    // Each row still reports its own truth.
    expect(r.rows.find((x) => x.budgetId === 'b0')!.spent).toBe(40)
    expect(r.rows.find((x) => x.budgetId === 'b1')!.spent).toBe(15)
  })

  it('a group budget absorbs a member’s own budget instead of adding to it', () => {
    const v = vaultWith(
      [
        { categoryId: 'ent', amount: 500 },
        { categoryId: 'cat-transfers', amount: 800, name: 'Fun', scope: { kind: 'group', categoryIds: ['ent', 'din'] } },
      ],
      [
        { id: 'x1', categoryId: 'ent', amount: -300 },
        { id: 'x2', categoryId: 'din', amount: -200 },
      ],
    )
    const r = budgetRollup(v, MK, 'month', noProj)
    expect(r.totalSpent).toBe(500) // not 300 + 500
    expect(r.totalBudget).toBe(800) // Fun replaces Entertainment's €500 in the plan
    expect(r.rows.find((x) => x.name === 'Fun')!.subLimit).toBeUndefined()
    expect(r.adherencePct).toBe(63)
  })

  it('holds containment even in a month with no spend at all', () => {
    const r = budgetRollup(
      vaultWith([
        { categoryId: 'ent', amount: 500 },
        { categoryId: 'cat-transfers', amount: 800, name: 'Fun', scope: { kind: 'group', categoryIds: ['ent', 'din'] } },
      ]),
      MK,
      'month',
      noProj,
    )
    // Both transaction sets are empty, so only the CATEGORY test can see the nesting.
    expect(r.totalBudget).toBe(800)
    expect(r.totalSpent).toBe(0)
  })

  it('two groups sharing a category count spend once and report the ambiguous plan', () => {
    const v = vaultWith(
      [
        { categoryId: 'cat-transfers', amount: 400, name: 'A', scope: { kind: 'group', categoryIds: ['ent', 'din'] } },
        { categoryId: 'cat-transfers', amount: 500, name: 'B', scope: { kind: 'group', categoryIds: ['ent', 'trav'] } },
      ],
      [{ id: 'x1', categoryId: 'ent', amount: -100 }],
    )
    const r = budgetRollup(v, MK, 'month', noProj)
    expect(r.totalSpent).toBe(100) // the shared charge, once
    expect(r.totalBudget).toBe(900) // neither contains the other, so the plan is both
    expect(r.overlapCategoryIds).toEqual(['ent'])
  })

  it('an unspent budget is never mistaken for a sub-limit of everything', () => {
    // An empty transaction set is a subset of every other set. Left unguarded, a budget with
    // no spend yet would drop out of the plan total.
    const v = vaultWith(
      [{ categoryId: 'util', amount: 200 }, { categoryId: 'ent', amount: 100 }],
      [{ id: 'x1', categoryId: 'ent', amount: -10 }],
    )
    const r = budgetRollup(v, MK, 'month', noProj)
    expect(r.totalBudget).toBe(300)
    expect(r.rows.every((x) => !x.subLimit)).toBe(true)
  })

  it('the total does not depend on budget order (the merge sorts by id)', () => {
    const budgets: Partial<Budget>[] = [
      { categoryId: 'ent', amount: 500 },
      { categoryId: 'cat-transfers', amount: 800, name: 'Fun', scope: { kind: 'group', categoryIds: ['ent', 'din'] } },
      { categoryId: 'ent', amount: 60, scope: { kind: 'recurring', cadence: 'monthly', categoryId: 'ent' } },
    ]
    const txns: Partial<Transaction>[] = [
      { id: 'x1', categoryId: 'ent', amount: -300, recurring: 'monthly' },
      { id: 'x2', categoryId: 'din', amount: -200 },
    ]
    const fwd = budgetRollup(vaultWith(budgets, txns), MK, 'month', noProj)
    const rev = budgetRollup(vaultWith([...budgets].reverse(), txns), MK, 'month', noProj)
    expect(rev.totalBudget).toBe(fwd.totalBudget)
    expect(rev.totalSpent).toBe(fwd.totalSpent)
    expect(rev.memo).toEqual(fwd.memo)
    expect(new Set(rev.overlapCategoryIds)).toEqual(new Set(fwd.overlapCategoryIds))
  })

  it('a group with a coarser period is a memo line at the month horizon', () => {
    const r = budgetRollup(
      vaultWith([
        { categoryId: 'ent', amount: 100 },
        { categoryId: 'cat-transfers', amount: 4800, name: 'Fun', scope: { kind: 'group', categoryIds: ['ent', 'din'], period: 'year' } },
      ]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(100)
    expect(r.memo.longer).toBe(4800)
  })

  it('a group overlapping only a memo’d budget is still counted in full', () => {
    // The annual budget is not in the total, so there is nothing for the group to double.
    const r = budgetRollup(
      vaultWith([
        { categoryId: 'ins', amount: 2400, scope: { kind: 'category-period', categoryId: 'ent', period: 'year' } },
        { categoryId: 'cat-transfers', amount: 800, name: 'Fun', scope: { kind: 'group', categoryIds: ['ent', 'din'] } },
      ]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(800)
    expect(r.memo.longer).toBe(2400)
  })
})

describe('budgetRollup · horizons', () => {
  it('a monthly budget counts scaled at the quarter horizon; a quarterly one joins it', () => {
    const v = vaultWith(
      [
        { categoryId: 'groc', amount: 400 },
        { categoryId: 'ins', amount: 350, scope: { kind: 'category-period', categoryId: 'ins', period: 'quarter' } },
      ],
      [
        { id: 'g1', categoryId: 'groc', amount: -100, date: '2026-07-05' },
        { id: 'g2', categoryId: 'groc', amount: -120, date: '2026-08-05' }, // same quarter, other month
        { id: 'i1', categoryId: 'ins', amount: -340, date: '2026-09-01' },
      ],
    )
    const month = budgetRollup(v, MK, 'month', noProj)
    expect(month.totalBudget).toBe(400) // quarterly budget is a memo at the month horizon
    expect(month.memo.longer).toBe(350)
    expect(month.totalSpent).toBe(100)

    const quarter = budgetRollup(v, MK, 'quarter', noProj)
    expect(quarter.totalBudget).toBe(1550) // 400×3 + 350
    expect(quarter.totalSpent).toBe(560) // 100 + 120 + 340
    expect(quarter.memo.longer).toBe(0)
    expect(quarter.rows.find((x) => x.budgetId === 'b0')!.budget).toBe(1200)
  })

  it('equal coverage at a shared horizon: the finer-native budget is the sub-limit', () => {
    const v = vaultWith(
      [
        { categoryId: 'ins', amount: 120 }, // monthly base
        { categoryId: 'ins', amount: 350, scope: { kind: 'category-period', categoryId: 'ins', period: 'quarter' } },
      ],
      [{ id: 'i1', categoryId: 'ins', amount: -300, date: '2026-08-01' }],
    )
    const r = budgetRollup(v, MK, 'quarter', noProj)
    expect(r.totalSpent).toBe(300) // counted once
    expect(r.totalBudget).toBe(350) // the quarterly limit; the monthly ×3 is a sub-limit inside it
    expect(r.rows.find((x) => x.budgetId === 'b0')!.subLimit).toBe(true)
    expect(r.overlapCategoryIds).toEqual([])
  })

  // Codex review: the finer-native tie-break read EQUAL categories as equal coverage even when the
  // matchers differ, so a monthly base lost to its own recurring-only cover while that cover lost
  // to the base by strict txn subset — both sub-limits, and the plan total fell to €0.
  it('a monthly base and its yearly recurring cover never both become sub-limits', () => {
    const v = vaultWith(
      [
        { categoryId: 'ins', amount: 50 }, // monthly base, €600 at the year horizon
        { categoryId: 'ins', amount: 240, scope: { kind: 'recurring', cadence: 'yearly', categoryId: 'ins' } },
      ],
      [
        { id: 'policy', categoryId: 'ins', amount: -200, recurring: 'yearly', date: '2026-03-01' },
        { id: 'excess', categoryId: 'ins', amount: -30, date: '2026-05-01' },
      ],
    )
    const r = budgetRollup(v, MK, 'year', noProj)
    expect(r.rows.find((x) => x.budgetId === 'b1')!.subLimit).toBe(true) // recurring sits inside the base
    expect(r.rows.find((x) => x.budgetId === 'b0')!.subLimit).toBeUndefined()
    expect(r.totalBudget).toBe(600)
  })

  it('a strict container is never demoted by the finer-native tie-break', () => {
    // The monthly group strictly contains Insurance by category; with only Insurance spending the
    // txn sets are equal, which used to make the finer group a sub-limit too.
    const v = vaultWith(
      [
        { categoryId: 'ins', amount: 350, scope: { kind: 'category-period', categoryId: 'ins', period: 'quarter' } },
        { categoryId: 'cat-transfers', amount: 100, name: 'Cover', scope: { kind: 'group', categoryIds: ['ins', 'ent'] } },
      ],
      [{ id: 'i1', categoryId: 'ins', amount: -300, date: '2026-08-01' }],
    )
    const r = budgetRollup(v, MK, 'quarter', noProj)
    expect(r.rows.find((x) => x.budgetId === 'b0')!.subLimit).toBe(true)
    expect(r.rows.find((x) => x.budgetId === 'b1')!.subLimit).toBeUndefined()
    expect(r.totalBudget).toBe(300) // the group ×3
  })

  it('a cross-category recurring budget stays a memo overlay at every horizon', () => {
    const v = vaultWith([
      { categoryId: 'ent', amount: 100 },
      { categoryId: 'cat-transfers', amount: 310, scope: { kind: 'recurring', cadence: 'monthly' } },
    ])
    for (const hz of ['month', 'quarter', 'half', 'year'] as const) {
      expect(budgetRollup(v, MK, hz, noProj).memo.crossCategoryRecurring).toBe(310)
    }
  })

  it('a per-category yearly recurring budget counts only at the year horizon', () => {
    const v = vaultWith([{ categoryId: 'ins', amount: 240, scope: { kind: 'recurring', cadence: 'yearly', categoryId: 'ins' } }])
    expect(budgetRollup(v, MK, 'month', noProj).memo.longer).toBe(240)
    expect(budgetRollup(v, MK, 'half', noProj).memo.longer).toBe(240)
    const year = budgetRollup(v, MK, 'year', noProj)
    expect(year.memo.longer).toBe(0)
    expect(year.totalBudget).toBe(240)
  })
})

describe('budgetRollup', () => {
  it('sums plain monthly budgets', () => {
    const r = budgetRollup(vaultWith([{ categoryId: 'ent', amount: 100 }, { categoryId: 'groc', amount: 400 }]), MK, 'month', noProj)
    expect(r.totalBudget).toBe(500)
    expect(r.rows).toHaveLength(2)
  })

  // An annual budget is not this month's money. Adding it would overstate the plan by a year.
  it('keeps an annual budget out of the monthly total, as a memo', () => {
    const r = budgetRollup(
      vaultWith([{ categoryId: 'ent', amount: 100 }, { categoryId: 'ins', amount: 2400, scope: { kind: 'category-period', categoryId: 'ins', period: 'year' } }]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(100)
    expect(r.memo.longer).toBe(2400)
    expect(r.rows).toHaveLength(1)
  })

  it('keeps a per-trip budget out of the monthly total, as a memo', () => {
    const r = budgetRollup(
      vaultWith([{ categoryId: 'ent', amount: 100 }, { categoryId: 'trav', amount: 800, scope: { kind: 'tracking', trackingId: 'tr1' } }]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(100)
    expect(r.memo.perTrip).toBe(800)
  })

  // The one real trap: a Netflix charge is inside BOTH Entertainment-monthly and a
  // cross-category Recurring budget, so summing both double-counts it.
  it('keeps a cross-category recurring budget out — it overlaps the category rows', () => {
    const r = budgetRollup(
      vaultWith([{ categoryId: 'ent', amount: 100 }, { categoryId: 'ent', amount: 310, scope: { kind: 'recurring', cadence: 'monthly' } }]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(100)
    expect(r.memo.crossCategoryRecurring).toBe(310)
  })

  // A recurring budget that names ONE category does not overlap: it is a subset of that
  // category, and the category budget it would double with is a different record.
  it('counts a per-category monthly recurring budget, which does not overlap', () => {
    const r = budgetRollup(
      vaultWith([{ categoryId: 'ent', amount: 60, scope: { kind: 'recurring', cadence: 'monthly', categoryId: 'ent' } }]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(60)
    expect(r.memo.crossCategoryRecurring).toBe(0)
  })

  it('keeps a yearly recurring budget out of the month total — coarser native period', () => {
    const r = budgetRollup(
      vaultWith([{ categoryId: 'ins', amount: 240, scope: { kind: 'recurring', cadence: 'yearly', categoryId: 'ins' } }]),
      MK,
      'month',
      noProj,
    )
    expect(r.totalBudget).toBe(0)
    expect(r.memo.longer).toBe(240)
  })

  it('counts what is over and reports adherence', () => {
    const r = budgetRollup(
      vaultWith(
        [{ categoryId: 'ent', amount: 100 }, { categoryId: 'groc', amount: 100 }],
        [{ categoryId: 'ent', amount: -150 }, { categoryId: 'groc', amount: -50 }],
      ),
      MK,
      'month',
      noProj,
    )
    expect(r.totalSpent).toBe(200)
    expect(r.overCount).toBe(1)
    expect(r.adherencePct).toBe(100)
  })

  it('has no adherence percentage when nothing is budgeted — not 0%', () => {
    const r = budgetRollup(vaultWith([]), MK, 'month', noProj)
    expect(r.adherencePct).toBeNull()
    expect(r.totalBudget).toBe(0)
  })

  it('sorts rows by variance so the biggest overspend leads', () => {
    const r = budgetRollup(
      vaultWith(
        [{ categoryId: 'ent', amount: 100 }, { categoryId: 'groc', amount: 100 }],
        [{ categoryId: 'ent', amount: -20 }, { categoryId: 'groc', amount: -180 }],
      ),
      MK,
      'month',
      noProj,
    )
    expect(r.rows[0]!.categoryId).toBe('groc')
    expect(r.rows[0]!.delta).toBe(80)
  })
})
