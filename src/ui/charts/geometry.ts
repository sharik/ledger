// Pure chart geometry (Phase G chart kit). No React, no DOM — unit-tested.

export interface Scale {
  (v: number): number
  domain: [number, number]
  range: [number, number]
}

/** Linear scale. A zero-width domain maps everything to the range start. */
export function linScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0
  const f = ((v: number) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0))) as Scale
  f.domain = domain
  f.range = range
  return f
}

/** Round up to a friendly ceiling (1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 7.5 / 10 × 10ⁿ); ≥1 always. */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / mag
  const nn = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 7.5 ? 7.5 : 10
  return nn * mag
}

/**
 * `count` evenly spaced ticks from 0 to a nice ceiling ≥ max. Degenerate data
 * (all-zero, empty, NaN) yields a 0..1 axis rather than NaN geometry.
 */
export function niceTicks(max: number, count = 4): { top: number; ticks: number[] } {
  const top = niceCeil(max)
  const ticks = Array.from({ length: count + 1 }, (_, i) => (top * i) / count)
  return { top, ticks }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Month-boundary ticks across a date range, thinned to at most `maxCount`.
 *
 * The step escalates 1 → 2 → 3 → 6 → 12 months, so a two-month range is labelled by month and a
 * five-year one by year, without the caller choosing. Dates only — the caller scales them.
 */
export function monthTicks(from: string, to: string, maxCount = 6): { date: string; label: string }[] {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))]
  const months = (ty - fy) * 12 + (tm - fm) + 1
  if (months <= 0) return []
  // `ceil`, not a bare divide: 73 months at a 12-month step is 7 ticks, not 6.08. The ladder runs
  // past a year so a multi-year ledger thins to something readable instead of one tick per year.
  const step = [1, 2, 3, 6, 12, 24, 60].find((s) => Math.ceil(months / s) <= maxCount) ?? 120
  const out: { date: string; label: string }[] = []
  // Start at the first month boundary at or after `from`, so a tick never sits left of the plot.
  let y = fy
  let m = fm
  if (from.slice(8, 10) !== '01') {
    m++
    if (m > 12) { m = 1; y++ }
  }
  for (; y * 12 + m <= ty * 12 + tm; m += step) {
    while (m > 12) { m -= 12; y++ }
    const date = `${y}-${String(m).padStart(2, '0')}-01`
    if (date > to) break
    out.push({ date, label: step >= 12 ? String(y) : `${MON[m - 1]} ’${String(y).slice(2)}` })
  }
  return out
}

export interface StackSeg<T> {
  item: T
  y0: number // running total below this segment
  y1: number // y0 + value
}

/** Stack positive values bottom-up, skipping hidden ids and non-positive values. */
export function stack<T extends { id: string; value: number }>(items: T[], hidden?: ReadonlySet<string>): StackSeg<T>[] {
  const out: StackSeg<T>[] = []
  let cum = 0
  for (const item of items) {
    if (hidden?.has(item.id) || !(item.value > 0)) continue
    out.push({ item, y0: cum, y1: cum + item.value })
    cum += item.value
  }
  return out
}

/**
 * Shared bullet-bar domain for a budget list, in multiples of each row's budget:
 * every row's budget tick sits at 1/domainMax of the track, and fills stay
 * proportional — 170% of budget is visibly longer than 102% (Phase G BudgetRow).
 */
export function computeBudgetDomain(rows: { spent: number; budget: number; proj: number }[]): number {
  let worst = 0
  for (const r of rows) {
    if (r.budget <= 0) continue
    worst = Math.max(worst, r.spent / r.budget, r.proj / r.budget)
  }
  return Math.max(1.25, worst)
}
