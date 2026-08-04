import type { DateStr, MonthKey } from '../model/types'
import { daysBetween } from './selections'

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
  // Coverage past this month ⇒ the month is complete; coverage before it ⇒ no data in this
  // month to extrapolate from. Either way the partial total is the honest answer.
  if (through.slice(0, 7) !== mk) return spentSoFar
  return pace(spentSoFar, Number(through.slice(8, 10)), daysInMonth(mk))
}

/** Year-end projection of a year-to-date total at the current pace. */
export function yearEndProjection(ytd: number, year: number, today: DateStr): number {
  const totalDays = daysBetween(`${year}-01-01`, `${year}-12-31`) + 1
  const inYear = Number(today.slice(0, 4)) === year
  if (!inYear) return ytd
  const elapsed = daysBetween(`${year}-01-01`, today) + 1
  return pace(ytd, elapsed, totalDays)
}

/**
 * 0..1 of `year` elapsed at `today` — calendar days, the same elapsed = daysBetween + 1
 * convention as `yearEndProjection`, so a today-marker and the projection cannot disagree
 * about how far into the year we are. Past year → 1, future → 0.
 */
export function yearElapsedFraction(year: number, today: DateStr): number {
  const y = Number(today.slice(0, 4))
  if (y > year) return 1
  if (y < year) return 0
  const total = daysBetween(`${year}-01-01`, `${year}-12-31`) + 1
  return (daysBetween(`${year}-01-01`, today) + 1) / total
}
