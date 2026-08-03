// Post-commit duplicate audit. Import dedup keys on `importMeta.hash` and is scoped to one account
// (IMPORT §8.1), so the same real transaction double-imports whenever its hash differs — a ghost
// account, a descriptor the adapter folds in one variant but not the other, or an export that renames
// the merchant (`La Table Tournant` → `SumUp`). Nothing detects that once the rows are committed; the
// only existing signal is `driftHints` noticing the balances stopped adding up.
//
// Precision here comes from PROVENANCE CONTEXT, not from comparing rows harder. `SumUp` vs
// `La Table Tournant` carries no descriptor signal at all: it is knowable as a duplicate only because
// the file it came from was fully matched by another file. So the unit of judgement is a FILE PAIR —
// two statements that overlap in time and restate each other — and individual pairs are reported only
// inside such a container. Measured on a real 1826-row vault: the true duplicate import scores 1.00
// while the worst false positive (two people's Amazon Prime subscriptions) scores 0.036.
import type { DateStr, Transaction, Vault } from '../model/types'
import { CAT_TRANSFERS } from '../model/types'
import type { Op } from '../model/mutations'
import { accountCurrencyMap, rowCurrency } from '../import/fx'
import { addDays, daysBetween } from './selections'
import { driftHints } from './recon'

/** Date slack between two legs of the same transaction: booked-vs-value date differs by a day. */
export const DUP_WINDOW_DAYS = 1
/** A file pair must restate at least this share of the smaller side to count as a duplicate import. */
export const DUP_MIN_RATE = 0.6
/** …over at least this many rows. A 1-row overlap trivially scores 100%. */
export const DUP_MIN_MATCHED = 3

export interface DupPair {
  /** Survivor — the oldest uuidv7, the same rule `postPassImportDedupe` applies on merge (SYNC §4.3). */
  keepId: string
  dropId: string
  amount: number
  keepDate: DateStr
  dropDate: DateStr
  keepMerchant: string
  dropMerchant: string
  dayGap: number
}

export interface DupFinding {
  /** `${fileA}|${fileB}` — stable across recomputation, so UI state can key on it. */
  id: string
  fileA: string
  fileB: string
  /** Accounts the matched rows sit on. One entry unless the pair straddles accounts. */
  accountIds: string[]
  window: [DateStr, DateStr]
  /** Rows each file contributed inside the shared window. */
  inWindow: [number, number]
  matched: number
  /** `matched / min(inWindow)` — see the note on `min` below. */
  matchRate: number
  /** Signed € balance drift over an enclosing snapshot window, when one exists. Advisory only. */
  driftCorroboration?: number
  pairs: DupPair[]
  totalAmount: number
}

export interface DupOptions {
  minRate?: number
  minMatched?: number
  windowDays?: number
}

interface Row {
  id: string
  date: DateStr
  amountMinor: number
  currency: string
  merchant: string
  accountId: string
  file: string
}

const minorOf = (t: Transaction): number => Math.round(t.amount * 100)

/** Imported rows only — a manual row has no file, so it can never anchor a file-pair verdict. */
function rowsOf(vault: Vault): Row[] {
  const base = vault.params.baseCurrency ?? 'EUR'
  // Resolve through the ACCOUNT: `currency` is stored only when it differs from the
  // account's, so `t.currency ?? 'EUR'` would bucket a ₴1,200 row with a €1,200 one.
  const accountCur = accountCurrencyMap(vault)
  const out: Row[] = []
  for (const t of vault.transactions) {
    const file = t.importMeta?.file
    if (!file || !t.accountId) continue
    // Both legs of a transfer are equal-and-opposite by construction, never duplicates of each other.
    if (t.transferGroupId || t.categoryId === CAT_TRANSFERS) continue
    out.push({
      id: t.id,
      date: t.date,
      amountMinor: minorOf(t),
      currency: rowCurrency(t, accountCur, base),
      merchant: t.merchant,
      accountId: t.accountId,
      file,
    })
  }
  return out
}

/**
 * Greedy 1:1 match between two row sets, nearest-date first. Scored like `pairTransfers`
 * (IMPORT §9.2) — closer dates win — and each row on either side is claimed at most once, so a
 * merchant that legitimately repeats inside one file cannot absorb several rows from the other.
 */
