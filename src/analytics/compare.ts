import type { DateStr, Selection, Vault } from '../model/types'
import { incomeCategoryId } from '../model/selectors'
import { accountCurrencyMap, rowCurrency, type RateBook } from '../import/fx'
import { daysBetween, resolveSelection, selectionPeriod } from './selections'

export type Normalize = 'total' | 'perDay' | 'perMonth'
export type CompareMode = 'samePoint' | 'full'

export interface SideResult {
  from: DateStr
  to: DateStr
  inProgress: boolean
  daysCounted: number
  total: number // normalized total spend
  totalRaw: number // raw base-currency spend (== last cumulative point)
  cumulative: number[] // raw running spend indexed by day 0..daysCounted-1
  excludedCount: number // rows dropped: non-base currency with no resolvable rate (tier-5)
  approxCount: number // rows converted via a nearest-earlier rate (render with `≈`)
}

export interface CompareResult {
  a: SideResult
  b: SideResult
  delta: number // a.total − b.total (normalized)
  /** Per-category normalized spend for both sides, sorted by |delta| desc (== movers). */
  byCategory: { categoryId: string; a: number; b: number; delta: number }[]
  normalize: Normalize
  mode: CompareMode
}

const DAYS_PER_MONTH = 30.44

/**
 * Spend of a row (expense-positive), **net of refunds** — the same Income/Refund/Transfer
 * trichotomy `derive()` applies (#13, selectors.ts): a positive amount in the Income-role category
 * is income and spends nothing; a positive anywhere else is a refund that nets its category down.
 * Transfers never reach here — `resolveSelection` drops them via `isCashflow`.
 *
 * This used to be gross (`amount < 0 ? -amount : 0`), which is why the Dashboard's "Spend · this
 * month" and a Plan budget row for the same category could disagree in a vault with refunds.
 */
const spend = (amount: number, categoryId: string, incomeCatId: string | undefined): number =>
  amount > 0 && categoryId === incomeCatId ? 0 : -amount

interface Resolved {
  from: DateStr
  to: DateStr
  fullLen: number
  elapsed: number
  inProgress: boolean
  rows: { day: number; cat: string; spend: number }[]
  excludedCount: number
  approxCount: number
}

function resolveSide(sel: Selection, vault: Vault, today: DateStr, rates?: RateBook): Resolved {
  const base = vault.params.baseCurrency ?? 'EUR'
  const incomeCatId = incomeCategoryId(vault)
  const accountCur = accountCurrencyMap(vault)
  const { from, to } = selectionPeriod(sel, vault, today)
  const fullLen = Math.max(1, daysBetween(from, to) + 1)
  const inProgress = today >= from && today <= to
  const elapsed = inProgress ? Math.max(0, daysBetween(from, today) + 1) : fullLen

  const rows: Resolved['rows'] = []
  let excludedCount = 0
  let approxCount = 0
  for (const t of resolveSelection(sel, vault, today)) {
    let amount = t.amount
    const cur = rowCurrency(t, accountCur, base)
    if (cur !== base) {
      // FX chain (Phase E): convert into base; exclude honestly only when unresolvable.
      const conv = rates?.convert(t.amount, cur, t.date)
      if (!conv) {
        excludedCount++
        continue
      }
      amount = conv.value
      if (conv.approx) approxCount++
    }
    rows.push({ day: daysBetween(from, t.date), cat: t.categoryId, spend: spend(amount, t.categoryId, incomeCatId) })
  }
  return { from, to, fullLen, elapsed, inProgress, rows, excludedCount, approxCount }
}

/**
 * ANALYTICS §5.3 — compare two selections. Same-point-in-time (default) truncates
 * a completed side to an in-progress side's elapsed length; the full-period switch
 * removes it. Totals/category breakdowns/cumulative respect the active mode and
 * normalization.
 */
export function compare(
  vault: Vault,
  selA: Selection,
  selB: Selection,
  today: DateStr,
  opts: { normalize?: Normalize; mode?: CompareMode; rates?: RateBook } = {},
): CompareResult {
  const normalize = opts.normalize ?? 'total'
  const mode = opts.mode ?? 'samePoint'
  const A = resolveSide(selA, vault, today, opts.rates)
  const B = resolveSide(selB, vault, today, opts.rates)

  // Same-point alignment: when exactly one side is in progress, both count only
  // its elapsed days. Otherwise each counts its own length.
  let alignLen = Infinity
  if (mode === 'samePoint' && A.inProgress !== B.inProgress) {
    alignLen = A.inProgress ? A.elapsed : B.elapsed
  }

  const factor = (daysCounted: number): number =>
    normalize === 'perDay' ? 1 / daysCounted : normalize === 'perMonth' ? DAYS_PER_MONTH / daysCounted : 1

  const build = (r: Resolved): { side: SideResult; byCat: Map<string, number> } => {
    const daysCounted = Math.min(r.inProgress ? r.elapsed : r.fullLen, alignLen)
    const cumulative = new Array<number>(Math.max(1, daysCounted)).fill(0)
    const byCatRaw = new Map<string, number>()
    let totalRaw = 0
    for (const row of r.rows) {
      if (row.day < 0 || row.day >= daysCounted) continue // outside the counted window
      cumulative[row.day]! += row.spend
      totalRaw += row.spend
      byCatRaw.set(row.cat, (byCatRaw.get(row.cat) ?? 0) + row.spend)
    }
    for (let i = 1; i < cumulative.length; i++) cumulative[i]! += cumulative[i - 1]!
    const f = factor(daysCounted)
    const byCat = new Map<string, number>()
    // A category whose refunds exceed its spend in the window floors at 0 — no negative bars and
    // no inverted movers, the same floor `derive()`'s `spentByCatMonth` applies. The side total and
    // the cumulative line are left signed: they are the honest figure, and a refund day dipping is
    // information rather than an artefact.
    for (const [c, v] of byCatRaw) byCat.set(c, Math.max(0, v) * f)
    return {
      side: {
        from: r.from,
        to: r.to,
        inProgress: r.inProgress,
        daysCounted,
        total: totalRaw * f,
        totalRaw,
        cumulative,
        excludedCount: r.excludedCount,
        approxCount: r.approxCount,
      },
      byCat,
    }
  }

  const a = build(A)
  const b = build(B)

  const cats = new Set([...a.byCat.keys(), ...b.byCat.keys()])
  const byCategory = [...cats]
    .map((categoryId) => {
      const av = a.byCat.get(categoryId) ?? 0
      const bv = b.byCat.get(categoryId) ?? 0
      return { categoryId, a: av, b: bv, delta: av - bv }
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

  return { a: a.side, b: b.side, delta: a.side.total - b.side.total, byCategory, normalize, mode }
}
