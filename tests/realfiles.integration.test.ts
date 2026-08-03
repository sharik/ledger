import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import { emptyVault } from '../src/model/seed'
import { applyOp } from '../src/model/mutations'
import { isCashflow } from '../src/model/selectors'
import { threeWayMerge } from '../src/sync/merge'
import { buildImportPlan, planToOp } from '../src/import/pipeline'
import { isRefusal } from '../src/import/types'
import { detectFile, adapterById } from '../src/import/registry'
import { bankDerivedRate } from '../src/import/fx'
import { buildVault } from './helpers/build'
import { expectations, have, haveReal, importFile, loadFile, planFor, REAL } from './helpers/importing'

const d = haveReal() ? describe : describe.skip
// Real-statement values live beside the files, in gitignored `docs/examples/expectations.json`.
const RE = () => expectations()

beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

d('real bank files (§5.3)', () => {
  // 1. Detection
  it('detects (institution, variant) with confidence ≥ 0.95', async () => {
    for (const [p, inst, variant] of ([
      [REAL.f1, 'revolut', 'xlsx'],
      [REAL.b2024, 'bnp', 'pdf'],
      [REAL.b2026, 'bnp', 'pdf'],
      [REAL.pumb, 'pumb', 'pdf'],
      [REAL.mono, 'monobank', 'csv'],
    ] as const).filter(([p]) => have(p))) {
      const det = await detectFile(loadFile(p))
      expect(det.best?.institution).toBe(inst)
      expect(det.best?.variant).toBe(variant)
      expect(det.best!.confidence).toBeGreaterThanOrEqual(0.95)
      expect(det.ambiguous).toBe(false)
    }
  })

  // 2. Parse + reconcile
  it('Revolut balance chain: 330 + 195 completed rows, exact anchors', async () => {
    const ad = adapterById('revolut')!
    const s1 = await ad.parse(loadFile(REAL.f1), 'xlsx')
    expect(s1.rows.length).toBe(330)
    expect(s1.openingBalance).toBe(1571.35)
    expect(s1.closingBalance).toBe(2738.89)
    const s2 = await ad.parse(loadFile(REAL.f2), 'xlsx')
    expect(s2.rows.length).toBe(195)
    expect(s2.openingBalance).toBe(703.55)
    expect(s2.closingBalance).toBe(2372.54)
  })

  it('BNP reconciliation matches printed totals (both statements)', async () => {
    const ad = adapterById('bnp')!
    const s24 = await ad.parse(loadFile(REAL.b2024), 'pdf')
    expect(s24.periodFrom).toBe('2024-10-13')
    expect(s24.periodTo).toBe('2024-11-13')
    expect(s24.openingBalance).toBe(9721.56)
    expect(s24.closingBalance).toBe(9747.26)
    const s26 = await ad.parse(loadFile(REAL.b2026), 'pdf')
    expect(s26.periodFrom).toBe('2026-05-13')
    expect(s26.openingBalance).toBe(34584.45)
    expect(s26.closingBalance).toBe(45923.35)
  })

  // 3. Normalize — JPY, mojibake, creditor ids, /BEN
  it('normalizes the JPY row, creditor ids and /BEN counterparty', async () => {
    const ad = adapterById('bnp')!
    const norm24 = ad.normalize(await ad.parse(loadFile(REAL.b2024), 'pdf'))
    const jpy = norm24.find((r) => r.original)
    expect(jpy?.original).toEqual({ amount: -59290, currency: 'JPY' })
    expect(jpy?.feeMinor).toBe(1138)
    // Phase E: the FX chain derives the bank rate from this row's own legs (§3).
    const jv = buildVault((v) => {
      v.transactions.push({
        id: 'jpy', updatedAt: '2026-01-01T00:00:00Z', date: jpy!.bookedDate, merchant: jpy!.merchant,
        categoryId: v.categories[0]!.id, amount: jpy!.amountMinor / 100, currency: 'EUR',
        fee: jpy!.feeMinor! / 100, original: jpy!.original,
      })
    })
    expect(bankDerivedRate(jv, 'JPY', 'EUR')).toBeCloseTo(0.0060982, 6)
    const ids = new Set(norm24.map((r) => r.creditorId).filter(Boolean))
    expect(ids.has('FR35ZZZ418323')).toBe(true) // Bouygues
    expect(ids.has('FR70ZZZ236497')).toBe(true) // SUEZ
    expect(ids.has('FR03SYM002381')).toBe(true) // ENGIE

    const norm26 = ad.normalize(await ad.parse(loadFile(REAL.b2026), 'pdf'))
    const emis = norm26.find((r) => r.kind === 'transfer-out')
    expect(emis?.counterparty).toMatch(new RegExp(RE().beneficiary)) // /BEN, never the motif
    expect(emis?.counterparty).not.toMatch(new RegExp(RE().motif))
  })

  it('repairs Revolut mojibake', async () => {
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.f2), 'xlsx'))
    expect(norm.some((r) => r.merchant.includes('Café'))).toBe(true)
    expect(norm.every((r) => !r.merchant.includes('Ã'))).toBe(true)
  })

  // 4. Full pipeline F1 → F2 and F2 → F1 converge. The two files share 88
  // identical rows (bidirectional exact match, verified below); the 3 §3 extras
  // (BIDEGI ×2, Île-de-France, settled 12–13 Jun after F1's 11 Jun cut) import as new.
  it('F1 then F2: overlap deduped, extras imported, both orders converge', async () => {
    let v = emptyVault()
    const a = await importFile(v, loadFile(REAL.f1))
    expect(a.plan.counts.toAdd).toBe(330)
    expect(a.plan.counts.duplicates).toBe(0)
    v = a.vault
    const b = await importFile(v, loadFile(REAL.f2))
    expect(b.plan.counts.duplicates).toBe(88) // zero false-new, zero false-dup (measured both ways)
    expect(b.plan.counts.toAdd).toBe(107)
    expect(b.vault.transactions.length).toBe(437)
    // the named §3 extras arrived as new rows, mojibake repaired
    expect(b.vault.transactions.some((t) => t.merchant.includes('Île-de-France') && t.date === '2026-06-12')).toBe(true)
    expect(b.vault.transactions.filter((t) => /BIDEGI/i.test(t.merchant) && t.date >= '2026-06-12').length).toBeGreaterThanOrEqual(1)

    // reverse order → identical hash set (order-invariance property)
    let w = emptyVault()
    w = (await importFile(w, loadFile(REAL.f2))).vault
    w = (await importFile(w, loadFile(REAL.f1))).vault
    expect(w.transactions.length).toBe(437)
    const hashesB = b.vault.transactions.map((t) => t.importMeta!.hash).sort()
    const hashesW = w.transactions.map((t) => t.importMeta!.hash).sort()
    expect(hashesB).toEqual(hashesW)
    expect(new Set(hashesB).size).toBe(hashesB.length) // no duplicate hashes
  })

  // 5. BNP both statements → same account, one stmt-gap note
  it('BNP 2024 then 2026: same fingerprint, one stmt-gap with the right figures', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.b2024))).vault
    const bnpAccounts = v.accounts.filter((acc) => acc.institutionId === 'bnp')
    expect(bnpAccounts.length).toBe(1)
    const r = await importFile(v, loadFile(REAL.b2026))
    // same account reused (fingerprint auto-select)
    expect(r.vault.accounts.filter((acc) => acc.institutionId === 'bnp').length).toBe(1)
    const gap = r.plan.notes.find((n) => n.kind === 'stmt-gap')
    expect(gap).toBeTruthy()
    expect(gap!.label).toContain('9,747.26')
    expect(gap!.label).toContain('34,584.45')
  })

  // 6. Transfer boundary — KPI correctness (IMPORT P1 exit criterion)
  it('all four files: top-ups, +7000 wire, +500 stand as income; zero pairs', async () => {
    let v = emptyVault()
    for (const p of [REAL.f1, REAL.f2, REAL.b2024, REAL.b2026]) {
      v = (await importFile(v, loadFile(p))).vault
    }
    // €3,000 top-ups → income cash-flow
    const topups = v.transactions.filter((t) => t.amount === 3000 && isCashflow(t))
    expect(topups.length).toBeGreaterThanOrEqual(5)
    // €7,000 wire and +€500 CPTE → income
    expect(v.transactions.some((t) => t.amount === 7000 && isCashflow(t))).toBe(true)
    expect(v.transactions.some((t) => t.amount === 500 && isCashflow(t))).toBe(true)
    // An outgoing transfer −1000 and an /BEN wire −1000 → expense
    expect(v.transactions.some((t) => t.amount === -1000 && isCashflow(t))).toBe(true)
    // zero pairs exist (no counterpart legs in these files)
    expect(v.transactions.every((t) => !t.transferGroupId)).toBe(true)
    expect(v.syncNotes.some((n) => n.kind === 'txfr-ambiguous')).toBe(false)
  })

  // 7. Two-device split converges
  it('two-device split (laptop F1+B2026, phone F2+B2024) converges via merge', async () => {
    let laptop = emptyVault()
    laptop = (await importFile(laptop, loadFile(REAL.f1))).vault
    laptop = (await importFile(laptop, loadFile(REAL.b2026))).vault
    let phone = emptyVault()
    phone.vaultId = laptop.vaultId
    phone.createdAt = laptop.createdAt
    phone = (await importFile(phone, loadFile(REAL.f2))).vault
    phone = (await importFile(phone, loadFile(REAL.b2024))).vault
    const { merged } = threeWayMerge(null, laptop, phone)
    // 330 revolut + 3 extras + 17 bnp(2024) + 14 bnp(2026) minus overlaps
    const hashes = merged.transactions.map((t) => t.importMeta!.hash)
    expect(new Set(hashes).size).toBe(hashes.length) // no duplicate hashes survive
    expect(merged.accounts.filter((a) => a.institutionId === 'bnp').length).toBe(1) // dup-account unified
    expect(merged.accounts.filter((a) => a.institutionId === 'revolut').length).toBe(1)
  })

  // 8b. Signals suggest, the user confirms, then per-transaction dedupe converges — and the
  // confirmation is remembered so the next same-account file binds silently.
  it('BNP PDF then XLS: suggested by last-4, confirmed, deduped, then remembered', async () => {
    let v = emptyVault()
    const a = await importFile(v, loadFile(REAL.b2026))
    v = a.vault
    const pdfRows = a.plan.counts.toAdd
    const acct = v.accounts.find((x) => x.institutionId === 'bnp')!
    expect(acct.last4).toBe(RE().mask) // last-4 stored from the RIB as a signal
    expect(acct.matchKeys).toEqual([`rib:${RE().rib}`]) // RIB auto; last-4 not yet

    // XLS alone → the last-4 only SUGGESTS the account (never silently bound)
    const suggest = await planFor(v, loadFile(REAL.bxls))
    if (isRefusal(suggest)) throw new Error('refused')
    expect(suggest.account.mode).toBe('confirm')
    expect(suggest.account.candidates.some((c) => c.reason === 'signal' && c.accountId === acct.id && c.signal === `····${RE().mask}`)).toBe(true)

    // Confirm → rows hash under the PDF account's key → overlap skipped per transaction
    const b = await importFile(v, loadFile(REAL.bxls), { accountId: acct.id })
    expect(b.plan.account.mode).toBe('existing')
    expect(b.plan.counts.duplicates).toBe(pdfRows)
    expect(b.plan.counts.toAdd).toBe(287 - pdfRows)
    v = b.vault
    expect(v.accounts.filter((x) => x.institutionId === 'bnp').length).toBe(1)
    const hashes = v.transactions.map((t) => t.importMeta!.hash)
    expect(new Set(hashes).size).toBe(hashes.length) // zero duplicate rows in the vault
    expect(v.snapshots.some((s) => s.date === '2026-07-23' && s.amount === 41347.28)).toBe(true)

    // a skipped row links to the existing transaction it matched (verify-panel data)
    const dup = b.plan.rows.find((r) => r.status === 'duplicate')!
    expect(dup.duplicateOf).toBeTruthy()
    expect(v.transactions.some((t) => t.id === dup.duplicateOf)).toBe(true)

    // legit same-day duplicate (ASF toll −€1.90 ×2) survives as two rows, never multiplies
    expect(v.transactions.filter((t) => t.date === '2026-01-08' && t.amount === -1.9).length).toBe(2)

    // remembered: last-4 is now a confirmed auto-key → the next XLS binds silently (no confirm).
    // (proceedAlreadyImported bypasses the same-file short-circuit so we can inspect resolution.)
    expect(v.accounts.find((x) => x.id === acct.id)!.matchKeys).toContain(`last4:${RE().mask}`)
    const next = await planFor(v, loadFile(REAL.bxls), { proceedAlreadyImported: true })
    if (isRefusal(next)) throw new Error('refused')
    expect(next.account.mode).toBe('existing')
  })

  it('BNP XLS dedupes when the account is picked by hand', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.b2026))).vault
    const bnp = v.accounts.find((acc) => acc.institutionId === 'bnp')!
    // Force an explicit account choice, bypassing last-4 correlation.
    const b = await importFile(v, loadFile(REAL.bxls), { accountId: bnp.id })
    expect(b.plan.counts.duplicates).toBeGreaterThan(0)
    const hashes = b.vault.transactions.map((t) => t.importMeta!.hash)
    expect(new Set(hashes).size).toBe(hashes.length) // regression guard: hash under the resolved account
  })

  // 8. Undo
  it('revertImport removes an import and restores the prior vault', async () => {
    let v = emptyVault()
    const plan = await buildImportPlan(loadFile(REAL.f1), v)
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    const op = planToOp(plan)
    const res = applyOp(v, op)
    expect(res.vault.transactions.length).toBe(330)
    expect(res.inverse).toBeTruthy()
    const undone = applyOp(res.vault, res.inverse!).vault
    expect(undone.transactions.length).toBe(0)
    expect(undone.accounts.length).toBe(0)
    expect(undone.statements.length).toBe(0)
  })
})
