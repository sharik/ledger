// Bulk budget proposals from history ("Budgets from your history", Plan screen). Pure over
// `Derived` + explicit anchor, like the rest of analytics: no React, no clock, nothing stored —
// the app proposes; the user disposes.
//
// Every proposal carries BOTH periods' figures — a monthly amount and an annual total — so the
// review dialog can let the user switch a row between /mo and /yr and show the real number for
// each. The engine only picks the DEFAULT:
//
//  - Spend in most complete months, mean close to median → monthly (the usual kind).
//  - Spend in few months (insurance paid quarterly, a yearly fee alone in its category) →
//    annual, sized on the trailing-12-complete-month total.
//  - Spend in most months BUT the 6-month mean far above the 12-month median → a lump riding on
//    a monthly base (a yearly premium over small monthly charges). A monthly budget at the mean
//    would sit 10× over the typical month and still blow up when the lump lands, so the default
//    is annual on the total, with the lump's rhythm stated.
//
// Two sources feed one proposal, deliberately asymmetric: the monthly amount comes from
// `scopeTrailingAvg` (budgetScopeSpent arithmetic: FX-honest, refund-netted — the exact number
// BudgetDialog's own 6-month chip shows), while rhythm, median and annual totals come from
// `spentByCatMonth` (same conventions, already floored per category-month, O(1) per lookup).
//
// The schema has no quarterly/semi-annual scope, so lumpy cadences ride the annual
// (`category-year`) budget with the detected rhythm stated in the caption.
import type { MonthKey } from '../model/types'
import { budgetKey, type Budget } from '../model/types'
import type { Derived } from '../model/selectors'
import type { RateBook } from '../import/fx'
import { scopeTrailingAvg } from './budgets'
import { completeMonths, median, typicalMonth, type InsightBasis } from './trends'

// Policy constants, exported so tests and UI copy state the same numbers.
export const PROPOSE_WINDOW = 6 // complete months averaged for a monthly amount
export const CADENCE_WINDOW = 12 // complete months scanned for cadence + annual totals
export const MONTHLY_MIN_RATIO = 0.6 // spend in ≥60% of scanned months ⇒ has a monthly base
export const LUMP_MIN_RATIO = 1.5 // mean ≥ 1.5× median ⇒ a lump dominates the mean…
export const LUMP_MIN_ABS = 25 // …and the gap is ≥ €25/mo (either alone flags noise)
export const SPIKE_RATIO = 2 // a spike month spends > 2× the median

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'yearly'

export interface BudgetProposal {
  categoryId: string
  /** The suggested DEFAULT period. `annual` ⇒ scope `{kind:'category-year', categoryId, year}`. */
  kind: 'monthly' | 'annual'
  /** Detected rhythm of the lumps, for the caption — 'monthly' when the spend is steady. */
  cadence: Cadence
  /** True when the category has a steady monthly base AND periodic lumps on top. */
  mixed: boolean
  /** round(scopeTrailingAvg over PROPOSE_WINDOW) — null when there is nothing to average. */
  monthly: number | null
  /** round(sum of the last CADENCE_WINDOW complete months) — null under a full year of data. */
  annual: number | null
  /** Median over the scanned window — the trip-proof monthly alternative. Omitted when it
   *  rounds to the same figure as `monthly`. */
  median?: number
  /** Of the scanned complete months, how many had spend in this category. */
  monthsWithSpend: number
}

export type SkipReason = 'already-budgeted' | 'no-spend' | 'irregular'

export interface BudgetProposals {
  /** Monthly-default proposals first, then annual; default amount desc within each. */
  proposals: BudgetProposal[]
  skipped: { categoryId: string; reason: SkipReason }[]
  /** Complete months actually scanned (≤ CADENCE_WINDOW). */
  monthsCovered: number
  basis: InsightBasis
  /** `typicalMonth().incomeMedian` — for a stated, never judged, footer sanity line. */
  typicalIncome: number
}

/** The anchor year a `category-year` proposal targets. */
export const proposalYear = (anchor: MonthKey): number => Number(anchor.slice(0, 4))

