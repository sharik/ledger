import { describe, expect, it } from 'vitest'
import { subscriptions } from '../../src/analytics/subscriptions'
import { emptyVault } from '../../src/model/seed'
import type { Transaction, Vault } from '../../src/model/types'

const TODAY = '2026-07-12'
let n = 0
const txn = (date: string, amount: number, merchant: string, recurring?: 'monthly' | 'yearly'): Transaction =>
  ({ id: `t${n++}`, updatedAt: '2026-07-01T00:00:00.000Z', date, merchant, categoryId: 'ent', amount, recurring }) as Transaction

const vaultWith = (txns: Transaction[]): Vault => ({ ...emptyVault(), transactions: txns })

/** Six monthly charges ending on `last`, all the same amount. */
function monthlyRun(merchant: string, amount: number, months: string[], recurring?: 'monthly' | 'yearly'): Transaction[] {
  return months.map((m) => txn(`${m}-06`, -amount, merchant, recurring))
}

const M6 = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']

describe('subscriptions', () => {
  it('totals only what the user has confirmed', () => {
    const v = vaultWith([...monthlyRun('Netflix', 13.49, M6, 'monthly'), ...monthlyRun('Spotify', 11.99, M6)])
    const s = subscriptions(v, TODAY)
    expect(s.rows.map((r) => r.merchant)).toEqual(['Netflix'])
    expect(s.monthlyTotal).toBe(13.49)
    // Spotify is detected but unmarked — visible, and deliberately not in the total.
    expect(s.unconfirmed.map((r) => r.merchant)).toEqual(['Spotify'])
  })

  // The row showed a typical amount and a cadence and nothing else: how long it had run, how
  // many charges that was, or what it had cost in total were all uncomputed.
  it('reports the span, the charge count and the money counted', () => {
    const v = vaultWith(monthlyRun('Netflix', 10, ['2025-11', '2025-12', '2026-01', '2026-02'], 'monthly'))
    const r = subscriptions(v, TODAY).rows[0]!
    expect(r.firstDate).toBe('2025-11-06')
    expect(r.lastDate).toBe('2026-02-06')
    expect(r.count).toBe(4)
    expect(r.totalCounted).toBe(40)
  })

  it('splits the run by calendar year, newest first, summing to the total', () => {
    const v = vaultWith(monthlyRun('Netflix', 10, ['2025-11', '2025-12', '2026-01', '2026-02'], 'monthly'))
    const r = subscriptions(v, TODAY).rows[0]!
    expect(r.byYear).toEqual([
      { year: 2026, count: 2, total: 20 },
      { year: 2025, count: 2, total: 20 },
    ])
    expect(r.byYear.reduce((s, y) => s + y.total, 0)).toBe(r.totalCounted)
    expect(r.byYear.reduce((s, y) => s + y.count, 0)).toBe(r.count)
  })

  it('annualises monthly plus yearly', () => {
    const v = vaultWith([
      ...monthlyRun('Netflix', 10, M6, 'monthly'),
      txn('2024-03-02', -14, 'Domain', 'yearly'),
      txn('2025-03-02', -14, 'Domain', 'yearly'),
      txn('2026-03-02', -14, 'Domain', 'yearly'),
    ])
    const s = subscriptions(v, TODAY)
    expect(s.monthlyTotal).toBe(10)
    expect(s.annualisedTotal).toBe(134)
  })

  it('flags a price rise beyond the tolerance, and ignores noise below it', () => {
    const rise = vaultWith([
      ...monthlyRun('Spotify', 11.99, M6.slice(0, 5), 'monthly'),
      txn('2026-07-06', -13.99, 'Spotify', 'monthly'),
    ])
    const r = subscriptions(rise, TODAY).rows[0]!
    expect(r.state).toBe('increased')
    expect(r.deltaPct).toBe(17)

    const noise = vaultWith([
      ...monthlyRun('Gym', 40, M6.slice(0, 5), 'monthly'),
      txn('2026-07-06', -41, 'Gym', 'monthly'),
    ])
    expect(subscriptions(noise, TODAY).rows[0]!.state).toBe('steady')
  })

  it('flags a drop as decreased, not as a rise', () => {
    const v = vaultWith([
      ...monthlyRun('Gym', 40, M6.slice(0, 5), 'monthly'),
      txn('2026-07-06', -25, 'Gym', 'monthly'),
    ])
    const r = subscriptions(v, TODAY).rows[0]!
    expect(r.state).toBe('decreased')
    expect(r.deltaPct).toBeLessThan(0)
  })

  // Nothing since 1.5 cadence periods means the charge stopped. A lapsed row must not keep
  // inflating the monthly total — that is the "am I still paying for this?" question inverted.
  it('marks a stopped charge lapsed and drops it from the total', () => {
    const v = vaultWith(monthlyRun('Deezer', 10.99, ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02'], 'monthly'))
    const s = subscriptions(v, TODAY)
    expect(s.rows[0]!.state).toBe('lapsed')
    expect(s.monthlyTotal).toBe(0)
  })

  it('calls a run that only started recently new', () => {
    const v = vaultWith(monthlyRun('Gym', 39, ['2026-05', '2026-06', '2026-07'], 'monthly'))
    expect(subscriptions(v, TODAY).rows[0]!.state).toBe('new')
  })

  // A cadence, never a due date (QUESTIONARY §2 refuses Q15–Q20 on exactly this ground).
  it('projects the next charge from the median gap in the user own history', () => {
    const v = vaultWith(monthlyRun('Netflix', 13.49, M6, 'monthly'))
    const r = subscriptions(v, TODAY).rows[0]!
    expect(r.lastDate).toBe('2026-07-06')
    expect(r.expectedNext > r.lastDate).toBe(true)
    expect(r.expectedNext.slice(0, 7)).toBe('2026-08')
  })

  it('ignores income and refunds — only debits can be a subscription', () => {
    const v = vaultWith(M6.map((m) => txn(`${m}-06`, 500, 'Employer', 'monthly')))
    const s = subscriptions(v, TODAY)
    expect(s.rows).toHaveLength(0)
    expect(s.monthlyTotal).toBe(0)
  })

  it('groups a merchant whose descriptor carries a changing reference', () => {
    const v = vaultWith(M6.map((m, i) => txn(`${m}-06`, -13.49, `NETFLIX #${1000 + i}`, 'monthly')))
    const s = subscriptions(v, TODAY)
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]!.count).toBe(6)
  })

  it('never lists the same merchant as both confirmed and a suggestion', () => {
    const v = vaultWith(monthlyRun('Netflix', 13.49, M6, 'monthly'))
    const s = subscriptions(v, TODAY)
    expect(s.rows).toHaveLength(1)
    expect(s.unconfirmed).toHaveLength(0)
  })
})

