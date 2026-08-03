// Local trip detection (no network): cluster foreign-currency spend by date.
// A run of card payments in a currency that isn't your home currency, close
// together in time, is almost always a trip abroad — the Iceland trip in a
// French BNP export shows up as a fortnight of `ISK` card rows. The detector
// is pure over a minimal shape so it runs on both committed transactions
// (Trips page) and not-yet-imported rows (import review).
import type { DateStr } from '../model/types'
import { addDays, daysBetween } from './selections'

/** Minimal projection both `Transaction` and an import `NormalizedRow` can supply. */
export interface DetectTxn {
  id: string // txn id, or the import row hash
  date: DateStr
  amount: number // signed base-currency amount (+ income, − expense)
  currency?: string // foreign leg currency, when the row was charged abroad
  merchant: string
}

export interface TripCandidate {
  name: string
  dateFrom: DateStr
  dateTo: DateStr
  /**
   * What kind of evidence produced this candidate. The UI must branch on this rather than on
   * `currency !== home`: a density candidate's `currency` IS the home currency, and rendering it
   * as "57 EUR payments" reads as nonsense to someone whose whole ledger is in EUR.
   */
  kind: 'foreign' | 'density'
  currency: string // dominant foreign currency in the cluster (home currency for `density`)
  txnIds: string[] // the foreign-currency rows — the definitely-trip ones
  count: number
  total: number // rough spend, base currency
  /** `density` only: the multiple of the usual daily rate this window ran at, for the UI's "why". */
  rateMultiple?: number
}

export interface DetectOpts {
  home?: string // home/base currency (default 'EUR')
  gapDays?: number // split a cluster when consecutive foreign rows are more than this apart (default 7)
  minCount?: number // ignore clusters with fewer foreign rows than this (default 3)
  strongAmount?: number // a 2-row cluster still qualifies if its largest charge ≥ this — a hotel/
  // flight-sized signal, so a short trip with only two foreign rows isn't missed (#16c, default 300)
}

/** ISO-4217 → a human place name for the trip. Common travel currencies only; the rest fall back to "<CUR> trip". */
const CURRENCY_PLACE: Record<string, string> = {
  ISK: 'Iceland', JPY: 'Japan', GBP: 'UK', USD: 'USA', CHF: 'Switzerland',
  SEK: 'Sweden', NOK: 'Norway', DKK: 'Denmark', PLN: 'Poland', CZK: 'Czechia',
  HUF: 'Hungary', RON: 'Romania', BGN: 'Bulgaria', HRK: 'Croatia', THB: 'Thailand',
  TRY: 'Türkiye', AED: 'UAE', MAD: 'Morocco', EGP: 'Egypt', ZAR: 'South Africa',
  CAD: 'Canada', AUD: 'Australia', NZD: 'New Zealand', SGD: 'Singapore', HKD: 'Hong Kong',
  CNY: 'China', KRW: 'South Korea', INR: 'India', IDR: 'Indonesia', VND: 'Vietnam',
  MXN: 'Mexico', BRL: 'Brazil', ARS: 'Argentina', RSD: 'Serbia', GEL: 'Georgia',
}

/** Name a cluster from its dominant currency: a place when we know it, else "<CUR> trip". */
export function tripNameFor(currency: string): string {
  return CURRENCY_PLACE[currency] ?? `${currency} trip`
}

/**
 * Group foreign-currency rows into candidate trips. Rows are sorted by date and
 * split into clusters wherever a gap exceeds `gapDays`; each cluster is then
 * partitioned by currency, so an Iceland (ISK) run and a Vietnam (VND) run that fall
 * within `gapDays` of each other surface as two candidates rather than one named after
 * whichever currency happened to dominate. Currency groups with fewer than `minCount`
 * rows are dropped, so a one-off foreign online purchase is never a trip.
 */
