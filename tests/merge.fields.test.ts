import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import type { Vault } from '../src/model/types'
import { threeWayMerge } from '../src/sync/merge'
import { acc, budget, buildVault, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

function budgetFixture() {
  const base = buildVault((v) => {
    budget(v, 'Dining out', 300)
  })
  const local: Vault = structuredClone(base)
  const remote: Vault = structuredClone(base)
  const id = base.budgets[0]!.id
  return { base, local, remote, id }
}

describe('field-level merge', () => {
  it('disjoint changed fields merge with zero conflicts', () => {
    const base = buildVault((v) => {
      txn(v, '2026-07-01', 'Cafe', 'Dining out', -10)
    })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const id = base.transactions[0]!.id
    local.transactions[0] = { ...local.transactions[0]!, note: 'renamed note', updatedAt: '2026-07-09T10:00:00Z' }
    remote.transactions[0] = { ...remote.transactions[0]!, amount: -11, updatedAt: '2026-07-09T10:00:01Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions[0]).toMatchObject({ id, note: 'renamed note', amount: -11 })
    expect(conflicts).toHaveLength(0)
  })

  it('same field changed both sides → newer wins, loser preserved in the note', () => {
    const { base, local, remote, id } = budgetFixture()
    local.budgets[0] = { ...local.budgets[0]!, amount: 350, updatedAt: '2026-07-09T14:02:00Z' }
    remote.budgets[0] = { ...remote.budgets[0]!, amount: 325, updatedAt: '2026-07-09T13:47:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.budgets[0]!.amount).toBe(350)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      kind: 'field-lww',
      field: 'amount',
      recordId: id,
      recordLabel: 'Dining out budget',
      keptValue: 350,
      discardedValue: 325,
      keptFrom: 'local',
    })
  })

  it('remote wins when newer', () => {
    const { base, local, remote } = budgetFixture()
    local.budgets[0] = { ...local.budgets[0]!, amount: 350, updatedAt: '2026-07-09T13:00:00Z' }
    remote.budgets[0] = { ...remote.budgets[0]!, amount: 325, updatedAt: '2026-07-09T14:00:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.budgets[0]!.amount).toBe(325)
    expect(conflicts[0]!.keptFrom).toBe('remote')
  })

  it('< 2 s apart is treated as simultaneous and always flagged', () => {
    const { base, local, remote } = budgetFixture()
    local.budgets[0] = { ...local.budgets[0]!, amount: 350, updatedAt: '2026-07-09T14:00:01.500Z' }
    remote.budgets[0] = { ...remote.budgets[0]!, amount: 325, updatedAt: '2026-07-09T14:00:00.000Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(conflicts[0]!.kind).toBe('simultaneous')
    expect(merged.budgets[0]!.amount).toBe(350) // raw-compare winner still takes the slot
  })

  it('exact tie is flagged simultaneous', () => {
    const { base, local, remote } = budgetFixture()
    const at = '2026-07-09T14:00:00.000Z'
    local.budgets[0] = { ...local.budgets[0]!, amount: 350, updatedAt: at }
    remote.budgets[0] = { ...remote.budgets[0]!, amount: 325, updatedAt: at }
    const { conflicts } = threeWayMerge(base, local, remote)
    expect(conflicts[0]!.kind).toBe('simultaneous')
  })

  it('transient isNew is excluded from diffing and from the merged output', () => {
    const base = buildVault((v) => {
      txn(v, '2026-07-01', 'Cafe', 'Dining out', -10)
    })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    // local only toggles the transient badge — must NOT count as an edit
    local.transactions[0] = { ...local.transactions[0]!, isNew: true, updatedAt: '2026-07-09T11:00:00Z' }
    // remote genuinely edits
    remote.transactions[0] = { ...remote.transactions[0]!, amount: -12, updatedAt: '2026-07-09T10:00:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions[0]!.amount).toBe(-12) // remote edit wins (local counted as unchanged)
    expect(merged.transactions[0]!.isNew).toBeUndefined()
    expect(conflicts).toHaveLength(0)
  })

  it('updatedAt alone is not an edit', () => {
    const base = buildVault((v) => {
      txn(v, '2026-07-01', 'Cafe', 'Dining out', -10)
    })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.transactions[0] = { ...local.transactions[0]!, updatedAt: '2026-07-09T11:00:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.transactions).toHaveLength(1)
    expect(conflicts).toHaveLength(0)
  })

  it('Account.hidden merges as an ordinary field against a peer that predates it', () => {
    // The whole no-schema-bump argument rests on this: `fieldMerge` unions the key sets, so a
    // device that has never heard of `hidden` carries it through instead of dropping it.
    const base = buildVault((v) => { acc(v, { name: 'Dead' }) })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.accounts[0] = { ...local.accounts[0]!, hidden: true, updatedAt: '2026-07-09T10:00:00Z' }
    remote.accounts[0] = { ...remote.accounts[0]!, name: 'Dead (old)', updatedAt: '2026-07-09T10:00:01Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.accounts[0]).toMatchObject({ hidden: true, name: 'Dead (old)' })
    expect(conflicts).toHaveLength(0)
  })

  it('unhiding on one device wins over an untouched peer, with no conflict to review', () => {
    // `hidden` has only two representable states, so one side always equals base and the
    // "same field changed both ways" case cannot arise — an edit simply beats a non-edit.
    const base = buildVault((v) => { acc(v, { name: 'Dead', hidden: true }) })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.accounts[0] = { ...local.accounts[0]!, hidden: undefined, updatedAt: '2026-07-09T10:00:00Z' }
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(merged.accounts[0]!.hidden).toBeUndefined()
    expect(conflicts).toHaveLength(0)
  })

  it('hidden is durable, not transient — it survives a merge with no local edit', () => {
    // Guards against anyone adding it to TRANSIENT_FIELDS alongside `isNew`.
    const base = buildVault((v) => { acc(v, { name: 'Dead' }) })
    const local = structuredClone(base)
    const remote = structuredClone(base)
    remote.accounts[0] = { ...remote.accounts[0]!, hidden: true, updatedAt: '2026-07-09T10:00:00Z' }
    const { merged } = threeWayMerge(base, local, remote)
    expect(merged.accounts[0]!.hidden).toBe(true)
  })

  it('singleton params: disjoint fields merge, same field goes LWW + note', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    local.params = { ...local.params, srTarget: 25, updatedAt: '2026-07-09T10:00:00Z' }
    remote.params = { ...remote.params, efTarget: 8, updatedAt: '2026-07-09T10:05:00Z' }
    let res = threeWayMerge(base, local, remote)
    expect(res.merged.params.srTarget).toBe(25)
    expect(res.merged.params.efTarget).toBe(8)
    expect(res.conflicts).toHaveLength(0)

    const local2 = structuredClone(base)
    const remote2 = structuredClone(base)
    local2.params = { ...local2.params, srTarget: 25, updatedAt: '2026-07-09T10:00:00Z' }
    remote2.params = { ...remote2.params, srTarget: 30, updatedAt: '2026-07-09T11:00:00Z' }
    res = threeWayMerge(base, local2, remote2)
    expect(res.merged.params.srTarget).toBe(30)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]).toMatchObject({ collection: 'params', field: 'srTarget', discardedValue: 25 })
  })
})

describe('merge commutativity on exact ties (§4.2 invariant 6)', () => {
  it('an exact-tie field conflict resolves to the SAME value on both devices', () => {
    const { base, local, remote } = budgetFixture()
    const at = '2026-07-09T14:00:00.000Z'
    local.budgets[0] = { ...local.budgets[0]!, amount: 350, updatedAt: at }
    remote.budgets[0] = { ...remote.budgets[0]!, amount: 325, updatedAt: at }
    const ab = threeWayMerge(base, local, remote).merged
    const ba = threeWayMerge(base, remote, local).merged
    // The old `l.updatedAt >= r.updatedAt` tie-break was true on BOTH devices, so
    // each kept its own value and the pair ping-ponged forever.
    expect(ab.budgets[0]!.amount).toBe(ba.budgets[0]!.amount)
  })

  it('duplicate budgets created at the same ms tombstone the SAME loser on both devices', () => {
    const base = buildVault()
    const local = structuredClone(base)
    const remote = structuredClone(base)
    const at = '2026-07-09T14:00:00.000Z'
    budget(local, 'Dining out', 300)
    budget(remote, 'Dining out', 280)
    local.budgets[0] = { ...local.budgets[0]!, updatedAt: at }
    remote.budgets[0] = { ...remote.budgets[0]!, updatedAt: at }
    const ab = threeWayMerge(base, local, remote).merged
    const ba = threeWayMerge(base, remote, local).merged
    expect(ab.budgets.map((b) => b.id)).toEqual(ba.budgets.map((b) => b.id))
    expect(ab.budgets).toHaveLength(1) // one survivor — and it is the same one everywhere
  })
})
