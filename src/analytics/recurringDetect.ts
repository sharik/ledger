// Local recurrence detection (no network): spot a merchant whose debits land at a
// steady cadence and near-constant amount — a subscription. Pure over a minimal shape
// so it runs over committed transactions; it only ever *suggests* — the user confirms
// before any `recurring` flag is written (#12b). Conservatively gated so an ordinary
// merchant paid a few times is never mistaken for a subscription.
import type { DateStr } from '../model/types'
import { daysBetween } from './selections'

/** Minimal projection a committed `Transaction` supplies. */
export interface RecurringTxn {
  id: string
  date: DateStr
  amount: number // signed base-currency amount (− expense)
  merchant: string
  recurring?: 'monthly' | 'yearly' // already marked, if any
}

export interface RecurringCandidate {
  merchant: string // the merchant as last seen (display)
  cadence: 'monthly' | 'yearly'
  txnIds: string[] // every occurrence in the run
  count: number
  typicalAmount: number // median expense magnitude, base currency
  lastDate: DateStr
}

export interface RecurringDetectOpts {
  minCount?: number // ignore runs shorter than this (default 3 — two intervals to confirm a cadence)
  amountTolerance?: number // max fractional spread of amounts around the median (default 0.15)
}

// A cadence's accepted gap band in days: monthly ≈ a calendar month, yearly ≈ a year,
// each widened enough to absorb weekends/short months without admitting the other.
const BANDS: { cadence: 'monthly' | 'yearly'; lo: number; hi: number }[] = [
  { cadence: 'monthly', lo: 26, hi: 35 },
  { cadence: 'yearly', lo: 330, hi: 400 },
]

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Normalize a merchant into a grouping key: lowercased, whitespace-collapsed, and with
 *  a trailing reference token dropped — a `#`/`*` ref (e.g. `NETFLIX #4821` → `netflix`,
 *  `SPOTIFY #A1` → `spotify`) or a standalone numeric ref (e.g. `CLOUD 8842` → `cloud`).
 *  Shared with the Transactions grouped-merchant view (#11e). */
export function merchantKey(m: string): string {
  return m
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*[#*]\S*$/, '')
    .replace(/\s+\d{2,}$/, '')
    .trim()
}

/**
 * Group expense rows by merchant and flag any group whose occurrences recur at a single
 * cadence (monthly/yearly) with a near-constant amount. Returns one candidate per run,
 * ordered by occurrence count descending. Income/refunds (amount ≥ 0) are ignored.
 */
export function detectRecurring(txns: RecurringTxn[], opts: RecurringDetectOpts = {}): RecurringCandidate[] {
  const minCount = opts.minCount ?? 3
  const tol = opts.amountTolerance ?? 0.15

  const groups = new Map<string, RecurringTxn[]>()
  for (const t of txns) {
    if (t.amount >= 0) continue // only debits can be a subscription
    const key = merchantKey(t.merchant)
    if (!key) continue
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  const out: RecurringCandidate[] = []
  for (const rows of groups.values()) {
    if (rows.length < minCount) continue
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

    // Amounts must be near-constant — a subscription doesn't swing month to month.
    const mags = rows.map((t) => -t.amount)
    const medAmt = median(mags)
    if (medAmt <= 0) continue
    const spread = Math.max(...mags) - Math.min(...mags)
    if (spread > tol * medAmt + 0.01) continue

    // Consecutive gaps must fall in one cadence band. The median gap picks the band;
    // require most gaps inside it so a single stray interval doesn't disqualify a run.
    const gaps: number[] = []
    for (let i = 1; i < rows.length; i++) gaps.push(daysBetween(rows[i - 1]!.date, rows[i]!.date))
    const medGap = median(gaps)
    const band = BANDS.find((b) => medGap >= b.lo && medGap <= b.hi)
    if (!band) continue
    const inBand = gaps.filter((g) => g >= band.lo && g <= band.hi).length
    if (inBand < Math.ceil(gaps.length * 0.7)) continue

    out.push({
      merchant: rows[rows.length - 1]!.merchant,
      cadence: band.cadence,
      txnIds: rows.map((t) => t.id),
      count: rows.length,
      typicalAmount: Math.round(medAmt * 100) / 100,
      lastDate: rows[rows.length - 1]!.date,
    })
  }
  return out.sort((a, b) => b.count - a.count)
}
