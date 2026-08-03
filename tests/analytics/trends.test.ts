import { describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { derive } from '../../src/model/selectors'
import {
  categoryMomentum,
  completeMonths,
  recurringDigest,
  savingsRateSeries,
  seasonality,
  trendHeadline,
  typicalMonth,
} from '../../src/analytics/trends'
import type { SubRow, Subscriptions } from '../../src/analytics/subscriptions'
import type { Vault } from '../../src/model/types'
import { acc, buildVault, catId, snap, txn } from '../helpers/build'

// Fixed before the first derive() — see the note in selectors.test.ts. Every call below
// still passes an explicit anchor; the frozen clock only pins derive()'s memo key.
setFixedNow('2026-07-09T12:00:00Z')

const ANCHOR = '2026-07'

/** One small cash-flow row per month so each month counts as complete. */
function fillMonths(v: Vault, months: string[], amount = -1): void {
  for (const mk of months) txn(v, `${mk}-15`, 'filler', 'Other', amount)
}

/** 'YYYY-MM' keys from `from` inclusive, `count` months forward. */
function monthRange(from: string, count: number): string[] {
  const y0 = Number(from.slice(0, 4))
  const m0 = Number(from.slice(5, 7)) - 1
  return Array.from({ length: count }, (_, i) => {
    const m = m0 + i
    return `${y0 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`
  })
}

describe('completeMonths', () => {
  it('excludes the anchor month itself', () => {
    const v = buildVault((v) => fillMonths(v, ['2026-05', '2026-06', '2026-07']))
    expect(completeMonths(derive(v), Infinity, ANCHOR)).toEqual(['2026-05', '2026-06'])
  })

  it('skips a gap month rather than counting it as €0', () => {
    const v = buildVault((v) => fillMonths(v, ['2026-01', '2026-03']))
    expect(completeMonths(derive(v), Infinity, ANCHOR)).toEqual(['2026-01', '2026-03'])
  })

  it('excludes a snapshot-only month — a balance entry is not cash flow', () => {
    const v = buildVault((v) => {
      fillMonths(v, ['2026-01', '2026-03'])
      const a = acc(v, { name: 'Checking' })
      snap(v, a.id, '2026-02-15', 1000)
    })
    const d = derive(v)
    expect(d.monthsTracked).toContain('2026-02')
    expect(completeMonths(d, Infinity, ANCHOR)).toEqual(['2026-01', '2026-03'])
  })

  it('respects the limit, keeping the most recent months', () => {
    const v = buildVault((v) => fillMonths(v, monthRange('2026-01', 6)))
    expect(completeMonths(derive(v), 2, ANCHOR)).toEqual(['2026-05', '2026-06'])
  })
})

describe('trendHeadline', () => {
  it('basis empty with no complete months', () => {
    const v = buildVault((v) => fillMonths(v, ['2026-07'])) // anchor month only
    const h = trendHeadline(derive(v), ANCHOR)
    expect(h.spend.basis).toBe('empty')
    expect(h.spend.deltaPct).toBeNull()
  })

  it('basis thin below 3 recent + 2 baseline months, and states no deltaPct', () => {
    const v = buildVault((v) => fillMonths(v, monthRange('2026-03', 4))) // 4 complete months
    const h = trendHeadline(derive(v), ANCHOR)
    expect(h.spend.basis).toBe('thin')
    expect(h.spend.deltaPct).toBeNull()
  })

  it('compares the last 3 complete months against the up-to-6 before', () => {
    const v = buildVault((v) => {
      // baseline Oct 2025..Mar 2026 at €100/mo, recent Apr..Jun 2026 at €150/mo
      for (const mk of monthRange('2025-10', 6)) txn(v, `${mk}-10`, 'Shop', 'Groceries', -100)
      for (const mk of monthRange('2026-04', 3)) txn(v, `${mk}-10`, 'Shop', 'Groceries', -150)
      for (const mk of monthRange('2025-10', 9)) txn(v, `${mk}-01`, 'Pay', 'Income', 2000)
    })
    const h = trendHeadline(derive(v), ANCHOR)
    expect(h.spend.basis).toBe('ok')
    expect(h.spend.recentAvg).toBe(150)
    expect(h.spend.baselineAvg).toBe(100)
    expect(h.spend.deltaPct).toBeCloseTo(50, 5)
    expect(h.income.deltaPct).toBeCloseTo(0, 5)
  })

  it('deltaPct is null when the baseline is zero', () => {
    const v = buildVault((v) => {
      fillMonths(v, monthRange('2025-10', 9)) // complete months with no income at all
      for (const mk of monthRange('2026-04', 3)) txn(v, `${mk}-01`, 'Pay', 'Income', 2000)
    })
    const h = trendHeadline(derive(v), ANCHOR)
    expect(h.income.basis).toBe('ok')
    expect(h.income.baselineAvg).toBe(0)
    expect(h.income.deltaPct).toBeNull()
  })
})

describe('categoryMomentum', () => {
  /** Baseline Jan..Mar at `base`/mo and recent Apr..Jun at `recent`/mo, in `cat`. */
  function withPattern(cat: string, base: number, recent: number) {
    return buildVault((v) => {
      fillMonths(v, monthRange('2026-01', 6))
      for (const mk of monthRange('2026-01', 3)) if (base) txn(v, `${mk}-10`, 'M', cat, -base)
      for (const mk of monthRange('2026-04', 3)) if (recent) txn(v, `${mk}-10`, 'M', cat, -recent)
    })
  }

  it('flags a riser that clears both the relative and absolute gates', () => {
    const v = withPattern('Groceries', 200, 300) // +50%, +€100/mo
    const r = categoryMomentum(derive(v), ANCHOR)
    expect(r.basis).toBe('ok')
    expect(r.risers.map((m) => m.categoryId)).toEqual([catId(v, 'Groceries')])
    const m = r.risers[0]!
    expect(m.recentAvg).toBe(300)
    expect(m.baselineAvg).toBe(200)
    expect(m.deltaAbs).toBe(100)
    expect(m.deltaPct).toBeCloseTo(50, 5)
  })

  it('rejects +30% that is under €25/mo (absolute gate)', () => {
    const r = categoryMomentum(derive(withPattern('Groceries', 30, 39)), ANCHOR)
    expect(r.risers).toEqual([])
  })

  it('rejects +€100/mo that is under 20% (relative gate)', () => {
    const r = categoryMomentum(derive(withPattern('Groceries', 1000, 1100)), ANCHOR)
    expect(r.risers).toEqual([])
  })

  it('a category with no baseline at all is a riser rendered "new" (null deltaPct)', () => {
    const v = withPattern('Entertainment', 0, 45)
    const r = categoryMomentum(derive(v), ANCHOR)
    expect(r.risers.map((m) => m.categoryId)).toEqual([catId(v, 'Entertainment')])
    expect(r.risers[0]!.deltaPct).toBeNull()
  })

  it('flags a faller with mirrored thresholds', () => {
    const v = withPattern('Dining out', 300, 200)
    const r = categoryMomentum(derive(v), ANCHOR)
    expect(r.fallers.map((m) => m.categoryId)).toEqual([catId(v, 'Dining out')])
    expect(r.fallers[0]!.deltaAbs).toBe(-100)
  })

  it('a refund-floored month counts as €0, not negative', () => {
    const v = buildVault((v) => {
      fillMonths(v, monthRange('2026-01', 6))
      for (const mk of monthRange('2026-01', 3)) txn(v, `${mk}-10`, 'M', 'Health', -100)
      // recent: two normal months + one where the refund exceeds the spend
      txn(v, '2026-04-10', 'M', 'Health', -100)
      txn(v, '2026-05-10', 'M', 'Health', -100)
      txn(v, '2026-06-10', 'Doctor', 'Health', -50)
      txn(v, '2026-06-20', 'CPAM', 'Health', 80) // floored to 0, never −30
    })
    const r = categoryMomentum(derive(v), ANCHOR)
    // recent mean = (100 + 100 + 0) / 3 ≈ 66.7 → a faller vs the €100 baseline;
    // were the floor missing, (100 + 100 − 30) / 3 = 56.7 would show here instead
    const health = r.fallers.find((m) => m.categoryId === catId(v, 'Health'))!
    expect(health.recentAvg).toBeCloseTo(200 / 3, 5)
  })

  it('a record high needs at least 6 months of category history and a strict max', () => {
    const five = buildVault((v) => {
      fillMonths(v, monthRange('2026-01', 6))
      for (const [i, mk] of monthRange('2026-02', 5).entries()) txn(v, `${mk}-10`, 'M', 'Transport', -(50 + i * 10))
    })
    expect(categoryMomentum(derive(five), ANCHOR).records).toEqual([])

    const six = buildVault((v) => {
      fillMonths(v, monthRange('2026-01', 6))
      for (const [i, mk] of monthRange('2026-01', 6).entries()) txn(v, `${mk}-10`, 'M', 'Transport', -(50 + i * 10))
    })
    const r = categoryMomentum(derive(six), ANCHOR)
    expect(r.records.map((m) => m.categoryId)).toEqual([catId(six, 'Transport')])
    expect(r.records[0]!.recordMonth).toBe('2026-06')

    // a tie is not a record — the max must be strict
    const tied = buildVault((v) => {
      fillMonths(v, monthRange('2026-01', 6))
      for (const mk of monthRange('2026-01', 6)) txn(v, `${mk}-10`, 'M', 'Transport', -100)
    })
    expect(categoryMomentum(derive(tied), ANCHOR).records).toEqual([])
  })

  it('never surfaces breakdown-excluded categories (Housing by default)', () => {
    const v = withPattern('Housing', 200, 400)
    const r = categoryMomentum(derive(v), ANCHOR)
    expect([...r.risers, ...r.fallers, ...r.records]).toEqual([])
  })

  it('series is 0-filled per complete month and capped at 12', () => {
    const v = buildVault((v) => {
      fillMonths(v, monthRange('2025-05', 14)) // 14 complete months
      for (const mk of monthRange('2026-04', 3)) txn(v, `${mk}-10`, 'M', 'Shopping', -80)
    })
    const r = categoryMomentum(derive(v), ANCHOR)
    const m = r.risers.find((x) => x.categoryId === catId(v, 'Shopping'))!
    expect(m.series).toHaveLength(12)
    expect(m.seriesMonths[0]).toBe('2025-07')
    expect(m.series.slice(0, 9)).toEqual(Array(9).fill(0))
    expect(m.series.slice(9)).toEqual([80, 80, 80])
  })
})

describe('seasonality', () => {
  function seasonalVault(fromMonth: string, count: number): Vault {
    return buildVault((v) => {
      for (const mk of monthRange(fromMonth, count)) {
        const dec = mk.endsWith('-12')
        txn(v, `${mk}-10`, 'Shop', 'Groceries', dec ? -900 : -300)
      }
    })
  }

  it('is null at 18 complete months — some calendar month has one observation', () => {
    expect(seasonality(derive(seasonalVault('2025-01', 19)), ANCHOR)).toBeNull()
  })

  it('names the peak month and its per-year consistency at 24 complete months', () => {
    // Jul 2024 .. Jun 2026: every calendar month observed twice; 2025 is the only full year
    const s = seasonality(derive(seasonalVault('2024-07', 24)), ANCHOR)!
    expect(s).not.toBeNull()
    expect(s.peak.m).toBe(12)
    expect(s.peak.avg).toBe(900)
    expect(s.peak.years).toBe(1)
    expect(s.peak.topYears).toBe(1)
    expect(s.byCalMonth.find((b) => b.m === 1)!.n).toBe(2)
  })

  it('never counts the partial anchor month', () => {
    // 24 months ending at the anchor itself: Jun 2026 falls out, June drops to 1 observation
    expect(seasonality(derive(seasonalVault('2024-08', 24)), '2026-06')).toBeNull()
  })
})

describe('typicalMonth', () => {
  it('median is unmoved by one huge month — the spread tells that story', () => {
    const v = buildVault((v) => {
      for (const mk of monthRange('2025-07', 11)) txn(v, `${mk}-10`, 'Shop', 'Groceries', -1000)
      txn(v, '2026-06-10', 'Trip', 'Travel', -5000)
    })
    const t = typicalMonth(derive(v), ANCHOR)
    expect(t.basis).toBe('ok')
    expect(t.monthsCounted).toBe(12)
    expect(t.spendMedian).toBe(1000)
    expect(t.spendSpread).toBeGreaterThanOrEqual(0)
  })

  it('basis is thin below 3 complete months', () => {
    const v = buildVault((v) => fillMonths(v, ['2026-05', '2026-06']))
    expect(typicalMonth(derive(v), ANCHOR).basis).toBe('thin')
  })
})

describe('savingsRateSeries', () => {
  it('nulls for the anchor month, no-income months and gap months; % otherwise', () => {
    const v = buildVault((v) => {
      txn(v, '2026-04-01', 'Pay', 'Income', 2000)
      txn(v, '2026-04-10', 'Shop', 'Groceries', -500)
      // 2026-05: expenses but no income — a 0% rate would be a lie
      txn(v, '2026-05-10', 'Shop', 'Groceries', -300)
      // 2026-06: nothing at all (gap)
      txn(v, '2026-07-01', 'Pay', 'Income', 2000) // anchor month — partial
    })
    const d = derive(v)
    expect(savingsRateSeries(d, ['2026-04', '2026-05', '2026-06', '2026-07'], ANCHOR)).toEqual([75, null, null, null])
  })
})

describe('recurringDigest', () => {
  const TODAY = '2026-07-09'
  const row = (partial: Partial<SubRow>): SubRow => ({ ...partial }) as SubRow
  const subsWith = (rows: SubRow[]): Subscriptions => ({ rows, unconfirmed: [], monthlyTotal: 118, annualisedTotal: 1540 })

  it('counts a recent change and ignores an old one', () => {
    const d = recurringDigest(
      subsWith([
        row({ state: 'increased', lastDate: '2026-06-29' }), // 10 days ago
        row({ state: 'increased', lastDate: '2026-04-10' }), // 90 days ago
        row({ state: 'new', lastDate: '2026-07-01' }),
        row({ state: 'steady', lastDate: '2026-07-01' }),
      ]),
      TODAY,
    )
    expect(d.increasedCount).toBe(1)
    expect(d.newCount).toBe(1)
    expect(d.monthlyTotal).toBe(118)
    expect(d.hasAny).toBe(true)
  })

  it('a lapse counts by when the charge was EXPECTED, not when it last happened', () => {
    const d = recurringDigest(
      subsWith([
        row({ state: 'lapsed', lastDate: '2026-05-01', expectedNext: '2026-06-01' }), // expected 38 days ago
        row({ state: 'lapsed', lastDate: '2025-06-01', expectedNext: '2025-07-01' }), // died a year ago — not news
      ]),
      TODAY,
    )
    expect(d.lapsedCount).toBe(1)
  })

  it('hasAny is false with no confirmed rows', () => {
    expect(recurringDigest(subsWith([]), TODAY).hasAny).toBe(false)
  })
})
