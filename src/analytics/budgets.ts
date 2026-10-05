// Budget scope arithmetic (ANALYTICS §6.2, Phase F). A budget's `spent` depends on
// its scope and its NATIVE PERIOD: legacy = one month of a category; category-period =
// a calendar quarter/half-year/year of a category, evergreen (the window containing the
// viewed month, never a stored year); tracking = the lifetime spend of a tracking's
// members. A budget can additionally be READ at any horizon coarser than its native
// period (`budgetSpentAt`/`budgetAmountAt`) — never finer. Always derived, never stored.
import type { Budget, DateStr, MonthKey, Transaction, Vault } from '../model/types'
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

/** The four budget periods — exactly these, calendar-aligned (Q1=Jan–Mar, H1=Jan–Jun). */
export type BudgetPeriod = 'month' | 'quarter' | 'half' | 'year'

export const PERIOD_MONTHS: Record<BudgetPeriod, number> = { month: 1, quarter: 3, half: 6, year: 12 }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number): string => String(n).padStart(2, '0')

const daysInMk = (mk: MonthKey): number =>
  new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)).getUTCDate()

export interface PeriodWindow {
  fromMk: MonthKey
  toMk: MonthKey // inclusive
  from: DateStr
  to: DateStr // last day of toMk — inclusive, for drill filters
  /** '2026-07' · '2026-Q3' · '2026-H2' · '2026' — round-trips through `periodKeyBounds`. */
  key: string
  /** 'Jul 2026' · 'Q3 2026' · 'H2 2026' · '2026'. */
  label: string
}

/** The calendar-aligned window of `period` containing `mk`. */
export function periodWindow(period: BudgetPeriod, mk: MonthKey): PeriodWindow {
  const y = Number(mk.slice(0, 4))
  const m = Number(mk.slice(5, 7))
  const span = PERIOD_MONTHS[period]
  const start = Math.floor((m - 1) / span) * span + 1
  const fromMk = `${y}-${pad2(start)}`
  const toMk = addMonths(fromMk, span - 1)
  const key =
    period === 'month' ? mk
    : period === 'quarter' ? `${y}-Q${(start - 1) / 3 + 1}`
    : period === 'half' ? `${y}-H${start < 7 ? 1 : 2}`
    : String(y)
  const label =
    period === 'month' ? `${MON[m - 1]} ${y}`
    : period === 'year' ? String(y)
    : `${key.slice(5)} ${y}`
  return { fromMk, toMk, from: `${fromMk}-01`, to: `${toMk}-${pad2(daysInMk(toMk))}`, key, label }
}

/** Inverse of `periodWindow().key` — the drill filter's date bounds. */
export function periodKeyBounds(key: string): { from: DateStr; to: DateStr } {
  const p = key.match(/^(\d{4})-([QH])([1-4])$/)
  const anchor: { period: BudgetPeriod; mk: MonthKey } = p
    ? p[2] === 'Q'
      ? { period: 'quarter', mk: `${p[1]}-${pad2((Number(p[3]) - 1) * 3 + 1)}` }
      : { period: 'half', mk: `${p[1]}-${pad2(p[3] === '1' ? 1 : 7)}` }
    : /^\d{4}$/.test(key)
      ? { period: 'year', mk: `${key}-01` }
      : { period: 'month', mk: key }
  const w = periodWindow(anchor.period, anchor.mk)
  return { from: w.from, to: w.to }
}

/**
 * The period a budget natively measures — the finest horizon it may honestly be shown at
 * (minimum resolution: view native or coarser, never finer). `null` for a tracking budget:
 * a trip's span is not a calendar period.
 */
export function budgetNativePeriod(budget: Budget): BudgetPeriod | null {
  const s = budget.scope
  if (!s) return 'month'
  if (s.kind === 'category-period') return s.period
  if (s.kind === 'group') return s.period ?? 'month'
  if (s.kind === 'recurring') return s.cadence === 'yearly' ? 'year' : 'month'
  return null
}

/**
 * The scope's criteria applied inside a month-key window — the shared core of the native
 * matcher and the coarser-horizon reads, so the two can never disagree about which rows a
 * budget covers. Tracking ignores the window: membership IS the span.
 */
