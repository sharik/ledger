import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { buildVault } from '../helpers/build'
import {
  bankDerivedRate,
  buildRateBook,
  fetchRateTable,
  parseRateTable,
  rateFor,
  type RateTables,
} from '../../src/import/fx'

beforeAll(() => setFixedNow('2026-07-12T00:00:00Z'))

/** A vault with the real JPY row (§3): EUR débit 372.94, fee 11.38, original −59290 JPY. */
function jpyVault() {
  return buildVault((v) => {
    v.params.baseCurrency = 'EUR'
    v.transactions.push({
      id: 'jpy1', updatedAt: '2026-05-02T00:00:00Z', date: '2026-05-02', merchant: 'JPN SHOP',
      categoryId: v.categories[0]!.id, amount: -372.94, currency: 'EUR', fee: 11.38,
      original: { amount: -59290, currency: 'JPY' },
    })
  })
}

describe('fx — bank-derived rate (§3 JPY)', () => {
  it('derives (|amount| − fee)/|original| ≈ 0.0060982 EUR/JPY', () => {
    const v = jpyVault()
    const r = bankDerivedRate(v, 'JPY', 'EUR')
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(0.0060982, 6)
  })

  // A row on a non-base account stores no `Transaction.currency` at all — `planToOp` writes it only
  // when it differs from the account's. Reading that as "denominated in the base" turned a
  // UAH-priced foreign leg into a EUR/PLN rate, at the top, non-approximate rung of the chain.
  it('reads a row denominated in its ACCOUNT currency, not the vault base', () => {
    const v = buildVault((vv) => {
      vv.params.baseCurrency = 'EUR'
      vv.accounts.push({ id: 'mono', updatedAt: '2026-05-02T00:00:00Z', name: 'Monobank UAH', liab: false, liquid: true, currency: 'UAH' })
      vv.transactions.push({
        id: 'uah1', updatedAt: '2026-05-02T00:00:00Z', date: '2026-05-02', merchant: 'SEAZON',
        categoryId: vv.categories[0]!.id, accountId: 'mono', amount: -2863.15, // UAH, implied by the account
        original: { amount: -59.9, currency: 'EUR' },
      })
    })
    // The row prices EUR in UAH — it says nothing whatever about EUR per EUR.
    expect(bankDerivedRate(v, 'EUR', 'UAH')).toBeCloseTo(47.7988, 4)
    expect(bankDerivedRate(v, 'EUR', 'EUR')).toBeNull()
  })

  it('beats an API table on the same date (priority chain)', () => {
    const v = jpyVault()
    const tables: RateTables = new Map([['2026-05-02', { jpy: 160 }]]) // API: 1 EUR = 160 JPY ⇒ 0.00625
    const r = rateFor(v, 'JPY', 'EUR', '2026-05-02', tables)
    expect(r?.source).toBe('bank-derived')
    expect(r!.rate).toBeCloseTo(0.0060982, 6)
  })
})

describe('fx — override & API tiers', () => {
  it('override beats API but loses to bank-derived', () => {
    const v = buildVault((v) => {
      v.fxOverrides.push({ id: 'o1', updatedAt: '2026-05-01T00:00:00Z', from: 'USD', to: 'EUR', date: '2026-05-01', rate: 0.9 })
    })
    const tables: RateTables = new Map([['2026-05-01', { usd: 1.1 }]]) // API ⇒ 1/1.1 ≈ 0.909
    const r = rateFor(v, 'USD', 'EUR', '2026-05-03', tables)
    expect(r?.source).toBe('override')
    expect(r!.rate).toBe(0.9)
  })

  it('API exact date is not approximate; nearest-earlier flags ≈', () => {
    const v = buildVault()
    const tables: RateTables = new Map([
      ['2026-05-01', { gbp: 0.85 }],
      ['2026-05-10', { gbp: 0.86 }],
    ])
    const exact = rateFor(v, 'GBP', 'EUR', '2026-05-10', tables)
    expect(exact?.source).toBe('api-exact')
    expect(exact?.approx).toBe(false)

    const near = rateFor(v, 'GBP', 'EUR', '2026-05-15', tables)
    expect(near?.source).toBe('api-nearest')
    expect(near?.approx).toBe(true)
    expect(near!.rate).toBeCloseTo(1 / 0.86, 6)
  })

  it('no rate anywhere ⇒ null (tier-5 exclusion)', () => {
    expect(rateFor(buildVault(), 'ZWL', 'EUR', '2026-05-01', new Map())).toBeNull()
  })

  it('identity for base==from', () => {
    const r = rateFor(buildVault(), 'EUR', 'EUR', '2026-05-01')
    expect(r).toEqual({ rate: 1, source: 'identity', approx: false })
  })
})

describe('fx — RateBook.convert', () => {
  it('converts a JPY amount into EUR via the bank-derived rate', () => {
    const book = buildRateBook(jpyVault())
    const c = book.convert(-59290, 'JPY', '2026-05-02')
    expect(c).not.toBeNull()
    expect(c!.value).toBeCloseTo(-361.56, 1) // −59290 × 0.0060982
    expect(c!.source).toBe('bank-derived')
  })

  it('base currency passes through untouched', () => {
    const book = buildRateBook(buildVault())
    expect(book.convert(-100, 'EUR', '2026-05-02')).toEqual({ value: -100, source: 'identity', approx: false })
    expect(book.convert(-100, undefined, '2026-05-02')).toEqual({ value: -100, source: 'identity', approx: false })
  })
})

describe('fx — provider client', () => {
  it('parses the fawazahmed0 shape into a RateTable', () => {
    const t = parseRateTable({ date: '2026-05-01', eur: { usd: 1.08, jpy: 164.2, bad: 'x', neg: -1 } }, 'EUR')
    expect(t).toEqual({ usd: 1.08, jpy: 164.2 })
  })

  it('falls back to the second URL when the primary fails', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (calls.length === 1) return { ok: false } as Response
      return { ok: true, json: async () => ({ eur: { usd: 1.07 } }) } as Response
    }) as unknown as typeof fetch
    const t = await fetchRateTable('2026-05-01', 'EUR', { fetchImpl })
    expect(t).toEqual({ usd: 1.07 })
    expect(calls.length).toBe(2)
  })

  it('returns null (never throws) when every URL fails', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(fetchRateTable('2026-05-01', 'EUR', { fetchImpl })).resolves.toBeNull()
  })
})
