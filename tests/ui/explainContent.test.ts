import { describe, expect, it } from 'vitest'
import { EXPLAIN, EXPLAIN_IDS, howText, type ExplainCtx, type Explanation } from '../../src/ui/explain/content'

const TABS = ['dash', 'compare', 'trends', 'trips', 'plan', 'accounts', 'txns', 'settings', 'import']
const BUILTIN_SKILL_NAMES = ['ledger-model', 'comparisons', 'balances']

const ctx: ExplainCtx = {
  sym: '€',
  srTarget: 20,
  efTarget: 6,
}

const all = EXPLAIN_IDS.map((id) => [id, EXPLAIN[id] as Explanation] as const)

describe('explanation registry', () => {
  it('has entries', () => {
    expect(EXPLAIN_IDS.length).toBeGreaterThan(10)
  })

  it.each(all)('%s has every required section filled in', (_id, e) => {
    expect(e.title.trim()).not.toBe('')
    expect(e.hint.trim()).not.toBe('')
    expect(e.what.trim()).not.toBe('')
    expect(howText(e, ctx).trim()).not.toBe('')
  })

  // The hint rides in the chart tooltip, which is nowrap — a paragraph would run off screen.
  it.each(all)('%s keeps its hint to one line', (_id, e) => {
    expect(e.hint.length).toBeLessThanOrEqual(90)
  })

  it.each(all)('%s links only to real tabs', (_id, e) => {
    for (const n of e.next ?? []) expect(TABS).toContain(n.tab)
  })

  it.each(all)('%s cites only skills that exist', (_id, e) => {
    if (e.seeSkill) expect(BUILTIN_SKILL_NAMES).toContain(e.seeSkill)
  })

  // The panel renders `what` as a sentence and `excludes` as bullets; an entry that put its
  // exclusions into prose would lose the trust section entirely.
  it.each(all)('%s states its exclusions as list items, not prose', (_id, e) => {
    for (const x of e.excludes ?? []) {
      expect(x.trim()).not.toBe('')
      expect(x.startsWith('-')).toBe(false)
    }
  })

  // The panel's prose sits beside the reader's own figures, so a currency-shaped example
  // reads as one of them — the exact confusion this panel exists to remove. Illustrate
  // without a symbol.
  it('never uses a currency-shaped example amount', () => {
    for (const [id, e] of all) {
      const text = [e.hint, e.what, howText(e, ctx), ...(e.excludes ?? [])].join(' ')
      expect(text, `${id} contains a literal money example`).not.toMatch(/[€$£¥]\s?\d/)
    }
  })

  it('never promises a due date — cadence is not a bill calendar (QUESTIONARY §2)', () => {
    for (const [id, e] of all) {
      const text = [e.what, howText(e, ctx), ...(e.excludes ?? [])].join(' ').toLowerCase()
      if (text.includes('due')) {
        // The only permitted use is the explicit refusal.
        expect(text, `${id} mentions "due"`).toMatch(/never a due date|not a due date|cannot tell you when/)
      }
    }
  })
})