function budgetMatcherIn(
  vault: Vault,
  budget: Budget,
  fromMk: MonthKey,
  toMk: MonthKey,
): (t: Transaction) => boolean {
  const scope = budget.scope
  const inWindow = (t: Transaction) => {
    const m = t.date.slice(0, 7)
    return m >= fromMk && m <= toMk
  }
  if (!scope) {
    const cat = budget.categoryId
    return (t) => t.categoryId === cat && inWindow(t)
  }
  if (scope.kind === 'category-period') {
    const cat = scope.categoryId
    return (t) => t.categoryId === cat && inWindow(t)
  }
  if (scope.kind === 'recurring') {
    // Recurring spend of this cadence. When `categoryId` is set, only that category
    // (#12c); otherwise cross-category minus the excluded categories.
    const excl = new Set(scope.excludeCategoryIds ?? [])
    const only = scope.categoryId
    return (t) =>
      t.recurring === scope.cadence &&
      inWindow(t) &&
      (only ? t.categoryId === only : !excl.has(t.categoryId))
  }
  if (scope.kind === 'group') {
    // Several categories, one period. A transaction has exactly one category, so a group is a
    // partition of its members' spend — it can never double-count against itself.
    const ids = new Set(scope.categoryIds)
    return (t) => ids.has(t.categoryId) && inWindow(t)
  }
  // tracking scope: lifetime spend of the tracking's members
  const mem = members(scope.trackingId, vault)
  return (t) => mem.has(t.id)
}

/**
 * The test a transaction must pass to be charged against this budget in its NATIVE window
 * containing the viewed month — evergreen: a year budget viewed at `2026-06` measures 2026,
 * the same budget viewed at `2025-06` measures 2025.
 *
 * One matcher for every scope, so `budgetScopeSpent` and `budgetScopeTxns` cannot drift — and
 * so the roll-up can ask *which* transactions a budget covers rather than only *how much*.
 * That is what lets it count a transaction two budgets both match exactly once.
 */
