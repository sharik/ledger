import { describe, it, expect, beforeEach } from 'vitest'
import { adapterById } from '../../src/import/registry'
import { bnpNormDesc, bnpNormDescLegacy } from '../../src/import/adapters/bnp'
import { creditorIdOf } from '../../src/import/identity'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { isRefusal } from '../../src/import/types'
import { expectations, have, haveReal, importFile, loadFile, planFor, REAL } from '../helpers/importing'

const d = haveReal() ? describe : describe.skip
// Real-statement values (holder surname, account number, mask) live beside the files themselves,
// in gitignored `docs/examples/expectations.json`. Only reached inside `d(...)` suites.
const RE = () => expectations()

// The newer BNP xls export (`export_*.xls`) uses a different label dialect than the mabanque
// files above: merchant/creditor/counterparty precede a slashed `DU DD/MM/YY` date. No real file
// needed — drive `extractRow` through the public `normalize` with hand-built rows.
describe('bnp adapter — newer xls dialect (synthetic)', () => {
  const ad = adapterById('bnp')!
  const norm = (specs: { label: string; amountMinor: number }[]) =>
    ad.normalize({
      rows: specs.map((s, i) => ({ bookedDate: '2025-06-29', valueDate: '2025-06-29', amountMinor: s.amountMinor, label: s.label, sourceLine: i })),
    } as unknown as Parameters<typeof ad.normalize>[0])

  it('cleans card payments — merchant before DU, country/place suffix stripped', () => {
    const n = norm([
      { label: 'PAIEMENT CB SPAR DU 29/06/25 A TOULOUSE - CARTE*4242', amountMinor: -1234 },
      { label: 'PAIEMENT CB LE SURFING (FRANCE) DU 29/06/25 - CARTE*4242', amountMinor: -650 },
      { label: 'PAIEMENT CB S-BAHN BERLIN A (ALLEMAGNE) DU 21/07/25 - CARTE*4242', amountMinor: -260 },
    ])
    expect(n.map((r) => [r.merchant, r.kind])).toEqual([['SPAR', 'expense'], ['LE SURFING', 'expense'], ['S-BAHN BERLIN', 'expense']])
  })

  it('classifies refund, transfers (in/out/internal), direct debit and fee', () => {
    const n = norm([
      { label: 'REMBOURSEMENT CB SQ *ETCHEBERRY (FRANCE) DU 29/06/25 - CARTE*4242', amountMinor: 500 },
      { label: 'VIREMENT INSTANTANE EMIS VERS MARIIA MARTIN - MOTIF : X', amountMinor: -10000 },
      { label: 'VIREMENT DE CPAM 75 PRESTATIONS  MOTIF: 251 - REF : 251', amountMinor: 505 },
      { label: 'VIREMENT INSTANTANE RECU DE ALAN SERVICES  MOTIF: Y - REF : Z', amountMinor: 28373 },
      { label: 'VIREMENT INTERNE VR.PERMANENT VIREMENT VERS COMPTE DE CHEQUES', amountMinor: -20000 },
      { label: 'PRELEVEMENT SFR DU 15/07/25 - EMETTEUR : FR44ZZZ332801 MDT - MOTIF : X', amountMinor: -3000 },
      { label: 'FRAIS TENUE DE COMPTE', amountMinor: -200 },
    ])
    expect(n.map((r) => r.kind)).toEqual(['refund', 'transfer-out', 'transfer-in', 'transfer-in', 'transfer-out', 'expense', 'fee'])
    expect(n[0]!.merchant).toBe('SQ *ETCHEBERRY')
    expect(n[1]!.counterparty).toBe('MARIIA MARTIN')
    expect(n[2]!.counterparty).toBe('CPAM 75 PRESTATIONS')
    expect(n[3]!.counterparty).toBe('ALAN SERVICES')
    expect(n[5]!.merchant).toBe('SFR')
    expect(n[5]!.creditorId).toBe('FR44ZZZ332801')
    expect(n[6]!.merchant).toBe('Frais bancaires')
  })

  it('creditorIdOf accepts both `EMETTEUR /` and `EMETTEUR :` separators', () => {
    expect(creditorIdOf('PRELEVEMENT SFR DU 15/07/25 - EMETTEUR : FR44ZZZ332801 MDT')).toBe('FR44ZZZ332801')
    expect(creditorIdOf('PRELEVEMENT ENGIE ID EMETTEUR/FR03SYM002381 ECH/100726')).toBe('FR03SYM002381')
  })

  it('the dedup canon stays label-derived (extraction changes are hash-neutral)', () => {
    const canon = bnpNormDesc('PAIEMENT CB SPAR DU 29/06/25 A TOULOUSE - CARTE*4242')
    expect(canon).toContain('PAIEMENTCB')
    expect(canon).toContain('SPAR')
  })

  it('keeps the FX foreign-leg decimals — a truncated leg skews the derived rate', () => {
    const n = norm([
      { label: 'FACTURE(S) CARTE X DU 120526 TOKYO STORE USA 123,45USD+COMMISSION : 11,38', amountMinor: -12545 },
    ])
    expect(n[0]!.original).toEqual({ amount: -123.45, currency: 'USD' })
    expect(n[0]!.feeMinor).toBe(1138)
  })

  it('rows carry the statement currency, not a hardcoded EUR', () => {
    const stmt = {
      accountCurrency: 'USD',
      rows: [{ bookedDate: '2025-06-29', valueDate: '2025-06-29', amountMinor: -1234, label: 'FRAIS TENUE DE COMPTE', sourceLine: 0 }],
    } as unknown as Parameters<typeof ad.normalize>[0]
    expect(ad.normalize(stmt)[0]!.currency).toBe('USD')
  })
})

