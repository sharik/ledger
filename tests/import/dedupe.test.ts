import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { applyOp } from '../../src/model/mutations'
import { threeWayMerge } from '../../src/sync/merge'
import { buildImportPlan } from '../../src/import/pipeline'
import { isRefusal } from '../../src/import/types'
import { haveReal, importFile, loadFile, REAL } from '../helpers/importing'

const d = haveReal() ? describe : describe.skip

beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

d('dedupe (§8)', () => {
  it('ring-1: re-importing the same file skips every row', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.f1))).vault
    const plan = await buildImportPlan(loadFile(REAL.f1, 'copy.xlsx'), v, { proceedAlreadyImported: true, accountId: v.accounts[0]!.id })
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.counts.toAdd).toBe(0)
    expect(plan.counts.duplicates).toBe(330)
  })

  it('fileHash short-circuits a byte-identical re-import (already-imported)', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.f1))).vault
    const again = await buildImportPlan(loadFile(REAL.f1), v)
    expect(isRefusal(again)).toBe(true)
    if (isRefusal(again)) expect(again.refusal).toBe('already-imported')
  })

  it('a user recategorization survives a re-import (duplicate dropped wholesale)', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.f1))).vault
    const target = v.transactions[0]!
    const edited = applyOp(v, { kind: 'setField', collection: 'transactions', id: target.id, field: 'categoryId', value: 'my-custom' }).vault
    const plan = await buildImportPlan(loadFile(REAL.f1, 'copy.xlsx'), edited, { proceedAlreadyImported: true, accountId: edited.accounts[0]!.id })
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.counts.toAdd).toBe(0)
    // the edit is untouched — nothing re-imported over it
    expect(edited.transactions.find((t) => t.id === target.id)!.categoryId).toBe('my-custom')
  })

  it('ring-1 is per-account: the same file imported into a DIFFERENT account is not deduped', async () => {
    let v = emptyVault()
    // account A gets f1 (creates a Revolut account by fingerprint)
    v = (await importFile(v, loadFile(REAL.f1))).vault
    // a second manual account exists; adopt it for a re-import of the same rows.
    // Same fingerprint would collide under a vault-wide hash set — scoping to the
    // target account keeps his-and-hers rows distinct (§5.8).
    const manual = { id: 'manual-b', updatedAt: '2026-01-01T00:00:00Z', name: 'Her Revolut', liab: false, liquid: true }
    v.accounts.push(manual)
    const plan = await buildImportPlan(loadFile(REAL.f1, 'copy.xlsx'), v, { proceedAlreadyImported: true, accountId: 'adopt:manual-b' })
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.counts.duplicates).toBe(0) // different account ⇒ nothing skipped
    expect(plan.counts.toAdd).toBe(330)
  })

  it('ring-2: two vaults that imported overlapping files converge with no duplicate hashes', async () => {
    let a = emptyVault()
    let b = emptyVault()
    b.vaultId = a.vaultId
    b.createdAt = a.createdAt
    a = (await importFile(a, loadFile(REAL.f1))).vault
    b = (await importFile(b, loadFile(REAL.f2))).vault
    const { merged } = threeWayMerge(null, a, b)
    const hashes = merged.transactions.map((t) => t.importMeta!.hash)
    expect(new Set(hashes).size).toBe(hashes.length)
    // union size = F1 (330) + F2-only (107)
    expect(merged.transactions.length).toBe(437)
  })
})
