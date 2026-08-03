import type { DateStr, MonthKey, PeriodRef, Selection, Transaction, Vault } from '../model/types'
import { isCashflow } from '../model/types'
import { members } from '../model/trackings'

// ---------- pure DateStr arithmetic (no timezones, IMPORT §5.5 verbatim-date policy) ----------

export function parseDay(d: DateStr): number {
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
}

/** Calendar days from `a` to `b` (b − a); same day = 0. */
export function daysBetween(a: DateStr, b: DateStr): number {
  return Math.round((parseDay(b) - parseDay(a)) / 86400000)
}

export function addDays(d: DateStr, n: number): DateStr {
  return new Date(parseDay(d) + n * 86400000).toISOString().slice(0, 10)
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

export interface Period {
  from: DateStr
  to: DateStr
}

function monthPeriod(mk: MonthKey): Period {
  const y = Number(mk.slice(0, 4))
  const m = Number(mk.slice(5, 7))
  return { from: `${mk}-01`, to: `${mk}-${String(daysInMonth(y, m)).padStart(2, '0')}` }
}

function yearPeriod(year: number): Period {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/** ANALYTICS §5.2 — resolve a PeriodRef against `today` at render time. */
export function resolvePeriod(period: PeriodRef, today: DateStr): Period {
  if ('from' in period) return { from: period.from, to: period.to }
  if ('month' in period) return monthPeriod(period.month)
  if ('year' in period) return yearPeriod(period.year)
  const thisMonth = today.slice(0, 7)
  const thisYear = Number(today.slice(0, 4))
  switch (period.rel) {
    case 'thisMonth':
      return monthPeriod(thisMonth)
    case 'lastMonth':
      return monthPeriod(shiftMonth(thisMonth, -1))
    case 'thisYear':
      return yearPeriod(thisYear)
    case 'lastYear':
      return yearPeriod(thisYear - 1)
    case 'sameMonthLastYear':
      return monthPeriod(shiftMonth(thisMonth, -12))
  }
}

/**
 * Re-read a `PeriodRef` against an anchor month instead of against today.
 *
 * The Dashboard can be pointed at any month, and a pinned comparison saying "this month vs last
 * month" means "relative to what I am looking at" — so its relatives move with the anchor. An
 * absolute (`{month}`, `{year}`, `{from,to}`) says what it says and is returned untouched: a pin
 * built as "2026 vs 2025" must still read 2026 vs 2025 while the header sits on March.
 *
 * Anchored to the current month this is the identity, which is what makes the default Dashboard
 * behaviourally unchanged (see the round-trip property in tests/analytics/selections.test.ts).
 */
export function rebasePeriod(period: PeriodRef, anchor: MonthKey): PeriodRef {
  if (!('rel' in period)) return period
  const year = Number(anchor.slice(0, 4))
  switch (period.rel) {
    case 'thisMonth':
      return { month: anchor }
    case 'lastMonth':
      return { month: shiftMonth(anchor, -1) }
    case 'sameMonthLastYear':
      return { month: shiftMonth(anchor, -12) }
    case 'thisYear':
      return { year }
    case 'lastYear':
      return { year: year - 1 }
  }
}

/** The same, for a whole selection. An unscoped selection (no period) stays unscoped. */
export function rebaseSelection(sel: Selection, anchor: MonthKey): Selection {
  return sel.period ? { ...sel, period: rebasePeriod(sel.period, anchor) } : sel
}

function shiftMonth(mk: MonthKey, n: number): MonthKey {
  const y = Number(mk.slice(0, 4))
  const m = Number(mk.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

/** Normalized contains-match for merchant queries. */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim()
}

/**
 * ANALYTICS §5.1 — resolve a Selection to a transaction set: intersect period,
 * categories, tracking members, accounts, merchant query; drop non-cashflow
 * (transfer legs) unless `includeNonCashflow`. Pure over (selection, vault, today).
 */
export function resolveSelection(sel: Selection, vault: Vault, today: DateStr): Transaction[] {
  const period = sel.period ? resolvePeriod(sel.period, today) : null
  const catSet = sel.categoryIds?.length ? new Set(sel.categoryIds) : null
  const accSet = sel.accountIds?.length ? new Set(sel.accountIds) : null
  const q = sel.merchantQuery ? norm(sel.merchantQuery) : null

  // Union of members across the selected trackings (OR within the field).
  let trackSet: Set<string> | null = null
  if (sel.trackingIds?.length) {
    trackSet = new Set()
    for (const tid of sel.trackingIds) for (const id of members(tid, vault)) trackSet.add(id)
  }

  const out: Transaction[] = []
  for (const t of vault.transactions) {
    if (period && (t.date < period.from || t.date > period.to)) continue
    if (catSet && !catSet.has(t.categoryId)) continue
    if (accSet && (t.accountId == null || !accSet.has(t.accountId))) continue
    if (trackSet && !trackSet.has(t.id)) continue
    if (q && !norm(t.merchant).includes(q)) continue
    if (!sel.includeNonCashflow && !isCashflow(t)) continue
    out.push(t)
  }
  return out
}

/** The resolved period of a selection, falling back to its data range when unscoped. */
export function selectionPeriod(sel: Selection, vault: Vault, today: DateStr): Period {
  if (sel.period) return resolvePeriod(sel.period, today)
  const dates = resolveSelection(sel, vault, today).map((t) => t.date)
  if (dates.length === 0) return { from: today, to: today }
  return { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) }
}
