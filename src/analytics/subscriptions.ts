// The recurring/subscriptions aggregate (QUESTIONARY §9, prerequisite P2).
//
// The detector already existed — `recurringDetect` — and was trusted for a one-row
// suggestion strip on Transactions. What was missing was the VIEW: a total, and the three
// states that answer "which of these are new, went up, or stopped".
//
// Two rules are load-bearing and are stated in the UI, not just here:
//
//  1. THE TOTAL COUNTS CONFIRMED ROWS ONLY. A subscription is confirmed when the user has
//     marked `t.recurring`. Detected-but-unconfirmed merchants are returned separately and
//     are NOT in the total — a figure that silently included guesses would be a guess.
//
//  2. `expectedNext` IS A CADENCE, NEVER A DUE DATE. It is the last charge plus the median
//     gap in the user's own history. Ledger has no billing calendar; the questionary refuses
//     Q15–Q20 for exactly this reason, and the label must say "expected ≈", never "due".
import type { DateStr, Transaction, Vault } from '../model/types'
import { addDays, daysBetween } from './selections'
import { detectRecurring, merchantKey, type RecurringTxn } from './recurringDetect'
import { round2, vaultOnlyBook } from '../model/selectors'
import { rowConverter, type RateBook } from '../import/fx'

/** How a confirmed subscription has changed against its own history. */
export type SubState = 'steady' | 'new' | 'increased' | 'decreased' | 'lapsed'

export interface SubRow {
  key: string
  merchant: string
  cadence: 'monthly' | 'yearly'
  /** Median charge, base currency, positive. */
  typical: number
  /** The most recent charge amount, positive. */
  latest: number
  lastDate: DateStr
  /** The earliest charge in the run — how far back this actually goes. */
  firstDate: DateStr
  /** Last charge + the median gap. A pattern — never presented as a due date. */
  expectedNext: DateStr
  state: SubState
  /** Percent change of the latest charge against the median of the earlier ones. */
  deltaPct: number | null
  count: number
  /**
   * Everything this merchant has charged across the run, in base currency. "Counted", not
   * "paid ever": it covers the rows that are imported and marked, which is all Ledger can see.
   */
  totalCounted: number
  /** The same total split by calendar year, newest first. */
  byYear: { year: number; count: number; total: number }[]
  txnIds: string[]
  /** True when the user has marked these rows recurring; false for a mere detection. */
  confirmed: boolean
}

export interface Subscriptions {
  /** Confirmed rows, most expensive per month first. */
  rows: SubRow[]
  /** Detected but not yet marked — listed apart, never in the totals. */
  unconfirmed: SubRow[]
  /** Confirmed monthly charges only. */
  monthlyTotal: number
  /** Monthly × 12 + yearly, for the "what does this cost me a year" question. */
  annualisedTotal: number
}

const BAND = { monthly: { lo: 26, hi: 35 }, yearly: { lo: 330, hi: 400 } } as const
/** Nothing since 1.5 cadence periods ⇒ the charge has stopped. */
const LAPSE_FACTOR = 1.5
/** Matches the detector's amount tolerance — below this, a change is noise, not a price rise. */
const CHANGE_TOL = 0.15

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function stateOf(mags: number[], lastDate: DateStr, cadence: 'monthly' | 'yearly', today: DateStr): { state: SubState; deltaPct: number | null } {
  const band = BAND[cadence]
  const sinceLast = daysBetween(lastDate, today)
  if (sinceLast > band.hi * LAPSE_FACTOR) return { state: 'lapsed', deltaPct: null }

  // "New" = the whole run fits inside the last two cadence periods.
  const latest = mags[mags.length - 1]!
  const priors = mags.slice(0, -1)
  if (priors.length === 0) return { state: 'new', deltaPct: null }

  const base = median(priors)
  if (base <= 0) return { state: 'steady', deltaPct: null }
  const change = (latest - base) / base
  if (Math.abs(change) <= CHANGE_TOL) return { state: 'steady', deltaPct: null }
  return { state: change > 0 ? 'increased' : 'decreased', deltaPct: Math.round(change * 100) }
}

