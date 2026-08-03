import { describe, it, expect, beforeEach } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { emptyVault } from '../../src/model/seed'
import { adapterById } from '../../src/import/registry'
import { buildImportPlan } from '../../src/import/pipeline'
import { isRefusal, type SourceFile } from '../../src/import/types'
import { haveReal, importFile, loadFile, REAL } from '../helpers/importing'

const d = haveReal() ? describe : describe.skip
beforeEach(() => setFixedNow('2026-07-12T14:32:00Z'))

const csvFile = (name: string, text: string): SourceFile => ({ name, bytes: new TextEncoder().encode(text), container: name.endsWith('.tsv') ? 'tsv' : 'csv' })

describe('revolut adapter — synthetic', () => {
  it('binds French (localized) headers via the dictionary', async () => {
    const csv =
      'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde\n' +
      'Card Payment,Current,2026-02-05 10:00:00,2026-02-05 12:00:00,Boulangerie,-3.50,0,EUR,COMPLETED,100.00\n'
    const ad = adapterById('revolut')!
    const stmt = await ad.parse(csvFile('fr.csv', csv), 'csv')
    expect(stmt.locale).toBe('fr')
    expect(stmt.headerWarning).toBeFalsy()
    const norm = ad.normalize(stmt)
    expect(norm[0]!.amountMinor).toBe(-350)
  })

  it('unknown headers fall back to positional binding and flag a warning', async () => {
    const csv =
      'Col1,Col2,Col3,Col4,Col5,Col6,Col7,Col8,Col9,Col10\n' +
      'Card Payment,Current,2026-02-05 10:00:00,2026-02-05 12:00:00,Shop,-9.99,0,EUR,COMPLETED,90.00\n'
    const ad = adapterById('revolut')!
    const stmt = await ad.parse(csvFile('x.csv', csv), 'csv')
    expect(stmt.headerWarning).toBe(true)
    expect(ad.normalize(stmt)[0]!.amountMinor).toBe(-999)
  })

  it('reads a thousands-separated amount instead of importing NaN', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Transfer,Current,2026-02-05,2026-02-05,Big move,"1,234.56",0,EUR,COMPLETED,"1,334.56"\n'
    const ad = adapterById('revolut')!
    const stmt = await ad.parse(csvFile('th.csv', csv), 'csv')
    expect(stmt.skipped.unparsed).toEqual([])
    expect(ad.normalize(stmt)[0]!.amountMinor).toBe(123456)
  })

  it('accounts an unreadable amount as unparsed, never as NaN', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Card Payment,Current,2026-02-05,2026-02-05,Broken,not-a-number,0,EUR,COMPLETED,90.00\n' +
      'Card Payment,Current,2026-02-06,2026-02-06,Shop,-9.99,0,EUR,COMPLETED,80.01\n'
    const ad = adapterById('revolut')!
    const stmt = await ad.parse(csvFile('nan.csv', csv), 'csv')
    expect(stmt.skipped.unparsed).toEqual(['Broken'])
    const norm = ad.normalize(stmt)
    expect(norm).toHaveLength(1)
    expect(norm[0]!.amountMinor).toBe(-999)
    expect(norm.every((r) => Number.isFinite(r.amountMinor))).toBe(true)
  })

  // The Revolut CSV arrives UTF-8-as-Latin-1 mojibaked (`CafÃ©`). merchant/normDesc were repaired
  // but `raw` kept the mojibake, so the detail panel showed `Milwaukee CafÃ©`. Both must be clean.
  it('repairs mojibake in raw as well as merchant', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Card Payment,Current,2026-02-05,2026-02-05,Milwaukee CafÃ©,-6.50,0,EUR,COMPLETED,93.50\n'
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(csvFile('moji.csv', csv), 'csv'))
    expect(norm[0]!.merchant).toContain('Café')
    expect(norm[0]!.raw).toBe('Milwaukee Café')
    expect(norm[0]!.raw).not.toContain('Ã')
  })

  // #19b: the real outgoing descriptor is `To NAME`, not `Transfer to NAME`, so the old strip was
  // a no-op and one person yielded two counterparty identities depending on direction.
  it('strips the outgoing prefix whether or not the export writes “Transfer”', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Topup,Current,2026-02-01,2026-02-01,Payment from Ivan Petrenko,3000.00,0,EUR,COMPLETED,3000.00\n' +
      'Transfer,Current,2026-02-02,2026-02-02,To Ivan Petrenko,-2000.00,0,EUR,COMPLETED,1000.00\n' +
      'Transfer,Current,2026-02-03,2026-02-03,Transfer to Ann,-100.00,0,EUR,COMPLETED,900.00\n' +
      'Topup,Current,2026-02-04,2026-02-04,From Bob,50.00,0,EUR,COMPLETED,950.00\n'
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(csvFile('cp.csv', csv), 'csv'))
    expect(norm.map((r) => r.counterparty)).toEqual(['Ivan Petrenko', 'Ivan Petrenko', 'Ann', 'Bob'])
    // …and one identity, two directions: the learned rule carries the sign instead.
    expect(norm[0]!.amountMinor).toBe(300000)
    expect(norm[1]!.amountMinor).toBe(-200000)
  })

  it('a broken balance chain refuses the whole file (chain-break) and names the row', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Card Payment,Current,2026-02-05,2026-02-05,A,-10.00,0,EUR,COMPLETED,90.00\n' +
      'Card Payment,Current,2026-02-06,2026-02-06,B,-10.00,0,EUR,COMPLETED,999.99\n' // wrong balance
    const plan = await buildImportPlan(csvFile('bad.csv', csv), emptyVault(), { accountId: 'new' })
    expect(isRefusal(plan)).toBe(true)
    if (!isRefusal(plan)) return
    expect(plan.refusal).toBe('chain-break')
    // §8a: the offending row, not just a bare delta
    expect(plan.message).toContain('row 2')
    expect(plan.message).toContain('6 Feb 2026')
    expect(plan.message).toContain('B')
    expect(plan.details).toMatchObject({ at: { line: 1, date: '2026-02-06', merchant: 'B' } })
  })
})

