// The Trends insight computations (QUESTIONARY §7): the page's job is to STATE trends,
// not just draw series the user must eyeball. Everything here is a pure function over
// `Derived` (or an already-computed `Subscriptions`), takes an explicit `anchor` month so
// tests never touch the real clock, and reads only COMPLETE months — see `completeMonths`.
//
// Two rules are load-bearing:
//
//  1. A "complete month" is strictly before the anchor AND present in `flowByMonth`.
//     `monthsTracked` also contains snapshot-only months; averaging those in as €0 would
//     manufacture a downward trend out of a balance entry.
//
//  2. A mover must clear BOTH thresholds — relative (≥20%) and absolute (≥€25/mo). Either
//     alone flags noise: +40% of a €12 category, or +2% of rent.
import type { DateStr, MonthKey } from '../model/types'
import type { Derived, MonthFlow } from '../model/selectors'
import { savingsRateOf } from '../model/selectors'
import { daysBetween } from './selections'
import type { Subscriptions } from './subscriptions'

export type InsightBasis = 'empty' | 'thin' | 'ok'

// Policy constants, exported so tests and explain copy state the same numbers.
export const MOMENTUM_REL_MIN = 0.2 // a mover needs ≥20% vs its baseline…
export const MOMENTUM_ABS_MIN = 25 // …AND ≥ €25/mo (base currency)
export const RECENT_N = 3 // trailing window (complete months)
export const BASELINE_N = 6 // up to 6 complete months before the recent window
export const RECORD_MIN_MONTHS = 6 // a record needs history to be a record against
export const DIGEST_WINDOW_DAYS = 60

/**
 * Ascending complete months: strictly before `anchor`, with cash-flow data, capped at the
 * last `limit`. The single place the complete-month rule lives — a month in `monthsTracked`
 * that only has snapshots is NOT complete (it would read as a fake €0 month), and a gap
 * month (no data at all) is skipped, matching `trailingAvg`.
 */
