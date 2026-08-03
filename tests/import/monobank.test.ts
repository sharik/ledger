import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { adapterById, detectFile } from '../../src/import/registry'
import { buildImportPlan } from '../../src/import/pipeline'
import { hashRows } from '../../src/import/identity'
import { toSourceFile } from '../../src/import/peek'
import { isRefusal, type SourceFile } from '../../src/import/types'
import { have, importFile, loadFile, REAL } from '../helpers/importing'

beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

const HDR_EN = [
  'Date and time', 'Description', 'MCC', 'Card currency amount, (UAH)', 'Operation amount',
  'Operation currency', 'Exchange rate', 'Commission(UAH)', 'Cashback amount(UAH)', 'Balance',
]
const HDR_UK = [
  'Дата і час операції', 'Опис операції', 'MCC', 'Сума в валюті картки (UAH)', 'Сума в валюті операції',
  'Валюта операції', 'Курс', 'Комісія (UAH)', 'Кешбек (UAH)', 'Залишок після операції',
]

/** Build a monobank export the way the real one is written: comma-delimited, strings quoted,
 *  numbers bare, NEWEST FIRST. */
const csv = (header: string[], rows: (string | number)[][]): string =>
  [header.map((c) => `"${c}"`).join(','), ...rows.map((r) => r.map((c) => (typeof c === 'number' ? String(c) : `"${c}"`)).join(','))].join('\n') + '\n'

const file = (name: string, text: string): SourceFile => toSourceFile(name, new TextEncoder().encode(text))

const ad = () => adapterById('monobank')!

