import { describe, it, expect } from 'vitest'
import type { Transaction } from '../../src/model/types'
import type { NormalizedRow } from '../../src/import/types'
import { buildManualHistory, historyLookup } from '../../src/import/history'

function row(p: Partial<NormalizedRow>): NormalizedRow {
  return { bookedDate: '2026-06-01', amountMinor: -1000, currency: 'EUR', merchant: 'APTEKA KRAKÓW', normDesc: 'APTEKA KRAKOW', kind: 'expense', sourceLine: 0, raw: 'x', ...p }
}
function txn(p: Partial<Transaction>): Transaction {
  return { id: Math.random().toString(36), updatedAt: '2026-07-01T00:00:00Z', date: '2026-06-01', merchant: 'APTEKA KRAKÓW', categoryId: 'health', amount: -12.5, provenance: 'manual', ...p }
}
function lookup(rows: Transaction[], r: NormalizedRow) {
  return historyLookup(r, buildManualHistory(rows))
}

describe('manual history — sourcing', () => {
  it('suggests the category a matching merchant was hand-categorized as', () => {
    expect(lookup([txn({ merchant: 'APTEKA KRAKÓW', categoryId: 'health' })], row({ merchant: 'APTEKA KRAKÓW' }))).toBe('health')
  })

  it('matches merchant case-insensitively, like the rule ladder', () => {
    expect(lookup([txn({ merchant: 'apteka kraków', categoryId: 'health' })], row({ merchant: 'APTEKA KRAKÓW' }))).toBe('health')
  })

  it('only `manual` transactions seed a suggestion — no feedback loop from ai/rule/fallback/history', () => {
    for (const p of ['ai', 'rule', 'fallback', 'history', undefined] as const) {
      expect(lookup([txn({ provenance: p, categoryId: 'health' })], row({}))).toBeNull()
    }
  })

  it('returns null for a merchant never categorized by hand', () => {
    expect(lookup([txn({ merchant: 'MONOPRIX', categoryId: 'grocery' })], row({ merchant: 'FNAC' }))).toBeNull()
  })
})

describe('manual history — key priority', () => {
  it('a SEPA creditor id (in the raw) beats a bare merchant match', () => {
    // Same creditor id, different displayed merchant → the id still binds it to the past decision.
    const past = txn({ merchant: 'BOUYGUES TELECOM', categoryId: 'util', importMeta: { hash: 'h', raw: 'PRLV EMETTEUR/FR35ZZZ418323' } })
    const r = row({ merchant: 'BOUYGUES SA', creditorId: 'FR35ZZZ418323', normDesc: 'X' })
    expect(lookup([past], r)).toBe('util')
  })

  it('falls back to a weaker key when the strong one has no history', () => {
    // New row carries a creditorId nobody has categorized, but its merchant is known by hand.
    const past = txn({ merchant: 'APTEKA KRAKÓW', categoryId: 'health' })
    const r = row({ merchant: 'APTEKA KRAKÓW', creditorId: 'FR99ZZZ000000' })
    expect(lookup([past], r)).toBe('health')
  })
})

describe('manual history — direction (#19)', () => {
  it('a counterparty’s inbound history says nothing about its outbound rows', () => {
    // The self-transfer boundary (IMPORT §1): money arriving from an untracked account is real income,
    // money leaving for it is not — and one name serves both directions.
    const past = txn({ merchant: 'IVAN PETRENKO', counterparty: 'IVAN PETRENKO', categoryId: 'income', amount: 3000 })
    const out = row({ merchant: 'IVAN PETRENKO', counterparty: 'IVAN PETRENKO', amountMinor: -200000 })
    const inn = row({ merchant: 'IVAN PETRENKO', counterparty: 'IVAN PETRENKO', amountMinor: 300000 })
    expect(lookup([past], inn)).toBe('income')
    expect(lookup([past], out)).toBeNull()
  })

  it('merchant history stays sign-blind, so a refund still finds its category (§5.4)', () => {
    const past = txn({ merchant: 'MONOPRIX', categoryId: 'grocery', amount: -40 })
    expect(lookup([past], row({ merchant: 'MONOPRIX', amountMinor: 1200 }))).toBe('grocery')
  })
})

describe('manual history — disagreement policy', () => {
  it('takes the most frequent category for a key', () => {
    const rows = [
      txn({ merchant: 'AMAZON', categoryId: 'shopping', updatedAt: '2026-01-01T00:00:00Z' }),
      txn({ merchant: 'AMAZON', categoryId: 'shopping', updatedAt: '2026-02-01T00:00:00Z' }),
      txn({ merchant: 'AMAZON', categoryId: 'electronics', updatedAt: '2026-03-01T00:00:00Z' }),
    ]
    expect(lookup(rows, row({ merchant: 'AMAZON' }))).toBe('shopping')
  })

  it('breaks a frequency tie by the most recent pick', () => {
    const rows = [
      txn({ merchant: 'AMAZON', categoryId: 'shopping', updatedAt: '2026-01-01T00:00:00Z' }),
      txn({ merchant: 'AMAZON', categoryId: 'electronics', updatedAt: '2026-05-01T00:00:00Z' }),
    ]
    expect(lookup(rows, row({ merchant: 'AMAZON' }))).toBe('electronics')
  })
})