export function completeMonths(d: Derived, limit: number, anchor: MonthKey = d.currentMonth): MonthKey[] {
  const out: MonthKey[] = []
  for (const mk of d.monthsTracked) {
    if (mk >= anchor) break
    if (d.flowByMonth.has(mk)) out.push(mk)
  }
  return limit < out.length ? out.slice(out.length - limit) : out
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Linear-interpolation quantile over a sorted copy; q in [0,1]. */
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

// ---------- headline ----------

export interface TrendDirection {
  /** Mean over the last RECENT_N complete months. */
  recentAvg: number
  /** Mean over up-to-BASELINE_N complete months before those. */
  baselineAvg: number
  /** Percent change of recent vs baseline; null when the baseline is 0 or basis isn't 'ok'. */
  deltaPct: number | null
  /** empty: no complete months · thin: recent < 3 or baseline < 2 · ok. */
  basis: InsightBasis
}

export interface TrendHeadline {
  spend: TrendDirection
  income: TrendDirection
}

function directionOf(d: Derived, months: MonthKey[], of: (f: MonthFlow) => number): TrendDirection {
  const recent = months.slice(-RECENT_N)
  const baseline = months.slice(0, -RECENT_N)
  const vals = (mks: MonthKey[]) => mks.map((mk) => of(d.flowByMonth.get(mk)!))
  const recentAvg = mean(vals(recent))
  const baselineAvg = mean(vals(baseline))
  const basis: InsightBasis =
    months.length === 0 ? 'empty' : recent.length < RECENT_N || baseline.length < 2 ? 'thin' : 'ok'
  const deltaPct = basis === 'ok' && baselineAvg > 0 ? ((recentAvg - baselineAvg) / baselineAvg) * 100 : null
  return { recentAvg, baselineAvg, deltaPct, basis }
}

/** Overall spend and income direction: last 3 complete months vs the up-to-6 before. */
export function trendHeadline(d: Derived, anchor: MonthKey = d.currentMonth): TrendHeadline {
  const months = completeMonths(d, RECENT_N + BASELINE_N, anchor)
  return {
    spend: directionOf(d, months, (f) => f.expense),
    income: directionOf(d, months, (f) => f.income),
  }
}

// ---------- category momentum ----------

export interface CategoryMomentum {
  categoryId: string
  recentAvg: number
  baselineAvg: number
  /** recentAvg − baselineAvg, €/mo. */
  deltaAbs: number
  /** Percent vs baseline; null when the baseline is 0 — render as "new", not "+∞%". */
  deltaPct: number | null
  /** Last complete month is the strict max over all complete months (≥ RECORD_MIN_MONTHS of history). */
  recordHigh: boolean
  recordMonth: MonthKey | null
  /** Last up-to-12 complete months (oldest first), 0-filled, for mini-bars. */
  series: number[]
  seriesMonths: MonthKey[]
}

export interface MomentumResult {
  risers: CategoryMomentum[]
  fallers: CategoryMomentum[]
  /** Record highs, whether or not they also moved; may overlap risers. */
  records: CategoryMomentum[]
  basis: InsightBasis
}

/**
 * Which categories are creeping up or falling off (Q73/74), and record-high months (Q84).
 * Same category filter as the Dashboard insight: income, transfers, and breakdown-excluded
 * categories (a user preference, defaulting to Housing) never appear.
 */
export function categoryMomentum(d: Derived, anchor: MonthKey = d.currentMonth): MomentumResult {
  const all = completeMonths(d, Infinity, anchor)
  const basis: InsightBasis = all.length === 0 ? 'empty' : all.length < RECENT_N + 2 ? 'thin' : 'ok'
  const windowMonths = all.slice(-(RECENT_N + BASELINE_N))
  const recentMks = windowMonths.slice(-RECENT_N)
  const baselineMks = windowMonths.slice(0, -RECENT_N)
  const seriesMonths = all.slice(-12)

  const risers: CategoryMomentum[] = []
  const fallers: CategoryMomentum[] = []
  const records: CategoryMomentum[] = []
  if (basis !== 'ok') return { risers, fallers, records, basis }

  for (const c of d.vault.categories) {
    if (c.role === 'income' || c.role === 'transfers') continue
    if (c.excludeFromBreakdown ?? c.role === 'housing') continue
    const spentAt = (mk: MonthKey) => d.spentByCatMonth.get(`${mk}|${c.id}`) ?? 0

    const recentAvg = mean(recentMks.map(spentAt))
    const baselineAvg = mean(baselineMks.map(spentAt))
    const deltaAbs = recentAvg - baselineAvg
    const deltaPct = baselineAvg > 0 ? (deltaAbs / baselineAvg) * 100 : null

    const allVals = all.map(spentAt)
    const monthsWithSpend = allVals.filter((v) => v > 0).length
    const last = allVals[allVals.length - 1]!
    const recordHigh =
      monthsWithSpend >= RECORD_MIN_MONTHS &&
      last >= MOMENTUM_ABS_MIN &&
      allVals.slice(0, -1).every((v) => v < last)

    const m: CategoryMomentum = {
      categoryId: c.id,
      recentAvg,
      baselineAvg,
      deltaAbs,
      deltaPct,
      recordHigh,
      recordMonth: recordHigh ? all[all.length - 1]! : null,
      series: seriesMonths.map(spentAt),
      seriesMonths,
    }

    if (baselineMks.length > 0) {
      if (baselineAvg > 0) {
        if (deltaAbs >= MOMENTUM_ABS_MIN && deltaPct! >= MOMENTUM_REL_MIN * 100) risers.push(m)
        else if (deltaAbs <= -MOMENTUM_ABS_MIN && deltaPct! <= -MOMENTUM_REL_MIN * 100) fallers.push(m)
      } else if (recentAvg >= MOMENTUM_ABS_MIN) {
        risers.push(m) // no baseline at all — a new spending category, rendered "new"
      }
    }
    if (recordHigh) records.push(m)
  }

  const byMagnitude = (a: CategoryMomentum, b: CategoryMomentum) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs)
  const lastOf = (m: CategoryMomentum) => m.series[m.series.length - 1] ?? 0
  return {
    risers: risers.sort(byMagnitude).slice(0, 4),
    fallers: fallers.sort(byMagnitude).slice(0, 4),
    records: records.sort((a, b) => lastOf(b) - lastOf(a)).slice(0, 2),
    basis,
  }
}

// ---------- seasonality ----------

export interface Seasonality {
  /** m = 1..12; avg spend and observation count per calendar month. */
  byCalMonth: { m: number; avg: number; n: number }[]
  /** topYears: complete calendar years where `m` was that year's most expensive month. */
  peak: { m: number; avg: number; topYears: number; years: number }
}

/**
 * Which calendar month runs highest (Q76). Null unless EVERY calendar month has ≥2
 * complete-month observations (≈ two full years) — below that, absence, never a guess.
 */
