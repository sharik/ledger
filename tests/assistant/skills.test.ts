import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS, DEFAULT_OFF, normalizeName, parseFrontmatter, skillNameExists, skillsOff } from '../../src/assistant/skills'
import { visibleSkills } from '../../src/assistant/tools'

const doc = (name: string, description: string, body = 'Body text.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

describe('frontmatter (§6)', () => {
  it('reads name and description and trims the body', () => {
    expect(parseFrontmatter(doc('my-skill', 'when to use it'))).toEqual({
      name: 'my-skill',
      description: 'when to use it',
      body: 'Body text.',
    })
  })

  it('normalizes a human-typed name into a handle the model can repeat', () => {
    expect(parseFrontmatter(doc('My Skill!', 'x'))!.name).toBe('my-skill')
    expect(normalizeName('  Household — Rules  ')).toBe('household-rules')
  })

  it('tolerates CRLF, a BOM and quoted values', () => {
    const raw = '﻿---\r\nname: "a-skill"\r\ndescription: \'one line\'\r\n---\r\nBody.\r\n'
    expect(parseFrontmatter(raw)).toEqual({ name: 'a-skill', description: 'one line', body: 'Body.' })
  })

  it('rejects rather than silently accepting a malformed file', () => {
    expect(parseFrontmatter('just a note, no frontmatter')).toBeNull()
    expect(parseFrontmatter(doc('', 'x'))).toBeNull() // no name
    expect(parseFrontmatter('---\nname: a\n---\n\nbody')).toBeNull() // no description
    expect(parseFrontmatter(doc('a', 'b', ''))).toBeNull() // no body
  })
})

describe('skillNameExists — an import must not shadow a trusted skill (§6)', () => {
  it('flags a name that collides with a built-in', () => {
    // `screens` is the built-in the safe-mode prompt anoints as its best source.
    expect(skillNameExists('screens', [])).toBe(true)
  })

  it('flags a name already taken by a user skill', () => {
    expect(skillNameExists('house-rules', [{ name: 'house-rules' }])).toBe(true)
  })

  it('allows a fresh name', () => {
    expect(skillNameExists('my-new-skill', [{ name: 'house-rules' }])).toBe(false)
  })
})

describe('the built-ins ship parsed (§6)', () => {
  it('every built-in has a unique name, a description and a body', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(4)
    expect(new Set(BUILTIN_SKILLS.map((s) => s.name)).size).toBe(BUILTIN_SKILLS.length)
    for (const s of BUILTIN_SKILLS) {
      expect(s.builtin).toBe(true)
      expect(s.description.length).toBeGreaterThan(10)
      expect(s.body.length).toBeGreaterThan(100)
    }
  })

  it('the valuation template ships switched off — it is a form, not a fact', () => {
    expect(DEFAULT_OFF).toContain('valuation')
    expect(visibleSkills(BUILTIN_SKILLS, [], skillsOff(undefined)).map((s) => s.name)).not.toContain('valuation')
  })

  it('once the user has touched the list, their choice replaces the defaults', () => {
    const on = visibleSkills(BUILTIN_SKILLS, [], skillsOff({ skillsOff: [] })).map((s) => s.name)
    expect(on).toContain('valuation')
  })

  it('built-ins carry knowledge, not the refusals — those are not switchable', () => {
    // A skill may explain what cannot be answered, but the binding rules live in the system prompt.
    const bodies = BUILTIN_SKILLS.map((s) => s.body).join('\n')
    expect(bodies).toContain('flow')
    expect(visibleSkills(BUILTIN_SKILLS, [], BUILTIN_SKILLS.map((s) => s.name))).toEqual([])
  })
})
