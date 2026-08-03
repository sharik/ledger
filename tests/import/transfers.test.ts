import { describe, it, expect } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { buildVault, acc } from '../helpers/build'
import type { Transaction, Vault } from '../../src/model/types'
import { pairTransfers } from '../../src/import/transfers'
import type { NormalizedRow } from '../../src/import/types'

setFixedNow('2026-07-12T00:00:00Z')

function existing(v: Vault, accountId: string, date: string, amount: number, merchant = 'x'): Transaction {
  const t: Transaction = { id: `t-${v.transactions.length}`, updatedAt: '2026-06-01T00:00:00Z', date, merchant, categoryId: 'other', amount, accountId }
  v.transactions.push(t)
  return t
}
function row(p: Partial<NormalizedRow>): NormalizedRow {
  return { bookedDate: '2026-05-26', amountMinor: 50000, currency: 'EUR', merchant: 'x', normDesc: 'X', kind: 'transfer-in', sourceLine: 0, raw: 'x', ...p }
}

describe('transfers — pairing', () => {
  it('pairs a +500 in against a −500 out in another account within the window', () => {
    const v = buildVault()
    const spouse = acc(v, { name: 'Spouse BNP' })
    existing(v, spouse.id, '2026-05-25', -500)
    const out = pairTransfers([row({ counterparty: 'MARTIN MARI' })], 'accX', v)
    expect(out).toHaveLength(1)
    expect(out[0]!.existingTxnId).toBeTruthy()
  })

  it('never pairs across a >4-day gap; 4 days ok, 5 days no', () => {
    const v = buildVault()
    const a = acc(v, { name: 'A' })
    existing(v, a.id, '2026-05-22', -500) // 4 days before 05-26
    const ok = pairTransfers([row({})], 'accX', v)
    expect(ok[0]?.existingTxnId).toBeTruthy()

    const v2 = buildVault()
    const b = acc(v2, { name: 'B' })
    existing(v2, b.id, '2026-05-21', -500) // 5 days
    expect(pairTransfers([row({})], 'accX', v2)).toHaveLength(0)
  })

  it('never auto-pairs cross-currency', () => {
    const v = buildVault()
    const a = acc(v, { name: 'A' })
    existing(v, a.id, '2026-05-25', -500)
    // incoming row is USD; existing is EUR default
    const out = pairTransfers([row({ currency: 'USD' })], 'accX', v)
    expect(out).toHaveLength(0)
  })

  it('pairs on a non-EUR account: the candidate currency comes from its account', () => {
    // The stored leg carries no `currency` (it matches its account's), so reading
    // `cand.currency ?? 'EUR'` made every ₴→₴ transfer unpairable — double-counted
    // as ₴5,000 of income AND ₴5,000 of spend.
    const v = buildVault()
    const privat = acc(v, { name: 'Privat', currency: 'UAH' })
    existing(v, privat.id, '2026-05-25', -5000) // UAH leg, currency undefined
    const out = pairTransfers([row({ currency: 'UAH', amountMinor: 500000 })], 'acc-mono', v)
    expect(out).toHaveLength(1)
    expect(out[0]!.existingTxnId).toBeTruthy()
  })

  it('two equally-good candidates ⇒ ambiguous, no link', () => {
    const v = buildVault()
    const a = acc(v, { name: 'A' })
    const b = acc(v, { name: 'B' })
    existing(v, a.id, '2026-05-25', -500)
    existing(v, b.id, '2026-05-25', -500)
    const out = pairTransfers([row({})], 'accX', v)
    expect(out).toHaveLength(1)
    expect(out[0]!.ambiguous?.length).toBe(2)
    expect(out[0]!.existingTxnId).toBeUndefined()
  })

  it('an income top-up with no counterpart leg produces no pairing', () => {
    const v = buildVault()
    acc(v, { name: 'Other' })
    const out = pairTransfers([row({ merchant: 'Payment from IVAN', counterparty: 'IVAN PETRENKO', amountMinor: 300000 })], 'accX', v)
    expect(out).toHaveLength(0)
  })

  it('same-account rows are never paired', () => {
    const v = buildVault()
    const a = acc(v, { name: 'A' })
    existing(v, a.id, '2026-05-25', -500)
    // target account IS a.id → excluded
    expect(pairTransfers([row({})], a.id, v)).toHaveLength(0)
  })
})
