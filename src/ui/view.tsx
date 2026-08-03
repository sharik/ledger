import { createContext, useContext } from 'react'
import type { TxnFilter } from './route'

/** New design view union (Convention #7). `import` is reached from the header button, not the nav. */
export type Tab = 'dash' | 'compare' | 'trends' | 'trips' | 'plan' | 'accounts' | 'txns' | 'settings' | 'import'

/** Retired screen ids still referenced by not-yet-deleted screens (deleted in Phase C/D). */
export type LegacyTab = 'overview' | 'cashflow' | 'budgets' | 'goals'

export const TABS: Tab[] = ['dash', 'compare', 'trends', 'trips', 'plan', 'accounts', 'txns', 'settings']

export type Theme = 'light' | 'dark'

export interface ViewCtx {
  tab: Tab
  /** Switch tab; optionally smooth-scroll to a section anchor. Accepts legacy ids from old screens. */
  goTab: (tab: Tab | LegacyTab, section?: string) => void
  /** Drill into Transactions with a seeded filter — every chart click routes through this. */
  goTxns: (filter: TxnFilter) => void
  /** Navigate to a tab with a seed query (e.g. Compare with a preselected trip or saved comparison). */
  go: (tab: Tab, query?: Record<string, string>) => void
  /**
   * Route seed, re-issued (new nonce) on every navigation. Screens consume the
   * query for their tab in an effect keyed on `nonce` — an empty query means
   * plain navigation and must leave local state alone.
   */
  seed: { tab: Tab; query: Record<string, string>; nonce: number } | null
  theme: Theme
  toggleTheme: () => void
  notesOpen: boolean
  setNotesOpen: (open: boolean) => void
}

export const ViewContext = createContext<ViewCtx | null>(null)

export function useView(): ViewCtx {
  const v = useContext(ViewContext)
  if (!v) throw new Error('ViewContext missing')
  return v
}

const KNOWN_TABS = new Set<string>(['dash', 'compare', 'trends', 'trips', 'plan', 'accounts', 'txns', 'settings', 'import'])

/** Narrow a possibly-legacy tab id to a valid new Tab, defaulting to the dashboard. */
export function normalizeTab(t: Tab | LegacyTab): Tab {
  return KNOWN_TABS.has(t) ? (t as Tab) : 'dash'
}

/** Eased scroll of the main container to a section anchor (ported from the mock). */
export function scrollToSection(name: string): void {
  const c = document.querySelector('[data-main-scroll]')
  const el = document.querySelector(`[data-cf-section="${name}"]`)
  if (!c || !el) return
  const from = c.scrollTop
  const to = from + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 12
  const steps = 10
  const dur = 200
  for (let i = 1; i <= steps; i++) {
    const p = i / steps
    const eased = 1 - Math.pow(1 - p, 3)
    setTimeout(() => {
      c.scrollTop = from + (to - from) * eased
    }, dur * p)
  }
}
