import type { Transaction, Vault } from '../model/types'
import { CAT_TRANSFERS } from '../model/types'
import { accountCurrencyMap, rowCurrency } from './fx'
import type { NormalizedRow, TransferCandidate } from './types'

export const TRANSFER_WINDOW_DAYS = 4

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000)
}

/** ≥3-char token-prefix overlap, truncation-tolerant (`MARTIN MARI` ✓) — a HINT only (§9.2). */
function nameSimilar(counterparty: string | undefined, accountName: string, institution?: string): boolean {
  if (!counterparty) return false
  const hay = `${accountName} ${institution ?? ''}`.toUpperCase()
  const hayTokens = hay.split(/\s+/).filter((t) => t.length >= 3)
  const cpTokens = counterparty.toUpperCase().split(/\s+/).filter((t) => t.length >= 3)
  for (const c of cpTokens) {
    for (const h of hayTokens) {
      const n = Math.min(c.length, h.length, Math.max(3, Math.min(c.length, h.length)))
      if (c.slice(0, n) === h.slice(0, n) && n >= 3) return true
      if (c.startsWith(h.slice(0, 3)) || h.startsWith(c.slice(0, 3))) return true
    }
  }
  return false
}

export interface PairOutcome {
  line: number // new row sourceLine
  existingTxnId?: string
  ambiguous?: TransferCandidate[]
}

/**
 * §9.2 — pair new transfer-candidate rows against the vault's unpaired pool.
 * Amount-sum-to-zero + same-currency + different-account + ≤4-day window is
 * *evidence*, not heuristic. Exactly one best pair links; two within a score
 * point become `txfr-ambiguous`; none leaves the row in cash-flow.
 */
export function pairTransfers(newRows: NormalizedRow[], accountId: string, vault: Vault): PairOutcome[] {
  const accById = new Map(vault.accounts.map((a) => [a.id, a]))
  // Resolve the candidate's currency through its ACCOUNT: `planToOp` stores
  // `Transaction.currency` only when it differs from the account's, so a row on a
  // UAH card carries `undefined` — reading that as EUR made a ₴→₴ transfer unpairable
  // for good (the exact hazard fx.ts documents for the rate derivation).
  const base = vault.params.baseCurrency ?? 'EUR'
  const accountCur = accountCurrencyMap(vault)
  const unpaired: Transaction[] = vault.transactions.filter(
    (t) => !t.transferGroupId && t.categoryId !== CAT_TRANSFERS && t.accountId !== undefined && t.accountId !== accountId,
  )
  const outcomes: PairOutcome[] = []
  const claimed = new Set<string>() // an existing leg pairs with at most one new row
  for (const row of newRows) {
    if (row.kind !== 'transfer-in' && row.kind !== 'transfer-out') continue
    const scored: { txn: Transaction; score: number }[] = []
    for (const cand of unpaired) {
      if (claimed.has(cand.id)) continue
      const candMinor = Math.round(cand.amount * 100)
      if (candMinor + row.amountMinor !== 0) continue
      if (rowCurrency(cand, accountCur, base) !== row.currency) continue
      const dd = dayDiff(row.bookedDate, cand.date)
      if (dd > TRANSFER_WINDOW_DAYS) continue
      const acc = accById.get(cand.accountId!)
      const sim = acc ? nameSimilar(row.counterparty, acc.name, acc.institution) : false
      scored.push({ txn: cand, score: TRANSFER_WINDOW_DAYS + 1 - dd + (sim ? 1 : 0) })
    }
    if (scored.length === 0) continue
    scored.sort((a, b) => b.score - a.score)
    if (scored.length >= 2 && scored[0]!.score - scored[1]!.score <= 1) {
      outcomes.push({
        line: row.sourceLine,
        ambiguous: scored.slice(0, 4).map((s) => ({ txnId: s.txn.id, accountId: s.txn.accountId!, score: s.score })),
      })
      continue
    }
    claimed.add(scored[0]!.txn.id)
    outcomes.push({ line: row.sourceLine, existingTxnId: scored[0]!.txn.id })
  }
  return outcomes
}
