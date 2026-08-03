import { describe, it, expect } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import type { Rule } from '../../src/model/types'
import { evaluateRules, installStarterPack, matchesRule, mintKey, mintLearnedRule, mintLearnedRuleForTxn, ruleKeyLabel, shouldOfferStarterPack } from '../../src/import/rules'
import type { NormalizedRow } from '../../src/import/types'
import type { Transaction } from '../../src/model/types'

setFixedNow('2026-07-12T00:00:00Z')

function row(p: Partial<NormalizedRow>): NormalizedRow {
  return { bookedDate: '2026-06-01', amountMinor: -1000, currency: 'EUR', merchant: 'ENGIE', normDesc: 'ENGIE', kind: 'expense', sourceLine: 0, raw: 'x', ...p }
}
function rule(p: Partial<Rule> & { value: string }): Rule {
  return {
    id: p.id ?? Math.random().toString(36),
    updatedAt: p.updatedAt ?? '2026-01-01T00:00:00Z',
    categoryId: p.categoryId ?? 'cat',
    priority: p.priority ?? 50,
    source: p.source ?? 'learned',
    enabled: p.enabled,
    match: p.match ?? { field: 'merchant', op: 'equals', value: p.value },
  }
}

describe('rules — evaluation ladder', () => {
  it('first match by priority DESC then updatedAt DESC', () => {
    const r = row({ merchant: 'ENGIE' })
    const seed = rule({ id: 'seed', value: 'ENGIE', priority: 10, source: 'seed', categoryId: 'util' })
    const user = rule({ id: 'user', value: 'ENGIE', priority: 100, source: 'user', categoryId: 'special' })
    expect(evaluateRules(r, [seed, user])?.categoryId).toBe('special') // user wins
  })

  it('recency breaks ties within a tier', () => {
    const r = row({ merchant: 'ENGIE' })
    const older = rule({ id: 'a', value: 'ENGIE', updatedAt: '2026-01-01T00:00:00Z', categoryId: 'old' })
    const newer = rule({ id: 'b', value: 'ENGIE', updatedAt: '2026-05-01T00:00:00Z', categoryId: 'new' })
    expect(evaluateRules(r, [older, newer])?.categoryId).toBe('new')
  })

  it('disabled rules are skipped', () => {
    const r = row({ merchant: 'ENGIE' })
    const disabled = rule({ value: 'ENGIE', enabled: false, categoryId: 'x' })
    expect(evaluateRules(r, [disabled])).toBeNull()
  })

  it('prefix and contains operators', () => {
    expect(evaluateRules(row({ merchant: 'SUPER U TOULOUSE' }), [rule({ value: 'SUPER U', match: { field: 'merchant', op: 'prefix', value: 'SUPER U' }, categoryId: 'g' })])?.categoryId).toBe('g')
    expect(evaluateRules(row({ normDesc: 'FOO LOYER BAR' }), [rule({ value: 'LOYER', match: { field: 'descriptor', op: 'contains', value: 'LOYER' }, categoryId: 'h' })])?.categoryId).toBe('h')
  })
})

