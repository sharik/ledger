import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { applyOp } from '../../src/model/mutations'
import { acc, buildVault, catId } from '../helpers/build'
import { buildImportPlan, planToOp } from '../../src/import/pipeline'
import { shouldOfferStarterPack } from '../../src/import/rules'
import { isRefusal, type SourceFile } from '../../src/import/types'
import { toSourceFile } from '../../src/import/peek'
import { hashRows } from '../../src/import/identity'
import type { Op } from '../../src/model/mutations'
import { expectations, haveReal, loadFile, REAL } from '../helpers/importing'

const d = haveReal() ? describe : describe.skip
beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

// #17: a hard read failure must surface a refusal, never propagate as a throw that
// leaves the review stuck on its skeleton. No real fixtures needed — a %PDF-magic
// file with garbage body sniffs as a PDF and fails extraction.
describe('unreadable refusal (#17)', () => {
  it('a corrupt PDF is refused as unreadable, not thrown', async () => {
    const v = emptyVault()
    const file = toSourceFile('broken.pdf', new TextEncoder().encode('%PDF-1.4\nnot a real pdf'))
    const plan = await buildImportPlan(file, v)
    expect(isRefusal(plan)).toBe(true)
    if (isRefusal(plan)) expect(plan.refusal).toBe('unreadable')
  })
})

