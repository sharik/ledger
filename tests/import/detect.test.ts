import { describe, it, expect } from 'vitest'
import { sniffContainer, buildPeek, toSourceFile } from '../../src/import/peek'
import { detect, detectFile } from '../../src/import/registry'
import { have, haveReal, loadFile, REAL } from '../helpers/importing'
import type { Peek } from '../../src/import/types'
import fs from 'node:fs'

const REVOLUT_CSV =
  'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n' +
  'Card Payment,Current,2026-02-05 10:00:00,2026-02-05 12:00:00,Grab,-5.86,0,EUR,COMPLETED,1565.49\n'

const REVOLUT_TSV = REVOLUT_CSV.replace(/,/g, '\t')

const PRIVAT_TSV =
  '"Date"\t"Category"\t"Card"\t"Description"\t"Amount in card currency"\t"Card currency"\t"Amount in transaction currency"\t"Transaction currency"\t"Rest at the end of the period"\t"Rest currency"\n' +
  '"20.09.2025 05:39:17"\t"Digital goods"\t"4149 **** **** 5583"\t"Amazon"\t-342.65\t"UAH"\t6.99\t"EUR"\t2979.9\t"UAH"\n'

const MONO_CSV =
  '"Date and time","Description","MCC","Card currency amount, (UAH)","Operation amount","Operation currency","Exchange rate","Commission(UAH)","Cashback amount(UAH)","Balance"\n' +
  '"05.06.2025 03:26:53","SEAZON",5812,-2863.15,-59.9,"EUR",47.7988,"—","—",1646.52\n'

const MONO_CSV_UK =
  '"Дата і час операції","Опис операції","MCC","Сума в валюті картки (UAH)","Сума в валюті операції","Валюта операції","Курс","Комісія (UAH)","Кешбек (UAH)","Залишок після операції"\n' +
  '"05.06.2025 03:26:53","SEAZON",5812,-2863.15,-59.9,"EUR",47.7988,"—","—",1646.52\n'

describe('detection — container sniff', () => {
  it('sniffs pdf by %PDF and csv/tsv by delimiter mode', () => {
    expect(sniffContainer(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('pdf')
    expect(sniffContainer(new TextEncoder().encode(REVOLUT_CSV))).toBe('csv')
    expect(sniffContainer(new TextEncoder().encode(REVOLUT_TSV))).toBe('tsv')
  })

  it('sniffs xlsx by the PK zip magic', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    expect(sniffContainer(bytes)).toBe('xlsx')
  })

  it('sniffs legacy .xls by the OLE/CDFV2 magic', () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(sniffContainer(bytes)).toBe('xlsx')
  })

  it('a CSV header binds Revolut at ≥0.95, unambiguous', async () => {
    const file = toSourceFile('random-name.csv', new TextEncoder().encode(REVOLUT_CSV))
    const peek = await buildPeek(file)
    const res = detect(file, peek)
    expect(res.best?.institution).toBe('revolut')
    expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(res.ambiguous).toBe(false)
  })

  // Privat's export is TAB-delimited despite its `.csv` name, and its columns are disjoint from
  // both other adapters' — so the three must never compete for one file.
  it('a Privat header binds privat, and neither Revolut nor BNP offers a rival', async () => {
    const file = toSourceFile('privat24.csv', new TextEncoder().encode(PRIVAT_TSV))
    expect(file.container).toBe('tsv')
    const res = detect(file, await buildPeek(file))
    expect(res.best?.institution).toBe('privat')
    expect(res.best?.variant).toBe('tsv')
    expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(res.ambiguous).toBe(false)
    expect(res.candidates).toHaveLength(1)
  })

  // Monobank keys on two markers no other format carries and that survive localization: a literal
  // `MCC` column, and the account currency parenthesised in a header cell.
  it('a Monobank header binds monobank alone, in either language', async () => {
    for (const text of [MONO_CSV, MONO_CSV_UK]) {
      const file = toSourceFile('report.csv', new TextEncoder().encode(text))
      expect(file.container).toBe('csv')
      const res = detect(file, await buildPeek(file))
      expect(res.best?.institution).toBe('monobank')
      expect(res.best?.variant).toBe('csv')
      expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
      expect(res.ambiguous).toBe(false)
      expect(res.candidates).toHaveLength(1)
    }
  })

  it('a ten-column CSV without an MCC column is not monobank', async () => {
    const text = MONO_CSV.replace(/"MCC"/, '"Code"')
    const file = toSourceFile('report.csv', new TextEncoder().encode(text))
    expect(detect(file, await buildPeek(file)).candidates.map((c) => c.institution)).not.toContain('monobank')
  })

  it('a Revolut header still binds revolut, with no Privat rival', async () => {
    const file = toSourceFile('random-name.csv', new TextEncoder().encode(REVOLUT_CSV))
    const res = detect(file, await buildPeek(file))
    expect(res.candidates.map((c) => c.institution)).toEqual(['revolut'])
  })

  it('unrecognized content is ambiguous (no silent guess)', async () => {
    const file = toSourceFile('note.txt', new TextEncoder().encode('hello,world\nfoo,bar\n'))
    const peek = await buildPeek(file)
    const res = detect(file, peek)
    expect(res.ambiguous).toBe(true)
  })
})

