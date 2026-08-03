import type { BalanceSnapshot, DateStr, Vault } from '../model/types'
import { round2 } from '../model/selectors'
import { addDays, daysBetween } from './selections'

export interface DriftHint {
  accountId: string
  between: [DateStr, DateStr]
  delta: number // snapshot delta − Σ transactions in the window (euros)
  message: string
}

const originKind = (s: BalanceSnapshot): 'anchor' | 'manual' => (s.origin?.kind === 'anchor' ? 'anchor' : 'manual')

/**
 * Does this snapshot describe the balance *before* its date's transactions?
 *
 * Only an implied opening does. Everything else — a closing balance, a month-end read off a
 * balance chain, a hand-typed figure, a legacy snapshot with no `origin` — is an end-of-day
 * reading, so `close` is the safe default for anything unmarked.
 */
const isOpening = (s: BalanceSnapshot): boolean => s.origin?.kind === 'anchor' && s.origin.at === 'open'

/**
 * ANALYTICS §7 — derived (never stored) reconciliation drift. For each account,
 * consecutive live snapshots (s₁, s₂) are compared against the account's Σ txns
 * in (s₁.date, s₂.date]. Drift beyond `params.reconTolerance` (default €1.00)
 * surfaces a live hint whose wording depends on the snapshots' `origin`.
 */
export function driftHints(vault: Vault, accountId: string): DriftHint[] {
  const tol = vault.params.reconTolerance ?? 1.0
  const snaps = vault.snapshots
    .filter((s) => s.accountId === accountId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
  const out: DriftHint[] = []
  for (let i = 1; i < snaps.length; i++) {
    const s1 = snaps[i - 1]!
    const s2 = snaps[i]!
    if (s1.date === s2.date) continue
    // The window is the set of transactions that must explain s2 − s1, so each end is bounded by
    // what its own figure already accounts for. An opening anchor is the balance *before* its
    // day's rows: as s1 that day's rows are still ahead of it and belong in the window, and as s2
    // they have not happened yet and must be left out. Charging them anyway invents drift equal
    // to that day's net — an opening whose day carries a large transfer reads as a missing
    // statement even when both balances agree exactly.
    const from = isOpening(s1) ? (d: DateStr) => d >= s1.date : (d: DateStr) => d > s1.date
    const to = isOpening(s2) ? (d: DateStr) => d < s2.date : (d: DateStr) => d <= s2.date
    const expected = vault.transactions
      .filter((t) => t.accountId === accountId && from(t.date) && to(t.date))
      .reduce((sum, t) => sum + t.amount, 0)
    const drift = round2(s2.amount - s1.amount - expected)
    if (Math.abs(drift) <= tol) continue
    const bothAnchor = originKind(s1) === 'anchor' && originKind(s2) === 'anchor'
    const message = bothAnchor
      ? `A statement may be missing between ${s1.date} and ${s2.date}.`
      : `Balance between ${s1.date} and ${s2.date} is off by €${Math.abs(drift).toFixed(2)} — a statement may be missing, or check the typed balance.`
    out.push({ accountId, between: [s1.date, s2.date], delta: drift, message })
  }
  return out
}

export interface CoverageSpan {
  kind: 'covered' | 'gap'
  from: DateStr
  to: DateStr
  days: number
  /** Statements making up a covered run — several when imports overlap. */
  files?: { fileName: string; rows: number }[]
  /** A gap running to today: nothing has been imported since, as opposed to a hole between two statements. */
  trailing?: boolean
}

/**
 * What has actually been imported for an account, and what is missing — read straight off
 * the `StatementRecord`s rather than inferred from balances.
 *
 * This is deliberately *not* drift-based like `driftHints` above. Drift needs a balance
 * anchor on both sides of a hole, so it is structurally blind to the most common case:
 * you simply stopped importing. Statement periods know that without any arithmetic.
 *
 * Overlapping imports are normal (consecutive exports share their edges), so periods are
 * merged into runs first; a gap is only reported where the next run starts more than a day
 * after the previous one ends.
 */
export function coverage(vault: Vault, accountId: string, today: DateStr): CoverageSpan[] {
  const stmts = vault.statements
    .filter((s) => s.accountId === accountId)
    .sort((a, b) => (a.periodFrom < b.periodFrom ? -1 : a.periodFrom > b.periodFrom ? 1 : a.periodTo < b.periodTo ? -1 : 1))
  if (stmts.length === 0) return []

  const runs: { from: DateStr; to: DateStr; files: { fileName: string; rows: number }[] }[] = []
  for (const s of stmts) {
    const last = runs[runs.length - 1]
    const file = { fileName: s.fileName, rows: s.rowsImported }
    // Contiguous (abutting or overlapping) periods extend the run rather than opening a gap.
    if (last && s.periodFrom <= addDays(last.to, 1)) {
      if (s.periodTo > last.to) last.to = s.periodTo
      last.files.push(file)
    } else {
      runs.push({ from: s.periodFrom, to: s.periodTo, files: [file] })
    }
  }

  const span = (kind: CoverageSpan['kind'], from: DateStr, to: DateStr, extra?: Partial<CoverageSpan>): CoverageSpan => ({
    kind,
    from,
    to,
    days: daysBetween(from, to) + 1,
    ...extra,
  })

  const out: CoverageSpan[] = []
  runs.forEach((r, i) => {
    if (i > 0) {
      const prev = runs[i - 1]!
      out.push(span('gap', addDays(prev.to, 1), addDays(r.from, -1)))
    }
    out.push(span('covered', r.from, r.to, { files: r.files }))
  })

  const end = runs[runs.length - 1]!.to
  if (end < today) out.push(span('gap', addDays(end, 1), today, { trailing: true }))
  return out
}