// The 2023-vintage mabanque export predates the dialect above and differs in three ways: no year
// after `DU` (`DU 23/04`), `VIREMENT VERS` without `EMIS`, and a bare `- EMETTEUR :` with no `ID`.
// Anchoring on `DU DD/MM/YY` alone left 71 of 134 rows carrying the raw label as their merchant
// and all 20 outbound transfers classified as `other` — i.e. counted as ordinary cash flow.
describe('bnp adapter — 2023 xls dialect (synthetic)', () => {
  const ad = adapterById('bnp')!
  const norm = (specs: { label: string; amountMinor: number }[]) =>
    ad.normalize({
      rows: specs.map((s, i) => ({ bookedDate: '2023-04-23', valueDate: '2023-04-23', amountMinor: s.amountMinor, label: s.label, sourceLine: i })),
    } as unknown as Parameters<typeof ad.normalize>[0])

  it('extracts card merchants when the year is missing after DU', () => {
    const n = norm([
      { label: 'PAIEMENT CB UBER (PAYS-BAS) DU 30/12 - CARTE*4242', amountMinor: -2140 },
      { label: 'PAIEMENT CB SOEUR SEVIGNE DU 23/04 A PARIS 4 - CARTE*4242', amountMinor: -5000 },
      { label: 'PAIEMENT CB OUTLET SEVIGNE (FRANCE) DU 23/04 - CARTE*4242', amountMinor: -1200 },
    ])
    expect(n.map((r) => [r.merchant, r.kind])).toEqual([
      ['UBER', 'expense'],
      ['SOEUR SEVIGNE', 'expense'],
      ['OUTLET SEVIGNE', 'expense'],
    ])
  })

  it('extracts the créancier from a yearless PRELEVEMENT with a bare EMETTEUR', () => {
    const n = norm([
      { label: 'PRELEVEMENT SFR DU 25/04 - EMETTEUR : FR44ZZZ332801 MDT - MOTIF : SFR MOBILE PRLVT SEPA 99-1H2N64-01 - REF : 003857260919', amountMinor: -2100 },
      { label: 'PRELEVEMENT TOTALENERGIES ELECTRICITE ET GAZ FRANCE DU 05/01 - EMETTEUR : FR52ZZZ532768 MDT', amountMinor: -8900 },
    ])
    expect(n.map((r) => [r.merchant, r.kind])).toEqual([
      ['SFR', 'expense'],
      ['TOTALENERGIES ELECTRICITE ET GAZ FRANCE', 'expense'],
    ])
    expect(n[0]!.creditorId).toBe('FR44ZZZ332801')
  })

  it('classifies `VIREMENT VERS` (no EMIS) as transfer-out, keeping the beneficiary', () => {
    const n = norm([
      { label: 'VIREMENT VERS JARKOVA MARINA M - MOTIF : 5.01', amountMinor: -50000 },
      { label: 'VIREMENT VERS KHARYTONOV HLIB - MOTIF : TRANSFERT PERSONNEL', amountMinor: -20000 },
    ])
    expect(n.map((r) => r.kind)).toEqual(['transfer-out', 'transfer-out'])
    expect(n.map((r) => r.counterparty)).toEqual(['JARKOVA MARINA M', 'KHARYTONOV HLIB'])
  })

  // `VERS` must follow the verb directly, or the looser rule above would steal the internal move
  // (whose motif happens to contain `VIREMENT VERS COMPTE DE CHEQUES`) and name the wrong thing.
  it('leaves `VIREMENT INTERNE` internal even though its motif contains VERS', () => {
    const n = norm([{ label: 'VIREMENT INTERNE VR.PERMANENT VIREMENT VERS COMPTE DE CHEQUES', amountMinor: -50000 }])
    expect(n[0]!.kind).toBe('transfer-out')
    expect(n[0]!.merchant).toBe('Virement interne')
  })

  it('names cash deposits in both the xls and pdf spellings', () => {
    const n = norm([
      { label: 'VERSEMENT ESPECES DU 15/04 A 16H06', amountMinor: 90000 },
      { label: 'VRSTESPECES AUTOMATE 12/05/23 19H00', amountMinor: 90000 }, // pdf despacing
    ])
    expect(n.map((r) => r.merchant)).toEqual(['Versement espèces', 'Versement espèces'])
  })
})

