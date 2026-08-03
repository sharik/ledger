import { describe, expect, it } from 'vitest'
import { computeFreshness, fmtDay } from '../src/ui/freshness'
import type { StatementRecord } from '../src/model/types'

const stmt = (accountId: string, periodTo: string): StatementRecord =>
  ({
    id: `s-${accountId}-${periodTo}`,
    updatedAt: '2026-07-12T00:00:00.000Z',
    accountId,
    institutionId: 'bnp',
    variant: 'csv',
    fileName: 'f.csv',
    fileHash: 'h',
    periodFrom: '2026-01-01',
    periodTo,
    rowsTotal: 1,
    rowsImported: 1,
    rowsSkipped: { duplicate: 0, pending: 0, reverted: 0, unparsed: 0 },
    importedAt: '2026-07-12T00:00:00.000Z',
  }) as StatementRecord

describe('fmtDay', () => {
  it('drops the leading zero and names the month', () => {
    expect(fmtDay('2026-07-02')).toBe('2 Jul')
    expect(fmtDay('2026-12-31')).toBe('31 Dec')
  })
})

describe('computeFreshness', () => {
  it('reports nothing imported rather than inventing a date', () => {
    const f = computeFreshness([])
    expect(f.through).toBeNull()
    expect(f.basis).toBe('none')
    expect(f.label).toBe('no imported data')
  })

  it('takes the latest period end for a single account', () => {
    const f = computeFreshness([stmt('a', '2026-05-31'), stmt('a', '2026-07-12')])
    expect(f.through).toBe('2026-07-12')
    expect(f.label).toBe('data through 12 Jul')
  })

  // The whole point: one account left un-imported makes the picture stale, and a caption that
  // reported the freshest account would be the lie this module exists to prevent.
  it('takes the MINIMUM across accounts, so the stalest account sets the caption', () => {
    const f = computeFreshness([
      stmt('a', '2026-07-12'),
      stmt('b', '2026-06-30'),
      stmt('b', '2026-05-31'),
    ])
    expect(f.through).toBe('2026-06-30')
    expect(f.label).toBe('data through 30 Jun')
  })

  it('ignores accounts with no statements — they cannot make the picture staler', () => {
    // Only account "a" has statements; "b" having none must not resolve to null/epoch.
    const f = computeFreshness([stmt('a', '2026-07-12')])
    expect(f.through).toBe('2026-07-12')
    expect(f.basis).toBe('statement')
  })

  it('never returns today — freshness is a statement fact or it is nothing', () => {
    // A vault whose newest statement is old still reports that old date, not now.
    const f = computeFreshness([stmt('a', '2025-01-31')])
    expect(f.through).toBe('2025-01-31')
    expect(f.label).toBe('data through 31 Jan')
  })
})