d('pipeline (§12)', () => {
  it('planning is pure — the vault is untouched until applyOp', async () => {
    const v = emptyVault()
    const snapshot = JSON.stringify(v)
    await buildImportPlan(loadFile(REAL.f1), v)
    expect(JSON.stringify(v)).toBe(snapshot)
  })

  it('applyImport → revertImport restores the live vault', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(loadFile(REAL.f1), v)
    if (isRefusal(plan)) throw new Error('refused')
    const res = applyOp(v, planToOp(plan))
    expect(res.vault.transactions.length).toBe(330)
    expect(res.vault.snapshots.length).toBe(6) // opening + one per covered month (Feb–Jun 2026)
    expect(res.vault.statements.length).toBe(1)
    const back = applyOp(res.vault, res.inverse!).vault
    expect(back.transactions).toEqual([])
    expect(back.snapshots).toEqual([])
    expect(back.statements).toEqual([])
    expect(back.accounts).toEqual([])
  })

  it('adopt-account writes fingerprint/institution/currency and the inverse clears them', async () => {
    const v = buildVault()
    const manual = acc(v, { name: 'My Revolut', liquid: true })
    const plan = await buildImportPlan(loadFile(REAL.f1), v, { accountId: `adopt:${manual.id}` })
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.account.mode).toBe('adopt')
    const res = applyOp(v, planToOp(plan))
    const adopted = res.vault.accounts.find((a) => a.id === manual.id)!
    expect(adopted.fingerprint).toBe('revolut:current:eur')
    expect(adopted.institutionId).toBe('revolut')
    expect(adopted.currency).toBe('EUR')
    const back = applyOp(res.vault, res.inverse!).vault
    const cleared = back.accounts.find((a) => a.id === manual.id)!
    expect(cleared.fingerprint).toBeUndefined()
    expect(cleared.institutionId).toBeUndefined()
  })

  // Issue 11f: the ladder rung was computed during review and thrown away at commit, so a
  // committed vault could not say which rows the model guessed at.
  it('planToOp carries each row’s ladder rung, and a review decision lands as manual', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(loadFile(REAL.f1), v)
    if (isRefusal(plan)) throw new Error('refused')
    const first = plan.rows.find((r) => r.status === 'new')!

    const committed = applyOp(v, planToOp(plan, [{ hash: first.hash, categoryId: catId(v, 'Transport') }])).vault
    const decided = committed.transactions.find((t) => t.importMeta?.hash === first.hash)!
    expect(decided.provenance).toBe('manual')
    expect(decided.categoryId).toBe(catId(v, 'Transport'))

    // Nothing is left unlabelled, and `rule:${id}` has collapsed to a bare `rule`.
    expect(committed.transactions.every((t) => t.provenance !== undefined)).toBe(true)
    for (const t of committed.transactions) expect(['rule', 'ai', 'transfer', 'fallback', 'manual']).toContain(t.provenance)
    // f1 into an empty vault has no rules to hit — every other row took the fallback rung.
    expect(committed.transactions.filter((t) => t.provenance === 'fallback').length).toBeGreaterThan(0)
  })

  // §10.1 history rung: a category the user set BY HAND on a merchant pre-fills a later import of
  // that same merchant — a needs-review suggestion, counted apart from auto-categorized, and (being
  // no longer `fallback`) never sent to the AI.
  it('a hand-categorized merchant is suggested on a later import (provenance history, needs review)', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.f1), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault

    // Recategorize one fallback (no-rule) row by hand → it becomes the manual-history seed.
    const fallbackRow = first.rows.find((r) => r.status === 'new' && r.provenance === 'fallback')!
    const seedTxn = committed.transactions.find((t) => t.importMeta?.hash === fallbackRow.hash)!
    const transport = catId(v, 'Transport')
    const v1 = applyOp(committed, { kind: 'recategorizeBatch', txnIds: [seedTxn.id], categoryId: transport }).vault
    expect(v1.transactions.find((t) => t.id === seedTxn.id)!.provenance).toBe('manual')

    // Re-plan the same file to a NEW account (so rows don't dedupe) — the seeded merchant is now history.
    const again = await buildImportPlan(loadFile(REAL.f1), v1, { accountId: 'new' })
    if (isRefusal(again)) throw new Error('refused')
    const hit = again.rows.find((r) => r.status === 'new' && r.norm.merchant === seedTxn.merchant)!
    expect(hit.provenance).toBe('history')
    expect(hit.categoryId).toBe(transport)
    expect(hit.needsReview).toBe(true)
    expect(again.counts.fromHistory).toBeGreaterThan(0)
    // A history row is not a fallback row, so the assist (§10.6) is never asked about it.
    expect(again.rows.filter((r) => r.provenance === 'fallback').some((r) => r.norm.merchant === seedTxn.merchant)).toBe(false)

    // A merchant no one hand-categorized still falls through to the Other fallback.
    expect(again.rows.some((r) => r.status === 'new' && r.provenance === 'fallback')).toBe(true)
  })

  it('a last-4 shared by two accounts asks (confirm with both), never guesses one', async () => {
    const v = emptyVault()
    const pdf = await buildImportPlan(loadFile(REAL.b2026), v)
    if (isRefusal(pdf)) throw new Error('refused')
    const v2 = applyOp(v, planToOp(pdf)).vault
    // a second BNP account that also ends in the real file's mask (no confirmed matchKeys)
    acc(v2, { name: 'BNP Other', institutionId: 'bnp', last4: expectations().mask, liquid: true })
    const plan = await buildImportPlan(loadFile(REAL.bxls), v2)
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.account.mode).toBe('confirm')
    expect(plan.account.candidates.filter((c) => c.reason === 'signal').length).toBe(2)
    expect(plan.account.accountId).toBeUndefined() // nothing auto-picked
  })

  it('exact-RIB re-import auto-binds silently (no confirm)', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.b2026), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    // a different BNP PDF of the SAME account (same RIB) → auto-binds by the stored rib matchKey
    const again = await buildImportPlan(loadFile(REAL.b2024), committed)
    if (isRefusal(again)) throw new Error('refused')
    expect(again.account.mode).toBe('existing')
  })

  // Regression (duplicate-account bug): an account created by an older build carries a fingerprint
  // but no `matchKeys`. Resolution must still auto-bind it by fingerprint — otherwise the same file
  // re-imports into a SECOND account with the same fingerprint and every row skips dedup.
  it('re-import adopts a legacy account by fingerprint alone (no matchKeys)', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.b2026), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!
    expect(acct.fingerprint).toBeTruthy() // premise: it has a fingerprint …
    const legacy = { ...committed, accounts: committed.accounts.map((a) => (a.id === acct.id ? { ...a, matchKeys: undefined } : a)) } // … but no match-keys
    const again = await buildImportPlan(loadFile(REAL.b2024), legacy)
    if (isRefusal(again)) throw new Error('refused')
    expect(again.account.mode).toBe('existing')
    expect(again.account.accountId).toBe(acct.id) // the SAME account, not a new one
  })

  it('a HIDDEN account is still auto-bound and still dedupes — import never reads visibility', async () => {
    // The guard on the hidden-accounts feature: identity resolution, ring-1 dedupe and the
    // overlap check all run on the RAW vault. If any of them started honouring `hidden`, a
    // statement for a retired account would mint a ghost account (§5.8) and re-add every row.
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.b2026), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!
    const withHidden = {
      ...committed,
      accounts: committed.accounts.map((a) => (a.id === acct.id ? { ...a, hidden: true } : a)),
    }

    // (a) a later statement for the same account still binds to it, not to a new one
    const other = await buildImportPlan(loadFile(REAL.b2024), withHidden)
    if (isRefusal(other)) throw new Error('refused')
    expect(other.account.mode).toBe('existing')
    expect(other.account.accountId).toBe(acct.id)
    expect(applyOp(withHidden, planToOp(other)).vault.accounts).toHaveLength(withHidden.accounts.length)

    // (b) re-importing the very same file is still short-circuited
    const same = await buildImportPlan(loadFile(REAL.b2026), withHidden)
    expect(isRefusal(same) && same.refusal).toBe('already-imported')

    // (c) forced through, every row is still a duplicate — dedupe sees the hidden account's rows
    const forced = await buildImportPlan(loadFile(REAL.b2026), withHidden, { accountId: acct.id, proceedAlreadyImported: true })
    if (isRefusal(forced)) throw new Error('refused')
    expect(forced.counts.toAdd).toBe(0)
  })

  it('a duplicate PlannedRow records duplicateOf → the existing txn it matched', async () => {
    // Import the XLS once (creates the account), then again confirmed to that account: the second
    // plan sees every row as a duplicate, each linked to the committed transaction (verify data).
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.bxls), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!

    const again = await buildImportPlan(loadFile(REAL.bxls), committed, { accountId: acct.id, proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error('refused')
    expect(again.counts.toAdd).toBe(0)
    const dups = again.rows.filter((r) => r.status === 'duplicate')
    expect(dups.length).toBe(first.counts.toAdd)
    for (const r of dups) {
      expect(r.duplicateOf).toBeTruthy()
      expect(committed.transactions.some((t) => t.id === r.duplicateOf && t.importMeta?.hash === r.hash)).toBe(true)
    }
  })

  // The Vietnam-ATM bug: the same statement re-imported in the other variant spells a descriptor
  // differently (`RETRAIT DAB` vs `RETRAIT DISTRIBUTEUR`), so the hash differs, ring-1 misses, and
  // every row re-imports as new. Simulated here by re-importing the file with the stored hashes
  // perturbed — the rows are identical, only their identity is unrecognisable.
  it('warns when a file restates a period an existing statement already covers', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.bxls), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!
    // Same rows, different identity — exactly what a cross-variant descriptor does.
    const rehashed = {
      ...committed,
      transactions: committed.transactions.map((t) => (t.importMeta ? { ...t, importMeta: { ...t.importMeta, hash: `x${t.importMeta.hash}` } } : t)),
    }

    const again = await buildImportPlan(loadFile(REAL.bxls), rehashed, { accountId: acct.id, proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error('refused')
    expect(again.counts.duplicates).toBe(0) // ring-1 is blind to them, as in the real bug
    // …but the overlap check catches what the hash missed: the rows are marked and left out.
    expect(again.counts.suspected).toBeGreaterThan(0)
    expect(again.counts.toAdd).toBe(0)
    const note = again.notes.find((n) => n.kind === 'stmt-overlap')
    expect(note).toBeTruthy()
    expect(note!.label).toContain('already exist')

    // Nothing is committed unless the user overrides row by row — that is what makes it safe.
    expect(planToOp(again).txns).toHaveLength(0)
    const suspect = again.rows.find((r) => r.suspectedDuplicateOf)!
    expect(planToOp(again, [{ hash: suspect.hash, keepAnyway: true }]).txns).toHaveLength(1)
  })

  it('does not warn about overlap when the rows genuinely are new', async () => {
    // B2024 and B2026 are different periods of the same account — an ordinary sequential import.
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.b2026), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const again = await buildImportPlan(loadFile(REAL.b2024), committed)
    if (isRefusal(again)) throw new Error('refused')
    expect(again.notes.some((n) => n.kind === 'stmt-overlap')).toBe(false)
  })

  // Resolving a duplicate deletes the row that carried its hash. Without `dupHashes` the next import
  // of that statement would add it straight back and the audit could never converge.
  it('a hash absorbed into a survivor still dedupes on re-import', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.bxls), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!

    // Simulate the resolve: drop one row, and fold its identity into another row on the account.
    const victim = committed.transactions.find((t) => t.importMeta?.hash)!
    const survivor = committed.transactions.find((t) => t.importMeta?.hash && t.id !== victim.id)!
    const resolved = {
      ...committed,
      transactions: committed.transactions
        .filter((t) => t.id !== victim.id)
        .map((t) => (t.id === survivor.id ? { ...t, importMeta: { ...t.importMeta!, dupHashes: [victim.importMeta!.hash] } } : t)),
    }

    const again = await buildImportPlan(loadFile(REAL.bxls), resolved, { accountId: acct.id, proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error('refused')
    expect(again.counts.toAdd).toBe(0) // the deleted row is NOT resurrected
    const readopted = again.rows.find((r) => r.hash === victim.importMeta!.hash)!
    expect(readopted.status).toBe('duplicate')
    expect(readopted.duplicateOf).toBe(survivor.id) // it points at the row that absorbed it
  })

  // Changing `bnpNormDesc` changes the identity of every row it touches. A vault committed by the
  // build BEFORE the RETRAIT fold holds the OLD hashes; re-importing that statement must still see
  // them, or the fix for double-importing would itself cause a double import.
  it('a statement committed before the canon changed still dedupes after it', async () => {
    const v = emptyVault()
    const first = await buildImportPlan(loadFile(REAL.bxls), v)
    if (isRefusal(first)) throw new Error('refused')
    const committed = applyOp(v, planToOp(first)).vault
    const acct = committed.accounts.find((a) => a.institutionId === 'bnp')!

    // The RETRAIT rows are the ones the fold moved: rewind them to their pre-fold identity.
    const retraitRows = first.rows.filter((r) => r.norm.legacyNormDesc)
    expect(retraitRows.length).toBeGreaterThan(0) // premise: this file exercises the fold
    const legacyHashes = await hashRows(
      retraitRows.map((r) => ({ ...r.norm, normDesc: r.norm.legacyNormDesc! })),
      acct.fingerprint!,
    )
    const byNewHash = new Map(retraitRows.map((r, i) => [r.hash, legacyHashes[i]!]))
    const oldVault = {
      ...committed,
      transactions: committed.transactions.map((t) =>
        t.importMeta && byNewHash.has(t.importMeta.hash) ? { ...t, importMeta: { ...t.importMeta, hash: byNewHash.get(t.importMeta.hash)! } } : t,
      ),
    }

    const again = await buildImportPlan(loadFile(REAL.bxls), oldVault, { accountId: acct.id, proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error('refused')
    expect(again.counts.toAdd).toBe(0) // nothing re-added despite every RETRAIT hash having moved
    expect(again.counts.duplicates).toBe(first.counts.toAdd)
  })

  it('installs the starter pack inside the same commit when accepted', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(loadFile(REAL.b2026), v, { accountId: 'new', installStarterPack: true })
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.newRules && plan.newRules.length).toBeGreaterThan(0)
    const res = applyOp(v, planToOp(plan))
    expect(res.vault.rules.some((r) => r.source === 'seed')).toBe(true)
    expect(res.vault.categories.some((c) => c.name === 'Utilities')).toBe(true)
    // a Bouygues direct-debit is auto-categorized by a seed creditorId rule
    const bouygues = res.vault.transactions.find((t) => t.importMeta?.raw?.includes('BOUYGUES'))
    expect(bouygues).toBeTruthy()
  })

  // The offer is one-time by spec, but the flag was written nowhere, so it re-qualified on every
  // French import. `confirm` now records it on the commit that showed it — this mirrors that op.
  it('declining the pack still records the one-time offer, so it never returns', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(loadFile(REAL.b2026), v, { accountId: 'new' }) // no installStarterPack
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.starterPackOffer).toBe(true)
    expect(shouldOfferStarterPack(v, 'bnp')).toBe(true)

    // The exact op `confirm` commits when the offer was shown: import + persist the flag, atomically.
    const op: Op = { kind: 'batch', ops: [planToOp(plan), { kind: 'setSingletonField', collection: 'settings', field: 'starterPackOffered', value: true }] }
    const { vault, inverse } = applyOp(v, op)

    expect(vault.settings.starterPackOffered).toBe(true)
    expect(shouldOfferStarterPack(vault, 'bnp')).toBe(false) // a second BNP import is not re-offered
    expect(vault.rules.some((r) => r.source === 'seed')).toBe(false) // declined ⇒ no seed rules added

    // undo restores both halves — the import and the flag
    expect(applyOp(vault, inverse!).vault.settings.starterPackOffered).toBeUndefined()
  })
})

