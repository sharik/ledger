import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow, uuidv7, now } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { adapterById } from '../../src/import/registry'
import { buildImportPlan } from '../../src/import/pipeline'
import { isRefusal, type SourceFile } from '../../src/import/types'
import { have, importFile, loadFile, REAL } from '../helpers/importing'

beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

const HDR_EN = ['Date', 'Category', 'Card', 'Description', 'Amount in card currency', 'Card currency', 'Amount in transaction currency', 'Transaction currency', 'Rest at the end of the period', 'Rest currency']
const HDR_UK = ['Дата', 'Категорія', 'Картка', 'Опис операції', 'Сума в валюті картки', 'Валюта картки', 'Сума в валюті транзакції', 'Валюта транзакції', 'Залишок на кінець періоду', 'Валюта залишку']

/** Build a Privat export the way the real one is written: TAB-delimited, quoted, NEWEST FIRST. */
const tsv = (header: string[], rows: (string | number)[][]): string =>
  [header, ...rows].map((r) => r.map((c) => (typeof c === 'number' ? String(c) : `"${c}"`)).join('\t')).join('\n') + '\n'

const file = (name: string, text: string): SourceFile => ({ name, bytes: new TextEncoder().encode(text), container: 'tsv' })

const CARD = '4149 **** **** 5583'
const ad = () => adapterById('privat')!

