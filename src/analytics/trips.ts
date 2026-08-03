// Trip/tracking analytics (ANALYTICS §8). Pure over (vault, trackingId, today).
// Trip spend counts cash-flow expenses among the tracking's members; foreign rows
// convert through the RateBook when supplied, else count in `foreignCount` for the
// currency footnote.
import type { DateStr, Vault } from '../model/types'
import { accountCurrencyMap, rowCurrency, type RateBook } from '../import/fx'
import { isCashflow, monthKeyOf, round2 } from '../model/selectors'
import { members, inWindow } from '../model/trackings'
import { addDays, daysBetween } from './selections'

export interface TripSummary {
  trackingId: string
  total: number // total spend in base currency
  days: number // the effective span (see `trackingSpan`)
  perDay: number
  /** The effective span's bounds — what every screen should print as the trip's dates. */
  spanFrom?: DateStr
  spanTo?: DateStr
  byCategory: { categoryId: string; spend: number }[] // desc
  currencies: string[] // non-base currencies present (footnote)
  foreignCount: number // rows that couldn't convert (excluded from total)
  approxCount: number // rows converted via nearest-earlier rate
  memberCount: number
}

/**
 * The days a tracking effectively covers: the **union** of its stored window and its members'
 * dates, not the window alone.
 *
 * A trip created from a transaction's `trip ▾` chip gets a single-day window at that row's date
 * (`TrackingChips.createTrip`) and never widens as more rows are added by `include`. Reading the
 * window alone then reports a 32-row trip as "1 day · €1,880/day" — and disagrees with Compare,
 * which derives a tracking selection's period from the resolved rows (`selectionPeriod`). The
 * union is what Compare already reports, so this makes the two screens agree.
 *
 * The stored window is deliberately NOT widened to match: `members()` is window-derived, so
 * growing `dateFrom`/`dateTo` would silently pull in every unrelated row in the widened range.
 * This is a reporting span, not a membership change.
 */
function trackingSpan(vault: Vault, trackingId: string, memberDates: DateStr[]): { from?: DateStr; to?: DateStr; days: number } {
  const tr = vault.trackings.find((t) => t.id === trackingId)
  const dates = [...memberDates]
  if (tr?.dateFrom != null) dates.push(tr.dateFrom)
  if (tr?.dateTo != null) dates.push(tr.dateTo)
  if (dates.length === 0) return { days: 1 }
  const from = dates.reduce((a, b) => (a < b ? a : b))
  const to = dates.reduce((a, b) => (a > b ? a : b))
  return { from, to, days: Math.max(1, daysBetween(from, to) + 1) }
}

interface TripRow {
  date: DateStr
  categoryId: string
  spend: number // positive, base currency
}

/**
 * The members of a tracking, resolved once: expense cash-flow converted to base, plus the
 * currency-footnote counters and every member's date. `tripSummary` folds these; `tripDaily`
 * buckets them. Private — the two exports below are the API.
 */
function tripRows(vault: Vault, trackingId: string, base: string, rates?: RateBook) {
  const mem = members(trackingId, vault)
  const accountCur = accountCurrencyMap(vault)
  const rows: TripRow[] = []
  const currencies = new Set<string>()
  const memberDates: DateStr[] = []
  let foreignCount = 0
  let approxCount = 0
  for (const t of vault.transactions) {
    if (!mem.has(t.id)) continue
    memberDates.push(t.date)
    if (!isCashflow(t) || t.amount >= 0) continue // trip spend = expense cash-flow
    let amount = t.amount
    const cur = rowCurrency(t, accountCur, base)
    if (cur !== base) {
      currencies.add(cur)
      const conv = rates?.convert(t.amount, cur, t.date)
      if (!conv) {
        foreignCount++
        continue
      }
      amount = conv.value
      if (conv.approx) approxCount++
    }
    rows.push({ date: t.date, categoryId: t.categoryId, spend: -amount })
  }
  return { rows, memberDates, currencies, foreignCount, approxCount, memberCount: mem.size }
}

export function tripSummary(vault: Vault, trackingId: string, base = 'EUR', rates?: RateBook): TripSummary {
  const { rows, memberDates, currencies, foreignCount, approxCount, memberCount } = tripRows(vault, trackingId, base, rates)
  const byCat = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    total += r.spend
    byCat.set(r.categoryId, (byCat.get(r.categoryId) ?? 0) + r.spend)
  }
  const span = trackingSpan(vault, trackingId, memberDates)
  const byCategory = [...byCat.entries()]
    .map(([categoryId, spend]) => ({ categoryId, spend: round2(spend) }))
    .sort((a, b) => b.spend - a.spend)
  return {
    trackingId,
    total: round2(total),
    days: span.days,
    perDay: round2(total / span.days),
    spanFrom: span.from,
    spanTo: span.to,
    byCategory,
    currencies: [...currencies].sort(),
    foreignCount,
    approxCount,
    memberCount,
  }
}

export interface TripDay {
  date: DateStr
  spend: number
  /** Per-category spend for that day, so the chart can stack it the way Trends stacks a month. */
  byCategory: Record<string, number>
}

/**
 * Spend per calendar day across a trip's effective span, zero-filled and split by category.
 *
 * Zero-filled rather than sparse because a quiet day inside a trip is information — a gapped
 * series would draw a five-day trip as three bars and imply it was three days long.
 */
