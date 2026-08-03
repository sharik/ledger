import { describe, it, expect } from 'vitest'
import {
  creditorIdOf,
  hashBasis,
  hashRows,
  normDesc,
  occurrenceIndexes,
  repairMojibake,
  repairText,
  unescapeOOXML,
} from '../../src/import/identity'
import type { NormalizedRow } from '../../src/import/types'
import { adapterById } from '../../src/import/registry'
import { haveReal, loadFile, REAL } from '../helpers/importing'

const d = haveReal() ? describe : describe.skip

function row(p: Partial<NormalizedRow>): NormalizedRow {
  return {
    bookedDate: '2026-02-10',
    amountMinor: -17,
    currency: 'EUR',
    merchant: 'Grab',
    normDesc: 'GRAB',
    kind: 'expense',
    sourceLine: 0,
    raw: 'Grab',
    ...p,
  }
}

describe('identity — normDesc & repair', () => {
  it('repairs mojibake and is idempotent (repair twice = once)', () => {
    const once = repairMojibake('Lobita CafÃ©')
    expect(once).toBe('Lobita Café')
    expect(repairMojibake(once)).toBe('Lobita Café')
  })

  it('unescapes _xHHHH_ then repairs the multi-byte sequence', () => {
    expect(unescapeOOXML('AB_x0043_D')).toBe('ABCD')
    expect(repairText('Ã_x008E_le-de-France MobilitÃ©s')).toBe('Île-de-France Mobilités')
  })

  it('normDesc: NFKC uppercase, whitespace collapse, ECH/DDMMYY stripped', () => {
    expect(normDesc('  Bouygues   Telecom  ECH/290526 ')).toBe('BOUYGUES TELECOM')
    // idempotent
    const n = normDesc('Café  Noir')
    expect(normDesc(n)).toBe(n)
  })

  it('creditorIdOf: the 13-char SEPA ICS after EMETTEUR/, or nothing', () => {
    expect(creditorIdOf('PRLV SEPA BOUYGUES EMETTEUR/FR35ZZZ418323 REF/9')).toBe('FR35ZZZ418323')
    expect(creditorIdOf('CB MONOPRIX PARIS')).toBeUndefined()
    // Too short to be an ICS — a partial match must not be mistaken for one.
    expect(creditorIdOf('EMETTEUR/FR35ZZZ41')).toBeUndefined()
  })

  it('hash basis: ref-based when a ref is present, else canonical composite', () => {
    const withRef = hashBasis(row({ ref: 'ABC123' }), 'bnp:x', 0)
    expect(withRef).toBe('r|bnp:x|ABC123|-17')
    const composite = hashBasis(row({}), 'bnp:x', 2)
    expect(composite).toBe('c|bnp:x|2026-02-10|-17|EUR|GRAB|2')
  })

  it('occurrence index numbers same-key rows 0,1,2… in source order', () => {
    const rows = [row({}), row({}), row({ amountMinor: -33 }), row({})]
    expect(occurrenceIndexes(rows)).toEqual([0, 1, 0, 2])
  })
})

d('identity — against the real files', () => {
  it('occurrence indexing over real same-second duplicate groups', async () => {
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.f1), 'xlsx'))
    // the Grab −0.17 group: at least two rows must share (date, amount, normDesc)
    const grab = norm.filter((r) => r.normDesc === 'GRAB' && r.amountMinor === -17)
    expect(grab.length).toBeGreaterThanOrEqual(2)
    const occ = occurrenceIndexes(norm)
    const hashes = await hashRows(norm, 'revolut:current:eur')
    expect(new Set(hashes).size).toBe(hashes.length) // all distinct despite identical rows
    void occ
  })

  it('hash is stable across two independent parses', async () => {
    const ad = adapterById('revolut')!
    const h1 = await hashRows(ad.normalize(await ad.parse(loadFile(REAL.f1), 'xlsx')), 'revolut:current:eur')
    const h2 = await hashRows(ad.normalize(await ad.parse(loadFile(REAL.f1), 'xlsx')), 'revolut:current:eur')
    expect(h1).toEqual(h2)
  })

  it('csv and xlsx of the same dataset produce identical hashes', async () => {
    const ad = adapterById('revolut')!
    const stmt = await ad.parse(loadFile(REAL.f1), 'xlsx')
    const rows = stmt.rows as unknown as {
      type: string; product: string; description: string; amount: number; fee: number; currency: string; state: string; balance?: number; completed: unknown
    }[]
    // reconstruct a CSV with the same completed-date parts (identity uses date-part only)
    const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
    const dateOf = (v: unknown) => (typeof v === 'number' ? new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10) : String(v).slice(0, 10))
    const header = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
    const lines = rows.map((r) => {
      const desc = r.description.includes(',') || r.description.includes('"') ? `"${r.description.replace(/"/g, '""')}"` : r.description
      return `${r.type},${r.product},,${dateOf(r.completed)} 00:00:00,${desc},${r.amount},${r.fee},${r.currency},${r.state},${r.balance ?? ''}`
    })
    const csv = [header, ...lines].join('\n')
    const csvFile = { name: 'f1.csv', bytes: new TextEncoder().encode(csv), container: 'csv' as const }
    const csvStmt = await ad.parse(csvFile, 'csv')
    const hx = await hashRows(ad.normalize(stmt), 'revolut:current:eur')
    const hc = await hashRows(ad.normalize(csvStmt), 'revolut:current:eur')
    expect(hc).toEqual(hx)
  })

  it('mid-day-cut prefix property: truncating the last day keeps indexes aligned', async () => {
    const ad = adapterById('revolut')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.f1), 'xlsx'))
    const lastDay = norm[norm.length - 1]!.bookedDate
    const truncated = norm.filter((r) => r.bookedDate < lastDay)
    const full = await hashRows(norm, 'revolut:current:eur')
    const pre = await hashRows(truncated, 'revolut:current:eur')
    // every truncated hash is a prefix-consistent member of the full set
    expect(pre.every((h) => full.includes(h))).toBe(true)
  })
})
