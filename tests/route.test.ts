import { describe, expect, it } from 'vitest'
import { formatHash, paramToSelection, parseHash, queryToTxnFilter, selectionToParam, txnFilterToQuery } from '../src/ui/route'
import { granOf, periodLabelOf, readPeriodParam, stepPeriod, withGran } from '../src/ui/kit/PeriodStepper'

describe('parseHash / formatHash', () => {
  it('round-trips a bare tab', () => {
    expect(parseHash('#/trends')).toEqual({ tab: 'trends', query: {} })
    expect(formatHash({ tab: 'trends', query: {} })).toBe('#/trends')
  })

  it('round-trips a tab with a query', () => {
    const r = parseHash('#/txns?cat=cat-dining&from=2026-07-01&to=2026-07-31')
    expect(r.tab).toBe('txns')
    expect(r.query).toEqual({ cat: 'cat-dining', from: '2026-07-01', to: '2026-07-31' })
    expect(parseHash(formatHash(r))).toEqual(r)
  })

  it('percent-encodes merchant text', () => {
    const h = formatHash({ tab: 'txns', query: { merchant: 'Café & Co' } })
    expect(parseHash(h).query.merchant).toBe('Café & Co')
  })

  it('junk and empty hashes land on the dashboard', () => {
    expect(parseHash('').tab).toBe('dash')
    expect(parseHash('#').tab).toBe('dash')
    expect(parseHash('#/nope').tab).toBe('dash')
    expect(parseHash('#/nope?x=1')).toEqual({ tab: 'dash', query: { x: '1' } })
  })

  it('accepts the header-only import screen', () => {
    expect(parseHash('#/import').tab).toBe('import')
  })
})

describe('txn filter ⇄ query', () => {
  it('round-trips every field and drops empties', () => {
    const f = { cat: 'cat-x', from: '2026-01-01', to: '2026-01-31', merchant: 'UPS', q: 'refund', status: 'review', acct: 'a1', tracking: 'trk-1', flow: 'income' }
    expect(queryToTxnFilter(txnFilterToQuery(f))).toEqual(f)
    expect(txnFilterToQuery({ cat: '', merchant: undefined })).toEqual({})
  })

  it('carries a trip through the hash — membership cannot be expressed as a date range', () => {
    const h = formatHash({ tab: 'txns', query: txnFilterToQuery({ tracking: 'trk-japan' }) })
    expect(h).toBe('#/txns?tracking=trk-japan')
    expect(queryToTxnFilter(parseHash(h).query).tracking).toBe('trk-japan')
  })

  it('ignores unknown query keys', () => {
    expect(queryToTxnFilter({ cat: 'c1', bogus: 'x' })).toEqual({ cat: 'c1' })
  })
})

describe('Selection ⇄ compare seed param (ASSISTANT §5)', () => {
  it('round-trips every field the assistant can set', () => {
    const sel = {
      period: { from: '2026-01-01', to: '2026-03-31' },
      categoryIds: ['cat-dining'],
      accountIds: ['a1'],
      trackingIds: ['t1'],
      merchantQuery: 'Café & Co',
      includeNonCashflow: true,
    }
    expect(paramToSelection(selectionToParam(sel))).toEqual(sel)
  })

  it('survives the hash, which is how it actually travels', () => {
    const sel = { period: { rel: 'sameMonthLastYear' as const }, merchantQuery: 'a&b=c?d' }
    const h = formatHash({ tab: 'compare', query: { cmpA: selectionToParam(sel) } })
    expect(paramToSelection(parseHash(h).query.cmpA!)).toEqual(sel)
  })

  it('every PeriodRef arm is accepted, and a junk one is dropped', () => {
    for (const period of [{ rel: 'thisMonth' }, { month: '2026-05' }, { year: 2025 }, { from: '2026-01-01', to: '2026-01-31' }]) {
      expect(paramToSelection(JSON.stringify({ period }))).toEqual({ period })
    }
    expect(paramToSelection(JSON.stringify({ period: { rel: 'nextCentury' }, categoryIds: ['c'] }))).toEqual({ categoryIds: ['c'] })
    expect(paramToSelection(JSON.stringify({ period: { month: 'nope' }, categoryIds: ['c'] }))).toEqual({ categoryIds: ['c'] })
  })

  it('unknown keys are dropped — this arrives from a URL, not from us', () => {
    expect(paramToSelection('{"categoryIds":["c1"],"dropDatabase":true,"amountOver":500}')).toEqual({ categoryIds: ['c1'] })
  })

  it('junk, an array, or a selection with nothing usable in it is null, never a crash', () => {
    expect(paramToSelection('not json')).toBeNull()
    expect(paramToSelection('[1,2,3]')).toBeNull()
    expect(paramToSelection('{}')).toBeNull()
    expect(paramToSelection('{"categoryIds":[]}')).toBeNull()
  })

  it('carries no amounts — the hash policy holds for this param too', () => {
    const sel = { period: { month: '2026-05' }, categoryIds: ['cat-dining'] }
    expect(selectionToParam(sel)).not.toMatch(/\d{3,}\.\d/)
  })
})

// The Dashboard and Plan both carry their period in `?mk=`, and both must refuse a future one:
// a period that has not happened has no spend in it, and the hash is hand-editable.
describe('readPeriodParam — one param, two shapes, never the future', () => {
  const THIS_MONTH = '2026-07'

  it('reads a month and a bare year, and derives granularity from the shape', () => {
    expect(readPeriodParam('2026-06', THIS_MONTH)).toBe('2026-06')
    expect(granOf(readPeriodParam('2026-06', THIS_MONTH)!)).toBe('month')
    expect(readPeriodParam('2025', THIS_MONTH)).toBe('2025')
    expect(granOf(readPeriodParam('2025', THIS_MONTH)!)).toBe('year')
  })

  it('accepts the current month and the current year — the boundary is inclusive', () => {
    expect(readPeriodParam('2026-07', THIS_MONTH)).toBe('2026-07')
    expect(readPeriodParam('2026', THIS_MONTH)).toBe('2026')
  })

  it('refuses the future, in either shape', () => {
    expect(readPeriodParam('2026-08', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2027-01', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2027', THIS_MONTH)).toBeNull()
  })

  it('refuses junk and impossible months rather than producing one', () => {
    expect(readPeriodParam(undefined, THIS_MONTH)).toBeNull()
    expect(readPeriodParam('', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2026-13', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2026-00', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2026-6', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('nope', THIS_MONTH)).toBeNull()
    expect(readPeriodParam('2026-06-01', THIS_MONTH)).toBeNull()
  })

  it('stepping and granularity switching stay inside the value', () => {
    expect(stepPeriod('2026-01', -1)).toBe('2025-12')
    expect(stepPeriod('2026', -1)).toBe('2025')
    // A year drops to its last elapsed month: this month inside the current year, else December.
    expect(withGran('2026', 'month', THIS_MONTH)).toBe('2026-07')
    expect(withGran('2025', 'month', THIS_MONTH)).toBe('2025-12')
    expect(withGran('2025-03', 'year', THIS_MONTH)).toBe('2025')
  })

  it('labels a month with its year only when it is not the current one', () => {
    expect(periodLabelOf('2026-06', THIS_MONTH)).toBe('June')
    expect(periodLabelOf('2025-12', THIS_MONTH)).toBe('December 2025')
    expect(periodLabelOf('2025', THIS_MONTH)).toBe('2025')
  })
})
