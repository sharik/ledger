// The `screens` built-in skill — generated from the UI's own explanation registry.
//
// Why this exists: a user reads "≈ on pace for €6,140" on the Dashboard and asks the
// assistant about it. Without this, the model has no idea what is on screen or how that
// figure was derived — it has no projection tool — so it answers from `aggregate` and can
// produce a DIFFERENT NUMBER FOR THE SAME QUESTION inside the same app. Two disagreeing
// figures with no explanation is worse than one unexplained figure.
//
// So the panel and the model read one source: `EXPLAIN` in src/ui/explain/content.ts.
// A test asserts every id reaches this body, which is what makes drift impossible rather
// than merely unlikely.
//
// BUILTIN_SKILLS is a SkillView[] assembled at module load; nothing requires an entry to
// come from a .md file. This one is a function of the registry instead. It shadows like
// any other built-in, so a user who disagrees can Duplicate & edit.
import type { SkillView } from '../tools'
import { EXPLAIN, EXPLAIN_IDS, type Explanation } from '../../ui/explain/content'

/**
 * `how` may be a function of live context (a savings target, a currency symbol). The skill
 * is built once at module load with no vault in scope, so those are rendered with neutral
 * placeholders — the model is told the shape of the rule, and reads the real target from
 * `list_budgets` / `get_overview` when it needs the number.
 */
const NEUTRAL = {
  sym: 'the base currency',
  srTarget: 0,
  efTarget: 0,
} as const

function howFor(e: Explanation): string {
  if (typeof e.how === 'string') return e.how
  // Strip the trailing sentence that names a user-set target — it would be a stale number.
  return e.how(NEUTRAL as never)
    .replace(/\s*Your target is [^.]*\.\s*$/, '')
    .trim()
}

/** Markdown body, grouped by screen. */
export function renderRegistry(): string {
  const byScreen = new Map<string, Explanation[]>()
  for (const id of EXPLAIN_IDS) {
    const e = EXPLAIN[id] as Explanation
    const list = byScreen.get(e.screen) ?? []
    list.push(e)
    byScreen.set(e.screen, list)
  }

  const out: string[] = [
    'What each Ledger screen shows, and how the figure on it was derived.',
    '',
    'Use this when the question is about something the person is LOOKING AT — "why does the',
    'dashboard say I am on pace for 6,140", "what does this bar mean", "why do these two',
    'numbers differ". Explain the screen\'s own rule from here rather than computing a rival',
    'figure with aggregate: a second number for the same question is worse than no number.',
    '',
    'These are descriptions of the UI, not tools. To get the person\'s actual figures, still',
    'call the tools.',
  ]

  for (const [screen, items] of byScreen) {
    out.push('', `# ${screen}`)
    for (const e of items) {
      out.push('', `## ${e.title}`, '', e.what, '', `**How it is calculated.** ${howFor(e)}`)
      if (e.excludes?.length) {
        out.push('', '**What it excludes.**')
        for (const x of e.excludes) out.push(`- ${x}`)
      }
      if (e.seeSkill) out.push('', `See also the \`${e.seeSkill}\` skill, which covers the underlying rule.`)
    }
  }
  return out.join('\n')
}

export function screensSkill(): SkillView {
  return {
    name: 'screens',
    description: 'What each Ledger screen shows and how the figures on it are derived — read this when a question is about something on screen',
    body: renderRegistry(),
    builtin: true,
  }
}