export function seasonality(d: Derived, anchor: MonthKey = d.currentMonth): Seasonality | null {
  const all = completeMonths(d, Infinity, anchor)
  const buckets: number[][] = Array.from({ length: 12 }, () => [])
  for (const mk of all) buckets[Number(mk.slice(5)) - 1]!.push(d.flowByMonth.get(mk)!.expense)
  if (buckets.some((b) => b.length < 2)) return null

  const byCalMonth = buckets.map((b, i) => ({ m: i + 1, avg: mean(b), n: b.length }))
  const peakEntry = byCalMonth.reduce((a, b) => (b.avg > a.avg ? b : a))

  // Consistency over complete calendar years only — a partial year's max is not a fair max.
  const monthSet = new Set(all)
  const years = new Set(all.map((mk) => Number(mk.slice(0, 4))))
  let fullYears = 0
  let topYears = 0
  for (const y of years) {
    const mks = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`)
    if (!mks.every((mk) => monthSet.has(mk))) continue
    fullYears++
    const spends = mks.map((mk) => d.flowByMonth.get(mk)!.expense)
    if (spends.indexOf(Math.max(...spends)) === peakEntry.m - 1) topYears++
  }

  return { byCalMonth, peak: { m: peakEntry.m, avg: peakEntry.avg, topYears, years: fullYears } }
}

// ---------- typical month ----------

export interface TypicalMonth {
  /** Median, not mean — one trip month must not move "typical"; the spread tells that story. */
  spendMedian: number
  /** Half the p25–p75 span — the "± €Y". */
  spendSpread: number
  incomeMedian: number
  monthsCounted: number
  basis: InsightBasis
}

/** "A typical month" (Q82/Q28) over the last 12 complete months. */
export function typicalMonth(d: Derived, anchor: MonthKey = d.currentMonth): TypicalMonth {
  const months = completeMonths(d, 12, anchor)
  const spends = months.map((mk) => d.flowByMonth.get(mk)!.expense)
  const incomes = months.map((mk) => d.flowByMonth.get(mk)!.income)
  return {
    spendMedian: median(spends),
    spendSpread: (quantile(spends, 0.75) - quantile(spends, 0.25)) / 2,
    incomeMedian: median(incomes),
    monthsCounted: months.length,
    basis: months.length === 0 ? 'empty' : months.length < 3 ? 'thin' : 'ok',
  }
}

// ---------- savings-rate series ----------

/**
 * Per-month savings rate for a chart overlay. Null — a break in the line, not a 0 — for
 * the partial anchor month, months with no flow data, and months with no income (a 0%
 * rate there would be a lie, not a figure).
 */
export function savingsRateSeries(d: Derived, months: MonthKey[], anchor: MonthKey = d.currentMonth): (number | null)[] {
  return months.map((mk) => {
    if (mk >= anchor) return null
    const f = d.flowByMonth.get(mk)
    if (!f || f.income <= 0) return null
    return savingsRateOf(f)
  })
}

// ---------- recurring digest ----------

export interface RecurringDigest {
  newCount: number
  increasedCount: number
  decreasedCount: number
  lapsedCount: number
  /** Passed through from Subscriptions — confirmed rows only, the stated rule. */
  monthlyTotal: number
  annualisedTotal: number
  /** Any confirmed rows at all; the strip hides when false. */
  hasAny: boolean
}

/**
 * What changed among confirmed recurring charges recently (Q90–92). `new|increased|decreased`
 * count when the charge itself landed inside the window; `lapsed` counts when the charge was
 * EXPECTED inside the window and didn't come — a sub that died a year ago is not news.
 */
export function recurringDigest(subs: Subscriptions, today: DateStr, windowDays = DIGEST_WINDOW_DAYS): RecurringDigest {
  let newCount = 0
  let increasedCount = 0
  let decreasedCount = 0
  let lapsedCount = 0
  for (const r of subs.rows) {
    if (r.state === 'lapsed') {
      if (daysBetween(r.expectedNext, today) <= windowDays) lapsedCount++
    } else if (daysBetween(r.lastDate, today) <= windowDays) {
      if (r.state === 'new') newCount++
      else if (r.state === 'increased') increasedCount++
      else if (r.state === 'decreased') decreasedCount++
    }
  }
  return {
    newCount,
    increasedCount,
    decreasedCount,
    lapsedCount,
    monthlyTotal: subs.monthlyTotal,
    annualisedTotal: subs.annualisedTotal,
    hasAny: subs.rows.length > 0,
  }
}
