import { describe, it, expect, beforeEach } from 'vitest'
import { adapterById } from '../../src/import/registry'
import { parseLines, pumbNormDesc } from '../../src/import/adapters/pumb'
import { reconstructLines, type PdfPage, type VisualLine } from '../../src/import/pdf'
import { hashRows } from '../../src/import/identity'
import { lookupQuery } from '../../src/import/lookup'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { isRefusal } from '../../src/import/types'
import { expectations, have, importFile, loadFile, planFor, REAL } from '../helpers/importing'

// ---------------------------------------------------------------------------
// Synthetic geometry. PUMB's real file is a Cyrillic PDF full of personal data, and pdf-lib's
// standard fonts cannot regenerate one (WinAnsi — every Cyrillic glyph would become `?`). The
// parser is therefore exposed as `parseLines`, a pure function over reconstructed lines, and
// driven here from hand-built runs measured off the real statement: the same x bands, the same
// three-lines-per-row shape, the same wrapped merchant and wrapped operation word. Identity
// values are invented.
// ---------------------------------------------------------------------------

type Spec = [x: number, y: number, w: number, str: string]

/** Build lines the way the real path does — through `reconstructLines`, not by hand. */
function linesOf(specs: Spec[]): VisualLine[] {
  const page: PdfPage = {
    width: 595,
    height: 842,
    items: specs.map(([x, y, w, str]) => ({ x, y, w, fontSize: 5, str })),
  }
  return reconstructLines(page)
}

const CARD = '53552800****2791'

const HEADER: Spec[] = [
  [26, 756.6, 26, 'Клієнт'], [322, 756.6, 66, 'За рахунком №'],
  [26, 743.0, 141, 'Тестенко Богдан Петрович'], [322, 743.0, 160, 'UA98 3348 5100 0007 7712 3456 7890 1'],
  [26, 726.3, 14, 'ІПН'], [322, 726.3, 42, 'За період'],
  [26, 712.6, 49, '1234567890'], [322, 712.6, 132, 'з 01.02.2025 р. по 28.02.2025 р.'],
  [26, 695.9, 94, 'Паспортний документ'], [322, 695.9, 35, 'У валюті'],
  [26, 682.3, 265, 'Паспорт громадянина України'], [322, 682.3, 18, 'UAH'],
  [26, 640.1, 128, 'Інформація про рух коштів'],
  // The column header — five visual lines of it, none carrying a date in the date band.
  [166, 623.2, 17, 'Дата'], [222, 623.2, 18, 'Сума'],
  [34, 619.6, 40, 'Дата та час'], [535, 619.6, 17, 'Опис'],
  [90, 615.3, 48, 'Сума операції'], [157, 615.3, 35, 'виконання'], [217, 615.3, 28, 'у валюті'],
  [266, 615.3, 43, 'Сума комісій'], [332, 615.3, 47, 'Номер картки'], [428, 615.3, 52, 'Деталі операції'],
  [40, 611.1, 29, 'операції'], [529, 611.1, 29, 'операції'],
  [153, 607.2, 43, '(Дата постінгу)'], [217, 607.2, 27, 'рахунку'],
]

// Two rows of the SAME amount, second, card and merchant — one a refund, one a purchase. This
// pair is real (it opens the sample statement) and is why the operation word is in the identity.
const ROW_REFUND: Spec[] = [
  [38, 592.6, 32, '2025-02-01'], [526, 592.6, 34, 'Повернення'],
  [99, 589.1, 31, '100.00 EUR'], [158, 589.1, 33, '2025-02-03'], [215, 589.1, 33, '4381.86 UAH'],
  [275, 589.1, 26, '0.00 UAH'], [331, 589.1, 47, CARD],
  [405, 589.1, 31, 'EUROPCAR'], [458, 589.1, 22, 'ANGLET'], [491, 589.1, 13, 'FRFR'],
  [42, 585.6, 23, '09:48:58'], [534, 585.6, 18, 'коштів'],
]

