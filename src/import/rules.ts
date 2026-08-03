import type { Category, Rule, Transaction, Vault } from '../model/types'
import { now, uuidv7 } from '../model/clock'
import { creditorIdOf, normDesc } from './identity'
import type { NormalizedRow } from './types'
import starterPack from './starterPack.json'

type MatchField = Rule['match']['field']
type MatchOp = Rule['match']['op']

const PRIORITY: Record<Rule['source'], number> = { user: 100, learned: 50, seed: 10 }

/** The value a rule's field reads from a normalized row. */
function fieldValue(row: NormalizedRow, field: MatchField): string | undefined {
  switch (field) {
    case 'creditorId':
      return row.creditorId
    case 'counterparty':
      return row.counterparty
    case 'merchant':
      return row.merchant
    case 'descriptor':
      return row.normDesc
  }
}

function matches(value: string, op: MatchOp, target: string): boolean {
  const v = value.toUpperCase()
  const t = target.toUpperCase()
  if (op === 'equals') return v === t
  if (op === 'prefix') return v.startsWith(t)
  return v.includes(t)
}

/** The direction an amount moves in — the vocabulary `Rule.match.sign` scopes to (#19). */
export function signOf(amountMinor: number): 'inflow' | 'outflow' {
  return amountMinor < 0 ? 'outflow' : 'inflow'
}

/**
 * Does a rule's direction scope admit this amount? One predicate for both engines below, so
 * `evaluateRules` (import rows) and `matchesRule` (committed transactions) cannot drift.
 * A rule with no `sign` admits either direction — the §5.4-preserving default.
 */
function signAdmits(rule: Rule, amountMinor: number): boolean {
  return rule.match.sign === undefined || rule.match.sign === signOf(amountMinor)
}

export interface RuleHit {
  categoryId: string
  ruleId: string
}

/**
 * §10.1 ladder step 2: first match over enabled rules sorted priority DESC,
 * updatedAt DESC. A hand-written rule beats a learned one beats a seed; the
 * newest wins within a tier.
 */
export function evaluateRules(row: NormalizedRow, rules: Rule[]): RuleHit | null {
  const active = rules
    .filter((r) => r.enabled !== false)
    .sort((a, b) => b.priority - a.priority || (a.updatedAt < b.updatedAt ? 1 : -1))
  for (const r of active) {
    if (!signAdmits(r, row.amountMinor)) continue
    const val = fieldValue(row, r.match.field)
    if (val && matches(val, r.match.op, r.match.value)) return { categoryId: r.categoryId, ruleId: r.id }
  }
  return null
}

/**
 * Does a committed transaction match a rule? Rules are written against normalized
 * import rows, so a stored transaction is read back through the same fields — the
 * SEPA creditor id only survives in the raw descriptor.
 */
export function matchesRule(txn: Transaction, rule: Rule): boolean {
  const { field, op, value } = rule.match
  if (!signAdmits(rule, Math.round(txn.amount * 100))) return false
  switch (field) {
    case 'merchant':
      return matches(txn.merchant, op, value)
    case 'counterparty':
      return txn.counterparty !== undefined && matches(txn.counterparty, op, value)
    case 'descriptor':
      return matches(normDesc(txn.importMeta?.raw ?? txn.merchant), op, value)
    case 'creditorId':
      return (txn.importMeta?.raw ?? '').toUpperCase().includes(value.toUpperCase())
  }
}

/**
 * The four fields a rule key can be built from — all `mintKey` ever reads of a row — plus the
 * amount, which contributes no key of its own but decides whether the key is direction-scoped.
 * Optional: a caller with no amount to offer mints the sign-blind rule it always did.
 */
type KeySource = Pick<NormalizedRow, 'creditorId' | 'counterparty' | 'merchant' | 'normDesc'> & { amountMinor?: number }

/**
 * Robustness ranking for minting a learned rule: creditorId > counterparty > merchant > descriptor (§10.2).
 *
 * A `counterparty` key is scoped to the row's own direction (#19): one person both sends and
 * receives, so "money from X is income" must not also claim "money to X is income". Every other
 * field stays sign-blind, which is what keeps §5.4 true — a `Card Refund` is a positive amount
 * that must still read as its merchant's category.
 */
