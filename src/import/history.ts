// Manual-history categorization (IMPORT §10.1 ladder, the rung between rules and fallback).
// The strongest signal there is: a category the user set BY HAND on the same merchant before.
// Only `provenance === 'manual'` transactions seed a suggestion — never an AI/rule/fallback guess,
// nor an unconfirmed history suggestion — so the rung can never feed its own output back to itself.
// Suggestions stay needs-review (they don't auto-apply), and match on the same exact keys rules use.
import type { Transaction } from '../model/types'
import { creditorIdOf } from './identity'
import type { NormalizedRow } from './types'

/** Fields a history suggestion keys on, strongest first — mirrors `mintKey` (§10.2), minus descriptor
 *  (too noisy for a bare suggestion; still available to learned rules). */
type Field = 'creditorId' | 'counterparty' | 'merchant'

/** A key and whether it is scoped to the row's direction. */
type Key = [Field, string, boolean]

/** Case-insensitive index key, matching `evaluateRules`' uppercase comparison so a suggestion keyed
 *  the same way a rule would match. NUL-separated so a value cannot collide across fields.
 *
 *  A key may carry the direction (#19). It does when the row names a **counterparty**: one person
 *  both sends and receives, and how their inbound transfers were categorized says nothing about the
 *  outbound ones. That scoping covers the row's `merchant` key too, because a transfer's merchant is
 *  the same name read off the same descriptor — leaving it sign-blind would smuggle back exactly
 *  what the counterparty scoping excludes. A card row (no counterparty) stays sign-blind, so a
 *  refund still finds its merchant's history (§5.4), and a SEPA creditor id — a biller's identity,
 *  never a direction — always does. */
function keyOf(field: Field, value: string, scoped: boolean, amountMinor: number): string {
  const dir = scoped ? (amountMinor < 0 ? '\0out' : '\0in') : ''
  return `${field}\0${value.toUpperCase()}${dir}`
}

/** Per key: categoryId → how often the user picked it by hand, and their most recent pick. */
export type ManualHistory = Map<string, Map<string, { count: number; latest: string }>>

/** The keys a stored transaction exposes — read back through the same fields a learned rule
 *  would (`mintLearnedRuleForTxn`): the SEPA creditor id only survives in the raw. */
function txnKeys(t: Transaction): Key[] {
  const out: Key[] = []
  const cid = t.importMeta?.raw ? creditorIdOf(t.importMeta.raw) : undefined
  const scoped = t.counterparty !== undefined
  if (cid) out.push(['creditorId', cid, false])
  if (t.counterparty) out.push(['counterparty', t.counterparty, true])
  if (t.merchant) out.push(['merchant', t.merchant, scoped])
  return out
}

/** The candidate keys for a fresh import row, strongest first. */
function rowKeys(row: NormalizedRow): Key[] {
  const out: Key[] = []
  const scoped = row.counterparty !== undefined
  if (row.creditorId) out.push(['creditorId', row.creditorId, false])
  if (row.counterparty) out.push(['counterparty', row.counterparty, true])
  if (row.merchant) out.push(['merchant', row.merchant, scoped])
  return out
}

/** Index every hand-categorized transaction under each key it exposes (one O(n) pass). */
export function buildManualHistory(txns: Transaction[]): ManualHistory {
  const hist: ManualHistory = new Map()
  for (const t of txns) {
    if (t.provenance !== 'manual') continue
    for (const [field, value, scoped] of txnKeys(t)) {
      const k = keyOf(field, value, scoped, Math.round(t.amount * 100))
      let cats = hist.get(k)
      if (!cats) hist.set(k, (cats = new Map()))
      const cur = cats.get(t.categoryId)
      if (!cur) cats.set(t.categoryId, { count: 1, latest: t.updatedAt })
      else {
        cur.count++
        if (t.updatedAt > cur.latest) cur.latest = t.updatedAt
      }
    }
  }
  return hist
}

/** The dominant category for a key: most frequent, ties broken by the most recent pick. */
function dominant(cats: Map<string, { count: number; latest: string }>): string {
  let best = ''
  let bestCount = 0
  let bestLatest = ''
  for (const [id, { count, latest }] of cats) {
    if (count > bestCount || (count === bestCount && latest > bestLatest)) {
      best = id
      bestCount = count
      bestLatest = latest
    }
  }
  return best
}

/** Suggest a category from the strongest key with any hand-categorization history, else null. */
export function historyLookup(row: NormalizedRow, hist: ManualHistory): string | null {
  for (const [field, value, scoped] of rowKeys(row)) {
    const cats = hist.get(keyOf(field, value, scoped, row.amountMinor))
    if (cats) return dominant(cats)
  }
  return null
}