function greedyMatch(left: Row[], right: Row[], windowDays: number): { a: Row; b: Row; dayGap: number }[] {
  // Bucket by (currency, amount): equal amount is a precondition, so this keeps the scan ~O(n)
  // instead of O(n²) over the ~1800 rows a real vault holds.
  const buckets = new Map<string, Row[]>()
  for (const r of right) {
    const k = `${r.currency}|${r.amountMinor}`
    const arr = buckets.get(k)
    if (arr) arr.push(r)
    else buckets.set(k, [r])
  }
  const claimed = new Set<string>()
  const out: { a: Row; b: Row; dayGap: number }[] = []
  for (const a of left) {
    const cands = buckets.get(`${a.currency}|${a.amountMinor}`)
    if (!cands) continue
    let best: Row | undefined
    let bestGap = Infinity
    for (const b of cands) {
      if (claimed.has(b.id)) continue
      const gap = Math.abs(daysBetween(a.date, b.date))
      if (gap > windowDays) continue
      if (gap < bestGap) {
        best = b
        bestGap = gap
      }
    }
    if (!best) continue
    claimed.add(best.id)
    out.push({ a, b: best, dayGap: bestGap })
  }
  return out
}

/** Oldest uuidv7 survives — the same winner `postPassImportDedupe` picks, so a later merge agrees. */
const older = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x])

/**
 * Find file pairs that restate each other. Returns one finding per overlapping file pair that clears
 * the rate and count thresholds, most confident first.
 *
 * Deliberate exclusions, each removing a class of false positive measured on real data:
 *  - **Same file** is never compared with itself. Rows repeating inside one statement are created on
 *    purpose by `occurrenceIndexes` (IMPORT §7.3) — SNCF ×3 in a day, tolls, a monthly standing order.
 *  - **Transfer legs** are dropped up front (see `rowsOf`).
 *  - **Low match rate** stops here: two accounts that merely share a subscription (his-and-hers Amazon
 *    Prime, €6.99 monthly) score ~0.02 against the 1.00 of a genuine re-import.
 */
export function findDuplicateImports(vault: Vault, opts: DupOptions = {}): DupFinding[] {
  const minRate = opts.minRate ?? DUP_MIN_RATE
  const minMatched = opts.minMatched ?? DUP_MIN_MATCHED
  const windowDays = opts.windowDays ?? DUP_WINDOW_DAYS

  const byFile = new Map<string, Row[]>()
  for (const r of rowsOf(vault)) {
    const arr = byFile.get(r.file)
    if (arr) arr.push(r)
    else byFile.set(r.file, [r])
  }
  const files = [...byFile.entries()]
    .map(([file, rows]) => {
      const dates = rows.map((r) => r.date).sort()
      return { file, rows, from: dates[0]!, to: dates[dates.length - 1]! }
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1)) // stable output regardless of vault ordering

  const findings: DupFinding[] = []
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const A = files[i]!
      const B = files[j]!
      if (A.from > B.to || B.from > A.to) continue // periods disjoint — nothing to restate
      const from = A.from > B.from ? A.from : B.from
      const to = A.to < B.to ? A.to : B.to
      // Widen the shared window by the match slack on each edge: a row whose twin sits a day outside
      // the strict intersection (booked vs value date) would otherwise be dropped before matching,
      // and its absence would silently deflate the rate.
      const lo = addDays(from, -windowDays)
      const hi = addDays(to, windowDays)
      const aw = A.rows.filter((r) => r.date >= lo && r.date <= hi)
      const bw = B.rows.filter((r) => r.date >= lo && r.date <= hi)
      if (aw.length === 0 || bw.length === 0) continue

      const matches = greedyMatch(aw, bw, windowDays)
      if (matches.length < minMatched) continue
      // `min`, not `max`: the real case was 118 rows against 7. Dividing by the larger side reads 6%
      // and misses it; dividing by the smaller reads 100% and says what is actually true — everything
      // the smaller file had, the larger one already holds.
      const rate = matches.length / Math.min(aw.length, bw.length)
      if (rate < minRate) continue

      const accountIds = [...new Set(matches.flatMap((m) => [m.a.accountId, m.b.accountId]))]
      const pairs: DupPair[] = matches.map((m) => {
        const [keepId, dropId] = older(m.a.id, m.b.id)
        const keep = keepId === m.a.id ? m.a : m.b
        const drop = dropId === m.a.id ? m.a : m.b
        return {
          keepId,
          dropId,
          amount: keep.amountMinor / 100,
          keepDate: keep.date,
          dropDate: drop.date,
          keepMerchant: keep.merchant,
          dropMerchant: drop.merchant,
          dayGap: m.dayGap,
        }
      })
      findings.push({
        id: `${A.file}|${B.file}`,
        fileA: A.file,
        fileB: B.file,
        accountIds,
        window: [from, to],
        inWindow: [aw.length, bw.length],
        matched: matches.length,
        matchRate: rate,
        driftCorroboration: corroborate(vault, accountIds, from, to),
        pairs,
        totalAmount: Math.round(pairs.reduce((s, p) => s + Math.abs(p.amount), 0) * 100) / 100,
      })
    }
  }
  return findings.sort((a, b) => b.matchRate - a.matchRate || b.matched - a.matched)
}

