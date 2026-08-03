// The period the Dashboard is pointed at, and the hooks the widgets read it through.
//
// Every figure on the Dashboard used to derive from two locals — `currentMonthKey()` and
// `todayStr()` — which is why the screen reads zeros on the 1st of a month: there is nothing in
// "now" yet, and no way to look at the month that just ended.
//
// The anchor is a MONTH (or a year), never a fake date. `compare()` gives `today` two jobs at once
// (resolving `rel` refs, and deciding which side is in progress — see `resolveSide`), so handing it
// a synthetic "last day of March" would make March look in-progress and silently truncate the side
// it is compared against. The real clock always goes to `compare()`; what moves is the PERIOD REF.
// Nothing needs a fake clock anyway: `monthEndProjection`, `monthEndProjectionThrough` and
// `yearEndProjection` already return the partial total unchanged for a period that is not current.
//
// The hooks fall back to live values when no provider is mounted, so Trends, Accounts and Plan —
// which render the very same widget components — are untouched by all of this.
import { createContext, useContext } from 'react'
import { currentMonthKey, monthsOfYear } from '../model/selectors'
import { resolvePeriod } from '../analytics/selections'
import type { DateStr, MonthKey, PeriodRef } from '../model/types'
import type { Gran, PeriodValue } from './kit/PeriodStepper'
import { granOf } from './kit/PeriodStepper'

export interface DashPeriod {
  /** '2026-03' or '2026' — what the stepper holds and the route carries. */
  value: PeriodValue
  gran: Gran
  /**
   * The month the screen reads. In year granularity this is the year's last elapsed month, so the
   * month-keyed tiles (budgets, the ">130% of last month" insights) still have a month to stand on
   * rather than silently reporting December of a year that is half over.
   */
  anchorMonth: MonthKey
  anchorYear: number
  /** The period as a ref, ready for `compare()` / `resolvePeriod()`. */
  period: PeriodRef
  /** The period one step back — the comparison side. */
  prevPeriod: PeriodRef
  /** Every month the period covers, for `flowOfRange`. */
  months: MonthKey[]
  /** The period's calendar bounds, for the drill-downs that open Transactions on it. */
  from: DateStr
  to: DateStr
  /** False ⇒ a finished period: no pace, no projection, no "same point", no freshness caption. */
  isCurrent: boolean
}

/** Build the whole shape from the one value the stepper holds. */
export function dashPeriodOf(value: PeriodValue, thisMonth: MonthKey = currentMonthKey()): DashPeriod {
  const gran = granOf(value)
  if (gran === 'year') {
    const year = Number(value)
    const thisYear = Number(thisMonth.slice(0, 4))
    const isCurrent = year === thisYear
    return {
      value,
      gran,
      // The year's last elapsed month: this month inside the current year, December otherwise.
      anchorMonth: isCurrent ? thisMonth : `${year}-12`,
      anchorYear: year,
      period: { year },
      prevPeriod: { year: year - 1 },
      months: monthsOfYear(year),
      ...bounds({ year }),
      isCurrent,
    }
  }
  const year = Number(value.slice(0, 4))
  return {
    value,
    gran,
    anchorMonth: value,
    anchorYear: year,
    period: { month: value },
    prevPeriod: { month: prevMonth(value) },
    months: [value],
    ...bounds({ month: value }),
    isCurrent: value === thisMonth,
  }
}

/** Every ref built here is absolute, so `resolvePeriod` never consults the date it is handed. */
function bounds(p: PeriodRef): { from: DateStr; to: DateStr } {
  return resolvePeriod(p, '')
}

function prevMonth(mk: MonthKey): MonthKey {
  const y = Number(mk.slice(0, 4))
  const m = Number(mk.slice(5, 7)) - 2
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

/** No provider ⇒ live values, which is every screen other than the Dashboard. */
const DashPeriodCtx = createContext<DashPeriod | null>(null)

export const DashPeriodProvider = DashPeriodCtx.Provider

/**
 * The period in force, live when nothing is providing one.
 *
 * Computed fresh on each call in the fallback case rather than memoized: it is a handful of string
 * slices, and a stale month here would be the very bug this file exists to fix.
 */
export function useDashPeriod(): DashPeriod {
  return useContext(DashPeriodCtx) ?? dashPeriodOf(currentMonthKey())
}

/** The month a widget should read. `currentMonthKey()` everywhere except inside the Dashboard. */
export function useAnchorMonth(): MonthKey {
  return useDashPeriod().anchorMonth
}

/**
 * For the tiles that have no period dimension at all.
 *
 * Net worth and the emergency fund cannot answer "how much in March": both divide a balance that
 * exists only in the present (`d.netWorth`, `d.liquid` come from `Account.balance`), and there is
 * no historical liquid balance to divide instead. Truncating only the chart series while the
 * headline stayed current would give a chart whose last point contradicts the figure above it.
 * Saying which basis they used is the honest option, and only while the header is elsewhere.
 *
 * The trip charts are NOT marked: a trip is a curated membership rather than a date range
 * (ANALYTICS §1.3), and each tile already names the trip it draws — "Amsterdam · daily spend"
 * cannot be misread as a claim about March, so a chip there would be noise.
 */
export function useAsOfToday(): boolean {
  return !useDashPeriod().isCurrent
}