const ROW_PURCHASE: Spec[] = [
  [38, 571.7, 32, '2025-02-01'],
  [99, 568.2, 31, '100.00 EUR'], [158, 568.2, 33, '2025-02-03'], [215, 568.2, 33, '4381.86 UAH'],
  [275, 568.2, 26, '0.00 UAH'], [331, 568.2, 47, CARD],
  [405, 568.2, 31, 'EUROPCAR'], [458, 568.2, 22, 'ANGLET'], [491, 568.2, 13, 'FRFR'],
  [531, 568.2, 24, 'Покупка'],
  [42, 564.7, 23, '09:48:58'],
]

// Merchant spread over all three lines of the group.
const ROW_WRAPPED: Spec[] = [
  [37, 529.9, 33, '2025-02-03'], [408, 529.9, 48, 'MAXICOFFEE SUD'], [470, 529.9, 32, 'GARDANNE'],
  [102, 526.4, 24, '2.40 EUR'], [158, 526.4, 34, '2025-02-05'], [216, 526.4, 31, '105.00 UAH'],
  [275, 526.4, 26, '0.00 UAH'], [331, 526.4, 47, CARD], [531, 526.4, 24, 'Покупка'],
  [42, 522.9, 24, '09:00:48'], [448, 522.9, 13, 'FRFR'],
]

// Operation currency EQUALS the account currency but the figures differ (481.02 vs 484.78) —
// a real row of the sample file, and not a foreign leg.
const ROW_SAME_CCY: Spec[] = [
  [38, 467.2, 33, '2025-02-22'], [414, 467.2, 57, 'JOE & THE JUICE HIA'], [478, 467.2, 17, 'DOHA'],
  [99, 463.7, 30, '481.02 UAH'], [158, 463.7, 33, '2025-02-24'], [216, 463.7, 31, '484.78 UAH'],
  [275, 463.7, 26, '0.00 UAH'], [331, 463.7, 47, CARD], [531, 463.7, 24, 'Покупка'],
  [44, 460.2, 20, '13:14:52'], [446, 460.2, 17, 'QAQA'],
]

// −4381.86 − 105.00 − 484.78 + 4381.86 against an opening of 10000.00.
const TOTALS: Spec[] = [
  [328, 342.2, 137, 'Баланс рахунку на початок періоду'], [485, 342.2, 33, '10000.00'],
  [328, 330.5, 97, 'Всього списань за період'], [485, 330.5, 31, '4971.64'],
  [328, 317.9, 111, 'Всього зарахувань за період'], [485, 317.9, 28, '4381.86'],
  [328, 305.2, 130, 'Баланс рахунку на кінець періоду'], [485, 305.2, 31, '9410.22'],
  [26, 279.4, 342, 'Вклади гарантуються відповідно до Закону України «Про систему гарантування вкладів».'],
  [25, 249.2, 122, 'Дата формування: 01.07.2025 16:13:58.'],
]

const SYNTHETIC = linesOf([...HEADER, ...ROW_REFUND, ...ROW_PURCHASE, ...ROW_WRAPPED, ...ROW_SAME_CCY, ...TOTALS])

