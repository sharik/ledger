// Budget scope arithmetic (ANALYTICS §6.2, Phase F). A budget's `spent` depends on
// its scope: legacy = one month of a category; category-year = a full calendar
// year of a category; tracking = the lifetime spend of a tracking's members.
// Always derived, never stored.
import type { Budget, MonthKey, Transaction, Vault } from '../model/types'
import { budgetCategoryIds } from '../model/types'
import { addMonths, round2, vaultOnlyBook } from '../model/selectors'
import { members } from '../model/trackings'
import { rowConverter, type RateBook } from '../import/fx'

// Signed netting: a refund (positive) reduces the budget's spend, matching the
// Income/Refund/Transfer model in selectors.derive(). Callers floor the total at 0.
const expense = (amount: number): number => -amount

export interface ScopeInfo {
  spent: number
  budget: number
  periodLabel: string // e.g. 'Jul' · '2026' · trip name
}

/**
 * The test a transaction must pass to be charged against this budget in the viewed period.
 *
 * One matcher for every scope, so `budgetScopeSpent` and `budgetScopeTxns` cannot drift — and
 * so the roll-up can ask *which* transactions a budget covers rather than only *how much*.
 * That is what lets it count a transaction two budgets both match exactly once.
 */
export function budgetMatcher(vault: Vault, budget: Budget, mk: MonthKey): (t: Transaction) => boolean {
  const scope = budget.scope
  if (!scope) {
    // legacy: this category, this month
    const cat = budget.categoryId
    return (t) => t.categoryId === cat && t.date.slice(0, 7) === mk
  }
  if (scope.kind === 'category-year') {
    const yr = String(scope.year)
    const cat = scope.categoryId
    return (t) => t.categoryId === cat && t.date.slice(0, 4) === yr
  }
  if (scope.kind === 'recurring') {
    // Recurring spend of this cadence. When `categoryId` is set, only that category
    // (#12c); otherwise cross-category minus the excluded categories.
    const excl = new Set(scope.excludeCategoryIds ?? [])
    const period = scope.cadence === 'yearly' ? mk.slice(0, 4) : mk
    const n = period.length
    const only = scope.categoryId
    return (t) =>
      t.recurring === scope.cadence &&
      t.date.slice(0, n) === period &&
      (only ? t.categoryId === only : !excl.has(t.categoryId))
  }
  if (scope.kind === 'group') {
    // Several categories, one period. A transaction has exactly one category, so a group is a
    // partition of its members' spend — it can never double-count against itself.
    const ids = new Set(scope.categoryIds)
    const period = scope.year != null ? String(scope.year) : mk
    const n = period.length
    return (t) => ids.has(t.categoryId) && t.date.slice(0, n) === period
  }
  // tracking scope: lifetime spend of the tracking's members
  const mem = members(scope.trackingId, vault)
  return (t) => mem.has(t.id)
}

/** Spend charged against a budget for the viewed month, respecting its scope.
 *  Summed in BASE currency (same FX chain as derive(): convert per row at its
 *  date; a row with no resolvable rate is excluded honestly, never counted 1:1). */
export function budgetScopeSpent(vault: Vault, budget: Budget, mk: MonthKey, rates?: RateBook): number {
  const match = budgetMatcher(vault, budget, mk)
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  let sum = 0
  for (const t of vault.transactions) {
    if (!match(t)) continue
    const amt = conv(t)
    if (amt !== null) sum += expense(amt)
  }
  return Math.max(0, round2(sum))
}

/** The ids of the transactions charged against a budget — the roll-up's dedup key. */
export function budgetScopeTxns(vault: Vault, budget: Budget, mk: MonthKey): Set<string> {
  const match = budgetMatcher(vault, budget, mk)
  const out = new Set<string>()
  for (const t of vault.transactions) if (match(t)) out.add(t.id)
  return out
}

/** Per-category recurring spend for one cadence in the viewed period — the breakdown rows
 *  under a recurring budget. Excludes `excludeIds`; ordered by spend descending. */
