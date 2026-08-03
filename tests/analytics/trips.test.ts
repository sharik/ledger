import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow, uuidv7, now } from '../../src/model/clock'
import { acc, buildVault, catId, txn } from '../helpers/build'
import type { Tracking, Vault } from '../../src/model/types'
import { tripSummary, tripDaily, suggestExcludes, tripForecast } from '../../src/analytics/trips'
import { buildRateBook } from '../../src/import/fx'
import { round2, visibleVault } from '../../src/model/selectors'

beforeAll(() => setFixedNow('2026-07-12T00:00:00Z'))

function trip(v: Vault, name: string, from: string, to: string): Tracking {
  const t: Tracking = { id: uuidv7(), updatedAt: now(), name, kind: 'trip', dateFrom: from, dateTo: to }
  v.trackings.push(t)
  return t
}

describe('tripSummary', () => {
  it('totals expense members, computes €/day over the window, category mix desc', () => {
    const v = buildVault()
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10') // 10 days
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300)
    txn(v, '2026-06-03', 'Resto', 'Dining out', -100)
    txn(v, '2026-06-04', 'Salary', 'Income', 500) // income never counts as trip spend
    txn(v, '2026-05-30', 'Before', 'Shopping', -999) // outside window
    const s = tripSummary(v, t.id, 'EUR')
    expect(s.total).toBe(400)
    expect(s.days).toBe(10)
    expect(s.perDay).toBe(40)
    expect(s.byCategory[0]).toEqual({ categoryId: catId(v, 'Shopping'), spend: 300 })
  })

  it('converts a foreign member via the RateBook; counts unconvertible rows', () => {
    const v = buildVault()
    v.fxOverrides.push({ id: 'o', updatedAt: now(), from: 'JPY', to: 'EUR', date: '2026-05-01', rate: 0.0061 })
    const t = trip(v, 'Japan', '2026-05-01', '2026-05-10')
    v.transactions.push({
      id: 'jpy', updatedAt: now(), date: '2026-05-02', merchant: 'Ramen', categoryId: catId(v, 'Dining out'),
      amount: -8199, currency: 'JPY',
    })
    const s = tripSummary(v, t.id, 'EUR', buildRateBook(v))
    expect(s.currencies).toEqual(['JPY'])
    expect(s.foreignCount).toBe(0)
    expect(s.total).toBeCloseTo(8199 * 0.0061, 2)
  })

  it('excludes a foreign member when no rate resolves', () => {
    const v = buildVault()
    const t = trip(v, 'X', '2026-05-01', '2026-05-10')
    v.transactions.push({ id: 'z', updatedAt: now(), date: '2026-05-02', merchant: 'M', categoryId: catId(v, 'Shopping'), amount: -100, currency: 'ZWL' })
    const s = tripSummary(v, t.id, 'EUR', buildRateBook(v))
    expect(s.foreignCount).toBe(1)
    expect(s.total).toBe(0)
  })
})

describe('effective span (union of window and members)', () => {
  // A trip created from a transaction's `trip ▾` chip gets a single-day window and never widens
  // as rows are added by `include`. Reading the window alone reported a 32-row trip as
  // "1 day · €1,880/day" on the real vault, while Compare — which derives a tracking's period
  // from the resolved rows — reported 68 days for the same trip.
  it('spans the members when they fall outside a single-day window', () => {
    const v = buildVault()
    const t = trip(v, 'Vietnam', '2026-02-02', '2026-02-02')
    const inWindow = txn(v, '2026-02-02', 'Pho', 'Dining out', -20)
    const later = txn(v, '2026-02-14', 'Hotel', 'Shopping', -100)
    const latest = txn(v, '2026-04-10', 'Flight', 'Travel', -300)
    for (const x of [later, latest]) {
      v.trackingAssignments.push({ id: uuidv7(), updatedAt: now(), trackingId: t.id, txnId: x.id, dir: 'include' })
    }
    const s = tripSummary(v, t.id, 'EUR')
    expect(s.memberCount).toBe(3)
    expect(s.spanFrom).toBe('2026-02-02')
    expect(s.spanTo).toBe('2026-04-10')
    expect(s.days).toBe(68) // 2 Feb → 10 Apr inclusive
    expect(s.perDay).toBe(round2(420 / 68))
    expect(inWindow.date).toBe('2026-02-02')
  })

  it('is the window when every member is inside it — the union changes nothing', () => {
    const v = buildVault()
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300)
    const s = tripSummary(v, t.id, 'EUR')
    expect(s.days).toBe(10)
    expect(s.spanFrom).toBe('2026-06-01')
    expect(s.spanTo).toBe('2026-06-10')
  })

  it('does not change membership — the stored window is never widened', () => {
    const v = buildVault()
    const t = trip(v, 'Vietnam', '2026-02-02', '2026-02-02')
    txn(v, '2026-02-02', 'Pho', 'Dining out', -20) // joins by the window
    const far = txn(v, '2026-04-10', 'Flight', 'Travel', -300)
    v.trackingAssignments.push({ id: uuidv7(), updatedAt: now(), trackingId: t.id, txnId: far.id, dir: 'include' })
    // An unrelated row inside the *widened* span must stay out: only the window and explicit
    // includes decide membership.
    txn(v, '2026-03-01', 'Groceries at home', 'Groceries', -50)
    const s = tripSummary(v, t.id, 'EUR')
    expect(s.days).toBe(68)
    expect(s.memberCount).toBe(2)
    expect(s.total).toBe(320)
    expect(v.trackings.find((x) => x.id === t.id)).toMatchObject({ dateFrom: '2026-02-02', dateTo: '2026-02-02' })
  })
})