export function detectTrips(txns: DetectTxn[], opts: DetectOpts = {}): TripCandidate[] {
  const home = opts.home ?? 'EUR'
  const gapDays = opts.gapDays ?? 7
  const minCount = opts.minCount ?? 3
  const strongAmount = opts.strongAmount ?? 300

  const foreign = txns
    .filter((t) => t.currency && t.currency !== home)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const clusters: DetectTxn[][] = []
  for (const t of foreign) {
    const last = clusters[clusters.length - 1]
    if (last && daysBetween(last[last.length - 1]!.date, t.date) <= gapDays) last.push(t)
    else clusters.push([t])
  }

  const out: TripCandidate[] = []
  for (const cl of clusters) {
    // One trip per currency in the cluster — each is a distinct destination.
    const byCurrency = new Map<string, DetectTxn[]>()
    for (const t of cl) {
      const arr = byCurrency.get(t.currency!) ?? []
      arr.push(t)
      byCurrency.set(t.currency!, arr)
    }
    for (const [currency, rows] of byCurrency) {
      // A cluster qualifies at `minCount` rows, or at 2 rows when one is a large charge — a
      // hotel or flight is a strong enough signal that even a short foreign run is a trip (#16c).
      const strong = rows.length >= 2 && rows.some((t) => (t.amount < 0 ? -t.amount : 0) >= strongAmount)
      if (rows.length < minCount && !strong) continue
      const total = rows.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0)
      out.push({
        name: tripNameFor(currency),
        dateFrom: rows[0]!.date,
        dateTo: rows[rows.length - 1]!.date,
        kind: 'foreign',
        currency,
        txnIds: rows.map((t) => t.id),
        count: rows.length,
        total: Math.round(total * 100) / 100,
      })
    }
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export interface HomeDetectOpts extends DetectOpts {
  densityFactor?: number // a window's per-CALENDAR-day spend must exceed this × the baseline daily rate (default 3)
  floor?: number // and its total must clear this, so a cheap busy week never reads as a trip (default 300)
  maxDays?: number // hard cap on a candidate's length — nothing longer is a trip anyone would recognise (default 21)
  recurMonths?: number // a payee seen in this many distinct months is a bill, not a trip (default 3)
  dominantShare?: number // reject a window where one charge is more than this share of its total (default 0.6)
}

/**
 * Payees that appear in `minMonths` or more distinct months — rent, utilities, insurance, the
 * phone bill.
 *
 * These have to leave the density pass entirely, not merely be tolerated by it. A month's fixed
 * costs land in a tight cluster at the start of the month across several different payees, which
 * is precisely the shape this detector looks for: on a real ledger it produced one "trip" per
 * month, 39 of them, every one of them the same handful of direct debits. A trip is spending on
 * payees you do not normally use; a bill is the opposite by definition.
 */
function recurringMerchants(rows: DetectTxn[], minMonths: number): Set<string> {
  const months = new Map<string, Set<string>>()
  for (const t of rows) {
    const k = t.merchant.toUpperCase()
    const s = months.get(k) ?? new Set<string>()
    s.add(t.date.slice(0, 7))
    months.set(k, s)
  }
  const out = new Set<string>()
  for (const [k, m] of months) if (m.size >= minMonths) out.add(k)
  return out
}

/**
 * The usual daily spending rate: the median over every 7-day calendar window of that window's
 * total ÷ 7.
 *
 * The previous baseline was `median(totals of days you spent anything)`, compared against a
 * cluster's `total / distinctActiveDays`. Both halves were wrong together: the left side is a
 * median *day* and the right a mean over a whole cluster, so for heavy-tailed daily spending the
 * ratio cleared 3× on ordinary weeks. A rolling calendar-window rate compares like with like, and
 * a window's own quiet days drag its rate down — which is the point, since a real trip has none.
 *
 * Windows with no spend at all are skipped rather than counted as zero. On a dense ledger almost
 * every window has something, so this is the plain rolling median; on a sparse one (a few charges
 * a month) the plain median would be exactly 0 and every candidate would clear `3 × 0`, which is
 * both useless and the opposite of conservative.
 */
function baselineDailyRate(byDay: Map<string, number>, from: DateStr, to: DateStr): number {
  const span = daysBetween(from, to) + 1
  if (span < 7) return 0
  const daily: number[] = []
  for (let i = 0, d = from; i < span; i++, d = addDays(d, 1)) daily.push(byDay.get(d) ?? 0)
  let win = daily.slice(0, 7).reduce((a, b) => a + b, 0)
  const rates = win > 0 ? [win / 7] : []
  for (let i = 7; i < daily.length; i++) {
    win += daily[i]! - daily[i - 7]!
    if (win > 0) rates.push(win / 7)
  }
  return median(rates)
}

/**
 * Best-effort detection of a *home-currency* trip (#16a). A trip inside your own currency
 * zone (an EUR account touring the Eurozone) leaves no foreign-currency rows, so `detectTrips`
 * can't see it — the only signal left is spending density: a burst of days spending far above
 * your normal rate. This is inherently approximate (a shopping spree at home looks similar), so
 * it is deliberately conservative — high thresholds, a date-based name — and, like every
 * detector here, only ever *suggests*; the user confirms before anything is written.
 */
export function detectHomeTrips(txns: DetectTxn[], opts: HomeDetectOpts = {}): TripCandidate[] {
  const home = opts.home ?? 'EUR'
  const gapDays = opts.gapDays ?? 5
  const minCount = opts.minCount ?? 5
  const densityFactor = opts.densityFactor ?? 3
  const floor = opts.floor ?? 300
  const maxDays = opts.maxDays ?? 21
  const recurMonths = opts.recurMonths ?? 3
  const dominantShare = opts.dominantShare ?? 0.6

  const all = txns
    .filter((t) => (!t.currency || t.currency === home) && t.amount < 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (all.length < minCount) return []

  // The baseline is what you ACTUALLY spend per day, bills included — that is the rate a trip has
  // to stand out against, and dropping the regular payees from it would leave a near-zero bar that
  // any cluster clears (in effect measuring a burst against itself).
  const byDay = new Map<string, number>()
  for (const t of all) byDay.set(t.date, (byDay.get(t.date) ?? 0) - t.amount)
  const baseline = baselineDailyRate(byDay, all[0]!.date, all[all.length - 1]!.date)
  if (baseline <= 0) return []

  // Clusters, though, are built only from payees that are NOT part of your monthly routine: a
  // month's fixed costs land together at the start of every month and would otherwise be offered
  // as a trip, every month.
  const regulars = recurringMerchants(all, recurMonths)
  const rows = all.filter((t) => !regulars.has(t.merchant.toUpperCase()))
  if (rows.length < minCount) return []

  // Cluster by date gap AND by a hard length cap. Without the cap the chain never terminates for
  // someone who spends most days — on the real vault a single cluster ran 31 Oct to 17 Dec.
  const clusters: DetectTxn[][] = []
  for (const t of rows) {
    const last = clusters[clusters.length - 1]
    const withinGap = last != null && daysBetween(last[last.length - 1]!.date, t.date) <= gapDays
    const withinCap = last != null && daysBetween(last[0]!.date, t.date) + 1 <= maxDays
    if (withinGap && withinCap) last.push(t)
    else clusters.push([t])
  }

  const out: TripCandidate[] = []
  for (const cl of clusters) {
    const best = bestWindow(cl, { minCount, densityFactor, floor, maxDays, baseline, dominantShare })
    if (!best) continue
    const from = best.rows[0]!.date
    out.push({
      name: `Trip · ${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`,
      dateFrom: from,
      dateTo: best.rows[best.rows.length - 1]!.date,
      kind: 'density',
      currency: home,
      txnIds: best.rows.map((t) => t.id),
      count: best.rows.length,
      total: Math.round(best.total * 100) / 100,
      rateMultiple: Math.round((best.total / best.span / baseline) * 10) / 10,
    })
  }
  return out
}

/**
 * The sub-window of a cluster that most looks like a trip.
 *
 * Taking the whole cluster put a candidate's edges wherever the ≤`gapDays` chain happened to start
 * and stop, which is how a long weekend surfaced with a fortnight of ordinary spending welded to
 * each end. A cluster is at most `maxDays` long, so every (start, end) pair over its distinct days
 * is a few hundred combinations — cheap enough to just scan.
 *
 * The window is scored by how far it runs ABOVE the threshold — `total − factor × baseline × span`
 * — not by its total. Scoring by total always prefers a wider window, because another day can only
 * add spend: a burst scored that way grows back out over the ordinary days around it for as long
 * as the average still clears the bar. Scoring by excess makes an ordinary day a negative
 * contribution, so the winner's edges land exactly where the elevated spending stops.
 */
function bestWindow(
  cluster: DetectTxn[],
  o: { minCount: number; densityFactor: number; floor: number; maxDays: number; baseline: number; dominantShare: number },
): { rows: DetectTxn[]; total: number; span: number } | null {
  const days = [...new Set(cluster.map((t) => t.date))].sort()
  const threshold = o.densityFactor * o.baseline
  let best: { rows: DetectTxn[]; total: number; span: number; excess: number } | null = null
  for (let i = 0; i < days.length; i++) {
    for (let j = i; j < days.length; j++) {
      const from = days[i]!
      const to = days[j]!
      const span = daysBetween(from, to) + 1
      if (span > o.maxDays) break
      // A trip runs several days across several merchants — not one big charge, not a single day.
      if (j - i + 1 < 3) continue
      const rows = cluster.filter((t) => t.date >= from && t.date <= to)
      if (rows.length < o.minCount) continue
      if (new Set(rows.map((t) => t.merchant)).size < o.minCount) continue
      const total = rows.reduce((s, t) => s - t.amount, 0)
      if (total < o.floor) continue
      // A trip is many payments, not one big one. Without this a €23k transfer with four small
      // rows near it reads as a 41×-the-usual-rate "trip" — the density is real and the
      // conclusion is nonsense.
      if (Math.max(...rows.map((t) => -t.amount)) > total * o.dominantShare) continue
      // Per CALENDAR day, not per active day: a burst with quiet days in it is not a trip.
      const excess = total - threshold * span
      if (excess <= 0) continue
      if (!best || excess > best.excess) best = { rows, total, span, excess }
    }
  }
  return best
}