export function recurringBreakdown(
  vault: Vault,
  cadence: 'monthly' | 'yearly',
  mk: MonthKey,
  excludeIds: string[] = [],
  rates?: RateBook,
): { categoryId: string; spent: number }[] {
  const excl = new Set(excludeIds)
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  const period = cadence === 'yearly' ? mk.slice(0, 4) : mk
  const n = period.length
  const byCat = new Map<string, number>()
  for (const t of vault.transactions) {
    if (t.recurring !== cadence || excl.has(t.categoryId) || t.date.slice(0, n) !== period) continue
    const amt = conv(t)
    if (amt === null) continue
    const e = expense(amt)
    if (e) byCat.set(t.categoryId, (byCat.get(t.categoryId) ?? 0) + e)
  }
  return [...byCat.entries()]
    .map(([categoryId, spent]) => ({ categoryId, spent: Math.max(0, round2(spent)) }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent)
}

/** A human label for a budget's scope period, for the row caption. */
export function budgetScopeLabel(vault: Vault, budget: Budget): string {
  const scope = budget.scope
  if (!scope) return 'monthly'
  if (scope.kind === 'category-year') return `${scope.year} · annual`
  if (scope.kind === 'recurring') return scope.cadence === 'yearly' ? 'annual · recurring' : 'monthly · recurring'
  if (scope.kind === 'group') {
    const n = scope.categoryIds.length
    return scope.year != null ? `${scope.year} · annual · ${n} categories` : `monthly · ${n} categories`
  }
  const tr = vault.trackings.find((t) => t.id === scope.trackingId)
  return tr ? `${tr.name} · per-event` : 'per-event'
}

/** Does this budget measure one month at a time (so it has a monthly history and a pace)? */
export function isMonthlyScope(budget: Budget): boolean {
  const s = budget.scope
  if (!s) return true
  if (s.kind === 'recurring') return s.cadence === 'monthly'
  if (s.kind === 'group') return s.year == null
  return false
}

export interface PeriodSpend {
  /** MonthKey or year string — also the drill period. */
  key: string
  /** 'Jul' · '2025'. */
  label: string
  spent: number
  budget: number
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * What this budget's own scope cost over the last `periods`, ending at `endMk` — months for a
 * monthly scope, calendar years for an annual one. Measured THROUGH `budgetScopeSpent`, so the
 * history and the row's bar are produced by the same arithmetic and cannot disagree.
 *
 * A `tracking` budget covers one lifetime span, not a series, so it returns `[]` — the caller
 * says so rather than drawing a trend through a single point.
 */
export function budgetPeriodHistory(
  vault: Vault,
  budget: Budget,
  endMk: MonthKey,
  periods: number,
  rates?: RateBook,
): PeriodSpend[] {
  const scope = budget.scope
  if (scope?.kind === 'tracking') return []
  const out: PeriodSpend[] = []
  if (isMonthlyScope(budget)) {
    for (let i = periods - 1; i >= 0; i--) {
      const mk = addMonths(endMk, -i)
      out.push({
        key: mk,
        label: MON[Number(mk.slice(5, 7)) - 1]!,
        spent: budgetScopeSpent(vault, budget, mk, rates),
        budget: budget.amount,
      })
    }
    return out
  }
  // Annual scope: re-ask the same budget about each year by moving its `year`.
  const endYear = Number(endMk.slice(0, 4))
  for (let i = periods - 1; i >= 0; i--) {
    const year = endYear - i
    const shifted: Budget =
      scope?.kind === 'category-year'
        ? { ...budget, scope: { ...scope, year } }
        : scope?.kind === 'group'
          ? { ...budget, scope: { ...scope, year } }
          : budget
    out.push({
      key: String(year),
      label: String(year),
      spent: budgetScopeSpent(vault, shifted, `${year}-01`, rates),
      budget: budget.amount,
    })
  }
  return out
}

/**
 * "What should this budget be?" (QUESTIONARY Q120) — the mean of what this exact scope actually
 * cost over the last `months` COMPLETE months. The current, partial month is never averaged in.
 *
 * Months where the VAULT has no data at all are skipped rather than counted as €0, matching
 * `trailingAvg` in selectors: a young vault's average must reflect the months it really has. A
 * month the vault covers in which this scope simply cost nothing DOES count — that is a real €0.
 *
 * `null` when there is nothing to average from: no covered months, or this scope has never cost
 * anything across the window. Both would otherwise produce a €0 "suggestion", and proposing a €0
 * budget is worse than admitting there is nothing to go on. Also `null` for a scope with no
 * monthly rhythm (annual, per-trip), where a monthly mean would be meaningless.
 */
export function scopeTrailingAvg(
  vault: Vault,
  budget: Budget,
  months: number,
  currentMk: MonthKey,
  rates?: RateBook,
): number | null {
  if (!isMonthlyScope(budget)) return null
  let sum = 0
  let n = 0
  for (let i = 1; i <= months; i++) {
    const mk = addMonths(currentMk, -i)
    if (!vault.transactions.some((t) => t.date.slice(0, 7) === mk)) continue
    sum += budgetScopeSpent(vault, budget, mk, rates)
    n++
  }
  return n === 0 || sum === 0 ? null : round2(sum / n)
}

export interface RollupRow {
  budgetId: string
  categoryId: string
  /** A multi-category budget's own name — it has no single category to borrow one from.
   *  Absent ⇒ label from `categoryId` as before. */
  name?: string
  spent: number
  budget: number
  /** spent − budget. Positive = over. */
  delta: number
  /** True when another counted budget contains this one, so its amount is a sub-limit
   *  inside that budget and is NOT added again into `totalBudget`. */
  subLimit?: boolean
}

export interface BudgetRollup {
  totalBudget: number
  totalSpent: number
  totalProj: number
  rows: RollupRow[]
  overCount: number
  /** spent ÷ budget as a percentage, or null when nothing is budgeted for this month. */
  adherencePct: number | null
  /**
   * Budgets deliberately left OUT of the total, and why. Shown as memo lines — a figure
   * that quietly swallowed them would be wrong in two different ways (see below).
   */
  memo: { annual: number; perTrip: number; crossCategoryRecurring: number }
  /**
   * Categories covered by two counted budgets where NEITHER contains the other (e.g. two
   * groups both including Entertainment). Spend is still counted once, but the *plan* is
   * genuinely ambiguous — the user set two limits over the same money — so the caller names
   * these rather than the roll-up picking a winner.
   */
  overlapCategoryIds: string[]
}

/** True when `a` is a strict subset of `b`. */
function strictSubset<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size >= b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * Every budget that covers the viewed MONTH, added up (QUESTIONARY Q122–124).
 *
 * Two rules carry the whole feature, and they are why this is a selector rather than a
 * `reduce` at the call site.
 *
 * **1. A different PERIOD cannot be summed into this month.** `category-year`, `tracking` and
 * group-with-a-year budgets cover a different span; a €2,400 annual budget is not €2,400 of
 * this month. A yearly or cross-category `recurring` budget is held out too — it is an overlay
 * across the category rows rather than a period of its own. All become memo lines.
 *
 * **2. EACH TRANSACTION IS COUNTED ONCE.** What remains can overlap: a "Fun" group over Dining
 * out + Entertainment while Dining out also has its own budget, or — and this shipped broken —
 * a category budget beside that same category's per-category recurring budget (#12c), whose
 * charges are a subset of the category's. Summing the rows counted that money twice. So the
 * spend side is the net over the UNION of the matched transaction sets, and the plan side drops
 * any budget contained in another: a contained budget is a sub-limit *inside* its container, not
 * extra plan, so "Fun €800" replaces "Dining out €500" in the total while the Dining out row
 * keeps its own bar and its own percentage.
 *
 * Containment is tested two ways because neither alone is enough: by CATEGORY set, which is
 * stable even in a month with no spend at all, and by TRANSACTION set, which catches a narrower
 * matcher over the same categories (the recurring-inside-category case). Both tests are pairwise
 * and existential, so the outcome never depends on `vault.budgets` order — which matters,
 * because the merge sorts collections by id.
 */
export function budgetRollup(
  vault: Vault,
  mk: MonthKey,
  project: (spent: number) => number,
  rates?: RateBook,
): BudgetRollup {
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  const memo = { annual: 0, perTrip: 0, crossCategoryRecurring: 0 }
  const counted: Budget[] = []

  for (const b of vault.budgets) {
    const scope = b.scope
    if (scope?.kind === 'category-year' || (scope?.kind === 'group' && scope.year != null)) {
      memo.annual += b.amount
      continue
    }
    if (scope?.kind === 'tracking') {
      memo.perTrip += b.amount
      continue
    }
    if (scope?.kind === 'recurring' && (scope.cadence === 'yearly' || !scope.categoryId)) {
      memo.crossCategoryRecurring += b.amount
      continue
    }
    counted.push(b)
  }

  const txns = counted.map((b) => budgetScopeTxns(vault, b, mk))
  const cats = counted.map((b) => new Set(budgetCategoryIds(b)))
  const byId = new Map(vault.transactions.map((t) => [t.id, t]))

  const rows: RollupRow[] = counted.map((b, i) => {
    let sum = 0
    for (const id of txns[i]!) {
      const amt = conv(byId.get(id)!)
      if (amt !== null) sum += expense(amt)
    }
    const spent = Math.max(0, round2(sum))
    const scope = b.scope
    const subLimit = counted.some(
      (_, j) =>
        j !== i &&
        (strictSubset(cats[i]!, cats[j]!) || (txns[i]!.size > 0 && strictSubset(txns[i]!, txns[j]!))),
    )
    return {
      budgetId: b.id,
      categoryId: scope?.kind === 'recurring' ? (scope.categoryId ?? b.categoryId) : b.categoryId,
      name: b.name,
      spent,
      budget: b.amount,
      delta: round2(spent - b.amount),
      subLimit: subLimit || undefined,
    }
  })

  // Spend: the union, so money two budgets both cover lands in the total once. Floored once
  // over the whole set rather than per row — with overlap, "the sum of the rows" is not a
  // number that means anything, so there is no per-row total to agree with.
  const union = new Set<string>()
  for (const set of txns) for (const id of set) union.add(id)
  let spentSum = 0
  for (const id of union) {
    const amt = conv(byId.get(id)!)
    if (amt !== null) spentSum += expense(amt)
  }
  const totalSpent = Math.max(0, round2(spentSum))

  // Plan: outermost budgets only. A sub-limit is already inside its container's amount.
  const totalBudget = round2(rows.filter((r) => !r.subLimit).reduce((s, r) => s + r.budget, 0))

  // Ambiguous plan: two counted budgets share a category and neither contains the other.
  const overlap = new Set<string>()
  for (let i = 0; i < counted.length; i++) {
    for (let j = i + 1; j < counted.length; j++) {
      if (rows[i]!.subLimit || rows[j]!.subLimit) continue
      for (const id of cats[i]!) if (cats[j]!.has(id)) overlap.add(id)
    }
  }

  return {
    totalBudget,
    totalSpent,
    // Projected from the DEDUPLICATED total, not by summing per-row projections — those would
    // carry the double count straight into the forecast. `pace()` is linear in spend, so for a
    // non-overlapping plan this is the same number the old per-row sum produced.
    totalProj: project(totalSpent),
    rows: rows.sort((a, b) => b.delta - a.delta),
    overCount: rows.filter((r) => r.spent > r.budget).length,
    adherencePct: totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : null,
    memo,
    overlapCategoryIds: [...overlap],
  }
}
