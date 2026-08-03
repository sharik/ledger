// How current the imported data is — the one definition, shared by every screen that captions a
// figure with "data through …".
//
// This exists because two screens disagreed. The Dashboard derived the caption from statement
// coverage; the Plan screen printed TODAY'S DATE in a caption identical in wording, font and colour
// (PlanScreen "data through {dayOfToday()}"). So the same "Plan · July" block claimed "data through
// 12 Jul" on one screen and "data through 29 Jul" on the other, and on Plan every budget bar looked
// comfortably under budget because the last 17 days of charges had not been imported yet.
//
// Freshness is a statement fact or it is nothing. It is never today.
import { useMemo } from 'react'
import type { StatementRecord } from '../model/types'
import { useStoreState } from './store'
import { MONTHS } from './format'

/** "2026-07-12" → "12 Jul". The short day label every freshness caption uses. */
export function fmtDay(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`
}

export interface Freshness {
  /** The date the whole picture is covered through, or null when nothing has been imported. */
  through: string | null
  /** "data through 12 Jul", or "no imported data". Ready to render. */
  label: string
  basis: 'statement' | 'none'
}

/**
 * The latest period end each account is covered through, then the MINIMUM across accounts: one
 * account left un-imported makes the whole picture stale, and saying otherwise is the lie this
 * caption exists to prevent. Accounts with no statements at all do not count — they cannot make
 * the picture staler than the data that does exist.
 */
export function computeFreshness(statements: readonly StatementRecord[]): Freshness {
  const maxByAcct = new Map<string, string>()
  for (const s of statements) {
    const prev = maxByAcct.get(s.accountId)
    if (!prev || s.periodTo > prev) maxByAcct.set(s.accountId, s.periodTo)
  }
  const vals = [...maxByAcct.values()]
  const through = vals.length ? vals.reduce((a, b) => (a < b ? a : b)) : null
  return through
    ? { through, label: `data through ${fmtDay(through)}`, basis: 'statement' }
    : { through: null, label: 'no imported data', basis: 'none' }
}

export function useFreshness(): Freshness {
  const { vault } = useStoreState()
  return useMemo(() => computeFreshness(vault.statements), [vault.statements])
}