describe('rules — minting', () => {
  it('mint key robustness: creditorId > counterparty > merchant > descriptor', () => {
    expect(mintKey(row({ creditorId: 'FR35ZZZ418323', counterparty: 'BOUYGUES', merchant: 'BOUYGUES' }))!.field).toBe('creditorId')
    expect(mintKey(row({ creditorId: undefined, counterparty: 'ENGIE' }))!.field).toBe('counterparty')
    expect(mintKey(row({ creditorId: undefined, counterparty: undefined, merchant: 'MONOPRIX' }))!.field).toBe('merchant')
    expect(mintKey(row({ creditorId: undefined, counterparty: undefined, merchant: '', normDesc: 'X' }))!.field).toBe('descriptor')
  })

  it('mintLearnedRule builds a priority-50 learned rule on the robust key', () => {
    const r = mintLearnedRule(row({ creditorId: 'FR35ZZZ418323' }), 'sub')!
    expect(r.source).toBe('learned')
    expect(r.priority).toBe(50)
    expect(r.match).toEqual({ field: 'creditorId', op: 'equals', value: 'FR35ZZZ418323' })
  })

  /**
   * #19 — direction is part of a counterparty's identity (one person both sends and receives),
   * and part of nothing else: §5.4 needs a `Card Refund` to read as its merchant's category, so
   * a merchant/creditorId/descriptor key must stay sign-blind.
   */
  it('scopes a counterparty key to the row’s direction and leaves every other key sign-blind', () => {
    expect(mintKey(row({ counterparty: 'IVAN PETRENKO', amountMinor: -200000 }))!.sign).toBe('outflow')
    expect(mintKey(row({ counterparty: 'IVAN PETRENKO', amountMinor: 300000 }))!.sign).toBe('inflow')
    expect(mintKey(row({ creditorId: 'FR35ZZZ418323', amountMinor: -1000 }))!.sign).toBeUndefined()
    expect(mintKey(row({ counterparty: undefined, merchant: 'MONOPRIX', amountMinor: 1250 }))!.sign).toBeUndefined()
    expect(mintKey(row({ counterparty: undefined, merchant: '', normDesc: 'X', amountMinor: -1000 }))!.sign).toBeUndefined()
  })

  it('mints sign-blind when the caller has no amount to offer', () => {
    expect(mintKey({ counterparty: 'ENGIE', merchant: 'ENGIE', normDesc: 'ENGIE' })!.sign).toBeUndefined()
  })
})

describe('rules — direction scoping (#19)', () => {
  const income = (sign?: 'inflow' | 'outflow'): Rule =>
    rule({ value: 'IVAN PETRENKO', categoryId: 'income', match: { field: 'counterparty', op: 'equals', value: 'IVAN PETRENKO', ...(sign ? { sign } : {}) } })

  it('an inflow-scoped rule ignores the outflow leg of the same counterparty', () => {
    const out = row({ counterparty: 'IVAN PETRENKO', merchant: 'x', amountMinor: -200000 })
    const inn = row({ counterparty: 'IVAN PETRENKO', merchant: 'x', amountMinor: 300000 })
    expect(evaluateRules(out, [income('inflow')])).toBeNull()
    expect(evaluateRules(inn, [income('inflow')])?.categoryId).toBe('income')
  })

  it('no sign ⇒ either direction — the §5.4-preserving default every existing rule keeps', () => {
    const out = row({ counterparty: 'IVAN PETRENKO', merchant: 'x', amountMinor: -200000 })
    const inn = row({ counterparty: 'IVAN PETRENKO', merchant: 'x', amountMinor: 300000 })
    expect(evaluateRules(out, [income()])?.categoryId).toBe('income')
    expect(evaluateRules(inn, [income()])?.categoryId).toBe('income')
  })

  it('matchesRule reads a committed transaction’s direction the same way', () => {
    const t = (amount: number): Transaction => ({ id: 't', updatedAt: '2026-07-01T00:00:00Z', date: '2026-06-01', merchant: 'x', counterparty: 'IVAN PETRENKO', categoryId: 'other', amount })
    expect(matchesRule(t(-2000), income('inflow'))).toBe(false)
    expect(matchesRule(t(3000), income('inflow'))).toBe(true)
    expect(matchesRule(t(-2000), income('outflow'))).toBe(true)
    expect(matchesRule(t(-2000), income())).toBe(true)
  })

  it('a zero amount reads as an inflow rather than falling out of both scopes', () => {
    const zero = row({ counterparty: 'X', merchant: 'x', amountMinor: 0 })
    expect(evaluateRules(zero, [rule({ value: 'X', match: { field: 'counterparty', op: 'equals', value: 'X', sign: 'inflow' } })])).not.toBeNull()
    expect(evaluateRules(zero, [rule({ value: 'X', match: { field: 'counterparty', op: 'equals', value: 'X', sign: 'outflow' } })])).toBeNull()
  })

  it('names the direction it scoped to, so the Always offer states its own narrowing', () => {
    expect(ruleKeyLabel(income('outflow'))).toBe('matches counterparty “IVAN PETRENKO” · money out')
    expect(ruleKeyLabel(income('inflow'))).toBe('matches counterparty “IVAN PETRENKO” · money in')
    expect(ruleKeyLabel(income())).toBe('matches counterparty “IVAN PETRENKO”')
  })
})