/**
 * Balance evidence for a finding, when the account has snapshots around it. Duplicated debits make
 * Σ transactions more negative than the bank's own balance delta, so the drift runs positive.
 * Corroboration only — measured at +€128.94 against a €190.94 pair sum on the real vault, i.e.
 * directionally right but not an identification, so it never creates or gates a finding.
 */
function corroborate(vault: Vault, accountIds: string[], from: DateStr, to: DateStr): number | undefined {
  let total = 0
  let found = false
  for (const accountId of accountIds) {
    for (const h of driftHints(vault, accountId)) {
      if (h.between[1] < from || h.between[0] > to) continue
      total += h.delta
      found = true
    }
  }
  return found ? Math.round(total * 100) / 100 : undefined
}

/** Every transaction id a finding proposes dropping — the lookup the row markers use. */
export function duplicateIds(findings: DupFinding[]): Set<string> {
  const out = new Set<string>()
  for (const f of findings) for (const p of f.pairs) out.add(p.dropId)
  return out
}

/**
 * The op that resolves a set of pairs: fold each dropped row into its survivor, then delete it — as
 * one `batch`, so the whole gesture undoes with a single click and nothing is lost irrecoverably.
 *
 * "Fold" is doing real work, in this order:
 *  1. the survivor inherits the victim's identity (`dupHashes`), so a re-import of the statement the
 *     victim came from recognises it as already present rather than adding it back;
 *  2. the survivor inherits curation the victim carried and it lacks — a note, a recurrence flag, a
 *     hand-picked category — because the survivor is chosen by age, not by how much work went into it;
 *  3. trip/set assignments move across (mirroring `remapAssignmentTxns` in the sync merge), so a
 *     tagged row does not silently drop out of a trip;
 *  4. only then are the victims deleted, which tombstones them for sync.
 */
export function resolveDuplicatesOp(vault: Vault, pairs: DupPair[]): Op | null {
  const byId = new Map(vault.transactions.map((t) => [t.id, t]))
  const ops: Op[] = []
  const dropIds: string[] = []

  for (const p of pairs) {
    const keep = byId.get(p.keepId)
    const drop = byId.get(p.dropId)
    if (!keep || !drop) continue // vault moved under us — skip rather than mutate blind
    dropIds.push(drop.id)

    const hashes = new Set([...(keep.importMeta?.dupHashes ?? [])])
    if (drop.importMeta?.hash) hashes.add(drop.importMeta.hash)
    for (const h of drop.importMeta?.dupHashes ?? []) hashes.add(h)
    if (keep.importMeta && hashes.size > (keep.importMeta.dupHashes?.length ?? 0)) {
      ops.push({ kind: 'setField', collection: 'transactions', id: keep.id, field: 'importMeta', value: { ...keep.importMeta, dupHashes: [...hashes].sort() } })
    }

    if (!keep.note && drop.note) ops.push({ kind: 'setField', collection: 'transactions', id: keep.id, field: 'note', value: drop.note })
    if (!keep.recurring && drop.recurring) ops.push({ kind: 'setField', collection: 'transactions', id: keep.id, field: 'recurring', value: drop.recurring })
    // A category someone chose by hand outranks whatever rung placed the survivor.
    if (drop.provenance === 'manual' && keep.provenance !== 'manual') {
      ops.push({ kind: 'setField', collection: 'transactions', id: keep.id, field: 'categoryId', value: drop.categoryId })
      ops.push({ kind: 'setField', collection: 'transactions', id: keep.id, field: 'provenance', value: 'manual' })
    }

    for (const a of vault.trackingAssignments) {
      if (a.txnId !== drop.id) continue
      const already = vault.trackingAssignments.some((x) => x.txnId === keep.id && x.trackingId === a.trackingId)
      if (!already) ops.push({ kind: 'setAssignment', trackingId: a.trackingId, txnId: keep.id, dir: a.dir })
    }
  }

  if (dropIds.length === 0) return null
  ops.push({ kind: 'delete', collection: 'transactions', ids: dropIds })
  return { kind: 'batch', ops }
}
