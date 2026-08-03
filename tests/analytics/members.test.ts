import { beforeAll, describe, expect, it } from 'vitest'
import { now, setFixedNow } from '../../src/model/clock'
import type { Tracking, TrackingAssignment, Vault } from '../../src/model/types'
import { members } from '../../src/model/trackings'
import { buildVault, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const trip = (v: Vault, id: string, p: Partial<Tracking> = {}): Tracking => {
  const tr: Tracking = { id, updatedAt: now(), name: 'Poland', kind: 'trip', ...p }
  v.trackings.push(tr)
  return tr
}
const assign = (v: Vault, trackingId: string, txnId: string, dir: 'include' | 'exclude'): TrackingAssignment => {
  const a: TrackingAssignment = { id: 'a-' + txnId + '-' + dir, updatedAt: now(), trackingId, txnId, dir }
  v.trackingAssignments.push(a)
  return a
}

describe('members() — ANALYTICS §3 algebra', () => {
  it('window captures in-range rows; excludes beat the window; includes beat everything', () => {
    const v = buildVault()
    const inA = txn(v, '2024-10-06', 'Hotel', 'Other', -100)
    const inB = txn(v, '2024-10-10', 'Loyer', 'Other', -700) // will be excluded
    const before = txn(v, '2024-10-01', 'Deposit', 'Other', -50) // out of window, will be included
    txn(v, '2024-11-01', 'After', 'Other', -20) // out of window, untouched
    trip(v, 'trk', { dateFrom: '2024-10-05', dateTo: '2024-10-15' })
    assign(v, 'trk', inB.id, 'exclude')
    assign(v, 'trk', before.id, 'include')

    const m = members('trk', v)
    expect(m.has(inA.id)).toBe(true)
    expect(m.has(inB.id)).toBe(false) // excluded
    expect(m.has(before.id)).toBe(true) // included despite being out of window
    expect(m.size).toBe(2)
  })

  it('include wins when a row carries both an include and an exclude', () => {
    const v = buildVault()
    const t = txn(v, '2024-10-06', 'Ambiguous', 'Other', -30)
    trip(v, 'trk', { dateFrom: '2024-10-05', dateTo: '2024-10-15' })
    assign(v, 'trk', t.id, 'exclude')
    assign(v, 'trk', t.id, 'include')
    expect(members('trk', v).has(t.id)).toBe(true)
  })

  it('a windowless set has only its explicit includes', () => {
    const v = buildVault()
    const t1 = txn(v, '2026-01-01', 'A', 'Other', -10)
    txn(v, '2026-02-01', 'B', 'Other', -10)
    trip(v, 'set', { kind: 'set' })
    assign(v, 'set', t1.id, 'include')
    const m = members('set', v)
    expect([...m]).toEqual([t1.id])
  })

  it('dangling assignments (pointing at a non-live txn) are inert', () => {
    const v = buildVault()
    trip(v, 'trk', { dateFrom: '2024-10-05', dateTo: '2024-10-15' })
    assign(v, 'trk', 'ghost-txn', 'include')
    expect(members('trk', v).size).toBe(0)
  })

  it('archived trackings still resolve; unknown tracking id is empty', () => {
    const v = buildVault()
    const t = txn(v, '2024-10-06', 'X', 'Other', -30)
    trip(v, 'trk', { dateFrom: '2024-10-05', dateTo: '2024-10-15', archived: true })
    expect(members('trk', v).has(t.id)).toBe(true)
    expect(members('nope', v).size).toBe(0)
  })
})
