import type { DateStr, MonthKey } from '../model/types'
import { daysBetween } from './selections'
import { periodWindow, type BudgetPeriod } from './budgets'

/**
 * Below this many elapsed days a pace extrapolation is noise (one rent charge on
 * the 1st would project 31×), so projections return the partial total unchanged
 * — "too early to project" — and no over-pace flag can fire from extrapolation.
 */
export const MIN_PACE_DAYS = 3

/**
 * BRIEF §8 pace-based projection: extrapolate a partial total to the full period
 * at the current spend rate. Returns 0 when nothing has elapsed, and the raw
 * partial total while fewer than MIN_PACE_DAYS have elapsed.
 */
export function pace(spentSoFar: number, elapsedDays: number, totalDays: number): number {
  if (elapsedDays <= 0) return 0
  if (elapsedDays < MIN_PACE_DAYS && elapsedDays < totalDays) return spentSoFar
  return (spentSoFar / elapsedDays) * totalDays
}

function daysInMonth(mk: MonthKey): number {
  return new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)).getUTCDate()
}

/** Month-end projection of spend at the current pace (per category or total). */
export function monthEndProjection(spentSoFar: number, mk: MonthKey, today: DateStr): number {
  const total = daysInMonth(mk)
  const inMonth = today.slice(0, 7) === mk
  if (!inMonth) return spentSoFar // month complete → no projection needed
  const elapsed = Number(today.slice(8, 10))
  return pace(spentSoFar, elapsed, total)
}

/**
 * The same projection, but over the window the DATA actually covers rather than the calendar.
 *
 * `monthEndProjection` divides by the day of the month, which is only right when statements run
 * through today. When they stop on the 23rd of a 31-day month, dividing 23 days of charges by 30
 * elapsed days understates the rate by ~30% — and the Plan header prints "time elapsed 97%" and
 * "data through 23 Jul" side by side, so the screen already knows both numbers and reconciled
 * neither. A rate is spend ÷ the days that spend was measured over; `freshness.ts` exists to
 * insist that window is a statement fact, and this is that insistence reaching the arithmetic.
 *
 * `through` is the coverage date (`useFreshness().through`), or today when nothing has been
 * imported — in which case this reduces exactly to `monthEndProjection`.
 */
export function monthEndProjectionThrough(spentSoFar: number, mk: MonthKey, through: DateStr): number {
  return periodEndProjectionThrough(spentSoFar, 'month', mk, through)
}

/**
 * Pace projection over any budget period's calendar window (the one containing `mk`), from the
 * window the DATA covers: `through` inside the window ⇒ extrapolate from its elapsed days;
 * before or past it ⇒ the partial total is the honest answer. Reduces exactly to
 * `monthEndProjectionThrough` / `yearEndProjection` for their periods — they delegate here,
 * so the two generations of call sites cannot disagree.
 */
export function periodEndProjectionThrough(
  spentSoFar: number,
  period: BudgetPeriod,
  mk: MonthKey,
  through: DateStr,
): number {
  const w = periodWindow(period, mk)
  if (through < w.from || through > w.to) return spentSoFar
  return pace(spentSoFar, daysBetween(w.from, through) + 1, daysBetween(w.from, w.to) + 1)
}

/** Period-end projection at the current pace, elapsed measured to `today` (calendar). */
export function periodEndProjection(spent: number, period: BudgetPeriod, mk: MonthKey, today: DateStr): number {
  return periodEndProjectionThrough(spent, period, mk, today)
}

/** Year-end projection of a year-to-date total at the current pace. */
export function yearEndProjection(ytd: number, year: number, today: DateStr): number {
  return periodEndProjectionThrough(ytd, 'year', `${year}-01`, today)
}

/**
 * 0..1 of a period's calendar window (the one containing `mk`) elapsed at `today` — calendar
 * days, the same elapsed = daysBetween + 1 convention as the projections, so a today-marker
 * and the projection cannot disagree about how far in we are. Past window → 1, future → 0.
 */
export function periodElapsedFraction(period: BudgetPeriod, mk: MonthKey, today: DateStr): number {
  const w = periodWindow(period, mk)
  if (today > w.to) return 1
  if (today < w.from) return 0
  return (daysBetween(w.from, today) + 1) / (daysBetween(w.from, w.to) + 1)
}

/** 0..1 of `year` elapsed at `today` — delegates to `periodElapsedFraction`. */
export function yearElapsedFraction(year: number, today: DateStr): number {
  return periodElapsedFraction('year', `${year}-01`, today)
}