export function tripDaily(vault: Vault, trackingId: string, base = 'EUR', rates?: RateBook): TripDay[] {
  const { rows, memberDates } = tripRows(vault, trackingId, base, rates)
  const span = trackingSpan(vault, trackingId, memberDates)
  if (span.from == null || span.to == null) return []
  const byDay = new Map<string, { spend: number; byCategory: Record<string, number> }>()
  for (const r of rows) {
    const e = byDay.get(r.date) ?? { spend: 0, byCategory: {} }
    e.spend += r.spend
    e.byCategory[r.categoryId] = (e.byCategory[r.categoryId] ?? 0) + r.spend
    byDay.set(r.date, e)
  }
  const out: TripDay[] = []
  for (let d = span.from; d <= span.to; d = addDays(d, 1)) {
    const e = byDay.get(d)
    const byCategory: Record<string, number> = {}
    for (const [k, v] of Object.entries(e?.byCategory ?? {})) byCategory[k] = round2(v)
    out.push({ date: d, spend: round2(e?.spend ?? 0), byCategory })
  }
  return out
}

export interface ExcludeSuggestion {
  /** Every in-window charge from this payee — one toggle covers them all. */
  txnIds: string[]
  merchant: string
  total: number // combined, signed as stored (negative)
  reason: string
}

/** Stable key for "is this the same recurring payee?": SEPA creditor/ref, else counterparty, else merchant. */
export function recurKey(t: { ref?: string; counterparty?: string; merchant: string }): string | null {
  const cid = t.ref // creditor/ref proxy for SEPA
  if (cid && /^[A-Z]{2}\w{5,}/.test(cid)) return `ref:${cid}`
  if (t.counterparty) return `cp:${t.counterparty}`
  return `m:${t.merchant.toUpperCase()}`
}

/**
 * Recurring-payee keys → how many distinct months they appear in OUTSIDE the window
 * (expenses only). A key present in ≥2 outside months is treated as a recurring home bill.
 *
 * Only months within `nearDays` either side of the window count. A monthly bill brackets a trip —
 * it is charged in the months right before and after it. A shop in a city you revisit does not:
 * counting a payee's whole history flagged Marks & Spencer and Transport for London as "recurring"
 * during a London trip purely because the previous year's visit was also to London.
 */
export function recurringMonths(
  vault: Vault,
  window: { dateFrom?: DateStr; dateTo?: DateStr },
  opts: { nearDays?: number } = {},
): Map<string, number> {
  const nearDays = opts.nearDays ?? 120
  const lo = window.dateFrom != null ? addDays(window.dateFrom, -nearDays) : undefined
  const hi = window.dateTo != null ? addDays(window.dateTo, nearDays) : undefined
  const outMonths = new Map<string, Set<string>>()
  for (const t of vault.transactions) {
    if (t.amount >= 0) continue
    if (inWindow(t.date, window)) continue
    if (lo != null && t.date < lo) continue
    if (hi != null && t.date > hi) continue
    const k = recurKey({ ref: t.importMeta?.ref, counterparty: t.counterparty, merchant: t.merchant })
    if (!k) continue
    const s = outMonths.get(k) ?? new Set<string>()
    s.add(monthKeyOf(t.date))
    outMonths.set(k, s)
  }
  const out = new Map<string, number>()
  for (const [k, months] of outMonths) if (months.size >= 2) out.set(k, months.size)
  return out
}

/**
 * ANALYTICS §8.2 — suggest excluding rows that look like recurring home bills that happen to fall
 * in the window: a direct-debit / SEPA creditor (or same merchant) that also appears in ≥2 distinct
 * months nearby but OUTSIDE the window. Each carries a stated reason; the user flips any back.
 *
 * One suggestion per payee, not per row: a merchant billed twice inside the window used to produce
 * two identical rows with two independent toggles, which reads as a list of duplicates and lets
 * you exclude half a bill.
 */
export function suggestExcludes(vault: Vault, tracking: { id: string; dateFrom?: DateStr; dateTo?: DateStr }): ExcludeSuggestion[] {
  if (!tracking.dateFrom || !tracking.dateTo) return []
  const recurring = recurringMonths(vault, tracking)
  // In-window rows are the trip's members at creation time; use the window directly so this works
  // for a not-yet-created draft (the Trips-page preview and import detection both pass a draft id).
  const byKey = new Map<string, ExcludeSuggestion>()
  for (const t of vault.transactions) {
    if (!inWindow(t.date, tracking) || t.amount >= 0) continue
    const k = recurKey({ ref: t.importMeta?.ref, counterparty: t.counterparty, merchant: t.merchant })
    if (!k) continue
    const n = recurring.get(k)
    if (!n) continue
    const existing = byKey.get(k)
    if (existing) {
      existing.txnIds.push(t.id)
      existing.total = round2(existing.total + t.amount)
      continue
    }
    // "n other months", not "n months outside the trip": the old wording read as though the number
    // described the trip's own period, which is the first thing people asked about it.
    const label = k.startsWith('ref:')
      ? `direct debit ${t.importMeta!.ref} — also charged in ${n} other months`
      : `also charged in ${n} other months`
    byKey.set(k, { txnIds: [t.id], merchant: t.merchant, total: round2(t.amount), reason: label })
  }
  return [...byKey.values()]
}

export interface TripForecast {
  perDayMedian: number
  projected: number
  comparableCount: number
}

/** BRIEF §8-3 — median €/day of comparable past trips × planned days (nothing stored). */
export function tripForecast(vault: Vault, comparableIds: string[], plannedDays: number, base = 'EUR', rates?: RateBook): TripForecast {
  const perDays = comparableIds.map((id) => tripSummary(vault, id, base, rates).perDay).filter((v) => v > 0).sort((a, b) => a - b)
  if (perDays.length === 0) return { perDayMedian: 0, projected: 0, comparableCount: 0 }
  const mid = Math.floor(perDays.length / 2)
  const median = perDays.length % 2 ? perDays[mid]! : (perDays[mid - 1]! + perDays[mid]!) / 2
  return { perDayMedian: round2(median), projected: round2(median * plannedDays), comparableCount: perDays.length }
}
