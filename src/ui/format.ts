// Figure captions — one definition of "how much did this change" and "over what window",
// shared by every screen that prints a percentage, a point difference or a day range.
//
// It exists because four screens hand-rolled the same arithmetic and only one of them
// guarded the baseline. `DashboardScreen` computed `prev > 0 ? … : 0` and rendered the
// fallback, so a month with no prior data read "+0.0% · vs €0 same point last month" —
// a claim that spending exactly matched a month that has no data. A percentage against
// an empty baseline is not zero; it does not exist.

export interface PctDelta {
  /** Signed, already rounded: '+9.9%' / '−12.0%'. Uses U+2212, matching `fmt`. */
  text: string
  /** Sign of the change, for choosing a glyph or a colour. */
  dir: 'up' | 'down' | 'flat'
  /** The signed percentage itself, unrounded. */
  value: number
}

/**
 * Percentage change from `prev` to `cur`, or **null when there is no basis** — a zero,
 * negative or absent baseline. Callers must render something honest for null ("no basis
 * yet", "B is empty"); they must not fall back to 0.
 */
export function pctDelta(cur: number, prev: number, dec = 1): PctDelta | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null
  const value = ((cur - prev) / prev) * 100
  return { text: signedPct(value, dec), dir: value > 0 ? 'up' : value < 0 ? 'down' : 'flat', value }
}

/** '+9.9%' / '−12.0%' / '+0.0%'. Sign always shown; U+2212 for negatives. */
export function signedPct(n: number, dec = 1): string {
  return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(dec) + '%'
}

/**
 * Difference between two percentages, in percentage POINTS — '+3 pt'. Points and
 * percent are different units and mixing them is its own class of wrong answer, so
 * this is deliberately a separate function with a separate suffix.
 */
export function ptsDelta(cur: number, prev: number): string {
  const d = Math.round(cur) - Math.round(prev)
  return (d >= 0 ? '+' : '−') + Math.abs(d) + ' pt'
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The window a figure covers: '1–12 Jul', or '28 Jun – 3 Jul' when it straddles a month.
 * Day-first, matching `fmtDay`. A comparison that truncates one side to the other's
 * elapsed length has to say so where the figure is, not only in a help panel — this is
 * what turns "same point last month" from a phrase into a pair of dates.
 */
export function dayRange(from: string, to: string): string {
  const d1 = Number(from.slice(8, 10))
  const d2 = Number(to.slice(8, 10))
  const m1 = MONTHS[Number(from.slice(5, 7)) - 1]
  const m2 = MONTHS[Number(to.slice(5, 7)) - 1]
  return m1 === m2 ? `${d1}–${d2} ${m1}` : `${d1} ${m1} – ${d2} ${m2}`
}

/** '3 Jul 2025'. Day-first, with the year — for any date that is not obviously recent. */
export function fmtDayYear(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
}

/**
 * '3 Jul' within the reference year, '3 Jul 2025' outside it.
 *
 * A year-less date is fine for a caption about the last few weeks and ambiguous for anything
 * older. The recurring list showed "last 19 Aug" on a 30 July screen — a charge from eleven
 * months earlier, rendered identically to one from this month.
 */
export function fmtDaySmart(d: string, ref: string): string {
  return d.slice(0, 4) === ref.slice(0, 4) ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : fmtDayYear(d)
}

/** 'day 12 of 31' — how far into a period a partial figure is, which is the assumption
 * any pace projection rests on. */
export function elapsedDays(counted: number, total: number): string {
  return `day ${counted} of ${total}`
}
