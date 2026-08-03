import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow } from '../src/model/clock'
import type { Budget, Tracking, TrackingAssignment, Transaction, Vault } from '../src/model/types'
import { threeWayMerge } from '../src/sync/merge'
import { acc, buildVault, catId } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

const trip = (v: Vault, id: string, partial: Partial<Tracking> = {}): Tracking => {
  const tr: Tracking = { id, updatedAt: now(), name: 'Poland', kind: 'trip', ...partial }
  v.trackings.push(tr)
  return tr
}

const assign = (
  v: Vault,
  id: string,
  trackingId: string,
  txnId: string,
  dir: 'include' | 'exclude',
  updatedAt = now(),
): TrackingAssignment => {
  const a: TrackingAssignment = { id, updatedAt, trackingId, txnId, dir }
  v.trackingAssignments.push(a)
  return a
}

const importTxn = (v: Vault, id: string, hash: string): Transaction => {
  const t: Transaction = {
    id,
    updatedAt: now(),
    date: '2026-06-10',
    merchant: 'Kraków Hotel',
    categoryId: catId(v, 'Other'),
    amount: -120,
    accountId: v.accounts[0]?.id,
    importMeta: { hash },
  }
  v.transactions.push(t)
  return t
}

describe('assignment collapse (ANALYTICS §4.2)', () => {
  it('same-dir doubles collapse to the oldest id, silently', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-1')
    trip(remote, 'trk-1')
    assign(local, 'asgn-a', 'trk-1', 'txn-x', 'include')
    assign(remote, 'asgn-b', 'trk-1', 'txn-x', 'include')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    const live = merged.trackingAssignments
    expect(live).toHaveLength(1)
    expect(live[0]!.id).toBe('asgn-a') // oldest id kept
    expect(conflicts.filter((c) => c.kind === 'tag-conflict')).toHaveLength(0)
    expect(merged.tombstones.some((t) => t.id === 'asgn-b' && t.collection === 'trackingAssignments')).toBe(true)
  })

  it('opposite dirs: newer updatedAt wins, one tag-conflict flag', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-1')
    trip(remote, 'trk-1')
    // exclude is older, include newer → include (the newer edit) wins
    assign(local, 'asgn-exc', 'trk-1', 'txn-x', 'exclude', '2026-07-01T00:00:00.000Z')
    assign(remote, 'asgn-inc', 'trk-1', 'txn-x', 'include', '2026-07-05T00:00:00.000Z')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.trackingAssignments).toHaveLength(1)
    expect(merged.trackingAssignments[0]!.dir).toBe('include')
    const flags = conflicts.filter((c) => c.kind === 'tag-conflict')
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ keptValue: 'include', discardedValue: 'exclude' })
  })

  it('near-simultaneous opposites (< 2 s): exclude wins conservatively', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-1')
    trip(remote, 'trk-1')
    assign(local, 'asgn-inc', 'trk-1', 'txn-x', 'include', '2026-07-05T00:00:00.000Z')
    assign(remote, 'asgn-exc', 'trk-1', 'txn-x', 'exclude', '2026-07-05T00:00:01.000Z') // 1 s apart
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.trackingAssignments).toHaveLength(1)
    expect(merged.trackingAssignments[0]!.dir).toBe('exclude')
    expect(conflicts.filter((c) => c.kind === 'tag-conflict')).toHaveLength(1)
  })
})

