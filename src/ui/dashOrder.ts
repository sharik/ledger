// Dashboard layout order (Phase G). A device-level preference: which cards sit
// where in the pinned grid, and how the coarse sections stack. Stored in
// localStorage (THEME_KEY precedent) — layout taste, not vault content.

export const DASH_ORDER_KEY = 'ledger.dashOrder'

/** How many columns of the grid a tile occupies. */
export type Span = 1 | 2 | 3

export const MAX_SPAN = 3

export interface DashOrder {
  /** Pre-tiles: the coarse hero/cards/plan stack. Read by `migrateTiles`, never written again. */
  sections?: string[]
  /** Plan still orders its cards with this; the Dashboard reads it once, to migrate. */
  cards?: string[]
  /** The Dashboard's single ordered tile list — sections and cards in one grid. */
  tiles?: string[]
  /** Overrides only; a tile with no entry gets its default span. */
  spans?: Record<string, Span>
}

/**
 * Apply a saved order to the current id list: saved ids keep their relative
 * order (stale ids drop out), ids the saved list has never seen append in
 * their default position order.
 */
export function applyOrder(ids: string[], saved: string[] | undefined): string[] {
  if (!saved || saved.length === 0) return ids
  const present = new Set(ids)
  const out = saved.filter((id) => present.has(id))
  const seen = new Set(out)
  for (const id of ids) if (!seen.has(id)) out.push(id)
  return out
}

/**
 * Like `applyOrder`, but an id the saved list has never seen lands *after its default predecessor*
 * rather than at the end.
 *
 * The Dashboard needs this and the card grid did not: `plan` used to be a section below the cards,
 * so appending was always right. Now that it is the last tile, a plain append would drop every
 * newly pinned card underneath the plan block instead of beside its siblings.
 */
export function applyOrderAnchored(ids: string[], saved: string[] | undefined): string[] {
  if (!saved || saved.length === 0) return ids
  const present = new Set(ids)
  const out = saved.filter((id) => present.has(id))
  const placed = new Set(out)
  let at = -1 // where in `out` the most recently walked default sits
  for (const id of ids) {
    if (placed.has(id)) {
      at = out.indexOf(id)
      continue
    }
    at += 1
    out.splice(at, 0, id)
    placed.add(id)
  }
  return out
}

/**
 * The tile order out of a stored preference — migrating a layout saved before the Dashboard's
 * sections and cards became one grid.
 *
 * `sections` held the coarse stack and `cards` the pinned grid inside it, so the tile list is the
 * saved section order with the saved card order spliced in where the cards section sat. A layout
 * that only ever nudged cards has no `sections`, hence the default passed in.
 */
export function migrateTiles(order: DashOrder, defaultSections: string[], cardsSectionId: string): string[] | undefined {
  if (order.tiles) return order.tiles
  if (!order.sections && !order.cards) return undefined
  const sections = order.sections?.length ? order.sections : defaultSections
  return sections.flatMap((s) => (s === cardsSectionId ? (order.cards ?? []) : [s]))
}

/** A span the grid can actually render: a whole number of columns, at least 1, at most `cols`. */
export function clampSpan(span: number, cols: number): Span {
  return Math.max(1, Math.min(Math.round(span) || 1, cols, MAX_SPAN)) as Span
}

/**
 * Lay tiles out in reading order, greedily: keep filling the current row while the next tile's span
 * fits, else start a new one.
 *
 * This is the whole snap semantics. A tile dropped after another on a line takes the next column; a
 * tile widened past the remaining room forces its own row and pushes what followed it down.
 */
export function packRows(ids: string[], spanOf: (id: string) => number, cols: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let used = 0
  for (const id of ids) {
    const s = clampSpan(spanOf(id), cols)
    if (row.length > 0 && used + s > cols) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(id)
    used += s
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/**
 * The `gridTemplateColumns` for one packed row, as `fr` tracks.
 *
 * Fractions rather than a fixed `repeat(cols, …)` are what makes a row always fill its width: a
 * lone 1-span tile gets `1fr` and stretches edge to edge, two of them split it in half, and a
 * 2-and-1 row keeps the 2:1 ratio. No leftover column, ever.
 */
export function rowTracks(row: string[], spanOf: (id: string) => number, cols: number): string {
  return row.map((id) => `${clampSpan(spanOf(id), cols)}fr`).join(' ')
}

/** Move `id` one slot up/down within `ids`; returns a new array (or the same if at an edge). */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return ids
  const out = [...ids]
  out[i] = out[j]!
  out[j] = id
  return out
}

/**
 * Which screen's layout an order belongs to. One key per screen rather than one shared blob: the
 * Dashboard's saved card ids mean nothing on Plan, and a shared list would have them fight over
 * `cards`. `dash` keeps `DASH_ORDER_KEY` verbatim so every layout saved before Plan had cards
 * survives untouched.
 */
export type OrderNs = 'dash' | 'plan'

const KEY: Record<OrderNs, string> = { dash: DASH_ORDER_KEY, plan: 'ledger.planOrder' }

export function loadOrder(ns: OrderNs): DashOrder {
  try {
    const raw = localStorage.getItem(KEY[ns])
    return raw ? (JSON.parse(raw) as DashOrder) : {}
  } catch {
    return {}
  }
}

export function saveOrder(ns: OrderNs, order: DashOrder): void {
  try {
    localStorage.setItem(KEY[ns], JSON.stringify(order))
  } catch {
    // storage full/blocked — layout preference is best-effort
  }
}

/** The coarse stack the Dashboard had before its sections and cards became one grid. */
const LEGACY_DASH_SECTIONS = ['hero', 'cards', 'plan']

/** `loadOrder` with a pre-tiles layout folded forward, so an old saved arrangement survives. */
export function loadTiles(ns: OrderNs): DashOrder {
  const order = loadOrder(ns)
  const tiles = migrateTiles(order, LEGACY_DASH_SECTIONS, 'cards')
  return tiles ? { ...order, tiles } : order
}

export const loadDashOrder = (): DashOrder => loadOrder('dash')
export const saveDashOrder = (order: DashOrder): void => saveOrder('dash', order)