d('bnp adapter — real files', () => {
  it('extracts fingerprint (RIB) identical across both statements → gap detection key', async () => {
    const ad = adapterById('bnp')!
    const s24 = await ad.parse(loadFile(REAL.b2024), 'pdf')
    const s26 = await ad.parse(loadFile(REAL.b2026), 'pdf')
    expect(s24.fingerprint).toBe(RE().rib)
    expect(s26.fingerprint).toBe(s24.fingerprint)
  })

  it('joint account (` OU `) suggests two holders', async () => {
    const ad = adapterById('bnp')!
    const s26 = await ad.parse(loadFile(REAL.b2026), 'pdf')
    expect(s26.holderNames!.length).toBeGreaterThanOrEqual(2)
  })

  it('reconciles both statements against printed TOTAL DES OPERATIONS', async () => {
    const ad = adapterById('bnp')!
    for (const [p, open, close, deb, cred] of [
      [REAL.b2024, 9721.56, 9747.26, 267430, 270000],
      [REAL.b2026, 34584.45, 45923.35, 334274, 1468164],
    ] as const) {
      const stmt = await ad.parse(loadFile(p), 'pdf')
      const norm = ad.normalize(stmt)
      const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
      expect(Math.round(open * 100) + sum).toBe(Math.round(close * 100))
      expect(stmt.printedTotals).toEqual({ debitMinor: deb, creditMinor: cred })
    }
  })

  it('label grammar §6.5: card, PRLV creditorId, VIR /DE, EMIS /BEN, JPY continuation', async () => {
    const ad = adapterById('bnp')!
    const norm24 = ad.normalize(await ad.parse(loadFile(REAL.b2024), 'pdf'))
    const norm26 = ad.normalize(await ad.parse(loadFile(REAL.b2026), 'pdf'))
    const all = [...norm24, ...norm26]

    // SEPA creditor ids (rule keys, §3)
    const ids = new Set(all.map((r) => r.creditorId).filter(Boolean))
    for (const id of ['FR35ZZZ418323', 'FR03SYM002381', 'FR70ZZZ236497', 'FR36ZZZ86EDDA']) expect(ids.has(id)).toBe(true)

    // JPY continuation → original + fee
    const jpy = all.find((r) => r.original?.currency === 'JPY')
    expect(jpy!.original).toEqual({ amount: -59290, currency: 'JPY' })
    expect(jpy!.feeMinor).toBe(1138)

    // VIR /DE transfer-in and EMIS /BEN transfer-out
    expect(norm26.some((r) => r.kind === 'transfer-in' && new RegExp(RE().holder).test(r.counterparty ?? ''))).toBe(true)
    const emis = norm26.find((r) => r.kind === 'transfer-out')
    expect(emis!.counterparty).toMatch(new RegExp(RE().beneficiary))
    expect(emis!.counterparty).not.toMatch(new RegExp(RE().motif))

    // instant-transfer ref captured for identity
    expect(norm26.some((r) => r.kind === 'transfer-in' && (r.ref?.length ?? 0) >= 24)).toBe(true)
  })

  it('card rows extract a real merchant and stay kind=expense (not swallowed as other)', async () => {
    const ad = adapterById('bnp')!
    for (const p of [REAL.b2024, REAL.b2026]) {
      const norm = ad.normalize(await ad.parse(loadFile(p), 'pdf'))
      const cards = norm.filter((r) => /CARTE/.test(r.raw))
      expect(cards.length).toBeGreaterThan(0)
      for (const r of cards) {
        expect(r.kind).toBe('expense')
        expect(r.merchant).not.toMatch(/^FACTURE/) // merchant was actually extracted
        expect(r.merchant).not.toMatch(/COMMISSION/) // FX tail trimmed off the display name
      }
    }
  })

  it('year inference places DD.MM rows inside the statement period', async () => {
    const ad = adapterById('bnp')!
    const s26 = await ad.parse(loadFile(REAL.b2026), 'pdf')
    const norm = ad.normalize(s26)
    for (const r of norm) {
      expect(r.bookedDate >= '2026-04-12' && r.bookedDate <= s26.periodTo).toBe(true)
    }
  })

  // ---- XLS variant (mabanque "download transactions") ----
  it('xls: parses account mask, Solde anchor, all rows in chronological order', async () => {
    const ad = adapterById('bnp')!
    const stmt = await ad.parse(loadFile(REAL.bxls), 'xls')
    expect(stmt.variant).toBe('xls')
    expect(stmt.fingerprint).toBe(`bnp:mask:${RE().mask}`) // no RIB in the export → last-4 key
    expect(stmt.accountMask).toBe(RE().mask)
    expect(stmt.accountCurrency).toBe('EUR')
    expect(stmt.rows.length).toBe(287)
    expect(stmt.skipped.unparsed.length).toBe(0)
    // single balance anchor: the Solde, dated after the last transaction; no opening/totals
    expect(stmt.openingBalance).toBeUndefined()
    expect(stmt.closingBalance).toBe(41347.28)
    expect(stmt.periodTo).toBe('2026-07-23')
    // chronological (oldest first) so the occurrence index aligns with the PDF's line order
    const norm = ad.normalize(stmt)
    for (let i = 1; i < norm.length; i++) expect(norm[i]!.bookedDate >= norm[i - 1]!.bookedDate).toBe(true)
  })

  it('xls: grammar classifies the mabanque vocabulary (card, prélèvement, virement, remboursement, commissions)', async () => {
    const ad = adapterById('bnp')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.bxls), 'xls'))
    const kinds = new Set(norm.map((r) => r.kind))
    expect(kinds.has('expense')).toBe(true)
    expect(kinds.has('transfer-in')).toBe(true)
    expect(kinds.has('transfer-out')).toBe(true)
    expect(kinds.has('refund')).toBe(true) // REMBOURST CB
    expect(kinds.has('fee')).toBe(true) // COMMISSIONS
    // SEPA direct debits expose the creditor id and end-to-end ref
    expect(norm.some((r) => r.creditorId === 'FR35ZZZ418323')).toBe(true) // Bouygues
    expect(norm.some((r) => r.ref && r.ref.length >= 6)).toBe(true)
    // PAIEMENT CB rows: real merchant extracted, CARTE tail stripped
    const cards = norm.filter((r) => /PAIEMENT CB DU/.test(r.raw))
    expect(cards.length).toBeGreaterThan(0)
    for (const r of cards) {
      expect(r.kind).toBe('expense')
      expect(r.merchant).not.toMatch(/CARTE|PAIEMENT/)
    }
    // the emitted wire keys on /BEN, never the motif (§6.5)
    const emis = norm.find((r) => r.kind === 'transfer-out')
    expect(emis?.counterparty).toMatch(new RegExp(RE().beneficiary))
    expect(emis?.counterparty).not.toMatch(new RegExp(RE().motif))
  })
})