describe('pumb adapter — geometry (synthetic lines)', () => {
  const stmt = parseLines(SYNTHETIC)
  const ad = adapterById('pumb')!

  it('reads the header block: IBAN key, mask, holder, period, currency', () => {
    expect(stmt.institution).toBe('pumb')
    expect(stmt.variant).toBe('pdf')
    expect(stmt.locale).toBe('uk')
    expect(stmt.fingerprint).toBe('pumb:UA983348510000077712345678901')
    expect(stmt.accountMask).toBe('8901')
    expect(stmt.holderNames).toEqual(['Тестенко Богдан Петрович'])
    expect(stmt.accountCurrency).toBe('UAH')
    expect(stmt.periodFrom).toBe('2025-02-01')
    expect(stmt.periodTo).toBe('2025-02-28')
  })

  it('reads all four printed figures from the totals block', () => {
    expect(stmt.openingBalance).toBe(10000)
    expect(stmt.closingBalance).toBe(9410.22)
    expect(stmt.printedTotals).toEqual({ debitMinor: 497164, creditMinor: 438186 })
  })

  it('groups three visual lines into one row and skips the repeated column header', () => {
    expect(stmt.rows.length).toBe(4)
    expect(stmt.skipped.unparsed).toEqual([])
    const norm = ad.normalize(stmt)
    expect(norm.map((r) => r.sourceLine)).toEqual([0, 1, 2, 3])
    expect(norm.map((r) => r.bookedDate)).toEqual(['2025-02-01', '2025-02-01', '2025-02-03', '2025-02-22'])
  })

  it('signs rows from the operation word — nothing else in the file states direction', () => {
    const norm = ad.normalize(stmt)
    expect(norm.map((r) => r.amountMinor)).toEqual([438186, -438186, -10500, -48478])
    expect(norm.map((r) => r.kind)).toEqual(['refund', 'expense', 'expense', 'expense'])
  })

  it('reconciles on BOTH gates the file offers — opening + Σ, and the printed totals', () => {
    const norm = ad.normalize(stmt)
    const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
    expect(Math.round(stmt.openingBalance! * 100) + sum).toBe(Math.round(stmt.closingBalance! * 100))
    const debit = norm.filter((r) => r.amountMinor < 0).reduce((t, r) => t - r.amountMinor, 0)
    const credit = norm.filter((r) => r.amountMinor > 0).reduce((t, r) => t + r.amountMinor, 0)
    expect({ debitMinor: debit, creditMinor: credit }).toEqual(stmt.printedTotals)
  })

  it('assembles a merchant wrapped across all three lines, stripping the acquirer tail', () => {
    const norm = ad.normalize(stmt)
    expect(norm[2]!.merchant).toBe('MAXICOFFEE SUD GARDANNE')
    expect(norm[0]!.merchant).toBe('EUROPCAR ANGLET')
    expect(norm[3]!.merchant).toBe('JOE & THE JUICE HIA DOHA')
    // The tail is noise for display only — `raw` keeps the descriptor whole.
    expect(norm[2]!.raw).toContain('FRFR')
  })

  it('emits a foreign leg only when the operation currency really differs', () => {
    const norm = ad.normalize(stmt)
    expect(norm[0]!.original).toEqual({ amount: 100, currency: 'EUR' }) // credit → positive
    expect(norm[1]!.original).toEqual({ amount: -100, currency: 'EUR' }) // debit → negative
    // 481.02 UAH against a posted 484.78 UAH is not a foreign leg; emitting it would derive a
    // bogus UAH→UAH rate.
    expect(norm[3]!.original).toBeUndefined()
  })

  it('leaves a zero fee unset', () => {
    expect(adapterById('pumb')!.normalize(stmt).every((r) => r.feeMinor === undefined)).toBe(true)
  })
})

