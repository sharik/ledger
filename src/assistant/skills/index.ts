// Built-in skills (ASSISTANT §6).
//
// These ship with the app as plain `.md` files: they are domain knowledge about how Ledger models
// money, not user data, so they have no business in the vault. Only their off-state persists, in
// `settings.assist.skillsOff`.
//
// They carry knowledge, never rules. The refusals — no advice, no runway, no scenario modelling —
// live in the system prompt, where switching a skill off cannot reach them.
//
// A user skill with the same `name` shadows a built-in. That is the edit path: "Duplicate & edit"
// copies the body into a user skill, and from then on the user's version is the one the model reads.
import type { SkillView } from '../tools'
import balances from './balances.md?raw'
import budgeting from './budgeting.md?raw'
import comparisons from './comparisons.md?raw'
import ledgerModel from './ledger-model.md?raw'
import valuation from './valuation.md?raw'
import { screensSkill } from './screens'

/** Built-ins that start switched OFF — templates meant to be duplicated and filled in. */
export const DEFAULT_OFF = ['valuation']

/** Which built-ins are off: the user's list once they have touched it, the defaults before that. */
export function skillsOff(assist: { skillsOff?: string[] } | undefined): string[] {
  return assist?.skillsOff ?? DEFAULT_OFF
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
}

/**
 * Minimal frontmatter: a leading `---` block of `key: value` lines. Deliberately not YAML — two
 * keys are all a skill has, and a parser dependency for that would be absurd. Returns null when the
 * block is missing or either key is empty, so a malformed import is reported rather than silently
 * landing as a nameless skill.
 */
export function parseFrontmatter(text: string): ParsedSkill | null {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    meta[line.slice(0, at).trim().toLowerCase()] = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  const name = normalizeName(meta.name ?? '')
  const description = meta.description ?? ''
  const body = (m[2] ?? '').trim()
  if (!name || !description || !body) return null
  return { name, description, body }
}

/**
 * Whether `name` (already normalized) is taken by a built-in or an existing user skill. Used to refuse
 * an imported `.md` that would otherwise shadow a built-in the assistant trusts (e.g. `screens`) —
 * stored prompt injection that syncs to every device — before it lands in the vault.
 */
export function skillNameExists(name: string, userSkills: { name: string }[]): boolean {
  return BUILTIN_SKILLS.some((b) => b.name === name) || userSkills.some((s) => s.name === name)
}

/** Skill names are handles the model types back verbatim: lowercase, no spaces. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

const SOURCES = [ledgerModel, comparisons, balances, budgeting, valuation]

/**
 * Parsed at module load. A built-in that fails to parse is a build-time bug, so it is dropped loudly.
 *
 * `screens` is the exception: it is generated from the UI's own explanation registry rather
 * than authored as a file, so the panel a user reads and the note the model reads are the
 * same source and cannot drift apart.
 */
export const BUILTIN_SKILLS: SkillView[] = [
  ...SOURCES.flatMap((src) => {
    const parsed = parseFrontmatter(src)
    if (!parsed) {
      console.error('built-in skill failed to parse; skipping')
      return []
    }
    return [{ ...parsed, builtin: true }]
  }),
  screensSkill(),
]
