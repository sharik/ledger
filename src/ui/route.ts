// Hash routing (Phase G). The route is the single source of truth for which
// screen is visible and, for drills, the seed query it arrived with:
//
//   #/trends
//   #/txns?cat=cat-dining&from=2026-07-01&to=2026-07-31
//
// The hash may carry tab ids, category/account ids, ISO dates, and merchant or
// search text — NEVER amounts or balances. On vault lock the query is stripped
// (App), so a locked tab shows at most '#/<tab>'.
import type { Selection } from '../model/types'
import { TABS, normalizeTab, type Tab } from './view'

export interface Route {
  tab: Tab
  query: Record<string, string>
}

/** Seedable Transactions filters, carried through the hash on drill-downs. */
export interface TxnFilter {
  q?: string
  cat?: string // category id
  /** Several category ids, comma-joined — a multi-category budget's drill (#Plan-1). */
  cats?: string
  status?: string
  acct?: string // account id
  from?: string // 'YYYY-MM-DD' inclusive
  to?: string // 'YYYY-MM-DD' inclusive
  merchant?: string
  /** Trip/set id. Membership is curated, so a date range is NOT a substitute (ANALYTICS §1.3). */
  tracking?: string
  /** One bucket of the Transactions totals bar — `TxnFlow` in model/txnFilter. */
  flow?: string
}

/** '#/txns?cat=x' → { tab, query }. Unknown/junk hashes land on the dashboard. */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  const qi = h.indexOf('?')
  const tabPart = qi === -1 ? h : h.slice(0, qi)
  const tab = (TABS as string[]).includes(tabPart) || tabPart === 'import' ? normalizeTab(tabPart as Tab) : 'dash'
  const query: Record<string, string> = {}
  if (qi !== -1) {
    for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) query[k] = v
  }
  return { tab, query }
}

export function formatHash(route: Route): string {
  const qs = new URLSearchParams(route.query).toString()
  return `#/${route.tab}${qs ? `?${qs}` : ''}`
}

const TXN_KEYS: (keyof TxnFilter)[] = ['q', 'cat', 'cats', 'status', 'acct', 'from', 'to', 'merchant', 'tracking', 'flow']

export function txnFilterToQuery(f: TxnFilter): Record<string, string> {
  const query: Record<string, string> = {}
  for (const k of TXN_KEYS) {
    const v = f[k]
    if (v) query[k] = v
  }
  return query
}

/** On vault lock: drop any drill query so the locked URL carries only '#/<tab>'. */
export function stripHashQuery(): void {
  const { tab } = parseHash(location.hash)
  history.replaceState(history.state, '', formatHash({ tab, query: {} }))
}

export function queryToTxnFilter(query: Record<string, string>): TxnFilter {
  const f: TxnFilter = {}
  for (const k of TXN_KEYS) {
    const v = query[k]
    if (v) f[k] = v
  }
  return f
}

/**
 * Compare seeds (ASSISTANT §5). '?trips=' and '?saved=' can only name something already in the
 * vault; the assistant needs to open an arbitrary pair of sides it just computed, so a Selection
 * travels in the hash as compact JSON under '?cmpA='/'?cmpB='.
 *
 * A Selection carries only ids, dates and search text — the same classes of value the drill query
 * already carries, and never an amount — so this stays inside the hash policy above, and
 * `stripHashQuery()` clears it on lock like everything else.
 */
export function selectionToParam(sel: Selection): string {
  return JSON.stringify(sanitizeSelection(sel) ?? {})
}

/** Parse one side. Junk, an unparseable string, or a shape with nothing usable in it returns null. */
export function paramToSelection(raw: string): Selection | null {
  try {
    return sanitizeSelection(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** Whitelist: unknown keys are dropped rather than trusted, since this arrives from a URL. */
function sanitizeSelection(raw: unknown): Selection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: Selection = {}
  if (isPeriod(r.period)) out.period = r.period
  const ids = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const list = v.filter((x): x is string => typeof x === 'string' && x !== '')
    return list.length ? list : undefined
  }
  const cats = ids(r.categoryIds)
  if (cats) out.categoryIds = cats
  const accts = ids(r.accountIds)
  if (accts) out.accountIds = accts
  const tracks = ids(r.trackingIds)
  if (tracks) out.trackingIds = tracks
  if (typeof r.merchantQuery === 'string' && r.merchantQuery.trim()) out.merchantQuery = r.merchantQuery
  if (r.includeNonCashflow === true) out.includeNonCashflow = true
  return Object.keys(out).length > 0 ? out : null
}

const RELS = new Set(['thisMonth', 'lastMonth', 'thisYear', 'lastYear', 'sameMonthLastYear'])
const DATE = /^\d{4}-\d{2}-\d{2}$/

function isPeriod(v: unknown): v is NonNullable<Selection['period']> {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.rel === 'string') return RELS.has(p.rel)
  if (typeof p.month === 'string') return /^\d{4}-\d{2}$/.test(p.month)
  if (typeof p.year === 'number') return Number.isInteger(p.year) && p.year > 1900 && p.year < 3000
  return typeof p.from === 'string' && typeof p.to === 'string' && DATE.test(p.from) && DATE.test(p.to)
}
