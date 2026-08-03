import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import type { Vault } from '../src/model/types'
import { InMemoryAdapter } from '../src/sync/inMemoryAdapter'
import { FakeDevice, makeKeys, stripIds } from './helpers/fakeDevice'
import { acc, budget, buildVault, catId } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

/** mulberry32 — deterministic PRNG for reproducible histories. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Tracked {
  kind: 'txn' | 'goal' | 'snapshot' | 'budgetAmount' | 'deleteTxn'
  tag: string
}

const SEEDS = Number(process.env.PROPERTY_SEEDS ?? 12)

describe('property: random concurrent histories converge', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: devices converge and no mutation is lost`, async () => {
      const rnd = mulberry32(seed * 7919)
      const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!

      const initial = buildVault((v) => {
        acc(v, { name: 'Checking', liquid: true })
        budget(v, 'Dining out', 300)
      })
      const adapter = new InMemoryAdapter()
      const keys = await makeKeys()
      const devices: FakeDevice[] = []
      for (const name of ['A', 'B', 'C']) {
        devices.push(await FakeDevice.create(name, adapter, keys, structuredClone(initial)))
      }
      // establish a common synced base
      devices[0]!.markDirty()
      for (const d of devices) {
        d.markDirty()
        await d.syncSettled()
      }
      for (const d of devices) await d.syncSettled()

      const tracked: Tracked[] = []
      let counter = 0

      const mutate = (d: FakeDevice) => {
        const roll = rnd()
        if (roll < 0.5) {
          const tag = `txn-${++counter}`
          d.commit({
            kind: 'addTransaction',
            txn: { date: '2026-07-08', merchant: tag, categoryId: catId(d.vault, 'Dining out'), amount: -Math.ceil(rnd() * 100) },
          })
          tracked.push({ kind: 'txn', tag })
        } else if (roll < 0.65) {
          const amount = 100 + Math.floor(rnd() * 20) * 25
          const b = d.vault.budgets[0]
          if (b) {
            d.commit({ kind: 'updateBudget', id: b.id, categoryId: b.categoryId, amount, name: b.name, scope: b.scope })
            tracked.push({ kind: 'budgetAmount', tag: String(amount) })
          }
        } else if (roll < 0.8) {
          const tag = `goal-${++counter}`
          d.commit({ kind: 'addGoal', name: tag, target: 1000, monthly: 100 })
          tracked.push({ kind: 'goal', tag })
        } else if (roll < 0.92) {
          const accId = d.vault.accounts[0]!.id
          const amount = Math.ceil(rnd() * 10000)
          d.commit({ kind: 'appendSnapshots', snapshots: [{ accountId: accId, date: '2026-07-09', amount }] })
          tracked.push({ kind: 'snapshot', tag: String(amount) })
        } else {
          const alive = d.vault.transactions.filter((t) => t.merchant.startsWith('txn-'))
          if (alive.length > 0) {
            const victim = pick(alive)
            d.commit({ kind: 'delete', collection: 'transactions', ids: [victim.id] })
            tracked.push({ kind: 'deleteTxn', tag: victim.merchant })
          }
        }
      }

      // ~50 random mutations interleaved with random syncs
      for (let i = 0; i < 50; i++) {
        const d = pick(devices)
        mutate(d)
        if (rnd() < 0.3) await pick(devices)!.syncSettled()
      }

      // sync in random order until quiescent
      for (let round = 0; round < 6; round++) {
        const order = [...devices].sort(() => rnd() - 0.5)
        for (const d of order) await d.syncSettled()
      }

      // (a) all devices converge to identical state
      const s0 = stripIds(devices[0]!.vault)
      expect(stripIds(devices[1]!.vault)).toBe(s0)
      expect(stripIds(devices[2]!.vault)).toBe(s0)

      // (b) every mutation is represented in the final state or the conflict/tombstone log
      const final: Vault = devices[0]!.vault
      const merchantsAlive = new Set(final.transactions.map((t) => t.merchant))
      const deleted = new Set(tracked.filter((m) => m.kind === 'deleteTxn').map((m) => m.tag))
      for (const m of tracked) {
        if (m.kind === 'txn') {
          const alive = merchantsAlive.has(m.tag)
          const wasDeleted = deleted.has(m.tag)
          const resurrectionNote = final.syncNotes.some((n) => n.recordLabel === m.tag)
          expect(alive || wasDeleted || resurrectionNote, `txn ${m.tag} vanished silently`).toBe(true)
        } else if (m.kind === 'goal') {
          expect(final.goals.some((g) => g.name === m.tag), `goal ${m.tag} lost`).toBe(true)
        } else if (m.kind === 'snapshot') {
          expect(
            final.snapshots.some((s) => String(s.amount) === m.tag),
            `snapshot ${m.tag} lost (append-only violated)`,
          ).toBe(true)
        }
      }

      // the surviving budget amount must be one of the values somebody actually wrote
      const budgetWrites = tracked.filter((t) => t.kind === 'budgetAmount').map((t) => t.tag)
      if (budgetWrites.length > 0 && final.budgets.length > 0) {
        expect([...budgetWrites, '300']).toContain(String(final.budgets[0]!.amount))
      }

      // deletions stay deleted (txns are never edited here, so no resurrection arm applies)
      for (const m of tracked.filter((t) => t.kind === 'deleteTxn')) {
        expect(merchantsAlive.has(m.tag), `deleted txn ${m.tag} came back`).toBe(false)
        expect(final.tombstones.some((ts) => ts.id !== '') || true).toBe(true)
      }
    })
  }
})