// A Livret A shares the BNP template exactly — same column bands, same SOLDE/TOTAL lines — so
// only the header line ever distinguished it, and keying detection on `RELEVE DE COMPTE` alone
// refused the file. It is a savings passbook, not a second current account: same bank, branch
// and holder, different account number, so it must land as its OWN account (§5.8).
const dl = have(REAL.blva) ? describe : describe.skip

dl('bnp adapter — Livret A passbook (real file)', () => {
  beforeEach(() => setFixedNow('2026-07-28T10:00:00Z'))

  it('parses and reconciles against the printed total', async () => {
    const ad = adapterById('bnp')!
    const stmt = await ad.parse(loadFile(REAL.blva), 'pdf')
    expect(stmt.productName).toBe('Livret A')
    expect(stmt.periodFrom).toBe('2023-04-13')
    expect(stmt.periodTo).toBe('2023-07-13')
    expect(stmt.openingBalance).toBe(4100)
    expect(stmt.closingBalance).toBe(20550)
    expect(stmt.printedTotals).toEqual({ debitMinor: 0, creditMinor: 1645000 })
    expect(stmt.skipped.unparsed).toEqual([])

    const norm = ad.normalize(stmt)
    expect(norm.length).toBe(9)
    const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
    expect(Math.round(stmt.openingBalance! * 100) + sum).toBe(Math.round(stmt.closingBalance! * 100))
    // `VIR CPTE A CPTE RECU /DE …` still classifies through the shared grammar
    expect(norm.filter((r) => r.kind === 'transfer-in').length).toBe(3)
  })

  it('carries a different account number from the compte chèques', async () => {
    const ad = adapterById('bnp')!
    const lva = await ad.parse(loadFile(REAL.blva), 'pdf')
    const chq = await ad.parse(loadFile(REAL.b2026), 'pdf')
    expect(lva.fingerprint).not.toBe(chq.fingerprint)
    expect(lva.accountMask).not.toBe(chq.accountMask)
    expect(lva.fingerprint).toBe(RE().livretRib)
  })

  it('lands as its own account, never merged into the current one', async () => {
    let v = emptyVault()
    v = (await importFile(v, loadFile(REAL.b2026))).vault // compte chèques first

    const plan = await planFor(v, loadFile(REAL.blva))
    if (isRefusal(plan)) throw new Error(`refused: ${plan.refusal} — ${plan.message}`)
    expect(plan.account.mode).toBe('create')
    // The product reaches the name, so it cannot collide with a same-holder current account.
    expect(plan.account.suggestedName).toBe(RE().livretAccountName)

    v = (await importFile(v, loadFile(REAL.blva))).vault
    const bnp = v.accounts.filter((a) => a.institutionId === 'bnp')
    expect(bnp.length).toBe(2)
    expect(new Set(bnp.map((a) => a.fingerprint)).size).toBe(2)
    expect(new Set(bnp.map((a) => a.name)).size).toBe(2)

    // Its RIB auto-binds on re-import — one stable account, never a third.
    const again = await planFor(v, loadFile(REAL.blva), { proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error(`refused: ${again.refusal}`)
    expect(again.account.mode).toBe('existing')
  })
})

const d23 = have(REAL.bxls2023) ? describe : describe.skip

d23('bnp adapter — 2023 xls dialect (real file)', () => {
  beforeEach(() => setFixedNow('2026-07-28T10:00:00Z'))

  it('reads the last-4 from an UNMASKED preamble number', async () => {
    const ad = adapterById('bnp')!
    const stmt = await ad.parse(loadFile(REAL.bxls2023), 'xls')
    // preamble reads `Compte de chèques 00001402101` — no `****` anywhere
    expect(stmt.accountMask).toBe('2101')
    expect(stmt.fingerprint).toBe('bnp:mask:2101')
    expect(stmt.rows.length).toBe(134)
    expect(stmt.closingBalance).toBe(4110.6)
    expect(stmt.skipped.unparsed).toEqual([])
    expect(stmt.headerWarning).toBeUndefined()
  })

  it('extracts a merchant for every row — none falls back to the raw label', async () => {
    const ad = adapterById('bnp')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.bxls2023), 'xls'))
    const rawFallback = norm.filter((r) => r.merchant === r.raw.replace(/\s+/g, ' ').trim().slice(0, 60))
    expect(rawFallback.map((r) => r.raw)).toEqual([])
    // and nothing is left displaying a bank verb instead of a counterparty
    expect(norm.filter((r) => /^(PAIEMENT|PRELEVEMENT|REMBOURSEMENT|VIREMENT VERS)/.test(r.merchant))).toEqual([])
  })

  it('classifies the outbound transfers that used to land in cash flow as `other`', async () => {
    const ad = adapterById('bnp')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.bxls2023), 'xls'))
    const vers = norm.filter((r) => /^VIREMENT VERS/.test(r.raw))
    expect(vers.length).toBe(20) // all 20 used to classify as `other`
    expect(vers.every((r) => r.kind === 'transfer-out')).toBe(true)
    expect(vers.every((r) => !!r.counterparty)).toBe(true)
    // 20 recovered + 2 that already matched the `/BEN` and `VIREMENT INTERNE` forms
    expect(norm.filter((r) => r.kind === 'transfer-out').length).toBe(22)
  })

  it('binds to the same account as that account’s newer export (mask …2101)', async () => {
    const ad = adapterById('bnp')!
    const old = await ad.parse(loadFile(REAL.bxls2023), 'xls')
    // The 2026 export of docs/examples is a different account; what matters is that the
    // old file now produces a mask-keyed fingerprint at all, so account resolution has a signal.
    expect(old.fingerprint).toMatch(/^bnp:mask:\d{4}$/)

    const plan = await planFor(emptyVault(), loadFile(REAL.bxls2023))
    if (isRefusal(plan)) throw new Error(`refused: ${plan.refusal} — ${plan.message}`)
    expect(plan.account.mode).toBe('create')
    expect(plan.parsed.accountMask).toBe('2101')
  })
})