describe('monobank adapter — synthetic', () => {
  it('binds English headers, reads the account currency out of the header, and reverses to chronological order', async () => {
    // Newest first, as the bank writes it.
    const stmt = await ad().parse(
      file('m.csv', csv(HDR_EN, [
        ['15.08.2025 11:38:25', 'Lifecell +380635785198', 4814, -20, -20, 'UAH', '—', '—', '—', 980],
        ['12.08.2025 09:40:09', 'From UAH account', 4829, 1000, 1000, 'UAH', '—', '—', '—', 1000],
      ])),
      'csv',
    )
    expect(stmt.locale).toBe('en')
    expect(stmt.headerWarning).toBeFalsy()
    expect(stmt.accountCurrency).toBe('UAH')
    // Reversed: sourceLine 0 is the OLDEST row, and the period runs forwards.
    expect(stmt.periodFrom).toBe('2025-08-12')
    expect(stmt.periodTo).toBe('2025-08-15')
    const n = ad().normalize(stmt)
    expect(n.map((r) => r.sourceLine)).toEqual([0, 1])
    expect(n.map((r) => r.bookedDate)).toEqual(['2025-08-12', '2025-08-15'])
    // Implied opening is the balance BEFORE the first row: 1000 − 1000.
    expect(stmt.openingBalance).toBe(0)
    expect(stmt.closingBalance).toBe(980)
  })

  it('binds Ukrainian headers through the dictionary, not by position', async () => {
    // Same columns, shuffled: only a real dictionary hit can survive this.
    const order = [1, 0, 3, 2, 9, 4, 5, 6, 7, 8]
    const hdr = order.map((i) => HDR_UK[i]!)
    const src = ['01.02.2025 10:00:00', 'Метро', 4111, -25, -25, 'UAH', '—', '—', '—', 975] as (string | number)[]
    const stmt = await ad().parse(file('uk.csv', csv(hdr, [order.map((i) => src[i]!)])), 'csv')
    expect(stmt.locale).toBe('uk')
    expect(stmt.headerWarning).toBeFalsy()
    expect(stmt.accountCurrency).toBe('UAH')
    const n = ad().normalize(stmt)[0]!
    expect(n.bookedDate).toBe('2025-02-01')
    expect(n.amountMinor).toBe(-2500)
    expect(n.merchant).toBe('Метро')
    expect(n.bankCategory).toBe('Transport')
  })

  it('the commission is already inside the card amount and is never subtracted twice', async () => {
    const stmt = await ad().parse(
      file('fee.csv', csv(HDR_EN, [
        ['12.08.2025 09:41:10', 'ФОП Грушко Лідія Василівна', 4829, -12261, -12261, 'UAH', '—', 61, '—', 28724.16],
        ['12.08.2025 09:40:09', 'From UAH account', 4829, 23925, 23925, 'UAH', '—', '—', '—', 40985.16],
      ])),
      'csv',
    )
    const n = ad().normalize(stmt)
    const fee = n[1]!
    expect(fee.amountMinor).toBe(-1226100)
    expect(fee.feeMinor).toBe(6100)
    // The chain proves it: the balance moves by the card amount alone.
    expect(n[0]!.balanceAfterMinor! + fee.amountMinor).toBe(fee.balanceAfterMinor)
  })

  it('carries a foreign leg with its printed sign and keeps the row in the card currency', async () => {
    const stmt = await ad().parse(
      file('fx.csv', csv(HDR_EN, [['05.06.2025 03:26:53', 'SEAZON', 5812, -2863.15, -59.9, 'EUR', 47.7988, '—', '—', 1646.52]])),
      'csv',
    )
    const n = ad().normalize(stmt)[0]!
    expect(n.amountMinor).toBe(-286315)
    expect(n.currency).toBe('UAH')
    expect(n.original).toEqual({ amount: -59.9, currency: 'EUR' })
    expect(n.bankCategory).toBe('Dining out')
  })

  it('treats the em dash, en dash and a bare hyphen as empty, never as a number', async () => {
    for (const marker of ['—', '–', '-', '']) {
      const stmt = await ad().parse(
        file('e.csv', csv(HDR_EN, [['01.03.2025 10:00:00', 'Shop', 5411, -10, -10, 'UAH', marker, marker, marker, 90]])),
        'csv',
      )
      const n = ad().normalize(stmt)[0]!
      expect(n.feeMinor).toBeUndefined()
      expect(Number.isNaN(n.amountMinor)).toBe(false)
      expect(n.amountMinor).toBe(-1000)
    }
  })

  it('reads a non-UAH account currency out of the header parentheses', async () => {
    const hdr = HDR_EN.map((h) => h.replace(/\(UAH\)/, '(EUR)'))
    const stmt = await ad().parse(
      file('eur.csv', csv(hdr, [['01.03.2025 10:00:00', 'Shop', 5411, -10, -10, 'EUR', '—', '—', '—', 90]])),
      'csv',
    )
    expect(stmt.accountCurrency).toBe('EUR')
    expect(ad().normalize(stmt)[0]!.original).toBeUndefined()
  })

  it('classifies kind from the MCC and the descriptor, with no Type column to read', async () => {
    const rows: (string | number)[][] = [
      ['09.03.2025 10:00:00', 'Олена Х.', 4829, -300, -300, 'UAH', '—', '—', '—', 100],
      ['08.03.2025 10:00:00', '5168 7****0537', 4829, -100, -100, 'UAH', '—', '—', '—', 400],
      ['07.03.2025 10:00:00', 'To UAH account', 4829, -50, -50, 'UAH', '—', '—', '—', 500],
      ['06.03.2025 10:00:00', 'From UAH account', 4829, 500, 500, 'UAH', '—', '—', '—', 550],
      ['05.03.2025 10:00:00', 'Cancel AUPA', 7512, 40, 40, 'UAH', '—', '—', '—', 50],
      ['04.03.2025 10:00:00', 'AUPA,Alsace,FR', 7512, -40, -40, 'UAH', '—', '—', '—', 10],
      ['03.03.2025 10:00:00', 'Some Credit', 5411, 50, 50, 'UAH', '—', '—', '—', 50],
    ]
    const stmt = await ad().parse(file('k.csv', csv(HDR_EN, rows)), 'csv')
    const n = ad().normalize(stmt)
    // Chronological order — the reverse of the rows above.
    expect(n.map((r) => r.kind)).toEqual(['other', 'expense', 'refund', 'transfer-in', 'transfer-out', 'transfer-out', 'transfer-out'])
    // `Cancel ` and the card-network geo tail both drop, so a reversal shares its charge's merchant…
    expect(n[1]!.merchant).toBe('AUPA')
    expect(n[2]!.merchant).toBe('AUPA')
    // …while the descriptor identity keeps them apart.
    expect(n[1]!.normDesc).not.toBe(n[2]!.normDesc)
    // Both directions of an own-account move name the same counterparty (#19).
    expect(n[3]!.counterparty).toBe('UAH account')
    expect(n[4]!.counterparty).toBe('UAH account')
    // A transfer's MCC is money movement, not a spending category.
    expect(n[6]!.bankCategory).toBeUndefined()
    // An unexplained credit is `other`, never a guessed refund.
    expect(n[0]!.kind).toBe('other')
  })

  it('falls back to positional binding on unknown headers and flags a warning', async () => {
    const stmt = await ad().parse(
      file('x.csv', csv(['C1', 'C2', 'MCC', 'C4 (UAH)', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'],
        [['03.01.2025 11:00:00', 'Shop', 5411, -9.99, -9.99, 'UAH', '—', '—', '—', 90]])),
      'csv',
    )
    expect(stmt.headerWarning).toBe(true)
    expect(ad().normalize(stmt)[0]!.amountMinor).toBe(-999)
  })

  it('refuses a layout it cannot bind rather than importing a plausible guess', async () => {
    // No MCC column, no currency parens, wrong width: a positional bind here would silently read
    // some other bank's columns as monobank's.
    await expect(
      ad().parse(file('bad.csv', csv(['A', 'B', 'C'], [['x', 'y', 'z']])), 'csv'),
    ).rejects.toThrow(/unrecognized column layout/)
  })

  it('accounts an unreadable row as unparsed instead of importing a NaN', async () => {
    const stmt = await ad().parse(
      file('u.csv', csv(HDR_EN, [
        ['not a date', 'Broken', 5411, -10, -10, 'UAH', '—', '—', '—', 90],
        ['01.03.2025 10:00:00', 'Shop', 5411, -10, -10, 'UAH', '—', '—', '—', 100],
      ])),
      'csv',
    )
    expect(stmt.rows.length).toBe(1)
    expect(stmt.skipped.unparsed).toEqual(['Broken'])
    expect(ad().normalize(stmt).every((r) => Number.isFinite(r.amountMinor))).toBe(true)
  })

  it('gives same-day identical rows distinct, reproducible identities', async () => {
    // The real file's 2025-09-05 quartet: two charges and two cancels, same day, same amount.
    // Nothing but the occurrence index tells them apart, and that is purely row order.
    const text = csv(HDR_EN, [
      ['05.09.2025 09:22:08', 'Cancel uz gov ua mobile payment', 4112, 4416.02, 4416.02, 'UAH', '—', '—', '—', 20168.98],
      ['05.09.2025 09:21:16', 'Cancel uz gov ua mobile payment', 4112, 4416.02, 4416.02, 'UAH', '—', '—', '—', 15752.96],
      ['05.09.2025 09:04:29', 'uz gov ua mobile payment', 4112, -4416.02, -4416.02, 'UAH', '—', '—', '—', 11336.94],
      ['05.09.2025 09:03:49', 'uz gov ua mobile payment', 4112, -4416.02, -4416.02, 'UAH', '—', '—', '—', 15752.96],
    ])
    const h1 = await hashRows(ad().normalize(await ad().parse(file('d.csv', text), 'csv')), 'local:monobank:uah')
    const h2 = await hashRows(ad().normalize(await ad().parse(file('d.csv', text), 'csv')), 'local:monobank:uah')
    expect(h1).toEqual(h2)
    expect(new Set(h1).size).toBe(4)
  })

  it('asks which account the file belongs to — it carries no account key at all', async () => {
    const plan = await buildImportPlan(
      file('m.csv', csv(HDR_EN, [['01.03.2025 10:00:00', 'Shop', 5411, -10, -10, 'UAH', '—', '—', '—', 90]])),
      emptyVault(),
    )
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.parsed.fingerprint).toBeNull()
    expect(plan.account.mustName).toBe(true)
    expect(plan.account.suggestedName).toBe('Monobank UAH')
    expect(plan.account.currency).toBe('UAH')
  })

  it('refuses a broken balance chain in the statement currency, not in euros', async () => {
    const plan = await buildImportPlan(
      file('broken.csv', csv(HDR_EN, [
        ['02.03.2025 10:00:00', 'Shop B', 5411, -10, -10, 'UAH', '—', '—', '—', 999],
        ['01.03.2025 10:00:00', 'Shop A', 5411, -10, -10, 'UAH', '—', '—', '—', 100],
      ])),
      emptyVault(),
    )
    expect(isRefusal(plan)).toBe(true)
    if (!isRefusal(plan)) return
    expect(plan.refusal).toBe('chain-break')
    expect(plan.message).toContain('₴')
    expect(plan.message).not.toContain('€')
  })
})