function buildRow(rows: RecurringTxn[], cadence: 'monthly' | 'yearly', today: DateStr, confirmed: boolean, firstSeenNew: boolean): SubRow {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const mags = sorted.map((t) => -t.amount)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1]!.date, sorted[i]!.date))
  const gap = gaps.length ? median(gaps) : cadence === 'yearly' ? 365 : 30
  const lastDate = sorted[sorted.length - 1]!.date
  const s = stateOf(mags, lastDate, cadence, today)
  const perYear = new Map<number, { count: number; total: number }>()
  for (const t of sorted) {
    const y = Number(t.date.slice(0, 4))
    const cur = perYear.get(y) ?? { count: 0, total: 0 }
    cur.count++
    cur.total = round2(cur.total + -t.amount)
    perYear.set(y, cur)
  }
  return {
    key: merchantKey(sorted[0]!.merchant),
    merchant: sorted[sorted.length - 1]!.merchant,
    cadence,
    typical: round2(median(mags)),
    latest: round2(mags[mags.length - 1]!),
    lastDate,
    firstDate: sorted[0]!.date,
    totalCounted: round2(mags.reduce((a, b) => a + b, 0)),
    byYear: [...perYear.entries()]
      .map(([year, v]) => ({ year, count: v.count, total: v.total }))
      .sort((a, b) => b.year - a.year),
    expectedNext: addDays(lastDate, Math.round(gap)),
    state: firstSeenNew && s.state === 'steady' ? 'new' : s.state,
    deltaPct: s.deltaPct,
    count: sorted.length,
    txnIds: sorted.map((t) => t.id),
    confirmed,
  }
}

/**
 * Confirmed subscriptions (grouped from `t.recurring`) plus detector suggestions that have
 * not been confirmed. Only the confirmed set contributes to the totals.
 *
 * Every amount is converted to BASE currency up front (same FX chain as derive();
 * a row with no resolvable rate is excluded honestly) — the docs on `typical` and
 * `totalCounted` say "base currency", and detection tolerance must not compare
 * hryvnias against euros.
 */
export function subscriptions(vault: Vault, today: DateStr, rates?: RateBook): Subscriptions {
  const conv = rowConverter(vault, rates ?? vaultOnlyBook(vault))
  const toBase = (t: Transaction): RecurringTxn | null => {
    const amt = conv(t)
    if (amt === null) return null
    return { id: t.id, date: t.date, amount: amt, merchant: t.merchant, recurring: t.recurring }
  }

  // --- confirmed: grouped straight from the user's own marks ---
  const marked = new Map<string, { cadence: 'monthly' | 'yearly'; rows: RecurringTxn[] }>()
  for (const t of vault.transactions) {
    if (!t.recurring || t.amount >= 0) continue
    const key = merchantKey(t.merchant)
    if (!key) continue
    const row = toBase(t)
    if (!row) continue
    const g = marked.get(key) ?? { cadence: t.recurring, rows: [] }
    g.cadence = t.recurring
    g.rows.push(row)
    marked.set(key, g)
  }

  const rows: SubRow[] = []
  for (const [, g] of marked) {
    const band = BAND[g.cadence]
    const first = [...g.rows].sort((a, b) => (a.date < b.date ? -1 : 1))[0]!
    const firstSeenNew = daysBetween(first.date, today) <= band.hi * 2
    rows.push(buildRow(g.rows, g.cadence, today, true, firstSeenNew))
  }

  // --- unconfirmed: what the detector sees that the user has not marked ---
  const confirmedKeys = new Set(rows.map((r) => r.key))
  const unconfirmed: SubRow[] = []
  const converted = vault.transactions.map(toBase).filter((t): t is RecurringTxn => t !== null)
  const byId = new Map(converted.map((t) => [t.id, t]))
  for (const c of detectRecurring(converted)) {
    const key = merchantKey(c.merchant)
    if (confirmedKeys.has(key)) continue
    const rowsFor = c.txnIds.map((id) => byId.get(id)).filter((t): t is RecurringTxn => !!t)
    if (rowsFor.length === 0) continue
    unconfirmed.push(buildRow(rowsFor, c.cadence, today, false, false))
  }

  const live = rows.filter((r) => r.state !== 'lapsed')
  const monthlyTotal = round2(live.filter((r) => r.cadence === 'monthly').reduce((s, r) => s + r.typical, 0))
  const yearlyTotal = round2(live.filter((r) => r.cadence === 'yearly').reduce((s, r) => s + r.typical, 0))

  const rank = (r: SubRow) => (r.cadence === 'monthly' ? r.typical : r.typical / 12)
  return {
    rows: rows.sort((a, b) => rank(b) - rank(a)),
    unconfirmed: unconfirmed.sort((a, b) => rank(b) - rank(a)),
    monthlyTotal,
    annualisedTotal: round2(monthlyTotal * 12 + yearlyTotal),
  }
}