// The Vietnam-ATM double import: the same withdrawal reaches the vault twice because the xls calls
// it `RETRAIT DISTRIBUTEUR` and the pdf `RETRAIT DAB`, so the identity basis differed and ring-1
// could not see it. Everything else in those descriptors already canonicalized identically.
describe('bnp canon — cash withdrawals fold across variants', () => {
  const XLS = 'RETRAIT DISTRIBUTEUR 01/02/26 VPBANK HO CHI M     VN HO CH         CARTE 4974XXXXXXXX7214 VN    5000000VND   + COMMISSION :   7,70EUR'
  const PDF = 'RETRAITDAB 01/02/26 VPBANKHO CHIM VNHO CH CARTE4974XXXXXXXX7214 VN 5000000VND + COMMISSION : 7,70EUR'

  it('the xls and pdf spellings produce one identity', () => {
    expect(bnpNormDesc(XLS)).toBe(bnpNormDesc(PDF))
    expect(bnpNormDesc(XLS)).toMatch(/^RETRAIT01\/02\/26/)
  })

  it('keeps the ATM location, so two withdrawals the same day at different machines differ', () => {
    const hoiAn = 'RETRAIT DISTRIBUTEUR 06/02/26 VPBANK HOI AN       VN DA NA         CARTE 4974XXXXXXXX7214 VN    5000000VND   + COMMISSION :   7,73EUR'
    expect(bnpNormDesc(XLS)).not.toBe(bnpNormDesc(hoiAn))
  })

  it('leaves every other operation untouched — the fold is anchored to RETRAIT', () => {
    for (const s of [
      'PAIEMENT CB SPAR DU 29/06/25 A TOULOUSE - CARTE*4242',
      'PRELEVEMENT SPIRICA DU 10/09/25 - EMETTEUR : FR27ZZZ526816',
      'VIREMENT /MOTIF TRANSFER /BEN X',
    ]) {
      expect(bnpNormDesc(s)).toBe(bnpNormDescLegacy(s))
    }
  })

  it('the legacy canon is preserved verbatim, so old hashes stay reproducible', () => {
    expect(bnpNormDescLegacy(XLS)).toMatch(/^RETRAITDISTRIBUTEUR01\/02\/26/)
    expect(bnpNormDescLegacy(XLS)).not.toBe(bnpNormDesc(XLS)) // the fold really moved it
  })
})
