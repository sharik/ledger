// Bulk budget proposals from history ("Budgets from your history", Plan screen). Pure over
// `Derived` + explicit anchor, like the rest of analytics: no React, no clock, nothing stored —
// the app proposes; the user disposes.
//
// Every proposal carries EVERY period's figure it can honestly compute — /mo, /quarter,
// /half-year, /yr — so the review dialog can let the user switch a row between periods and show
// the real number for each. The engine only picks the DEFAULT native period:
//
//  - Spend in most complete months, mean close to median → month (the usual kind).
//  - Spend in few months with a steady rhythm (insurance paid quarterly, a yearly fee alone in
//    its category) → the period matching that rhythm: quarter, half-year, or year.
//  - Spend in most months BUT the 12-month mean far above the 12-month median → a lump riding
//    on a monthly base (a yearly premium over small monthly charges). A monthly budget sized on
//    a mean would sit far over the typical month and still blow up when the lump lands, so the
//    default is the lump's own period, sized on that window's run rate.
//
// Two sources feed one proposal, deliberately asymmetric: the monthly amount comes from
// `scopeTrailingAvg` (budgetScopeSpent arithmetic: FX-honest, refund-netted — the exact number
// BudgetDialog's own 6-month chip shows), while rhythm, median and the coarser-period totals
// come from `spentByCatMonth` (same conventions, already floored per category-month, O(1) per
// lookup). Coarser figures are run rates over the scanned complete months — total ÷ W × period
// — offered only when the window is long enough to back them (see `figures`).
import type { MonthKey } from '../model/types'
import { budgetKey, type Budget } from '../model/types'
import type { Derived } from '../model/selectors'
import type { RateBook } from '../import/fx'
import { PERIOD_MONTHS, scopeTrailingAvg, type BudgetPeriod } from './budgets'
import { completeMonths, median, typicalMonth, type InsightBasis } from './trends'

// Policy constants, exported so tests and UI copy state the same numbers.
export const PROPOSE_WINDOW = 6 // complete months averaged for a monthly amount
export const CADENCE_WINDOW = 12 // complete months scanned for cadence + period totals
export const MONTHLY_MIN_RATIO = 0.6 // spend in ≥60% of scanned months ⇒ has a monthly base
export const LUMP_MIN_RATIO = 1.5 // mean ≥ 1.5× median ⇒ a lump dominates the mean…
export const LUMP_MIN_ABS = 25 // …and the gap is ≥ €25/mo (either alone flags noise)
export const SPIKE_RATIO = 2 // a spike month spends > 2× the median
export const QUARTER_MIN_MONTHS = 6 // a /quarter figure needs ≥ 2 quarters of window

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'yearly'

export const PERIOD_OF_CADENCE: Record<Cadence, BudgetPeriod> = {
  monthly: 'month',
  quarterly: 'quarter',
  semiannual: 'half',
  yearly: 'year',
}

/**
 * Per-category spending rhythm over the scanned window — the shared detection core of
 * `proposeBudgets` and the assistant's `spending_cadence` tool, so the two can never disagree
 * about what a category's rhythm is.
 */
export interface CategoryCadence {
  categoryId: string
  /** Rhythm of the spend (of the lumps, when `mixed`) — null when no honest rhythm exists. */
  cadence: Cadence | null
  /** True when the category has a steady monthly base AND periodic lumps on top. */
  mixed: boolean
  /** Of the scanned complete months, how many had spend in this category. */
  monthsWithSpend: number
  /** The suggested native budget period, or null when history cannot back one. */
  period: BudgetPeriod | null
  /** round(scopeTrailingAvg over PROPOSE_WINDOW) — null when there is nothing to average. */
  monthly: number | null
  /** Run rate per quarter over the scanned months — null under QUARTER_MIN_MONTHS of window. */
  quarterly: number | null
  /** Run rate per half-year — null under a full year of window. */
  semiannual: number | null
  /** round(sum of the last CADENCE_WINDOW complete months) — null under a full year. */
  annual: number | null
  /** Median month over the scanned window — the trip-proof monthly alternative. */
  median: number | null
}

