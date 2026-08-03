import { describe, expect, it } from 'vitest'
import { dayRange, elapsedDays, fmtDaySmart, fmtDayYear, pctDelta, ptsDelta, signedPct } from '../src/ui/format'

describe('pctDelta', () => {
  // The whole reason this function exists: DashboardScreen rendered "+0.0% · vs €0"
  // when the prior month had no spend — a claim of parity that was never computed.
  it('returns null when there is no baseline', () => {
    expect(pctDelta(4230, 0)).toBeNull()
    expect(pctDelta(0, 0)).toBeNull()
    expect(pctDelta(4230, -12)).toBeNull()
  })

  it('returns null rather than Infinity or NaN', () => {
    expect(pctDelta(Number.NaN, 100)).toBeNull()
    expect(pctDelta(100, Number.NaN)).toBeNull()
    expect(pctDelta(Number.POSITIVE_INFINITY, 100)).toBeNull()
  })

  it('signs and rounds the change', () => {
    expect(pctDelta(110, 100)).toMatchObject({ text: '+10.0%', dir: 'up' })
    expect(pctDelta(90, 100)).toMatchObject({ text: '−10.0%', dir: 'down' })
    expect(pctDelta(100, 100)).toMatchObject({ text: '+0.0%', dir: 'flat' })
  })

  it('honours the decimal precision', () => {
    expect(pctDelta(4230, 3850, 0)!.text).toBe('+10%')
    expect(pctDelta(4230, 3850, 1)!.text).toBe('+9.9%')
  })

  it('uses U+2212, matching fmt — never a hyphen', () => {
    expect(pctDelta(50, 100)!.text.startsWith('−')).toBe(true)
    expect(signedPct(-5).includes('-')).toBe(false)
  })
})

describe('ptsDelta', () => {
  // Points and percent are different units; mixing them is its own wrong answer.
  it('reports whole percentage points with a sign and a pt suffix', () => {
    expect(ptsDelta(24, 21)).toBe('+3 pt')
    expect(ptsDelta(18, 21)).toBe('−3 pt')
    expect(ptsDelta(21, 21)).toBe('+0 pt')
  })

  it('rounds each side before subtracting, matching what the screen displays', () => {
    // 21.4% and 20.6% both render as 21%, so the displayed difference is 0 pt.
    expect(ptsDelta(21.4, 20.6)).toBe('+0 pt')
  })
})

describe('dayRange', () => {
  // The point of the helper: "same point last month" is a phrase; "1–12 Jun" is a fact.
  it('collapses a within-month window to one month name', () => {
    expect(dayRange('2026-07-01', '2026-07-12')).toBe('1–12 Jul')
    expect(dayRange('2026-06-01', '2026-06-30')).toBe('1–30 Jun')
  })

  it('names both months when the window straddles one', () => {
    expect(dayRange('2026-06-28', '2026-07-03')).toBe('28 Jun – 3 Jul')
  })

  it('is day-first, matching fmtDay', () => {
    expect(dayRange('2026-01-05', '2026-01-05')).toBe('5–5 Jan')
  })
})

describe('elapsedDays', () => {
  it('states how far into the period the figure is — the pace projection rests on it', () => {
    expect(elapsedDays(12, 31)).toBe('day 12 of 31')
    expect(elapsedDays(31, 31)).toBe('day 31 of 31')
  })
})

// A year-less date is fine for the last few weeks and ambiguous for anything older: the
// recurring list printed "last 19 Aug" on a July screen for a charge eleven months back.
describe('fmtDaySmart / fmtDayYear', () => {
  it('omits the year inside the reference year and states it outside', () => {
    expect(fmtDaySmart('2026-07-03', '2026-07-30')).toBe('3 Jul')
    expect(fmtDaySmart('2025-08-19', '2026-07-30')).toBe('19 Aug 2025')
  })

  it('fmtDayYear always carries the year', () => {
    expect(fmtDayYear('2026-07-03')).toBe('3 Jul 2026')
  })
})
