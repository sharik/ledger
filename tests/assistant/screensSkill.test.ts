import { describe, expect, it } from 'vitest'
import { renderRegistry, screensSkill } from '../../src/assistant/skills/screens'
import { parseFrontmatter } from '../../src/assistant/skills'
import { EXPLAIN, EXPLAIN_IDS, type Explanation } from '../../src/ui/explain/content'

describe('the generated `screens` skill', () => {
  it('is a well-formed SkillView', () => {
    const s = screensSkill()
    expect(s.name).toBe('screens')
    expect(s.builtin).toBe(true)
    expect(s.description.trim()).not.toBe('')
    expect(s.body.trim().length).toBeGreaterThan(500)
  })

  // THE anti-drift assertion. The panel and the model read one source; if an explanation is
  // added to the UI registry and does not reach the model, the two can disagree about the
  // same figure — which is the failure this whole mechanism exists to prevent.
  it('carries every explanation the UI can show', () => {
    const body = renderRegistry()
    for (const id of EXPLAIN_IDS) {
      const e = EXPLAIN[id] as Explanation
      expect(body, `${id} missing its title`).toContain(e.title)
      expect(body, `${id} missing its "what"`).toContain(e.what)
    }
  })

  it('carries the exclusions, which are the part a model would otherwise omit', () => {
    const body = renderRegistry()
    for (const id of EXPLAIN_IDS) {
      for (const x of (EXPLAIN[id] as Explanation).excludes ?? []) {
        expect(body, `${id}: "${x.slice(0, 30)}…" missing`).toContain(x)
      }
    }
  })

  it('cross-references a cited skill instead of duplicating its prose', () => {
    const body = renderRegistry()
    expect(body).toContain('`comparisons` skill')
    expect(body).toContain('`balances` skill')
  })

  // `how` may be a function of a user-set target. The skill is built once at module load
  // with no vault, so a stale "Your target is 0%" must never reach the model.
  it('drops the sentence naming a user-set target rather than printing a placeholder', () => {
    const body = renderRegistry()
    expect(body).not.toMatch(/target is 0%/)
    expect(body).not.toMatch(/target is 0 months/)
    expect(body).not.toContain('undefined')
    expect(body).not.toContain('NaN')
  })

  it('tells the model to explain the screen rather than compute a rival figure', () => {
    expect(renderRegistry()).toMatch(/rather than computing a rival/i)
  })

  it('would survive the built-in frontmatter parser if it were ever written to a file', () => {
    const s = screensSkill()
    const round = parseFrontmatter(`---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`)
    expect(round).not.toBeNull()
    expect(round!.name).toBe('screens')
  })
})