/** The Budget record (sans amount/bookkeeping) a proposal-row would create at `kind`. */
export function proposalProbe(p: { categoryId: string; kind: 'monthly' | 'annual' }, anchor: MonthKey): Budget {
  const base = { id: 'probe', updatedAt: '', categoryId: p.categoryId, amount: 0 }
  if (p.kind === 'monthly') return base
  return { ...base, scope: { kind: 'category-year', categoryId: p.categoryId, year: proposalYear(anchor) } }
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

export function proposeBudgets(d: Derived, anchor: MonthKey = d.currentMonth, rates?: RateBook): BudgetProposals {
  const months = completeMonths(d, CADENCE_WINDOW, anchor)
  const basis: InsightBasis = months.length === 0 ? 'empty' : months.length < 3 ? 'thin' : 'ok'
  const typicalIncome = typicalMonth(d, anchor).incomeMedian
  const out: BudgetProposals = { proposals: [], skipped: [], monthsCovered: months.length, basis, typicalIncome }
  if (basis !== 'ok') return out // never guess from thin history

  const taken = new Set(d.vault.budgets.map(budgetKey))
  const W = months.length
  const fullYear = W === CADENCE_WINDOW

  for (const c of d.vault.categories) {
    if (c.role === 'income' || c.role === 'transfers') continue

    const series = months.map((mk) => d.spentByCatMonth.get(`${mk}|${c.id}`) ?? 0)
    const spendIdx = series.flatMap((v, i) => (v > 0 ? [i] : []))
    const monthsWithSpend = spendIdx.length
    if (monthsWithSpend === 0) {
      out.skipped.push({ categoryId: c.id, reason: 'no-spend' })
      continue
    }

    const avg = scopeTrailingAvg(d.vault, proposalProbe({ categoryId: c.id, kind: 'monthly' }, anchor), PROPOSE_WINDOW, anchor, rates)
    const monthly = avg == null ? null : Math.round(avg)
    // An annual total from a partial year would be a guess, so it is only offered at W === 12.
    const annual = fullYear ? Math.round(series.reduce((a, b) => a + b, 0)) : null
    const med = Math.round(median(series))

    let kind: 'monthly' | 'annual'
    let cadence: Cadence = 'monthly'
    let mixed = false
    if (monthsWithSpend / W >= MONTHLY_MIN_RATIO) {
      kind = 'monthly'
      // Lump on a monthly base: the mean towers over the median. Read the rhythm off the spike
      // months (spend > SPIKE_RATIO × median) and default to annual — when a full year backs it.
      if (annual != null && monthly != null && med > 0 && monthly >= LUMP_MIN_RATIO * med && monthly - med >= LUMP_MIN_ABS) {
        const spikes = series.flatMap((v, i) => (v > SPIKE_RATIO * med ? [i] : []))
        const lumpCadence = spikes.length ? cadenceOfGaps(spikes, W) : null
        if (lumpCadence != null) {
          kind = 'annual'
          cadence = lumpCadence
          mixed = true
        }
      }
      if (kind === 'monthly' && monthly == null) {
        // Rhythmic across the window but nothing inside the 6-month average window.
        out.skipped.push({ categoryId: c.id, reason: 'irregular' })
        continue
      }
    } else {
      // Lumpy spend alone in its category. Needs a full year and a steady rhythm — a burst or a
      // partial year is 'irregular', never a guessed figure.
      const lumpCadence = fullYear ? cadenceOfGaps(spendIdx, W) : null
      if (annual == null || lumpCadence == null) {
        out.skipped.push({ categoryId: c.id, reason: 'irregular' })
        continue
      }
      kind = 'annual'
      cadence = lumpCadence
    }

    if ((kind === 'monthly' ? monthly : annual)! <= 0) {
      out.skipped.push({ categoryId: c.id, reason: 'no-spend' })
      continue
    }
    if (taken.has(budgetKey(proposalProbe({ categoryId: c.id, kind }, anchor)))) {
      out.skipped.push({ categoryId: c.id, reason: 'already-budgeted' })
      continue
    }
    out.proposals.push({
      categoryId: c.id,
      kind,
      cadence,
      mixed,
      monthly,
      annual,
      ...(med > 0 && monthly != null && med !== monthly ? { median: med } : {}),
      monthsWithSpend,
    })
  }

  const rank = (p: BudgetProposal) => (p.kind === 'monthly' ? 0 : 1)
  const amt = (p: BudgetProposal) => (p.kind === 'monthly' ? p.monthly! : p.annual!)
  out.proposals.sort((a, b) => rank(a) - rank(b) || amt(b) - amt(a))
  return out
}