// A file with a per-row balance chain knows the balance on every day it covers. Anchoring only
// its two endpoints left every interior month snapshot-free, and the net-worth chart hatches an
// anchor-free interior month as "statements missing" — so a multi-year export read as a
// multi-year hole in an account whose history was in fact complete.
describe('revolut adapter — balance anchors off the chain', () => {
  const MULTIMONTH =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
    'Card Payment,Current,2025-01-05,2025-01-05,A,-10.00,0,EUR,COMPLETED,90.00\n' +
    'Card Payment,Current,2025-01-20,2025-01-20,B,-5.00,0,EUR,COMPLETED,85.00\n' +
    'Card Payment,Current,2025-02-14,2025-02-14,C,-15.00,0,EUR,COMPLETED,70.00\n' +
    'Card Payment,Current,2025-04-02,2025-04-02,D,-20.00,0,EUR,COMPLETED,50.00\n'

  it('anchors every covered month at its closing balance, not just the two endpoints', async () => {
    const { vault: v } = await importFile(emptyVault(), csvFile('multimonth.csv', MULTIMONTH))
    expect(v.snapshots.map((s) => `${s.date}|${s.amount}`)).toEqual([
      '2025-01-05|100', // implied opening, before row A
      '2025-01-20|85', // January closes on its last row…
      '2025-02-14|70', // …February on its own
      '2025-04-02|50', // and the last month's anchor IS the closing balance — not anchored twice
    ])
    // March has no rows, so it gets no anchor: the gap there is real, unlike the one this fixes.
    expect(v.snapshots.some((s) => s.date.startsWith('2025-03'))).toBe(false)
  })

  it('an implied opening loses its date to the chain anchor that covers it', async () => {
    // One row in the first month ⇒ the opening (before the row) and that month's anchor (after it)
    // would land on one date. Day-granular snapshots can't be ordered, so the chain figure wins.
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Card Payment,Current,2025-01-05,2025-01-05,A,-10.00,0,EUR,COMPLETED,90.00\n' +
      'Card Payment,Current,2025-02-14,2025-02-14,C,-15.00,0,EUR,COMPLETED,75.00\n'
    const { vault: v } = await importFile(emptyVault(), csvFile('oneperfirstmonth.csv', csv))
    expect(v.snapshots.map((s) => `${s.date}|${s.amount}`)).toEqual(['2025-01-05|90', '2025-02-14|75'])
  })

  it('anchors are recorded as statement-derived, not as hand-typed balances', async () => {
    const { vault: v } = await importFile(emptyVault(), csvFile('multimonth.csv', MULTIMONTH))
    const stmtId = v.statements[0]!.id
    expect(v.snapshots.every((s) => s.origin?.kind === 'anchor' && s.origin.statementId === stmtId)).toBe(true)
  })

  it('the implied opening is marked `open`, every chain anchor `close`', async () => {
    const { vault: v } = await importFile(emptyVault(), csvFile('multimonth.csv', MULTIMONTH))
    expect(v.snapshots.map((s) => `${s.date}|${s.origin?.kind === 'anchor' ? s.origin.at : '?'}`)).toEqual([
      '2025-01-05|open', // balance before row A
      '2025-01-20|close',
      '2025-02-14|close',
      '2025-04-02|close',
    ])
  })
})