export interface BudgetProposal extends CategoryCadence {
  cadence: Cadence
  /** The suggested DEFAULT native period. `month` ⇒ a bare legacy budget;
   *  anything coarser ⇒ scope `{kind:'category-period', categoryId, period}`. */
  period: BudgetPeriod
}

export type SkipReason = 'already-budgeted' | 'no-spend' | 'irregular'

export interface BudgetProposals {
  /** Finest default period first (month → quarter → half → year); figure desc within each. */
  proposals: BudgetProposal[]
  skipped: { categoryId: string; reason: SkipReason }[]
  /** Complete months actually scanned (≤ CADENCE_WINDOW). */
  monthsCovered: number
  basis: InsightBasis
  /** `typicalMonth().incomeMedian` — for a stated, never judged, footer sanity line. */
  typicalIncome: number
}

/** The Budget record (sans amount/bookkeeping) a proposal-row would create at `period`. */
export function proposalProbe(p: { categoryId: string; period: BudgetPeriod }): Budget {
  const base = { id: 'probe', updatedAt: '', categoryId: p.categoryId, amount: 0 }
  if (p.period === 'month') return base
  return { ...base, scope: { kind: 'category-period', categoryId: p.categoryId, period: p.period } }
}

/** A proposal's suggested figure at `period`, or null when the window cannot back one. */
export function proposalFigure(p: CategoryCadence, period: BudgetPeriod): number | null {
  return period === 'month' ? p.monthly : period === 'quarter' ? p.quarterly : period === 'half' ? p.semiannual : p.annual
}

/** Median month-gap between the given spend indices → the lump's cadence. */
function cadenceOfGaps(spendIdx: number[], W: number): Cadence | null {
  const gaps = spendIdx.slice(1).map((idx, i) => idx - spendIdx[i]!)
  const gap = gaps.length ? median(gaps) : W
  // A rhythm faster than every-other-month is a burst (a recently started monthly spend),
  // not a cadence — the caller treats null as "no honest cadence to state".
  if (gap < 2) return null
  return gap <= 4 ? 'quarterly' : gap <= 8 ? 'semiannual' : 'yearly'
}

/** The rhythm analysis for every expense category — no budget-key filtering, no thresholds
 *  on what to PROPOSE; that is `proposeBudgets`' layer on top. */