export function mintKey(row: KeySource): { field: MatchField; op: MatchOp; value: string; sign?: 'inflow' | 'outflow' } | null {
  if (row.creditorId) return { field: 'creditorId', op: 'equals', value: row.creditorId }
  if (row.counterparty) {
    const sign = row.amountMinor === undefined ? undefined : signOf(row.amountMinor)
    return { field: 'counterparty', op: 'equals', value: row.counterparty, ...(sign ? { sign } : {}) }
  }
  if (row.merchant) return { field: 'merchant', op: 'equals', value: row.merchant.toUpperCase() }
  if (row.normDesc) return { field: 'descriptor', op: 'contains', value: row.normDesc }
  return null
}

/** Build a `learned` rule (priority 50) for the row's most robust key (§10.3). */
export function mintLearnedRule(row: KeySource, categoryId: string): Rule | null {
  const key = mintKey(row)
  if (!key) return null
  return { id: uuidv7(), updatedAt: now(), categoryId, priority: PRIORITY.learned, source: 'learned', enabled: true, match: key }
}

/**
 * How an *Always* offer names the key it would rule on — shared by review and the txn list.
 * A direction scope is named too: it narrows what the rule will ever do, so the offer has to
 * say so before it is accepted.
 */
export function ruleKeyLabel(rule: Rule): string {
  const { field, value, sign } = rule.match
  const dir = sign === 'outflow' ? ' · money out' : sign === 'inflow' ? ' · money in' : ''
  if (field === 'creditorId') return `matches SEPA creditor id ${value}${dir}`
  if (field === 'counterparty') return `matches counterparty “${value}”${dir}`
  if (field === 'merchant') return `matches merchant “${value}”${dir}`
  return `matches “${value}”${dir}`
}

/**
 * The same §10.3 loop, started from a committed transaction rather than an import row —
 * recategorizing on the Transactions screen teaches a rule exactly as review does. The
 * key source is read back through the fields `matchesRule` uses, so a minted rule always
 * matches the transaction it was minted from.
 */
export function mintLearnedRuleForTxn(txn: Transaction, categoryId: string): Rule | null {
  const raw = txn.importMeta?.raw
  return mintLearnedRule(
    {
      creditorId: raw ? creditorIdOf(raw) : undefined,
      counterparty: txn.counterparty,
      merchant: txn.merchant,
      normDesc: normDesc(raw ?? txn.merchant),
      amountMinor: Math.round(txn.amount * 100),
    },
    categoryId,
  )
}

interface PackEntry {
  field: MatchField
  op: MatchOp
  value: string
  category: string
}
interface Pack {
  categories: { name: string; color: string }[]
  rules: PackEntry[]
}

export function loadStarterPack(): Pack {
  return starterPack as Pack
}

/**
 * §10.4 — resolve the starter pack against the vault: reuse categories by name,
 * mint the missing ones, and produce `seed` rules (priority 10) referencing the
 * resolved ids. Pure: mints records for the caller to commit, touches nothing.
 */
export function installStarterPack(vault: Vault): { categories: Category[]; rules: Rule[] } {
  const t = now()
  const byName = new Map(vault.categories.map((c) => [c.name.toLowerCase(), c.id]))
  const newCategories: Category[] = []
  const pack = loadStarterPack()
  for (const c of pack.categories) {
    if (byName.has(c.name.toLowerCase())) continue
    const id = uuidv7()
    byName.set(c.name.toLowerCase(), id)
    newCategories.push({ id, updatedAt: t, name: c.name, color: c.color })
  }
  const rules: Rule[] = pack.rules.map((r) => ({
    id: uuidv7(),
    updatedAt: t,
    categoryId: byName.get(r.category.toLowerCase())!,
    priority: PRIORITY.seed,
    source: 'seed' as const,
    enabled: true,
    match: { field: r.field, op: r.op, value: r.value },
  }))
  return { categories: newCategories, rules }
}

/**
 * §10.4 offer policy: the first import that would benefit (a French bank, no seed
 * rules installed yet) and never offered before (`settings.starterPackOffered`).
 */
export function shouldOfferStarterPack(vault: Vault, institution: string): boolean {
  if (vault.settings.starterPackOffered) return false
  if (vault.rules.some((r) => r.source === 'seed')) return false
  return institution === 'bnp'
}