// Issue 8 / §5.8: one export can carry several accounts. Each is its own ledger —
// its own balance chain, anchors and fingerprint — and gets its own plan.
describe('revolut adapter — multi-account exports', () => {
  // 2 EUR rows, then 2 USD rows: as one chain this breaks by exactly the stranded
  // EUR balance (90.90); per account both chains are exact.
  const MIXED =
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
    'Card Payment,Current,2025-01-03,2025-01-03,Coffee,-4.00,0,EUR,COMPLETED,96.00\n' +
    'Card Payment,Current,2025-06-30,2025-06-30,Books,-5.10,0,EUR,COMPLETED,90.90\n' +
    'Topup,Current,2025-01-06,2025-01-06,Payment from Ann,2972.33,0,USD,COMPLETED,2972.33\n' +
    'Card Payment,Current,2025-02-08,2025-02-08,Hotel,-2972.33,0,USD,COMPLETED,0.00\n'

  it('splits the file into one statement per product+currency, each with its own anchors', async () => {
    const ad = adapterById('revolut')!
    const stmts = await ad.parseAll!(csvFile('mixed.csv', MIXED), 'csv')
    expect(stmts.map((s) => s.fingerprint)).toEqual(['revolut:current:eur', 'revolut:current:usd'])
    expect(stmts.map((s) => s.rows.length)).toEqual([2, 2])
    expect(stmts[0]!).toMatchObject({ accountCurrency: 'EUR', openingBalance: 100, closingBalance: 90.9, periodFrom: '2025-01-03', periodTo: '2025-06-30' })
    expect(stmts[1]!).toMatchObject({ accountCurrency: 'USD', openingBalance: 0, closingBalance: 0, periodFrom: '2025-01-06', periodTo: '2025-02-08' })
    // parse() stays the single-statement entry point: the first account in the file
    expect((await ad.parse(csvFile('mixed.csv', MIXED), 'csv')).fingerprint).toBe('revolut:current:eur')
  })

  it('plans the currencies separately instead of refusing the file', async () => {
    const file = csvFile('mixed.csv', MIXED)
    const eur = await buildImportPlan(file, emptyVault())
    expect(isRefusal(eur)).toBe(false)
    if (isRefusal(eur)) return
    expect(eur.groups).toEqual([
      { key: 'revolut:current:eur', label: 'Current · EUR', rows: 2 },
      { key: 'revolut:current:usd', label: 'Current · USD', rows: 2 },
    ])
    expect(eur.groupKey).toBe('revolut:current:eur')
    expect(eur.counts.total).toBe(2)
    expect(eur.account.suggestedName).toBe('Revolut EUR')

    const usd = await buildImportPlan(file, emptyVault(), { group: 'revolut:current:usd' })
    expect(isRefusal(usd)).toBe(false)
    if (isRefusal(usd)) return
    expect(usd.account).toMatchObject({ currency: 'USD', fingerprint: 'revolut:current:usd', suggestedName: 'Revolut USD' })
    expect(usd.rows.map((r) => r.norm.merchant)).toEqual(['Ann', 'Hotel'])
  })

  it('committing one group does not make the next read as already-imported', async () => {
    const file = csvFile('mixed.csv', MIXED)
    const first = await importFile(emptyVault(), file)
    const second = await importFile(first.vault, file, { group: 'revolut:current:usd' })
    const v = second.vault

    expect(v.accounts.map((a) => a.name).sort()).toEqual(['Revolut EUR', 'Revolut USD'])
    const usdAccount = v.accounts.find((a) => a.fingerprint === 'revolut:current:usd')!
    expect(v.transactions.filter((t) => t.accountId === usdAccount.id).map((t) => t.amount)).toEqual([2972.33, -2972.33])
    expect(v.transactions.length).toBe(4)
    // both accounts anchored from their own chain — one anchor per month the group covers
    expect(v.snapshots.filter((s) => s.accountId === usdAccount.id).map((s) => s.amount)).toEqual([2972.33, 0])
    // and re-dropping the file now refuses on the group that IS already imported
    const again = await buildImportPlan(file, v)
    expect(isRefusal(again)).toBe(true)
    if (isRefusal(again)) expect(again.refusal).toBe('already-imported')
  })

  it('two products in one currency are two accounts with distinct names', async () => {
    const csv =
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
      'Card Payment,Current,2025-01-03,2025-01-03,Coffee,-4.00,0,EUR,COMPLETED,96.00\n' +
      'Transfer,Savings,2025-01-04,2025-01-04,Transfer to Savings,50.00,0,EUR,COMPLETED,50.00\n'
    const file = csvFile('products.csv', csv)
    const plan = await buildImportPlan(file, emptyVault())
    expect(isRefusal(plan)).toBe(false)
    if (isRefusal(plan)) return
    expect(plan.groups.map((g) => g.key)).toEqual(['revolut:current:eur', 'revolut:savings:eur'])
    const savings = await buildImportPlan(file, emptyVault(), { group: 'revolut:savings:eur' })
    expect(isRefusal(savings)).toBe(false)
    if (isRefusal(savings)) return
    expect(savings.account.suggestedName).toBe('Revolut Savings EUR')
  })
})