describe('multi-currency', () => {
  const UAH_ACC = { id: 'acc-uah', updatedAt: '2026-07-01T00:00:00.000Z', liab: false, liquid: true, name: 'Privat', currency: 'UAH' }

  it('foreign charges convert to base — typical and totals are in EUR', () => {
    const rows = monthlyRun('Kyivstar', 249, M6, 'monthly').map((t) => ({ ...t, accountId: 'acc-uah' }))
    const v: Vault = {
      ...emptyVault(),
      transactions: rows,
      accounts: [UAH_ACC as never],
      fxOverrides: [{ id: 'o', updatedAt: '2026-07-01T00:00:00.000Z', from: 'UAH', to: 'EUR', date: '2026-01-01', rate: 0.02 }],
    }
    const s = subscriptions(v, TODAY)
    expect(s.rows[0]!.typical).toBe(4.98) // ₴249 × 0.02, not 249
    expect(s.monthlyTotal).toBe(4.98)
    expect(s.annualisedTotal).toBe(59.76)
  })

  it('foreign charges with no resolvable rate are excluded, never grouped as base', () => {
    const rows = monthlyRun('Kyivstar', 249, M6, 'monthly').map((t) => ({ ...t, accountId: 'acc-uah' }))
    const v: Vault = { ...emptyVault(), transactions: rows, accounts: [UAH_ACC as never] }
    const s = subscriptions(v, TODAY)
    expect(s.rows).toEqual([])
    expect(s.monthlyTotal).toBe(0)
  })
})