export function budgetMatcher(vault: Vault, budget: Budget, mk: MonthKey): (t: Transaction) => boolean {
  const native = budgetNativePeriod(budget)
  const w = periodWindow(native ?? 'month', mk) // tracking ignores the window anyway
  return budgetMatcherIn(vault, budget, w.fromMk, w.toMk)
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

/**
 * Spend charged against a budget over the HORIZON window containing `mk` — the coarser-view
 * read (a monthly budget summed over the quarter, etc.). Callers enforce the minimum-resolution
 * rule (native ≤ horizon); reading finer than native is not offered anywhere.
 */
export function budgetSpentAt(
  vault: Vault,
  budget: Budget,
  horizon: BudgetPeriod,
  mk: MonthKey,
  rates?: RateBook,
): number {
  const w = periodWindow(horizon, mk)
  const match = budgetMatcherIn(vault, budget, w.fromMk, w.toMk)
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  let sum = 0
  for (const t of vault.transactions) {
    if (!match(t)) continue
    const amt = conv(t)
    if (amt !== null) sum += expense(amt)
  }
  return Math.max(0, round2(sum))
}

/** The ids a budget covers inside the horizon window — the horizon roll-up's dedup key. */
export function budgetTxnsAt(vault: Vault, budget: Budget, horizon: BudgetPeriod, mk: MonthKey): Set<string> {
  const w = periodWindow(horizon, mk)
  const match = budgetMatcherIn(vault, budget, w.fromMk, w.toMk)
  const out = new Set<string>()
  for (const t of vault.transactions) if (match(t)) out.add(t.id)
  return out
}

/** A budget's amount scaled to a coarser horizon: €400/mo reads as €1,200 over a quarter. */
export function budgetAmountAt(budget: Budget, horizon: BudgetPeriod): number {
  const native = budgetNativePeriod(budget)
  if (native === null) return budget.amount
  return round2((budget.amount * PERIOD_MONTHS[horizon]) / PERIOD_MONTHS[native])
}

/** Per-category recurring spend for one cadence in the viewed period — the breakdown rows
 *  under a recurring budget. Excludes `excludeIds`; ordered by spend descending. `horizon`
 *  widens the window to the one a coarser view sums the row's bar over (a monthly budget read
 *  at the quarter); absent, it is the cadence's own month or year. */
export function recurringBreakdown(
  vault: Vault,
  cadence: 'monthly' | 'yearly',
  mk: MonthKey,
  excludeIds: string[] = [],
  rates?: RateBook,
  horizon?: BudgetPeriod,
): { categoryId: string; spent: number }[] {
  const excl = new Set(excludeIds)
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  const w = periodWindow(horizon ?? (cadence === 'yearly' ? 'year' : 'month'), mk)
  const byCat = new Map<string, number>()
  for (const t of vault.transactions) {
    const tm = t.date.slice(0, 7)
    if (t.recurring !== cadence || excl.has(t.categoryId) || tm < w.fromMk || tm > w.toMk) continue
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

/** Row-caption words for a period: 'monthly' · 'quarterly' · 'per half-year' · 'annual'. */
export const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  month: 'monthly',
  quarter: 'quarterly',
  half: 'per half-year',
  year: 'annual',
}

/** A human label for a budget's scope period, for the row caption. Evergreen — no year number. */
export function budgetScopeLabel(vault: Vault, budget: Budget): string {
  const scope = budget.scope
  if (!scope) return 'monthly'
  if (scope.kind === 'category-period') return PERIOD_LABEL[scope.period]
  if (scope.kind === 'recurring') return scope.cadence === 'yearly' ? 'annual · recurring' : 'monthly · recurring'
  if (scope.kind === 'group') return `${PERIOD_LABEL[scope.period ?? 'month']} · ${scope.categoryIds.length} categories`
  const tr = vault.trackings.find((t) => t.id === scope.trackingId)
  return tr ? `${tr.name} · per-event` : 'per-event'
}

/** Does this budget measure one month at a time (so it has a monthly history and a pace)? */
export function isMonthlyScope(budget: Budget): boolean {
  return budgetNativePeriod(budget) === 'month'
}

/** €/mo equivalent of a coarser-period budget's amount — derived, never stored. Null for
 *  month-native (it already is one) and tracking (no calendar period at all). */
export function monthlyEquivalent(budget: Budget): number | null {
  const native = budgetNativePeriod(budget)
  if (native === null || native === 'month' || budget.amount <= 0) return null
  return round2(budget.amount / PERIOD_MONTHS[native])
}

export interface PeriodSpend {
  /** A `periodWindow().key` ('2026-07' · '2026-Q3' · '2026-H2' · '2026') — also the drill period. */
  key: string
  /** 'Jul' · 'Q3 2025' · '2025'. */
  label: string
  spent: number
  budget: number
}

/**
 * What this budget's own scope cost over the last `periods` NATIVE windows, ending at the
 * window containing `endMk` — months, quarters, halves or years. Evergreen scopes re-window
 * by the probed month, so every point is measured THROUGH `budgetScopeSpent` and the history
 * and the row's bar are produced by the same arithmetic and cannot disagree.
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
  const native = budgetNativePeriod(budget)
  if (native === null) return []
  const span = PERIOD_MONTHS[native]
  const end = periodWindow(native, endMk)
  const out: PeriodSpend[] = []
  for (let i = periods - 1; i >= 0; i--) {
    const mk = addMonths(end.fromMk, -i * span)
    const w = periodWindow(native, mk)
    out.push({
      // Bars are narrow: months keep their bare 'Jul' label as before; coarser periods carry
      // the year ('Q3 2025'), since an 8-quarter series repeats every quarter name.
      key: w.key,
      label: native === 'month' ? MON[Number(mk.slice(5, 7)) - 1]! : w.label,
      spent: budgetScopeSpent(vault, budget, mk, rates),
      budget: budget.amount,
    })
  }
  return out
}

/**
 * "What should this budget be?" (QUESTIONARY Q120) — the mean of what this exact scope actually
 * cost over the last `periods` COMPLETE native windows: months for a monthly budget, quarters
 * for a quarterly one, and so on. The current, partial window is never averaged in.
 *
 * Windows where the VAULT has no data at all, or that start before its first month, are skipped
 * rather than counted as €0 or as complete, matching
 * `trailingAvg` in selectors: a young vault's average must reflect the periods it really has. A
 * window the vault covers in which this scope simply cost nothing DOES count — that is a real €0.
 *
 * `null` when there is nothing to average from: no covered windows, or this scope has never cost
 * anything across the span. Both would otherwise produce a €0 "suggestion", and proposing a €0
 * budget is worse than admitting there is nothing to go on. Also `null` for a per-trip budget,
 * whose span is not a calendar period.
 */
export function scopeTrailingAvg(
  vault: Vault,
  budget: Budget,
  periods: number,
  currentMk: MonthKey,
  rates?: RateBook,
): number | null {
  const native = budgetNativePeriod(budget)
  if (native === null) return null
  const span = PERIOD_MONTHS[native]
  const cur = periodWindow(native, currentMk)
  // A coarse window that starts before the vault does is only partly imported: one transaction in
  // it is not coverage, and averaging it as complete understates the figure.
  let firstMk: MonthKey | null = null
  for (const t of vault.transactions) {
    const m = t.date.slice(0, 7)
    if (firstMk === null || m < firstMk) firstMk = m
  }
  let sum = 0
  let n = 0
  for (let i = 1; i <= periods; i++) {
    const w = periodWindow(native, addMonths(cur.fromMk, -i * span))
    if (firstMk === null || w.fromMk < firstMk) continue
    const covered = vault.transactions.some((t) => {
      const m = t.date.slice(0, 7)
      return m >= w.fromMk && m <= w.toMk
    })
    if (!covered) continue
    sum += budgetScopeSpent(vault, budget, w.fromMk, rates)
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
   * `longer` = budgets whose native period is coarser than the viewing horizon (their
   * native amounts summed; the caller renders them as paced rows, not as part of this total).
   */
  memo: { longer: number; perTrip: number; crossCategoryRecurring: number }
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

/** True when the two sets hold exactly the same members. */
function setEquals<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * Every budget that covers the viewed HORIZON window, added up (QUESTIONARY Q122–124).
 *
 * Two rules carry the whole feature, and they are why this is a selector rather than a
 * `reduce` at the call site.
 *
 * **1. A COARSER PERIOD cannot be summed into this window.** A budget whose native period is
 * coarser than the horizon (a yearly budget at the month view) covers a different span; a
 * €2,400 annual budget is not €2,400 of this month. Those become `memo.longer`, and the caller
 * renders them paced against their own native window. A budget at or finer than the horizon IS
 * counted, scaled (`budgetAmountAt`): a €400 monthly budget is €1,200 of plan at the quarter
 * view. `tracking` budgets stay out at every horizon (a trip's span is not a calendar period),
 * and a cross-category `recurring` budget too — it is an overlay across the category rows
 * rather than a period of its own.
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
 * matcher over the same categories (the recurring-inside-category case). EQUAL sets — a monthly
 * and a quarterly budget on the same category, both counted at the quarter horizon, matching the
 * same rows — resolve by native period: the FINER budget is the sub-limit inside the coarser
 * one's plan, deterministically. All tests are pairwise and existential, so the outcome never
 * depends on `vault.budgets` order — which matters, because the merge sorts collections by id.
 */
export function budgetRollup(
  vault: Vault,
  mk: MonthKey,
  horizon: BudgetPeriod,
  project: (spent: number) => number,
  rates?: RateBook,
): BudgetRollup {
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  const memo = { longer: 0, perTrip: 0, crossCategoryRecurring: 0 }
  const counted: Budget[] = []

  for (const b of vault.budgets) {
    const scope = b.scope
    if (scope?.kind === 'tracking') {
      memo.perTrip += b.amount
      continue
    }
    if (scope?.kind === 'recurring' && !scope.categoryId) {
      memo.crossCategoryRecurring += b.amount
      continue
    }
    const native = budgetNativePeriod(b)!
    if (PERIOD_MONTHS[native] > PERIOD_MONTHS[horizon]) {
      memo.longer += b.amount
      continue
    }
    counted.push(b)
  }

  const natives = counted.map((b) => budgetNativePeriod(b)!)
  const txns = counted.map((b) => budgetTxnsAt(vault, b, horizon, mk))
  const cats = counted.map((b) => new Set(budgetCategoryIds(b)))
  const recurringOnly = counted.map((b) => b.scope?.kind === 'recurring')
  const byId = new Map(vault.transactions.map((t) => [t.id, t]))
  // `i` sits strictly inside `j` — by category set, or by the rows it actually matched.
  const inside = (i: number, j: number) =>
    strictSubset(cats[i]!, cats[j]!) || (txns[i]!.size > 0 && strictSubset(txns[i]!, txns[j]!))

  const rows: RollupRow[] = counted.map((b, i) => {
    let sum = 0
    for (const id of txns[i]!) {
      const amt = conv(byId.get(id)!)
      if (amt !== null) sum += expense(amt)
    }
    const spent = Math.max(0, round2(sum))
    const scope = b.scope
    const amount = budgetAmountAt(b, horizon)
    const subLimit = counted.some((_, j) => {
      if (j === i) return false
      if (inside(i, j)) return true
      // Equal coverage, different native periods: the finer budget is the sub-limit — unless `j`
      // already sits strictly inside `i`, or the two would demote each other and both leave the
      // plan. Equal categories only mean equal coverage when both matchers are the same kind: a
      // recurring-only budget covers less of its category than an ordinary one does.
      const finer = PERIOD_MONTHS[natives[i]!] < PERIOD_MONTHS[natives[j]!]
      return (
        finer &&
        !inside(j, i) &&
        ((recurringOnly[i] === recurringOnly[j] && setEquals(cats[i]!, cats[j]!)) ||
          (txns[i]!.size > 0 && setEquals(txns[i]!, txns[j]!)))
      )
    })
    return {
      budgetId: b.id,
      categoryId: scope?.kind === 'recurring' ? (scope.categoryId ?? b.categoryId) : b.categoryId,
      name: b.name,
      spent,
      budget: amount,
      delta: round2(spent - amount),
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
