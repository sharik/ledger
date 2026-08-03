import type { Tracking, Vault } from './types'

/**
 * ANALYTICS §3 membership algebra:
 *
 *   members(T) = ( { live txns whose bookedDate ∈ W } − { excludes } ) ∪ { includes }
 *
 * where W is T's `dateFrom..dateTo` window (empty when both bounds are absent).
 * Excludes beat the window; includes beat everything. Assignments pointing at a
 * tombstoned (non-live) txn are inert. Archived trackings still resolve. Only
 * *live* assignments (the vault's `trackingAssignments` array) participate.
 */
export function members(trackingId: string, vault: Vault): Set<string> {
  const tr = vault.trackings.find((t) => t.id === trackingId)
  if (!tr) return new Set()

  const liveTxnIds = new Set(vault.transactions.map((t) => t.id))
  const out = new Set<string>()

  // window rows
  if (tr.dateFrom != null || tr.dateTo != null) {
    for (const t of vault.transactions) {
      if (inWindow(t.date, tr)) out.add(t.id)
    }
  }

  // excludes remove, includes add (includes win by construction)
  for (const a of vault.trackingAssignments) {
    if (a.trackingId !== trackingId) continue
    if (!liveTxnIds.has(a.txnId)) continue // dangling → inert
    if (a.dir === 'exclude') out.delete(a.txnId)
  }
  for (const a of vault.trackingAssignments) {
    if (a.trackingId !== trackingId) continue
    if (!liveTxnIds.has(a.txnId)) continue
    if (a.dir === 'include') out.add(a.txnId)
  }
  return out
}

/** True when `date` falls inside a tracking's window (present bounds only). */
export function inWindow(date: string, tr: Pick<Tracking, 'dateFrom' | 'dateTo'>): boolean {
  if (tr.dateFrom != null && date < tr.dateFrom) return false
  if (tr.dateTo != null && date > tr.dateTo) return false
  return tr.dateFrom != null || tr.dateTo != null
}