describe('dedupe remap preserves tags (ANALYTICS §4.3)', () => {
  it('a tag on the tombstoned duplicate moves to the surviving txn', () => {
    // Two devices import the same bank row under different UUIDs; the phone tags
    // its copy into the trip. Ring-2 dedupe keeps the oldest txn id (a1) and the
    // §4.3 remap moves the include onto it — no double, no tag-conflict.
    const base = buildVault((v) => acc(v, { name: 'Revolut', fingerprint: 'revolut:eur' }))
    const local = structuredClone(base) // laptop: imports row X → a1
    const remote = structuredClone(base) // phone: imports row X → b7, tags it
    importTxn(local, 'txn-a1', 'hash-X')
    importTxn(remote, 'txn-b7', 'hash-X')
    trip(remote, 'trk-1')
    assign(remote, 'asgn-1', 'trk-1', 'txn-b7', 'include')

    const { merged, conflicts } = threeWayMerge(base, local, remote)
    // dedupe: one survivor (older id a1)
    const live = merged.transactions.filter((t) => t.importMeta?.hash === 'hash-X')
    expect(live).toHaveLength(1)
    expect(live[0]!.id).toBe('txn-a1')
    // the tag survived and points at the survivor
    expect(merged.trackingAssignments).toHaveLength(1)
    expect(merged.trackingAssignments[0]!.txnId).toBe('txn-a1')
    expect(conflicts.filter((c) => c.kind === 'tag-conflict')).toHaveLength(0)
    expect(conflicts.filter((c) => c.kind === 'dup-import')).toHaveLength(1)
  })

  it('remap then collapse: same tag on both duplicates yields one assignment, no flag', () => {
    const base = buildVault((v) => acc(v, { name: 'Revolut', fingerprint: 'revolut:eur' }))
    const local = structuredClone(base)
    const remote = structuredClone(base)
    importTxn(local, 'txn-a1', 'hash-X')
    importTxn(remote, 'txn-b7', 'hash-X')
    trip(local, 'trk-1')
    trip(remote, 'trk-1')
    assign(local, 'asgn-a', 'trk-1', 'txn-a1', 'include')
    assign(remote, 'asgn-b', 'trk-1', 'txn-b7', 'include') // remaps to a1 → collides with asgn-a
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.trackingAssignments).toHaveLength(1)
    expect(merged.trackingAssignments[0]!.txnId).toBe('txn-a1')
    expect(conflicts.filter((c) => c.kind === 'tag-conflict')).toHaveLength(0)
  })
})

describe('duplicate trackings (ANALYTICS §4.4)', () => {
  it('casefold name + kind + overlapping windows → unify, remap assignments, one flag', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-a', { name: 'Poland', dateFrom: '2024-10-05', dateTo: '2024-10-15' })
    trip(remote, 'trk-b', { name: 'poland', dateFrom: '2024-10-08', dateTo: '2024-10-20' }) // overlaps, casefold-equal
    assign(remote, 'asgn-1', 'trk-b', 'txn-x', 'include')
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.trackings).toHaveLength(1)
    expect(merged.trackings[0]!.id).toBe('trk-a') // older id wins
    expect(merged.trackingAssignments[0]!.trackingId).toBe('trk-a') // remapped to winner
    expect(conflicts.filter((c) => c.kind === 'dup-tracking')).toHaveLength(1)
  })

  it('same name but window-disjoint → not merged', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-a', { name: 'Poland', dateFrom: '2024-10-05', dateTo: '2024-10-15' })
    trip(remote, 'trk-b', { name: 'Poland', dateFrom: '2026-06-01', dateTo: '2026-06-10' })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.trackings).toHaveLength(2)
    expect(conflicts.filter((c) => c.kind === 'dup-tracking')).toHaveLength(0)
  })

  it('two windowless sets with the same name unify (both-absent)', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trip(local, 'trk-a', { name: 'Recurring', kind: 'set' })
    trip(remote, 'trk-b', { name: 'Recurring', kind: 'set' })
    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.trackings).toHaveLength(1)
  })
})

describe('budget scope identity (ANALYTICS §6.2)', () => {
  const trackBudget = (v: Vault, id: string, trackingId: string, amount: number): Budget => {
    const b: Budget = { id, updatedAt: now(), categoryId: catId(v, 'Other'), amount, scope: { kind: 'tracking', trackingId } }
    v.budgets.push(b)
    return b
  }
  const yearBudget = (v: Vault, id: string, cat: string, year: number, amount: number): Budget => {
    const b: Budget = { id, updatedAt: now(), categoryId: catId(v, cat), amount, scope: { kind: 'category-year', categoryId: catId(v, cat), year } }
    v.budgets.push(b)
    return b
  }

  it('two tracking-scoped budgets for the same tracking are duplicates', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    trackBudget(local, 'bud-a', 'trk-1', 1500)
    trackBudget(remote, 'bud-b', 'trk-1', 1800)
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.budgets).toHaveLength(1)
    expect(conflicts.filter((c) => c.kind === 'dup-budget')).toHaveLength(1)
  })

  it('category-year budgets for different years are NOT duplicates', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    yearBudget(local, 'bud-a', 'Other', 2025, 4000)
    yearBudget(remote, 'bud-b', 'Other', 2026, 4200)
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.budgets).toHaveLength(2)
    expect(conflicts.filter((c) => c.kind === 'dup-budget')).toHaveLength(0)
  })
})