// A BNP xls whose preamble carries no masked account number → no fingerprint, no last-4, no holder.
// This is the file that spawned the ghost "BNP Paribas" account: nothing to key on, so it created a
// second, un-re-adoptable account and skipped cross-account dedup (§5.8). No real fixture needed.
async function masklessBnpXls(): Promise<SourceFile> {
  const XLSX = await import('xlsx')
  const aoa = [
    ['Solde au 08/06/2023', 'EUR'], // preamble: currency + a solde, but NO "**** 4242" mask
    ['Date operation', 'Libelle', 'Montant'],
    ['02-01-2023', 'PAIEMENT CB DU 020123 PHOTOMATON', -8],
    ['09-01-2023', 'VIREMENT RECU /DE IVAN PETRENKO', 3000],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xls' }))
  return toSourceFile('nomask.xls', bytes)
}

describe('unidentifiable file never silently creates a ghost account (§5.8)', () => {
  it('a no-signal xls is gated on `mustName`, not auto-created', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(await masklessBnpXls(), v, { institution: 'bnp', variant: 'xls' })
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.parsed.fingerprint).toBeNull() // premise: nothing to key on
    expect(plan.account.mode).toBe('create')
    expect(plan.account.mustName).toBe(true) // must name it or pick an existing account first
    expect(plan.account.accountId).toBeUndefined()
  })

  it('offers existing same-institution accounts to pick, so the file can map onto the real one', async () => {
    const v = emptyVault()
    const real = acc(v, { name: 'BNP Paribas Ivan', institutionId: 'bnp', last4: '4242', fingerprint: 'bnp:mask:4242', liquid: true })
    const plan = await buildImportPlan(await masklessBnpXls(), v, { institution: 'bnp', variant: 'xls' })
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.account.mustName).toBe(true) // still gated — the file itself matched nothing
    const pick = plan.account.candidates.find((c) => c.reason === 'pick')
    expect(pick?.accountId).toBe(real.id) // the real account is selectable
  })

  it('an explicit account choice clears the gate', async () => {
    const v = emptyVault()
    const plan = await buildImportPlan(await masklessBnpXls(), v, { institution: 'bnp', variant: 'xls', accountId: 'new', name: 'BNP Ivan' })
    if (isRefusal(plan)) throw new Error('refused')
    expect(plan.account.mustName).toBeFalsy()
  })
})