describe('pumb identity — the operation word is what separates two identical rows', () => {
  const ad = adapterById('pumb')!
  const norm = ad.normalize(parseLines(SYNTHETIC))

  it('a refund and a purchase of the same amount, second, card and merchant do not collide', async () => {
    const [refund, purchase] = [norm[0]!, norm[1]!]
    expect(refund.bookedDate).toBe(purchase.bookedDate)
    expect(Math.abs(refund.amountMinor)).toBe(Math.abs(purchase.amountMinor))
    expect(refund.merchant).toBe(purchase.merchant)
    expect(refund.normDesc).not.toBe(purchase.normDesc)
    const hashes = await hashRows(norm, 'pumb:test')
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('the canon strips whitespace, so a mid-word wrap cannot move a hash', () => {
    expect(pumbNormDesc('EUROP CAR ANGLET FRFR', 'Покупка', '53552800****2791', '10:40:26')).toBe(
      pumbNormDesc('EUROPCAR ANGLETFRFR', 'Покупка', '53552800****2791', '10:40:26'),
    )
  })

  it('the card tail is in the basis, so the same charge on two cards stays two rows', () => {
    expect(pumbNormDesc('AIR FRANCE ROISSY CDG', 'Покупка', '53552800****2791', '14:54:08')).not.toBe(
      pumbNormDesc('AIR FRANCE ROISSY CDG', 'Покупка', '53552800****3898', '14:54:08'),
    )
  })
})

// The sample statement only ever says `Покупка` and `Повернення коштів`. The rest of the
// dictionary is the PUMB statement vocabulary and unverified, so what matters is that an
// unrecognized word is read as a debit rather than guessed at — the reconciliation gate then
// refuses the file if that reading is wrong.
describe('pumb grammar — operation words (synthetic rows)', () => {
  const ad = adapterById('pumb')!
  const norm = (specs: { opDesc: string; details?: string }[]) =>
    ad.normalize({
      rows: specs.map((s, i) => ({
        bookedDate: '2025-02-01',
        time: '09:00:00',
        amountMinor: /ПОВЕРНЕННЯ|ЗАРАХУВАННЯ|ПОПОВНЕННЯ/i.test(s.opDesc) ? 5000 : -5000,
        currency: 'UAH',
        cardMask: CARD,
        details: s.details ?? 'SOME MERCHANT PARIS FRFR',
        opDesc: s.opDesc,
        sourceLine: i,
      })),
    } as unknown as Parameters<typeof ad.normalize>[0])

  it('maps the vocabulary to kinds', () => {
    const n = norm([
      { opDesc: 'Покупка' },
      { opDesc: 'Повернення коштів' },
      { opDesc: 'Комісія за обслуговування' },
      { opDesc: 'Переказ на картку' },
      // "crediting of a transfer" — the same reading Privat gives its `Transfer crediting`.
      { opDesc: 'Зарахування переказу' },
      // A bare credit word names no counterparty, so it stays `other` rather than claiming a leg.
      { opDesc: 'Поповнення рахунку' },
      { opDesc: 'Зняття готівки' },
    ])
    expect(n.map((r) => r.kind)).toEqual(['expense', 'refund', 'fee', 'transfer-out', 'transfer-in', 'other', 'expense'])
  })

  it('reads an unrecognized word as a debit rather than guessing', () => {
    const n = norm([{ opDesc: 'Невідома операція' }])
    expect(n[0]!.kind).toBe('expense')
    expect(n[0]!.amountMinor).toBeLessThan(0)
  })

  it('strips the doubled country tail but never a merchant name', () => {
    const n = norm([
      { opDesc: 'Покупка', details: 'AIR FRANCE ROISSY CDG CEFRFR' },
      { opDesc: 'Покупка', details: 'Quitoque Paris FRFR' },
      { opDesc: 'Покупка', details: 'EUROPCAR' }, // no tail at all
      { opDesc: 'Покупка', details: 'SumUp *Taxi Chegra Zi Aulnay-sous- BFRFR' }, // wrapped mid-word
    ])
    expect(n.map((r) => r.merchant)).toEqual([
      'AIR FRANCE ROISSY CDG',
      'Quitoque Paris',
      'EUROPCAR',
      'SumUp *Taxi Chegra Zi Aulnay-sous',
    ])
  })

  it('a lookup query reaches the merchant, not the Ukrainian operation word', () => {
    const n = norm([{ opDesc: 'Покупка', details: 'MAXICOFFEE SUD GARDANNE FRFR' }])
    const q = lookupQuery(n[0]!.merchant, n[0]!.raw)
    expect(q).toContain('MAXICOFFEE')
    expect(q).not.toMatch(/Покупка/i)
  })
})

const d = have(REAL.pumb) ? describe : describe.skip

d('pumb adapter — real file', () => {
  beforeEach(() => setFixedNow('2026-08-01T10:00:00Z'))

  it('detects pumb/pdf unambiguously — no other adapter answers', async () => {
    const { detectFile } = await import('../../src/import/registry')
    const res = await detectFile(loadFile(REAL.pumb))
    expect(res.best?.institution).toBe('pumb')
    expect(res.best?.variant).toBe('pdf')
    expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(res.ambiguous).toBe(false)
    expect(res.candidates.length).toBe(1)
  })

  it('parses 11 rows with nothing unparsed, and reconciles on both gates', async () => {
    const ad = adapterById('pumb')!
    const stmt = await ad.parse(loadFile(REAL.pumb), 'pdf')
    expect(stmt.accountCurrency).toBe('UAH')
    expect(stmt.periodFrom).toBe('2025-02-01')
    expect(stmt.periodTo).toBe('2025-02-28')
    expect(stmt.openingBalance).toBe(26349.45)
    expect(stmt.closingBalance).toBe(11525.3)
    expect(stmt.printedTotals).toEqual({ debitMinor: 1920601, creditMinor: 438186 })
    expect(stmt.rows.length).toBe(11)
    expect(stmt.skipped.unparsed).toEqual([])

    const norm = ad.normalize(stmt)
    const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
    expect(Math.round(stmt.openingBalance! * 100) + sum).toBe(Math.round(stmt.closingBalance! * 100))
    // exactly one credit — the refund that opens the statement
    expect(norm.filter((r) => r.amountMinor > 0).length).toBe(1)
    expect(norm[0]!.kind).toBe('refund')
  })

  it('the account key is the IBAN, and it is stable across two parses', async () => {
    const ad = adapterById('pumb')!
    const a = await ad.parse(loadFile(REAL.pumb), 'pdf')
    const b = await ad.parse(loadFile(REAL.pumb), 'pdf')
    expect(a.fingerprint).toMatch(/^pumb:UA\d{2}\d{20,}$/)
    expect(b.fingerprint).toBe(a.fingerprint)
    expect(a.accountMask).toBe(a.fingerprint!.slice(-4))
    const h1 = await hashRows(ad.normalize(a), a.fingerprint!)
    const h2 = await hashRows(ad.normalize(b), b.fingerprint!)
    expect(h1).toEqual(h2)
  })

  it('every row extracts a real merchant — none falls back to the operation word', async () => {
    const ad = adapterById('pumb')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.pumb), 'pdf'))
    for (const r of norm) {
      expect(r.merchant.length).toBeGreaterThan(2)
      expect(r.merchant).not.toMatch(/Покупка|Повернення/)
    }
    // the two cards of this account both appear, and both reach the identity basis
    expect(new Set(norm.map((r) => r.normDesc.match(/\*{4}(\d{4})/)?.[1])).size).toBe(2)
  })

  it('imports into a fresh vault as one IBAN-keyed account, and re-import auto-binds', async () => {
    const { vault: v, plan } = await importFile(emptyVault(), loadFile(REAL.pumb))
    expect(plan.account.mode).toBe('create')
    expect(plan.account.suggestedName).toBe(expectations().pumbAccountName)
    expect(plan.groups.length).toBe(1) // one statement per account, not per card
    expect(plan.counts.toAdd).toBe(11)
    expect(plan.reconciliation.ok).toBe(true)
    expect(plan.starterPackOffer).toBe(false) // the seed pack is French and SEPA-keyed

    const acc = v.accounts.filter((a) => a.institutionId === 'pumb')
    expect(acc.length).toBe(1)
    expect(acc[0]!.currency).toBe('UAH')
    expect(v.transactions.length).toBe(11)

    const again = await planFor(v, loadFile(REAL.pumb), { proceedAlreadyImported: true })
    if (isRefusal(again)) throw new Error(`refused: ${again.refusal} — ${again.message}`)
    expect(again.account.mode).toBe('existing')
    expect(again.counts.duplicates).toBe(11)
    expect(again.counts.toAdd).toBe(0)
  })
})