describe('privat adapter — synthetic', () => {
  it('binds English headers and reads a foreign leg', async () => {
    const stmt = await ad().parse(
      file('p.csv', tsv(HDR_EN, [['20.09.2025 05:39:17', 'Digital goods', CARD, 'Amazon', -342.65, 'UAH', 6.99, 'EUR', 2979.9, 'UAH']])),
      'tsv',
    )
    expect(stmt.locale).toBe('en')
    expect(stmt.headerWarning).toBeFalsy()
    const n = ad().normalize(stmt)[0]!
    expect(n.bookedDate).toBe('2025-09-20')
    expect(n.amountMinor).toBe(-34265)
    expect(n.currency).toBe('UAH')
    // The foreign leg is printed unsigned; it must take the card amount's sign, or every FX
    // expense would derive a negative rate (§4.5 bank-derived rates).
    expect(n.original).toEqual({ amount: -6.99, currency: 'EUR' })
    expect(n.balanceAfterMinor).toBe(297990)
  })

  it('binds Ukrainian headers through the dictionary, not by position', async () => {
    // Same columns, shuffled: only a real dictionary hit can survive this.
    const order = [3, 0, 2, 1, 4, 5, 6, 7, 8, 9]
    const hdr = order.map((i) => HDR_UK[i]!)
    const row = order.map((i) => (['01.02.2025 10:00:00', 'Транспорт', CARD, 'Метро', -25, 'UAH', 25, 'UAH', 975, 'UAH'] as (string | number)[])[i]!)
    const stmt = await ad().parse(file('uk.csv', tsv(hdr, [row])), 'tsv')
    expect(stmt.locale).toBe('uk')
    expect(stmt.headerWarning).toBeFalsy()
    const n = ad().normalize(stmt)[0]!
    expect(n.bookedDate).toBe('2025-02-01')
    expect(n.amountMinor).toBe(-2500)
    expect(n.merchant).toBe('Метро')
    expect(n.bankCategory).toBe('Transport')
  })

  it('unknown headers fall back to positional binding and flag a warning', async () => {
    const stmt = await ad().parse(
      file('x.csv', tsv(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'], [['03.01.2025 11:00:00', 'Other', CARD, 'Shop', -9.99, 'UAH', 9.99, 'UAH', 90, 'UAH']])),
      'tsv',
    )
    expect(stmt.headerWarning).toBe(true)
    expect(ad().normalize(stmt)[0]!.amountMinor).toBe(-999)
  })

  // The file lists newest first. Everything downstream — chain reconciliation, anchors, the
  // occurrence index, gap notes — reads chronologically, so the adapter reverses once.
  it('reverses to chronological order and renumbers sourceLine', async () => {
    const stmt = await ad().parse(
      file('order.csv', tsv(HDR_EN, [
        ['03.01.2025 12:00:00', 'Transport', CARD, 'Third', -30, 'UAH', 30, 'UAH', 40, 'UAH'],
        ['02.01.2025 12:00:00', 'Transport', CARD, 'Second', -20, 'UAH', 20, 'UAH', 70, 'UAH'],
        ['01.01.2025 12:00:00', 'Transport', CARD, 'First', -10, 'UAH', 10, 'UAH', 90, 'UAH'],
      ])),
      'tsv',
    )
    const n = ad().normalize(stmt)
    expect(n.map((r) => r.merchant)).toEqual(['First', 'Second', 'Third'])
    expect(n.map((r) => r.sourceLine)).toEqual([0, 1, 2])
    expect(stmt.periodFrom).toBe('2025-01-01')
    expect(stmt.periodTo).toBe('2025-01-03')
    // opening is implied from the row BEFORE the first one: 90 − (−10)
    expect(stmt.openingBalance).toBe(100)
    expect(stmt.closingBalance).toBe(40)
  })

  it('omits the foreign leg when the transaction is in the card currency', async () => {
    const n = ad().normalize(
      await ad().parse(file('same.csv', tsv(HDR_EN, [['01.01.2025 09:00:00', 'Other', CARD, 'ATB', -200, 'UAH', 200, 'UAH', 800, 'UAH']])), 'tsv'),
    )
    expect(n[0]!.original).toBeUndefined()
  })

  it('the Category column names transfers; everything else is signed', async () => {
    const n = ad().normalize(
      await ad().parse(
        file('kinds.csv', tsv(HDR_EN, [
          ['05.01.2025 10:00:00', 'Other', CARD, 'PAYBACK, SIXT', 500, 'UAH', 500, 'UAH', 1500, 'UAH'],
          ['04.01.2025 10:00:00', 'Transfer to my card', CARD, 'To my card *0741', -700, 'UAH', 700, 'UAH', 1000, 'UAH'],
          ['03.01.2025 10:00:00', 'Transfer crediting', CARD, 'from PETRENKO IVAN', 2000, 'UAH', 2000, 'UAH', 1700, 'UAH'],
          ['02.01.2025 10:00:00', 'Supermarkets and groceries', CARD, 'Silpo', -300, 'UAH', 300, 'UAH', -300, 'UAH'],
        ])),
        'tsv',
      ),
    )
    expect(n.map((r) => r.kind)).toEqual(['expense', 'transfer-in', 'transfer-out', 'refund'])
    expect(n[1]!.counterparty).toBe('PETRENKO IVAN')
    expect(n[2]!.counterparty).toBe('*0741')
    expect(n[0]!.counterparty).toBeUndefined()
  })

  it('maps its own categories onto Ledger names, and abstains where there is no honest home', async () => {
    const n = ad().normalize(
      await ad().parse(
        file('cats.csv', tsv(HDR_EN, [
          ['06.01.2025 10:00:00', 'Foundations and organizations', CARD, 'WFP.CHARITY', -200, 'UAH', 200, 'UAH', 100, 'UAH'],
          ['05.01.2025 10:00:00', 'Services', CARD, 'FRIENDS FOR PET', -50, 'UAH', 50, 'UAH', 300, 'UAH'],
          ['04.01.2025 10:00:00', 'Other', CARD, 'Something', -10, 'UAH', 10, 'UAH', 350, 'UAH'],
          ['03.01.2025 10:00:00', 'Air tickets', CARD, 'Ryanair', -100, 'UAH', 100, 'UAH', 360, 'UAH'],
          ['02.01.2025 10:00:00', 'Restaurants, cafes, bars', CARD, 'Gianni', -40, 'UAH', 40, 'UAH', 460, 'UAH'],
          ['01.01.2025 10:00:00', 'Supermarkets and groceries', CARD, 'Silpo', -60, 'UAH', 60, 'UAH', 500, 'UAH'],
        ])),
        'tsv',
      ),
    )
    expect(n.map((r) => r.bankCategory)).toEqual(['Groceries', 'Dining out', 'Travel', undefined, undefined, undefined])
  })

  it('one export, two cards — one statement each, keyed on card + currency', async () => {
    const two = tsv(HDR_EN, [
      ['23.08.2025 21:50:03', 'Foundations and organizations', '5169 **** **** 0741', 'WFP.CHARITY', -200, 'UAH', 200, 'UAH', 2510.31, 'UAH'],
      ['03.08.2025 00:52:50', 'Digital goods', CARD, 'JetBrains', -2974.79, 'UAH', 70.8, 'USD', 9166.93, 'UAH'],
      ['23.07.2025 21:40:03', 'Foundations and organizations', '5169 **** **** 0741', 'WFP.CHARITY', -200, 'UAH', 200, 'UAH', 2710.31, 'UAH'],
    ])
    const stmts = await ad().parseAll!(file('two.csv', two), 'tsv')
    expect(stmts.map((s) => s.fingerprint)).toEqual(['privat:5169-0741:uah', 'privat:4149-5583:uah'])
    expect(stmts.map((s) => s.rows.length)).toEqual([2, 1])
    expect(stmts[0]!).toMatchObject({ accountMask: '0741', productName: '····0741', accountCurrency: 'UAH' })
    // parse() stays the single-statement entry point: the card the file opens with
    expect((await ad().parse(file('two.csv', two), 'tsv')).fingerprint).toBe('privat:5169-0741:uah')
  })

  it('plans the two cards as two accounts with distinct names', async () => {
    const f = file('two.csv', tsv(HDR_EN, [
      ['04.01.2025 10:00:00', 'Transport', CARD, 'Metro', -25, 'UAH', 25, 'UAH', 975, 'UAH'],
      ['03.01.2025 10:00:00', 'Transport', '5169 **** **** 0741', 'Bus', -8, 'UAH', 8, 'UAH', 492, 'UAH'],
    ]))
    const plan = await buildImportPlan(f, emptyVault())
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.groups).toEqual([
      { key: 'privat:4149-5583:uah', label: '····5583 · UAH', rows: 1 },
      { key: 'privat:5169-0741:uah', label: '····0741 · UAH', rows: 1 },
    ])
    expect(plan.account.suggestedName).toBe('Privat UAH ····5583')

    const other = await buildImportPlan(f, emptyVault(), { group: 'privat:5169-0741:uah' })
    expect(isRefusal(other)).toBe(false)
    if (isRefusal(other)) return
    expect(other.account.suggestedName).toBe('Privat UAH ····0741')
  })
})

describe('privat — the bank-category rung (§10.1)', () => {
  const plan1 = async (category: string, vault = emptyVault()) => {
    const p = await buildImportPlan(
      file('one.csv', tsv(HDR_EN, [['02.01.2025 10:00:00', category, CARD, 'Silpo', -60, 'UAH', 60, 'UAH', 940, 'UAH']])),
      vault,
    )
    if (isRefusal(p)) throw new Error(p.message)
    return p.rows[0]!
  }

  it('a category the vault has is applied without review', async () => {
    const row = await plan1('Supermarkets and groceries')
    const v = emptyVault()
    expect(row.provenance).toBe('bank')
    expect(row.needsReview).toBe(false)
    expect(row.categoryId).toBe(v.categories.find((c) => c.name === 'Groceries')!.id)
  })

  it('a category the vault does NOT have falls through — it is never minted', async () => {
    const vault = emptyVault()
    vault.categories = vault.categories.filter((c) => c.name !== 'Groceries')
    const row = await plan1('Supermarkets and groceries', vault)
    expect(row.provenance).toBe('fallback')
    expect(row.needsReview).toBe(true)
  })

  it('an unmapped Privat label falls through', async () => {
    expect((await plan1('Foundations and organizations')).provenance).toBe('fallback')
  })

  it('a user rule still beats the bank category', async () => {
    const vault = emptyVault()
    const travel = vault.categories.find((c) => c.name === 'Travel')!
    vault.rules = [{ id: uuidv7(), updatedAt: now(), categoryId: travel.id, priority: 100, source: 'user', enabled: true, match: { field: 'merchant', op: 'prefix', value: 'SILPO' } }]
    const row = await plan1('Supermarkets and groceries', vault)
    expect(row.provenance.startsWith('rule:')).toBe(true)
    expect(row.categoryId).toBe(travel.id)
  })
})

const d = have(REAL.privatCsv, REAL.privatXlsx) ? describe : describe.skip

d('privat adapter — real files', () => {
  it('the tab-delimited "csv" splits into two cards, 11 and 3 rows', async () => {
    const stmts = await ad().parseAll!(loadFile(REAL.privatCsv), 'tsv')
    expect(stmts.map((s) => s.fingerprint)).toEqual(['privat:4149-5583:uah', 'privat:5169-0741:uah'])
    expect(stmts.map((s) => s.rows.length)).toEqual([11, 3])
    expect(stmts.every((s) => s.skipped.unparsed.length === 0)).toBe(true)
  })

  it('every card of every file has a zero-deviation balance chain', async () => {
    for (const [p, variant] of [[REAL.privatCsv, 'tsv'], [REAL.privatXlsx, 'xlsx']] as const) {
      for (const stmt of await ad().parseAll!(loadFile(p), variant)) {
        let bal = Math.round(stmt.openingBalance! * 100)
        for (const r of ad().normalize(stmt)) {
          bal += r.amountMinor
          expect(bal).toBe(r.balanceAfterMinor)
        }
        expect(bal).toBe(Math.round(stmt.closingBalance! * 100))
      }
    }
  })

  it('the xlsx binds on row 1, under the merged period title', async () => {
    const stmt = await ad().parse(loadFile(REAL.privatXlsx), 'xlsx')
    expect(stmt.headerWarning).toBeFalsy()
    expect(stmt.rows.length).toBe(73)
    expect(stmt.accountCurrency).toBe('UAH')
    expect(stmt.periodFrom).toBe('2025-01-01')
    expect(stmt.periodTo).toBe('2025-06-29')
  })

  // The xlsx covers Jan–Jun and the csv Jun–Sep of the SAME card, and the June tail is listed in
  // both: 3 PAYBACK rows on 9 June (same date, same descriptor, DIFFERENT amounts), Amazon on the
  // 10th and two Prime Video rows. Ring-1 must recognize all six by hash and add only the rest —
  // and the card must bind by fingerprint alone, with no mapping prompt.
  it('the overlapping June tail dedupes across the two files', async () => {
    const first = await importFile(emptyVault(), loadFile(REAL.privatXlsx))
    const second = await buildImportPlan(loadFile(REAL.privatCsv), first.vault)
    expect(isRefusal(second)).toBe(false)
    if (isRefusal(second)) return
    expect(second.account.mode).toBe('existing')
    expect(second.counts.total).toBe(11)
    expect(second.counts.duplicates).toBe(6)
    expect(second.counts.suspected).toBe(0)
    expect(second.counts.toAdd).toBe(5)
    // and committing it leaves one copy of each June row, not two
    const { vault } = await importFile(first.vault, loadFile(REAL.privatCsv))
    expect(vault.transactions.filter((t) => t.date === '2025-06-09')).toHaveLength(3)
    expect(vault.transactions).toHaveLength(78)
  })

  it('re-dropping the same file refuses as already-imported', async () => {
    const { vault } = await importFile(emptyVault(), loadFile(REAL.privatXlsx))
    const again = await buildImportPlan(loadFile(REAL.privatXlsx), vault)
    expect(isRefusal(again)).toBe(true)
    if (isRefusal(again)) expect(again.refusal).toBe('already-imported')
  })
})