describe('tripDaily', () => {
  it('is zero-filled across the whole span and sums to the trip total', () => {
    const v = buildVault()
    const t = trip(v, 'Trip', '2026-06-01', '2026-06-05')
    txn(v, '2026-06-01', 'A', 'Shopping', -30)
    txn(v, '2026-06-01', 'B', 'Dining out', -10)
    txn(v, '2026-06-04', 'C', 'Shopping', -60)
    const d = tripDaily(v, t.id, 'EUR')
    expect(d.map((x) => x.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'])
    expect(d.map((x) => x.spend)).toEqual([40, 0, 0, 60, 0])
    expect(d.reduce((a, b) => a + b.spend, 0)).toBe(tripSummary(v, t.id, 'EUR').total)
  })

  it('is empty for a tracking with neither a window nor members', () => {
    const v = buildVault()
    const t: Tracking = { id: uuidv7(), updatedAt: now(), name: 'Empty', kind: 'set' }
    v.trackings.push(t)
    expect(tripDaily(v, t.id, 'EUR')).toEqual([])
  })
})

describe('hidden accounts', () => {
  it('a trip shrinks when an account is hidden, and unhiding restores it exactly', () => {
    // trackingAssignments are never filtered — members() treats a dangling assignment as
    // inert — so hiding is reversible with nothing lost.
    const v = buildVault()
    const live = acc(v, { name: 'Live' })
    const dead = acc(v, { name: 'Dead' })
    const t = trip(v, 'Poland', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-02', 'Hotel', 'Shopping', -300).accountId = live.id
    txn(v, '2026-06-03', 'Resto', 'Dining out', -100).accountId = dead.id

    const before = tripSummary(v, t.id, 'EUR')
    expect(before.total).toBe(400)

    const hidden = { ...v, accounts: v.accounts.map((a) => (a.id === dead.id ? { ...a, hidden: true } : a)) }
    expect(tripSummary(visibleVault(hidden), t.id, 'EUR').total).toBe(300)

    const unhidden = { ...hidden, accounts: hidden.accounts.map((a) => ({ ...a, hidden: undefined })) }
    expect(tripSummary(visibleVault(unhidden), t.id, 'EUR')).toEqual(before)
  })
})

describe('suggestExcludes (§8.2)', () => {
  it('flags a member recurring in ≥2 months outside the window', () => {
    const v = buildVault()
    const t = trip(v, 'Trip', '2026-06-01', '2026-06-10')
    // Loyer inside the window + two months outside → recurring
    txn(v, '2026-06-05', 'Loyer', 'Housing', -1240)
    txn(v, '2026-04-05', 'Loyer', 'Housing', -1240)
    txn(v, '2026-05-05', 'Loyer', 'Housing', -1240)
    // A one-off inside the window → not recurring
    txn(v, '2026-06-06', 'Souvenir', 'Shopping', -40)
    const sug = suggestExcludes(v, { id: t.id, dateFrom: t.dateFrom, dateTo: t.dateTo })
    expect(sug.length).toBe(1)
    expect(sug[0]!.merchant).toBe('Loyer')
    expect(sug[0]!.reason).toMatch(/also charged in 2 other months/)
  })

  it('returns nothing for an unwindowed tracking', () => {
    const v = buildVault()
    expect(suggestExcludes(v, { id: 'x' })).toEqual([])
  })

  it('groups a payee billed twice in the window into one suggestion', () => {
    const v = buildVault()
    const t = trip(v, 'Trip', '2026-06-01', '2026-06-30')
    txn(v, '2026-06-03', 'Telecom', 'Utilities', -20)
    txn(v, '2026-06-19', 'Telecom', 'Utilities', -12)
    txn(v, '2026-04-03', 'Telecom', 'Utilities', -20)
    txn(v, '2026-05-03', 'Telecom', 'Utilities', -20)
    const sug = suggestExcludes(v, { id: t.id, dateFrom: t.dateFrom, dateTo: t.dateTo })
    expect(sug.length).toBe(1)
    expect(sug[0]!.txnIds.length).toBe(2)
    expect(sug[0]!.total).toBe(-32)
  })

  it('ignores a payee whose other months are far outside the window', () => {
    // A shop you hit on last year's trip to the same city is not a recurring home bill —
    // this is what flagged Marks & Spencer and Transport for London during a London trip.
    const v = buildVault()
    const t = trip(v, 'London', '2026-06-01', '2026-06-10')
    txn(v, '2026-06-05', 'Marks & Spencer', 'Groceries', -19)
    txn(v, '2025-06-05', 'Marks & Spencer', 'Groceries', -17)
    txn(v, '2025-07-05', 'Marks & Spencer', 'Groceries', -21)
    expect(suggestExcludes(v, { id: t.id, dateFrom: t.dateFrom, dateTo: t.dateTo })).toEqual([])
  })
})

describe('tripForecast', () => {
  it('projects planned days × median €/day of comparable trips', () => {
    const v = buildVault()
    const a = trip(v, 'A', '2026-01-01', '2026-01-10') // 10 days
    const b = trip(v, 'B', '2026-02-01', '2026-02-10')
    txn(v, '2026-01-02', 'x', 'Shopping', -1000) // A: 100/day
    txn(v, '2026-02-02', 'y', 'Shopping', -2000) // B: 200/day
    const f = tripForecast(v, [a.id, b.id], 5, 'EUR')
    expect(f.comparableCount).toBe(2)
    expect(f.perDayMedian).toBe(150) // median of 100 & 200
    expect(f.projected).toBe(750)
  })
})
