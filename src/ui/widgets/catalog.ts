// What can be pinned to the dashboard, as data.
//
// Modelled on `EXPLAIN` (src/ui/explain/content.ts): an `as const satisfies Record<…>` literal
// with the id union derived from it, so a typo is a type error. Like `EXPLAIN` it holds no JSX and
// imports no React — the suite runs in the node environment, and this is the half that can be
// unit-tested. Its partner is `render.tsx`, whose `Record<WidgetId, …>` makes the pairing total:
// an entry added here without a renderer fails to compile rather than rendering a blank tile.
//
// A pin stores an id plus the screen state the chart was showing, and the dashboard replays that
// against the live vault. Nothing about the *result* is stored, so a pinned chart is as evergreen
// as `SavedComparison`'s `{ rel: 'thisMonth' }` — see `PinnedWidget` in model/types.
import type { WidgetParam } from '../../model/types'
import type { Span } from '../dashOrder'

export type WidgetParams = Record<string, WidgetParam>

export interface WidgetSpec {
  /** Where it lives, and how the picker groups it. */
  screen: 'Trends' | 'Accounts' | 'Trips' | 'Plan'
  title: string
  /** One line in the picker: what the chart shows. */
  blurb: string
  /** Columns it takes when first pinned — a dense chart earns more than a single figure. */
  defaultSpan: Span
  /** The state to render with when pinned from the picker rather than from its own screen. */
  defaults: WidgetParams
}

export const WIDGETS = {
  'trends.yearly': {
    screen: 'Trends',
    title: 'Spending by year',
    blurb: 'Stacked months across the year, with the year-end projection.',
    defaultSpan: 3,
    defaults: { hiddenCats: [] },
  },
  'trends.monthly': {
    screen: 'Trends',
    title: 'Spending by month',
    blurb: 'Month totals or a category split, with a rolling average.',
    defaultSpan: 3,
    defaults: { monthMode: 'total', monthWindow: '18M', rollOn: true, hiddenCats: [] },
  },
  'trends.drill': {
    screen: 'Trends',
    title: 'Top merchants in a category',
    blurb: 'Where one category actually goes, by merchant.',
    defaultSpan: 2,
    defaults: { drillCat: '', drillRange: '3M' },
  },
  'trends.momentum': {
    screen: 'Trends',
    title: 'What’s moving',
    blurb: 'Categories rising or falling against their own recent history.',
    defaultSpan: 2,
    defaults: {},
  },
  'trends.income': {
    screen: 'Trends',
    title: 'Income & savings rate',
    blurb: 'Income bars, spending line, and the monthly savings rate.',
    defaultSpan: 3,
    defaults: { window: '18M' },
  },
  'trends.seasonality': {
    screen: 'Trends',
    title: 'Seasonality',
    blurb: 'Which calendar month consistently runs highest.',
    defaultSpan: 2,
    defaults: {},
  },
  'accounts.net-worth': {
    screen: 'Accounts',
    title: 'Net worth',
    blurb: 'Assets minus liabilities over time, from balance snapshots.',
    defaultSpan: 2,
    defaults: { range: '1y' },
  },
  'accounts.emergency': {
    screen: 'Accounts',
    title: 'Emergency fund',
    blurb: 'How many months of expenses your liquid accounts cover.',
    defaultSpan: 1,
    defaults: {},
  },
  'trips.timeline': {
    screen: 'Trips',
    title: 'Trip timeline',
    blurb: 'Every active trip on one axis, block height = spend per day.',
    defaultSpan: 3,
    defaults: {},
  },
  // The two below name a specific trip in their params. Added from the picker they have no trip to
  // point at and say so, rather than silently picking one — a tile that quietly changed which trip
  // it showed would be worse than an empty one.
  'trips.daily': {
    screen: 'Trips',
    title: 'Daily spend on a trip',
    blurb: 'Day-by-day spend across one trip. Pin it from that trip’s page.',
    defaultSpan: 2,
    defaults: { tripId: '' },
  },
  'trips.categories': {
    screen: 'Trips',
    title: 'Trip category breakdown',
    blurb: 'Every category in one trip. Pin it from that trip’s page.',
    defaultSpan: 1,
    defaults: { tripId: '' },
  },
  'plan.rules': {
    screen: 'Plan',
    title: 'Rules of thumb',
    blurb: 'Housing share, savings rate and months of cover against their targets.',
    defaultSpan: 1,
    defaults: {},
  },
} as const satisfies Record<string, WidgetSpec>

export type WidgetId = keyof typeof WIDGETS

/** Stable id list, for the picker and for the test that pairs this with the renderers. */
export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[]

export const isWidgetId = (id: string): id is WidgetId => id in WIDGETS

/**
 * The params a widget should render with: its defaults, overridden by whatever was stored.
 *
 * Defaults are merged rather than assumed present because a pin outlives the version that wrote
 * it — a widget that grows a third control must still render the two-control pins already saved.
 */
export function widgetParams(id: WidgetId, stored: WidgetParams | undefined): WidgetParams {
  return { ...WIDGETS[id].defaults, ...stored }
}

/**
 * A comparable key for one widget's parameters, so "is this already pinned?" has an answer.
 *
 * Key-sorted rather than a plain `JSON.stringify`: the same params reach this from a literal on
 * the chart's own screen and from a merge of defaults with a stored record, and those two produce
 * the same object with different key order. `CompareScreen`'s `pinnedMatch` can compare selections
 * directly because both sides are built by the same expression; these two are not.
 */
export function paramKey(params: WidgetParams): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  )
}

/** Widgets grouped for the picker, in catalogue order within each screen. */
export function widgetsByScreen(): [WidgetSpec['screen'], WidgetId[]][] {
  const out = new Map<WidgetSpec['screen'], WidgetId[]>()
  for (const id of WIDGET_IDS) {
    const arr = out.get(WIDGETS[id].screen) ?? []
    arr.push(id)
    out.set(WIDGETS[id].screen, arr)
  }
  return [...out.entries()]
}