d('revolut adapter — real files', () => {
  it('state policy: COMPLETED imported, PENDING/REVERTED skipped and counted', async () => {
    const ad = adapterById('revolut')!
    const s1 = await ad.parse(loadFile(REAL.f1), 'xlsx')
    expect(s1.rows.length).toBe(330)
    expect(s1.skipped.reverted).toBe(6)
    const s2 = await ad.parse(loadFile(REAL.f2), 'xlsx')
    expect(s2.rows.length).toBe(195)
    expect(s2.skipped.pending).toBe(1)
    expect(s2.skipped.reverted).toBe(9)
  })

  it('fee arithmetic: POP MART gross −27.68 fee 0.28 → net −27.96', async () => {
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.f1), 'xlsx'))
    const pop = norm.find((r) => r.merchant === 'POP MART')
    expect(pop!.amountMinor).toBe(-2796)
    expect(pop!.feeMinor).toBe(28)
  })

  it('balance chain has zero deviation over every completed row (both files)', async () => {
    const ad = adapterById('revolut')!
    for (const [p, open] of [[REAL.f1, 1571.35], [REAL.f2, 703.55]] as const) {
      const stmt = await ad.parse(loadFile(p), 'xlsx')
      const norm = ad.normalize(stmt)
      let bal = Math.round(open * 100)
      for (const r of norm) {
        bal += r.amountMinor
        expect(bal).toBe(r.balanceAfterMinor)
      }
      expect(bal).toBe(Math.round(stmt.closingBalance! * 100))
    }
  })
})