export function categoryCadences(d: Derived, anchor: MonthKey = d.currentMonth, rates?: RateBook): CategoryCadence[] {
  const months = completeMonths(d, CADENCE_WINDOW, anchor)
  const W = months.length
  const fullYear = W === CADENCE_WINDOW
  const out: CategoryCadence[] = []

  for (const c of d.vault.categories) {
    if (c.role === 'income' || c.role === 'transfers') continue

    const series = months.map((mk) => d.spentByCatMonth.get(`${mk}|${c.id}`) ?? 0)
    const spendIdx = series.flatMap((v, i) => (v > 0 ? [i] : []))
    const monthsWithSpend = spendIdx.length
    const total = series.reduce((a, b) => a + b, 0)

    const avg =
      W === 0
        ? null
        : scopeTrailingAvg(d.vault, proposalProbe({ categoryId: c.id, period: 'month' }), PROPOSE_WINDOW, anchor, rates)
    const monthly = avg == null ? null : Math.round(avg)
    // A coarser figure from too short a window would be one lump dressed as a mean, so each
    // period needs a window at least twice its own length; annual keeps the full-year bar.
    const quarterly = W >= QUARTER_MIN_MONTHS && total > 0 ? Math.round((total / W) * 3) : null
    const semiannual = fullYear && total > 0 ? Math.round(total / 2) : null
    const annual = fullYear ? Math.round(total) : null
    const med = Math.round(median(series))

    let cadence: Cadence | null = null
    let mixed = false
    let period: BudgetPeriod | null = null
    if (monthsWithSpend === 0) {
      // leave everything null — the caller reads monthsWithSpend
    } else if (monthsWithSpend / Math.max(W, 1) >= MONTHLY_MIN_RATIO) {
      cadence = 'monthly'
      period = 'month'
      // Lump on a monthly base: the year's mean towers over the median — measured over the same
      // 12 months, so a premium 8 months back weighs the same as one last month. Read the rhythm
      // off the spike months (spend > SPIKE_RATIO × median) and default to the lump's own
      // period — when a full year backs it.
      const mean12 = total / Math.max(W, 1)
      if (annual != null && med > 0 && mean12 >= LUMP_MIN_RATIO * med && mean12 - med >= LUMP_MIN_ABS) {
        const spikes = series.flatMap((v, i) => (v > SPIKE_RATIO * med ? [i] : []))
        const lumpCadence = spikes.length ? cadenceOfGaps(spikes, W) : null
        if (lumpCadence != null && lumpCadence !== 'monthly') {
          cadence = lumpCadence
          mixed = true
          period = PERIOD_OF_CADENCE[lumpCadence]
        }
      }
      if (period === 'month' && monthly == null) period = null // rhythmic, but nothing to average
    } else {
      // Lumpy spend alone in its category. A quarterly rhythm is readable from half a year;
      // slower rhythms need the full one — a burst or a too-short window is null, never a guess.
      const lumpCadence = W >= QUARTER_MIN_MONTHS ? cadenceOfGaps(spendIdx, W) : null
      cadence = lumpCadence
      period = lumpCadence ? PERIOD_OF_CADENCE[lumpCadence] : null
    }
    const row: CategoryCadence = {
      categoryId: c.id,
      cadence,
      mixed,
      monthsWithSpend,
      period,
      monthly,
      quarterly,
      semiannual,
      annual,
      median: med > 0 ? med : null,
    }
    // A period whose figure the window cannot back (semiannual cadence, 8-month vault) is not
    // a proposable period.
    if (row.period != null && proposalFigure(row, row.period) == null) row.period = null
    out.push(row)
  }
  return out
}

export function proposeBudgets(d: Derived, anchor: MonthKey = d.currentMonth, rates?: RateBook): BudgetProposals {
  const months = completeMonths(d, CADENCE_WINDOW, anchor)
  const basis: InsightBasis = months.length === 0 ? 'empty' : months.length < 3 ? 'thin' : 'ok'
  const typicalIncome = typicalMonth(d, anchor).incomeMedian
  const out: BudgetProposals = { proposals: [], skipped: [], monthsCovered: months.length, basis, typicalIncome }
  if (basis !== 'ok') return out // never guess from thin history

  const taken = new Set(d.vault.budgets.map(budgetKey))

  for (const cc of categoryCadences(d, anchor, rates)) {
    if (cc.monthsWithSpend === 0) {
      out.skipped.push({ categoryId: cc.categoryId, reason: 'no-spend' })
      continue
    }
    if (cc.period == null) {
      out.skipped.push({ categoryId: cc.categoryId, reason: 'irregular' })
      continue
    }
    const figure = proposalFigure(cc, cc.period)
    if (figure == null || figure <= 0) {
      out.skipped.push({ categoryId: cc.categoryId, reason: 'no-spend' })
      continue
    }
    if (taken.has(budgetKey(proposalProbe({ categoryId: cc.categoryId, period: cc.period })))) {
      out.skipped.push({ categoryId: cc.categoryId, reason: 'already-budgeted' })
      continue
    }
    out.proposals.push({
      ...cc,
      cadence: cc.cadence!,
      period: cc.period,
      // The median is the trip-proof monthly alternative; identical to the monthly figure it
      // says nothing, so the dialog's second chip is dropped.
      median: cc.median != null && cc.median !== cc.monthly ? cc.median : null,
    })
  }

  out.proposals.sort(
    (a, b) =>
      PERIOD_MONTHS[a.period] - PERIOD_MONTHS[b.period] ||
      proposalFigure(b, b.period)! - proposalFigure(a, a.period)!,
  )
  return out
}