const d = have(REAL.mono) ? describe : describe.skip

d('monobank adapter — the real export', () => {
  it('detects, parses and reconciles', async () => {
    const f = loadFile(REAL.mono)
    const res = await detectFile(f)
    expect(res.best?.institution).toBe('monobank')
    expect(res.best?.variant).toBe('csv')
    expect(res.ambiguous).toBe(false)

    const stmt = await ad().parse(f, 'csv')
    expect(stmt.rows.length).toBe(23)
    expect(stmt.accountCurrency).toBe('UAH')
    expect(stmt.periodFrom).toBe('2025-06-02')
    expect(stmt.periodTo).toBe('2025-09-23')
    expect(stmt.openingBalance).toBe(5254.11)
    expect(stmt.closingBalance).toBe(10133.8)
    expect(stmt.headerWarning).toBeFalsy()
    expect(stmt.skipped.unparsed).toEqual([])

    const n = ad().normalize(stmt)
    const sum = n.reduce((t, r) => t + r.amountMinor, 0)
    expect(Math.round(stmt.openingBalance! * 100) + sum).toBe(Math.round(stmt.closingBalance! * 100))
    // Every row carries a balance, so the per-row chain must hold end to end (§5.6).
    for (let i = 1; i < n.length; i++) {
      expect(n[i - 1]!.balanceAfterMinor! + n[i]!.amountMinor).toBe(n[i]!.balanceAfterMinor!)
    }
  })

  it('imports into a named account and re-imports as a duplicate', async () => {
    const { vault, plan } = await importFile(emptyVault(), loadFile(REAL.mono), { accountId: 'new', name: 'Mono UAH' })
    expect(plan.counts.toAdd).toBe(23)
    expect(vault.transactions.length).toBe(23)
    expect(vault.accounts[0]!.currency).toBe('UAH')

    const again = await buildImportPlan(loadFile(REAL.mono), vault, { accountId: vault.accounts[0]!.id })
    expect(isRefusal(again) && again.refusal).toBe('already-imported')
  })
})