// BNP prints the product on the page-1 header line and detection keys on it. A passbook must
// bind as surely as a compte chèques — keying on `RELEVE DE COMPTE` alone refused every
// `RELEVE DE LIVRET A` outright. Peek is built by hand: this is about the header string, not
// about pdf.js.
describe('detection — BNP statement header products', () => {
  const pdf = toSourceFile('statement.pdf', new TextEncoder().encode('%PDF-1.7\n'))
  const peek = (firstPageText: string): Peek => ({ container: 'pdf', firstPageText, fileName: 'statement.pdf' })
  const FOOT = '\nRIB : 99999 00001 00004242424 89\nBIC : BNPAFRPPXXX\nBNP PARIBAS SA au capital de 2 468 663 292'

  it('binds a Livret A passbook header', () => {
    const res = detect(pdf, peek(`RELEVE DE LIVRET A P. 1/1\ndu 13 avril 2023 au 13 juillet 2023${FOOT}`))
    expect(res.best?.institution).toBe('bnp')
    expect(res.best?.variant).toBe('pdf')
    expect(res.ambiguous).toBe(false)
  })

  it('still binds the current-account header', () => {
    const res = detect(pdf, peek(`RELEVE DE COMPTE P. 1/2${FOOT}`))
    expect(res.best?.institution).toBe('bnp')
    expect(res.ambiguous).toBe(false)
  })

  // The adapter names the account from the same table it detects on. A product it cannot name
  // must not bind at all, or it would import as a second, mis-named "current account".
  it('abstains on a BNP product it cannot name (no silent guess)', () => {
    const res = detect(pdf, peek(`RELEVE DE PLAN EPARGNE LOGEMENT P. 1/1${FOOT}`))
    expect(res.best).toBe(null)
    expect(res.ambiguous).toBe(true)
  })
})

// PUMB is the only other PDF format in the registry, so it is the one that could collide with
// BNP. It keys on two markers, not one: the letterhead alone also appears on account certificates
// and loan schedules, which carry no transaction table and must stay unrecognized rather than
// import as an empty account. Peek is built by hand — this is about the header string.
describe('detection — PUMB statement header', () => {
  const pdf = toSourceFile('statement.pdf', new TextEncoder().encode('%PDF-1.7\n'))
  const peek = (firstPageText: string): Peek => ({ container: 'pdf', firstPageText, fileName: 'statement.pdf' })
  const LETTERHEAD = 'АТ “ПУМБ” МФО 334851\nПерший Український Міжнародний банк\nПрацюємо для Вас\nwww.pumb.ua'
  const STATEMENT = `${LETTERHEAD}\nКлієнт\nЗа рахунком №\nЗа період\nУ валюті\nІнформація про рух коштів`

  it('binds a statement on letterhead + transaction table, unambiguous', () => {
    const res = detect(pdf, peek(STATEMENT))
    expect(res.best?.institution).toBe('pumb')
    expect(res.best?.variant).toBe('pdf')
    expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(res.best?.hints?.locale).toBe('uk')
    expect(res.ambiguous).toBe(false)
    expect(res.candidates).toHaveLength(1)
  })

  it('abstains on PUMB letterhead with no transaction table (no silent guess)', () => {
    const res = detect(pdf, peek(`${LETTERHEAD}\nДовідка про стан рахунку`))
    expect(res.best).toBe(null)
    expect(res.ambiguous).toBe(true)
  })

  it('the two PDF adapters never compete: neither offers a rival for the other’s header', () => {
    const bnp = 'RELEVE DE COMPTE P. 1/2\nRIB : 99999 00001 00004242424 89\nBIC : BNPAFRPPXXX\nBNP PARIBAS SA'
    expect(detect(pdf, peek(bnp)).candidates.map((c) => c.institution)).toEqual(['bnp'])
    expect(detect(pdf, peek(STATEMENT)).candidates.map((c) => c.institution)).toEqual(['pumb'])
  })
})

const d = haveReal() ? describe : describe.skip

d('detection — real files, extension ignored', () => {
  it('detects by content even when the extension lies', async () => {
    const bytes = new Uint8Array(fs.readFileSync(REAL.f1))
    const renamed = toSourceFile('statement.pdf', bytes) // wrong extension
    expect(renamed.container).toBe('xlsx') // sniffed from bytes, not name
    const res = await detectFile(renamed)
    expect(res.best?.institution).toBe('revolut')
  })

  it('BNP first-page markers detect bnp/pdf', async () => {
    const res = await detectFile(loadFile(REAL.b2026))
    expect(res.best?.institution).toBe('bnp')
    expect(res.best?.variant).toBe('pdf')
  })

  it('BNP mabanque .xls detects bnp/xls, unambiguous (Revolut abstains)', async () => {
    const file = loadFile(REAL.bxls)
    expect(file.container).toBe('xlsx') // sniffed from the OLE magic
    const res = await detectFile(file)
    expect(res.best?.institution).toBe('bnp')
    expect(res.best?.variant).toBe('xls')
    expect(res.best!.confidence).toBeGreaterThanOrEqual(0.95)
    expect(res.ambiguous).toBe(false)
  })
})

const p = have(REAL.privatCsv, REAL.privatXlsx) ? describe : describe.skip

p('detection — real Privat files', () => {
  // The xlsx opens with a merged period title, so the column header is on row 1 — detection has
  // to read `Peek.sheetRows`, not just `headerCells`.
  it('the xlsx binds under its merged title row, extension ignored', async () => {
    const renamed = toSourceFile('statement.pdf', new Uint8Array(fs.readFileSync(REAL.privatXlsx)))
    expect(renamed.container).toBe('xlsx') // sniffed from bytes, not name
    const res = await detectFile(renamed)
    expect(res.best?.institution).toBe('privat')
    expect(res.best?.variant).toBe('xlsx')
    expect(res.ambiguous).toBe(false)
  })

  it('the tab-delimited "csv" detects privat/tsv', async () => {
    const file = loadFile(REAL.privatCsv)
    expect(file.container).toBe('tsv') // delimiter mode, not the `.csv` extension
    const res = await detectFile(file)
    expect(res.best?.institution).toBe('privat')
    expect(res.best?.variant).toBe('tsv')
    expect(res.ambiguous).toBe(false)
  })
})
