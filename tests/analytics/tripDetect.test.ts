import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { detectTrips, detectHomeTrips, tripNameFor, type DetectTxn } from '../../src/analytics/tripDetect'
import { addDays, daysBetween } from '../../src/analytics/selections'
import { adapterById } from '../../src/import/registry'
import { haveReal, loadFile, REAL } from '../helpers/importing'

describe('detectTrips (synthetic)', () => {
  it('clusters a run of foreign-currency rows into one candidate, ignoring home spend', () => {
    const txns: DetectTxn[] = [
      { id: 'a', date: '2025-08-25', amount: -240, currency: 'ISK', merchant: 'GLACIERWORLD' },
      { id: 'b', date: '2025-08-28', amount: -10, currency: 'ISK', merchant: 'PARKA' },
      { id: 'c', date: '2025-09-01', amount: -22, currency: 'ISK', merchant: 'BONUS' },
      { id: 'd', date: '2025-09-05', amount: -147, currency: 'ISK', merchant: 'MESSINN' },
      { id: 'home', date: '2025-08-30', amount: -1462, merchant: 'RENT' }, // no foreign leg → ignored
    ]
    const cands = detectTrips(txns)
    expect(cands.length).toBe(1)
    expect(cands[0]!.name).toBe('Iceland')
    expect(cands[0]!.currency).toBe('ISK')
    expect(cands[0]!.dateFrom).toBe('2025-08-25')
    expect(cands[0]!.dateTo).toBe('2025-09-05')
    expect(cands[0]!.count).toBe(4)
    expect(cands[0]!.txnIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ignores one-off foreign purchases below the min cluster size', () => {
    const txns: DetectTxn[] = ['2025-03-02', '2025-04-02', '2025-05-02'].map((date, i) => ({
      id: 'u' + i, date, amount: -12, currency: 'USD', merchant: 'OPENAI',
    }))
    expect(detectTrips(txns)).toEqual([]) // monthly, gaps > 4 days → singleton clusters, all dropped
  })

  it('splits two separate trips when the date gap exceeds gapDays', () => {
    const txns: DetectTxn[] = [
      ...['2025-01-01', '2025-01-02', '2025-01-03'].map((date, i) => ({ id: 'a' + i, date, amount: -10, currency: 'JPY', merchant: 'M' })),
      ...['2025-06-01', '2025-06-02', '2025-06-03'].map((date, i) => ({ id: 'b' + i, date, amount: -10, currency: 'JPY', merchant: 'M' })),
    ]
    expect(detectTrips(txns).length).toBe(2)
  })

  it('splits two destinations within gapDays into one candidate per currency', () => {
    const txns: DetectTxn[] = [
      ...['2025-01-01', '2025-01-02', '2025-01-03'].map((date, i) => ({ id: 'j' + i, date, amount: -10, currency: 'JPY', merchant: 'M' })),
      // one day after the JPY run — same date cluster, different destination
      ...['2025-01-04', '2025-01-05', '2025-01-06'].map((date, i) => ({ id: 'c' + i, date, amount: -10, currency: 'CHF', merchant: 'M' })),
    ]
    const cands = detectTrips(txns)
    expect(cands.length).toBe(2)
    expect(cands.map((c) => c.name).sort()).toEqual(['Japan', 'Switzerland'])
    for (const c of cands) expect(c.count).toBe(3)
  })

  it('drops a stray foreign currency below minCount inside a trip window', () => {
    const txns: DetectTxn[] = [
      ...['2025-08-25', '2025-08-26', '2025-08-27', '2025-08-28'].map((date, i) => ({ id: 'i' + i, date, amount: -20, currency: 'ISK', merchant: 'M' })),
      { id: 'u', date: '2025-08-27', amount: -12, currency: 'USD', merchant: 'ONLINE' }, // one-off, same window
    ]
    const cands = detectTrips(txns)
    expect(cands.length).toBe(1)
    expect(cands[0]!.currency).toBe('ISK')
    expect(cands[0]!.count).toBe(4)
  })

  it('names unknown currencies as "<CUR> trip"', () => {
    expect(tripNameFor('ISK')).toBe('Iceland')
    expect(tripNameFor('XYZ')).toBe('XYZ trip')
  })

  // #16c: a two-row foreign run is normally below minCount, but a hotel/flight-sized charge
  // is a strong enough signal to keep it.
  it('keeps a 2-row foreign cluster when one charge is large (strong signal)', () => {
    const small: DetectTxn[] = [
      { id: 'a', date: '2025-07-01', amount: -18, currency: 'GBP', merchant: 'PUB' },
      { id: 'b', date: '2025-07-02', amount: -24, currency: 'GBP', merchant: 'CAFE' },
    ]
    expect(detectTrips(small)).toEqual([]) // 2 small rows → dropped

    const withHotel: DetectTxn[] = [
      { id: 'a', date: '2025-07-01', amount: -420, currency: 'GBP', merchant: 'HOTEL' },
      { id: 'b', date: '2025-07-02', amount: -24, currency: 'GBP', merchant: 'CAFE' },
    ]
    const cands = detectTrips(withHotel)
    expect(cands.length).toBe(1)
    expect(cands[0]!.currency).toBe('GBP')
    expect(cands[0]!.count).toBe(2)
  })
})

// #16a: same-currency-zone trips carry no foreign rows — only a spending-density signal.
describe('detectHomeTrips (spending density)', () => {
  it('surfaces a dense home-currency burst above the baseline', () => {
    const txns: DetectTxn[] = []
    // Baseline: one small home charge a week for months.
    for (let w = 0; w < 12; w++) txns.push({ id: `base${w}`, date: `2025-0${1 + Math.floor(w / 4)}-0${1 + (w % 4)}`, amount: -12, merchant: `Shop${w}` })
    // A week abroad in the Eurozone: many mid-size charges across days and merchants.
    const trip = ['2025-06-10', '2025-06-11', '2025-06-12', '2025-06-13', '2025-06-14']
    trip.forEach((date, i) => txns.push({ id: `t${i}`, date, amount: -140, merchant: `Place${i}` }))
    const cands = detectHomeTrips(txns, { home: 'EUR' })
    expect(cands.length).toBe(1)
    expect(cands[0]!.dateFrom).toBe('2025-06-10')
    expect(cands[0]!.count).toBe(5)
    expect(cands[0]!.currency).toBe('EUR')
    expect(cands[0]!.name).toContain('Jun 2025')
  })

  it('does not flag steady, ordinary home spending', () => {
    const txns: DetectTxn[] = []
    for (let d = 1; d <= 28; d++) txns.push({ id: `d${d}`, date: `2025-06-${String(d).padStart(2, '0')}`, amount: -30, merchant: `M${d % 5}` })
    expect(detectHomeTrips(txns, { home: 'EUR' })).toEqual([]) // uniform spend, no burst
  })

  it('ignores a single large charge (rent), not a trip', () => {
    const txns: DetectTxn[] = [
      { id: 'rent', date: '2025-06-01', amount: -1400, merchant: 'Landlord' },
      { id: 'a', date: '2025-06-02', amount: -8, merchant: 'Coffee' },
      { id: 'b', date: '2025-06-20', amount: -8, merchant: 'Coffee' },
    ]
    expect(detectHomeTrips(txns, { home: 'EUR' })).toEqual([]) // one big row, too few merchants/days
  })

  // The regression this pass was rewritten for. On the real vault a daily spender's ≤5-day-gap
  // chain never terminated, so "31 Oct 2022 – 17 Dec 2022 · 57 payments · €10,059" was offered as
  // a trip — one of 13 such candidates.
  const dailySpender = (fromDay: number, days: number, perDay: number, merchants: number, who = 'Usual'): DetectTxn[] => {
    const out: DetectTxn[] = []
    for (let d = 0; d < days; d++) {
      const date = addDays('2025-01-01', fromDay + d)
      for (let m = 0; m < merchants; m++) {
        out.push({ id: `${date}-${who}${m}`, date, amount: -perDay / merchants, merchant: `${who}${m}` })
      }
    }
    return out
  }

  it('never offers a 60-day run of ordinary daily spending as a trip', () => {
    const cands = detectHomeTrips(dailySpender(0, 60, 150, 5), { home: 'EUR' })
    expect(cands).toEqual([])
  })

  it('caps every candidate at maxDays, whatever the input', () => {
    // A long dense run: even if something qualifies, nothing may span longer than the cap.
    const txns = [...dailySpender(0, 60, 150, 5), ...dailySpender(20, 25, 900, 6, 'Away')]
    for (const c of detectHomeTrips(txns, { home: 'EUR' })) {
      expect(daysBetween(c.dateFrom, c.dateTo) + 1).toBeLessThanOrEqual(21)
    }
  })

  it('trims a burst to its own days rather than the chain it sits in', () => {
    // 60 days of ordinary spend with a 6-day burst at ~5× the usual rate in the middle of it.
    const txns = [...dailySpender(0, 60, 150, 5), ...dailySpender(30, 6, 600, 6, 'Away')]
    const cands = detectHomeTrips(txns, { home: 'EUR' })
    expect(cands.length).toBe(1)
    expect(cands[0]!.dateFrom).toBe(addDays('2025-01-01', 30))
    expect(cands[0]!.dateTo).toBe(addDays('2025-01-01', 35))
  })

  // The second regression, found on the same real ledger after the duration cap landed: monthly
  // fixed costs land together at the start of every month and clear any density bar, so the
  // detector offered one "trip" per month — 39 of them, all direct debits.
  it('does not read a month’s bills as a trip', () => {
    const bills = ['Landlord', 'Utilities', 'Insurance', 'Telecom', 'Gym', 'Broadband']
    const txns: DetectTxn[] = []
    for (let m = 0; m < 12; m++) {
      const mk = `2025-${String(m + 1).padStart(2, '0')}`
      // Every bill on the 1st–3rd, every month, at a rate far above ordinary daily spend.
      bills.forEach((b, i) => txns.push({ id: `${mk}-b${i}`, date: `${mk}-0${1 + (i % 3)}`, amount: -600, merchant: b }))
      // Ordinary daily spending across the rest of the month.
      for (let d = 6; d <= 27; d++) txns.push({ id: `${mk}-d${d}`, date: `${mk}-${String(d).padStart(2, '0')}`, amount: -20, merchant: `Shop${d % 4}` })
    }
    expect(detectHomeTrips(txns, { home: 'EUR' })).toEqual([])
  })

  it('still finds a real burst among unfamiliar payees, with bills present', () => {
    const txns: DetectTxn[] = []
    for (let m = 0; m < 12; m++) {
      const mk = `2025-${String(m + 1).padStart(2, '0')}`
      for (const [i, b] of ['Landlord', 'Utilities', 'Insurance', 'Telecom', 'Gym', 'Broadband'].entries()) {
        txns.push({ id: `${mk}-b${i}`, date: `${mk}-0${1 + (i % 3)}`, amount: -600, merchant: b })
      }
      for (let d = 6; d <= 27; d++) txns.push({ id: `${mk}-d${d}`, date: `${mk}-${String(d).padStart(2, '0')}`, amount: -20, merchant: `Shop${d % 4}` })
    }
    // A week away in the middle of August, on payees seen nowhere else.
    for (let d = 10; d <= 15; d++) {
      for (let k = 0; k < 3; k++) txns.push({ id: `trip-${d}-${k}`, date: `2025-08-${d}`, amount: -90, merchant: `Lisboa${d}${k}` })
    }
    const cands = detectHomeTrips(txns, { home: 'EUR' })
    expect(cands.length).toBe(1)
    expect(cands[0]!.dateFrom).toBe('2025-08-10')
    expect(cands[0]!.dateTo).toBe('2025-08-15')
  })

  it('labels its candidates as density, and detectTrips labels its own as foreign', () => {
    const txns = [...dailySpender(0, 60, 150, 5), ...dailySpender(30, 6, 600, 6, 'Away')]
    expect(detectHomeTrips(txns, { home: 'EUR' }).every((c) => c.kind === 'density')).toBe(true)
    const foreign: DetectTxn[] = ['2025-03-01', '2025-03-02', '2025-03-03'].map((date, i) => ({
      id: `f${i}`, date, amount: -50, currency: 'ISK', merchant: `Reykjavik${i}`,
    }))
    expect(detectTrips(foreign).every((c) => c.kind === 'foreign')).toBe(true)
  })
})

const dReal = haveReal() && fs.existsSync(REAL.bxls) ? describe : describe.skip
dReal('detectTrips (real BNP xls — Iceland)', () => {
  it('finds the Iceland trip in the pariba export', async () => {
    const ad = adapterById('bnp')!
    const norm = ad.normalize(await ad.parse(loadFile(REAL.bxls), 'xls'))
    const txns: DetectTxn[] = norm.map((r, i) => ({
      id: String(i), date: r.bookedDate, amount: r.amountMinor / 100, currency: r.original?.currency, merchant: r.merchant,
    }))
    const ice = detectTrips(txns).find((c) => c.currency === 'ISK')
    expect(ice).toBeTruthy()
    expect(ice!.name).toBe('Iceland')
    expect(ice!.count).toBeGreaterThanOrEqual(13)
    expect(ice!.dateFrom <= '2025-08-27').toBe(true)
    expect(ice!.dateTo >= '2025-09-11').toBe(true)
  })
})
