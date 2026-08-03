import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow, now, uuidv7 } from '../../src/model/clock'
import { applyOp } from '../../src/model/mutations'
import { members } from '../../src/model/trackings'
import { buildVault, catId } from '../helpers/build'
import { detectTrips } from '../../src/analytics/tripDetect'
import type { Transaction } from '../../src/model/types'

beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

// The detected trip keeps a window (for display) but marks ONLY the detected foreign-currency rows;
// every other transaction in the window is excluded by default — nothing unrelated is swept in.
describe('detected trip → window kept, only detected rows are members', () => {
  it('includes the ISK spend and excludes both a one-off (Decathlon) and a recurring bill in the window', () => {
    const iskIds: string[] = []
    let decathlon = ''
    let engieInWindow = ''
    const v = buildVault((vault) => {
      const other = catId(vault, 'Other')
      const push = (t: Partial<Transaction> & { date: string; merchant: string; amount: number }) => {
        const id = uuidv7()
        vault.transactions.push({ id, updatedAt: now(), categoryId: other, ...t } as Transaction)
        return id
      }
      // Iceland trip: foreign-currency (ISK) card rows, Aug 25 – Sep 5.
      for (const [date, m, amt] of [['2025-08-25', 'GLACIERWORLD', -240], ['2025-08-28', 'PARKA', -10], ['2025-09-01', 'BONUS', -22], ['2025-09-05', 'MESSINN', -147]] as const)
        iskIds.push(push({ date, merchant: m, amount: amt, currency: 'EUR', original: { amount: amt * 150, currency: 'ISK' } }))
      // A one-off home purchase that merely falls in the dates — must NOT be marked.
      decathlon = push({ date: '2025-08-30', merchant: 'DECATHLON', amount: -89 })
      // A recurring bill inside the window — also must NOT be marked.
      engieInWindow = push({ date: '2025-09-03', merchant: 'ENGIE', amount: -60, counterparty: 'ENGIE' })
    })

    const cand = detectTrips(v.transactions.map((t) => ({ id: t.id, date: t.date, amount: t.amount, currency: t.original?.currency, merchant: t.merchant }))).find((c) => c.currency === 'ISK')
    expect(cand).toBeTruthy()
    expect(cand!.name).toBe('Iceland')
    expect(new Set(cand!.txnIds)).toEqual(new Set(iskIds)) // detection found exactly the ISK rows

    // createReviewed: windowed trip, exclude every in-window row that isn't detected/kept.
    const keep = new Set(cand!.txnIds)
    const assignments = v.transactions
      .filter((t) => t.date >= cand!.dateFrom && t.date <= cand!.dateTo && !keep.has(t.id))
      .map((t) => ({ txnId: t.id, dir: 'exclude' as const }))
    const { vault: v2 } = applyOp(v, {
      kind: 'addTracking',
      tracking: { name: cand!.name, kind: 'trip', color: 'var(--cmpa)', dateFrom: cand!.dateFrom, dateTo: cand!.dateTo },
      assignments,
    })
    const trip = v2.trackings[v2.trackings.length - 1]!
    const mem = members(trip.id, v2)
    for (const id of iskIds) expect(mem.has(id)).toBe(true)
    expect(mem.has(decathlon)).toBe(false)
    expect(mem.has(engieInWindow)).toBe(false)
    expect(mem.size).toBe(iskIds.length) // exactly the detected rows
  })
})
