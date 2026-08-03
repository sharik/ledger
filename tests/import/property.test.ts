import { describe, it, expect } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { applyOp } from '../../src/model/mutations'
import { threeWayMerge } from '../../src/sync/merge'
import { buildImportPlan, planToOp } from '../../src/import/pipeline'
import { isRefusal, type SourceFile } from '../../src/import/types'

setFixedNow('2026-07-12T00:00:00Z')

// Deterministic PRNG (mulberry32, like sync.property).
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Build a synthetic Revolut CSV statement over a date window with a maintained balance chain. */
function makeStatement(rng: () => number, startDay: number, count: number): { file: SourceFile; rows: string[] } {
  const header = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
  const lines: string[] = []
  const rowKeys: string[] = []
  let balance = 100000 // minor units
  const base = Date.UTC(2026, 0, 1)
  for (let i = 0; i < count; i++) {
    const day = startDay + Math.floor(i / 2) // ~2 rows/day → some same-day groups
    const date = new Date(base + day * 86400000).toISOString().slice(0, 10)
    const amt = -(Math.floor(rng() * 5000) + 100) // small expenses
    balance += amt
    const merchant = ['Grab', 'Amami', 'Lobita', 'Picard', 'Shop'][Math.floor(rng() * 5)]
    lines.push(`Card Payment,Current,${date},${date},${merchant},${(amt / 100).toFixed(2)},0,EUR,COMPLETED,${(balance / 100).toFixed(2)}`)
    rowKeys.push(`${date}|${amt}|${merchant}`)
  }
  return { file: { name: `s-${startDay}.csv`, bytes: new TextEncoder().encode([header, ...lines].join('\n')), container: 'csv' }, rows: rowKeys }
}

async function importInto(vault: ReturnType<typeof emptyVault>, file: SourceFile) {
  const plan = await buildImportPlan(file, vault, { accountId: vault.accounts[0]?.id ?? 'new' })
  if (isRefusal(plan)) throw new Error(`refused: ${plan.refusal}`)
  return applyOp(vault, planToOp(plan)).vault
}

describe('property — random overlaps converge (§15)', () => {
  it('two devices, overlapping statements, random order ⇒ same settled rows once', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      // Two overlapping windows sharing rows by construction (same startDay region + count).
      const sA = makeStatement(mulberry32(seed), 0, 40)
      const sB = makeStatement(mulberry32(seed), 0, 60) // superset-ish: same prefix rows, more tail
      // device 1: A then B; device 2: B then A
      let d1 = emptyVault()
      d1 = await importInto(d1, sA.file)
      d1 = await importInto(d1, sB.file)
      let d2 = emptyVault()
      d2.vaultId = d1.vaultId
      d2.createdAt = d1.createdAt
      d2 = await importInto(d2, sB.file)
      d2 = await importInto(d2, sA.file)

      const h1 = d1.transactions.map((t) => t.importMeta!.hash).sort()
      const h2 = d2.transactions.map((t) => t.importMeta!.hash).sort()
      expect(h1).toEqual(h2) // order-invariance
      expect(new Set(h1).size).toBe(h1.length) // every row once

      // merge across devices → still one copy each, statements accounted
      const { merged } = threeWayMerge(null, d1, d2)
      const hm = merged.transactions.map((t) => t.importMeta!.hash)
      expect(new Set(hm).size).toBe(hm.length)
      expect(merged.statements.length).toBeGreaterThanOrEqual(2)
    }
  })
})
