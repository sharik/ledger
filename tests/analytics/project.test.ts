import { describe, expect, it } from 'vitest'
import { daysBetween } from '../../src/analytics/selections'
import { monthEndProjection, monthEndProjectionThrough, pace, yearElapsedFraction, yearEndProjection } from '../../src/analytics/project'

const TODAY = '2026-07-12'

describe('pace-based projection (BRIEF §8)', () => {
  it('extrapolates at the current rate', () => {
    expect(pace(120, 12, 31)).toBe(310)
    expect(pace(0, 12, 31)).toBe(0)
  })

  it('returns 0 when nothing has elapsed (sparse guard)', () => {
    expect(pace(0, 0, 31)).toBe(0)
    expect(pace(50, 0, 31)).toBe(0)
  })

  it('month-end projection uses days elapsed in the month', () => {
    expect(monthEndProjection(150, '2026-07', TODAY)).toBe((150 / 12) * 31)
  })

  it('a completed month is not projected', () => {
    expect(monthEndProjection(300, '2026-06', TODAY)).toBe(300)
  })

  // The Plan header printed "time elapsed 97%" beside "data through 23 Jul" and reconciled
  // neither: dividing 23 days of charges by 30 elapsed days understated every pace by ~30%.
  it('projects over the days the STATEMENTS cover, not the days of the month', () => {
    // 23 days of imports in a 31-day month, on the 30th.
    expect(monthEndProjectionThrough(4459, '2026-07', '2026-07-23')).toBeCloseTo((4459 / 23) * 31, 2)
    // What the calendar-based version claimed for the same figure, for contrast.
    expect(monthEndProjection(4459, '2026-07', '2026-07-30')).toBeCloseTo((4459 / 30) * 31, 2)
  })

  it('reduces exactly to the calendar version when the data reaches today', () => {
    expect(monthEndProjectionThrough(150, '2026-07', TODAY)).toBe(monthEndProjection(150, '2026-07', TODAY))
  })

  it('keeps the sparse-data floor: under 3 days covered is not extrapolated', () => {
    expect(monthEndProjectionThrough(980, '2026-07', '2026-07-02')).toBe(980)
  })

  it('does not project when the coverage lies outside the month shown', () => {
    // Coverage past the month ⇒ the month is complete. Before it ⇒ no data in it to extrapolate.
    expect(monthEndProjectionThrough(300, '2026-06', '2026-07-23')).toBe(300)
    expect(monthEndProjectionThrough(0, '2026-08', '2026-07-23')).toBe(0)
  })

  it('year-end projection extrapolates YTD to 365 days', () => {
    const elapsed = daysBetween('2026-01-01', TODAY) + 1
    expect(yearEndProjection(1000, 2026, TODAY)).toBe((1000 / elapsed) * 365)
  })

  it('a past year is not projected', () => {
    expect(yearEndProjection(5000, 2025, TODAY)).toBe(5000)
  })

  it('yearElapsedFraction: past year 1, future year 0, calendar bounds', () => {
    expect(yearElapsedFraction(2025, TODAY)).toBe(1)
    expect(yearElapsedFraction(2027, TODAY)).toBe(0)
    expect(yearElapsedFraction(2026, '2026-01-01')).toBe(1 / 365)
    expect(yearElapsedFraction(2026, '2026-12-31')).toBe(1)
  })

  it('yearElapsedFraction agrees with yearEndProjection about elapsed time', () => {
    // Same daysBetween + 1 convention ⇒ projection = ytd / fraction (past MIN_PACE_DAYS).
    expect(yearEndProjection(1000, 2026, TODAY)).toBeCloseTo(1000 / yearElapsedFraction(2026, TODAY), 8)
  })
})
