import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow } from '../../src/model/clock'
import type { BalanceSnapshot, Goal, Vault } from '../../src/model/types'
import { goalStatus } from '../../src/analytics/goals'
import { acc, buildVault, catId, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const TODAY = '2026-07-12'

const goal = (v: Vault, p: Partial<Goal> & { name: string; target: number }): Goal => {
  const g: Goal = { id: 'g-' + p.name, updatedAt: now(), saved: 0, monthly: 0, ...p }
  v.goals.push(g)
  return g
}
const snapAt = (v: Vault, accountId: string, date: string, amount: number, origin?: BalanceSnapshot['origin']) => {
  v.snapshots.push({ id: 'snap-' + date, updatedAt: now(), accountId, date, amount, createdAt: now(), origin })
}

describe('legacy goals (§6.1)', () => {
  it('use stored saved/monthly and project an ETA', () => {
    const v = buildVault()
    const g = goal(v, { name: 'Trip', target: 1000, saved: 200, monthly: 100 })
    const s = goalStatus(v, g, TODAY)
    expect(s.kind).toBe('legacy')
    expect(s.progress).toBe(200)
    expect(s.fraction).toBeCloseTo(0.2)
    expect(s.eta).toBe('2027-03') // 800 / 100 = 8 months from 2026-07
  })
})

describe('flow goals (§6.1)', () => {
  it('progress is Σ(−amount) over the category; refunds net out', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'Groceries', 'Groceries', -100)
    txn(v, '2026-06-05', 'Groceries', 'Groceries', -80)
    txn(v, '2026-07-08', 'Refund', 'Groceries', 30) // refund reduces progress
    const g = goal(v, { name: 'Food fund', target: 500, source: { kind: 'flow', categoryId: catId(v, 'Groceries') } })
    const s = goalStatus(v, g, TODAY)
    expect(s.kind).toBe('flow')
    expect(s.progress).toBe(150) // 100 + 80 − 30
    expect(s.eta).not.toBeNull() // June contribution → positive trailing pace
  })

  it('flat contribution history yields no ETA', () => {
    const v = buildVault()
    txn(v, '2026-07-03', 'Groceries', 'Groceries', -100) // current month only, no trailing pace
    const g = goal(v, { name: 'Food fund', target: 500, source: { kind: 'flow', categoryId: catId(v, 'Groceries') } })
    expect(goalStatus(v, g, TODAY).eta).toBeNull()
  })
})

describe('balance goals (§6.1)', () => {
  it('emergency fund (up): progress is the latest snapshot; saved is ignored', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Livret A', liquid: true })
    snapAt(v, a.id, '2026-05-15', 15000, { kind: 'manual' })
    snapAt(v, a.id, '2026-06-15', 18000, { kind: 'manual' })
    snapAt(v, a.id, '2026-07-01', 20000, { kind: 'manual' })
    const g = goal(v, { name: 'EF', target: 28000, saved: 999, source: { kind: 'balance', accountId: a.id, direction: 'up', target: 28000 } })
    const s = goalStatus(v, g, TODAY)
    expect(s.progress).toBe(20000) // not 999
    expect(s.fraction).toBeCloseTo(20000 / 28000)
    expect(s.asOf).toBe('2026-07-01')
    expect(s.eta).not.toBeNull() // rising fit
  })

  it('mortgage payoff (down): fraction measures paid-down from the baseline', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Mortgage', liab: true })
    snapAt(v, a.id, '2026-01-01', 210400)
    snapAt(v, a.id, '2026-04-01', 205100)
    snapAt(v, a.id, '2026-07-01', 199650)
    const g = goal(v, { name: 'Payoff', target: 0, source: { kind: 'balance', accountId: a.id, direction: 'down', target: 0 } })
    const s = goalStatus(v, g, TODAY)
    expect(s.progress).toBe(199650)
    expect(s.fraction).toBeCloseTo((210400 - 199650) / 210400, 4)
    expect(s.eta).not.toBeNull() // declining fit toward 0
  })

  it('a single snapshot is not enough for a trajectory', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Livret A', liquid: true })
    snapAt(v, a.id, '2026-07-01', 20000, { kind: 'manual' })
    const g = goal(v, { name: 'EF', target: 28000, source: { kind: 'balance', accountId: a.id, direction: 'up', target: 28000 } })
    const s = goalStatus(v, g, TODAY)
    expect(s.eta).toBeNull()
    expect(s.note).toBe('no-trajectory')
  })

  it('a removed account keeps history but never fabricates progress', () => {
    const v = buildVault()
    const g = goal(v, { name: 'EF', target: 28000, source: { kind: 'balance', accountId: 'gone', direction: 'up', target: 28000 } })
    expect(goalStatus(v, g, TODAY).note).toBe('account-removed')
  })
})

describe('multi-currency flow goals', () => {
  it('contributions convert to base at the row date; no rate ⇒ excluded', () => {
    const v = buildVault()
    const a = acc(v, { name: 'Privat', currency: 'UAH' })
    const t1 = txn(v, '2026-07-03', 'Deposit', 'Groceries', -1000)
    t1.accountId = a.id
    txn(v, '2026-07-05', 'Deposit', 'Groceries', -10) // base-currency row
    v.fxOverrides.push({ id: 'o-uah', updatedAt: now(), from: 'UAH', to: 'EUR', date: '2026-01-01', rate: 0.02 })
    const g = goal(v, { name: 'Fund', target: 100, source: { kind: 'flow', categoryId: catId(v, 'Groceries') } })
    expect(goalStatus(v, g, TODAY).progress).toBe(30) // 1000 × 0.02 + 10

    // Without a rate the UAH row is excluded, not counted as €1,000 of progress.
    const v2 = buildVault()
    const a2 = acc(v2, { name: 'Privat', currency: 'UAH' })
    const t2 = txn(v2, '2026-07-03', 'Deposit', 'Groceries', -1000)
    t2.accountId = a2.id
    const g2 = goal(v2, { name: 'Fund', target: 100, source: { kind: 'flow', categoryId: catId(v2, 'Groceries') } })
    expect(goalStatus(v2, g2, TODAY).progress).toBe(0)
  })
})
