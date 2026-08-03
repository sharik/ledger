import { describe, expect, it } from 'vitest'
import { computeBudgetDomain, linScale, monthTicks, niceCeil, niceTicks, stack } from '../src/ui/charts/geometry'

describe('linScale', () => {
  it('maps a domain onto a range', () => {
    const s = linScale([0, 10], [0, 100])
    expect(s(0)).toBe(0)
    expect(s(5)).toBe(50)
    expect(s(10)).toBe(100)
  })

  it('inverted ranges (y axes) and zero-width domains stay finite', () => {
    const y = linScale([0, 100], [200, 20])
    expect(y(0)).toBe(200)
    expect(y(100)).toBe(20)
    const z = linScale([5, 5], [0, 100])
    expect(z(5)).toBe(0)
    expect(Number.isFinite(z(7))).toBe(true)
  })
})

describe('niceCeil / niceTicks', () => {
  it('rounds to friendly ceilings', () => {
    expect(niceCeil(87)).toBe(100)
    expect(niceCeil(140)).toBe(150)
    expect(niceCeil(3400)).toBe(4000)
  })

  it('degenerate data yields a 0..1 axis, never NaN', () => {
    for (const v of [0, -5, NaN, Infinity * 0]) expect(niceCeil(v)).toBe(1)
    const t = niceTicks(0)
    expect(t.top).toBe(1)
    expect(t.ticks).toEqual([0, 0.25, 0.5, 0.75, 1])
  })
})

describe('stack', () => {
  const items = [
    { id: 'a', value: 10 },
    { id: 'b', value: 0 },
    { id: 'c', value: 5 },
  ]

  it('stacks positive values bottom-up, skipping zeros', () => {
    const s = stack(items)
    expect(s.map((x) => x.item.id)).toEqual(['a', 'c'])
    expect(s[1]).toMatchObject({ y0: 10, y1: 15 })
  })

  it('skips hidden ids and re-flows the stack', () => {
    const s = stack(items, new Set(['a']))
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ y0: 0, y1: 5 })
  })
})

describe('computeBudgetDomain', () => {
  it("distinguishes the user's 102% and 170% budgets", () => {
    const rows = [
      { spent: 1536, budget: 1500, proj: 1701 },
      { spent: 850, budget: 500, proj: 941 },
    ]
    const domain = computeBudgetDomain(rows)
    expect(domain).toBeCloseTo(941 / 500) // worst ratio wins
    // Fill fractions are now proportional and distinct:
    const fill = (spent: number, budget: number) => spent / budget / domain
    expect(fill(1536, 1500)).not.toBeCloseTo(fill(850, 500))
    // and the budget tick is at the same track fraction for every row:
    expect(1 / domain).toBeGreaterThan(0)
  })

  it('floors at 1.25 and ignores €0 budgets', () => {
    expect(computeBudgetDomain([{ spent: 100, budget: 1000, proj: 200 }])).toBe(1.25)
    expect(computeBudgetDomain([{ spent: 430, budget: 0, proj: 430 }])).toBe(1.25)
  })
})

describe('monthTicks', () => {
  it('labels every month over a short range', () => {
    const t = monthTicks('2026-01-01', '2026-04-30')
    expect(t.map((x) => x.label)).toEqual(['Jan ’26', 'Feb ’26', 'Mar ’26', 'Apr ’26'])
  })

  it('escalates the step so the count stays within maxCount', () => {
    const t = monthTicks('2020-01-01', '2026-01-01', 6)
    expect(t.length).toBeLessThanOrEqual(6)
    expect(t.every((x) => x.label === String(Number(x.label)))).toBe(true) // year labels
  })

  it('keeps every tick inside the domain', () => {
    const t = monthTicks('2025-03-17', '2025-11-04')
    expect(t.length).toBeGreaterThan(0)
    for (const x of t) {
      expect(x.date >= '2025-03-17').toBe(true)
      expect(x.date <= '2025-11-04').toBe(true)
    }
  })

  it('is empty for an inverted range', () => {
    expect(monthTicks('2026-05-01', '2026-01-01')).toEqual([])
  })
})