describe('rules — minting from a committed transaction', () => {
  function txn(p: Partial<Transaction>): Transaction {
    return { id: 't', updatedAt: '2026-07-01T00:00:00Z', date: '2026-06-01', merchant: 'MONOPRIX', categoryId: 'other', amount: -12.5, ...p }
  }

  it('recovers the SEPA key from the raw descriptor, where it is the only place it survives', () => {
    const t = txn({ merchant: 'BOUYGUES', importMeta: { hash: 'h', raw: 'PRLV SEPA BOUYGUES TELECOM EMETTEUR/FR35ZZZ418323 REF/1234' } })
    expect(mintLearnedRuleForTxn(t, 'sub')!.match).toEqual({ field: 'creditorId', op: 'equals', value: 'FR35ZZZ418323' })
  })

  it('falls through counterparty → merchant → descriptor, the same ranking as an import row', () => {
    expect(mintLearnedRuleForTxn(txn({ counterparty: 'ENGIE' }), 'c')!.match.field).toBe('counterparty')
    expect(mintLearnedRuleForTxn(txn({ merchant: 'MONOPRIX' }), 'c')!.match).toEqual({ field: 'merchant', op: 'equals', value: 'MONOPRIX' })
    expect(mintLearnedRuleForTxn(txn({ merchant: '', importMeta: { hash: 'h', raw: 'CB 4321 RETRAIT' } }), 'c')!.match.field).toBe('descriptor')
  })

  it('a row with nothing to key on mints no rule rather than a rule matching everything', () => {
    expect(mintLearnedRuleForTxn(txn({ merchant: '' }), 'c')).toBeNull()
  })

  /**
   * The invariant the *Always* offer rests on: whatever key is chosen, the rule must match
   * the row it was minted from — otherwise "Always → X" would silently exclude its own row
   * from the backfill it offers.
   */
  it('every minted rule matches the transaction it was minted from', () => {
    const cases = [
      txn({ merchant: 'BOUYGUES', importMeta: { hash: 'h', raw: 'PRLV EMETTEUR/FR35ZZZ418323' } }),
      txn({ counterparty: 'ENGIE', merchant: 'ENGIE SA' }),
      txn({ merchant: 'MONOPRIX PARIS 11' }),
      txn({ merchant: '', importMeta: { hash: 'h', raw: 'VIR INST /REF ABC123456' } }),
    ]
    for (const t of cases) expect(matchesRule(t, mintLearnedRuleForTxn(t, 'cat')!)).toBe(true)
  })

  it('names the key it would rule on, SEPA ids unquoted', () => {
    expect(ruleKeyLabel(rule({ value: 'X', match: { field: 'creditorId', op: 'equals', value: 'FR35ZZZ418323' } }))).toBe('matches SEPA creditor id FR35ZZZ418323')
    expect(ruleKeyLabel(rule({ value: 'MONOPRIX' }))).toBe('matches merchant “MONOPRIX”')
  })
})

describe('rules — starter pack', () => {
  it('offers once for a French bank, then never again', () => {
    const v = emptyVault()
    expect(shouldOfferStarterPack(v, 'bnp')).toBe(true)
    expect(shouldOfferStarterPack(v, 'revolut')).toBe(false)
    v.settings.starterPackOffered = true
    expect(shouldOfferStarterPack(v, 'bnp')).toBe(false)
  })

  it('installs seed rules, reusing base categories by name', () => {
    const v = emptyVault()
    const { categories, rules } = installStarterPack(v)
    // Every pack category now lives in the base seed → nothing is minted; rules reuse base ids.
    expect(categories).toHaveLength(0)
    expect(rules.every((r) => r.source === 'seed' && r.priority === 10)).toBe(true)
    // every rule resolves to a real category id (existing or freshly minted)
    const known = new Set([...v.categories.map((c) => c.id), ...categories.map((c) => c.id)])
    expect(rules.every((r) => known.has(r.categoryId))).toBe(true)
  })
})
