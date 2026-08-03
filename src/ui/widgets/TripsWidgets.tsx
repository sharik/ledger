// The trip charts, as components both Trips and the dashboard render.
//
// The timeline used to take its summaries as a prop from `TripsScreen`, which is why it could only
// be seen there. It computes them itself now — from the same `useStoreState()` and `useRateBook()`
// the screen reads, so a pinned copy shows live trips rather than the ones that existed when it was
// pinned. "Which trips" is not a parameter: it is always every active one.
//
// The per-trip charts below ARE parameterised, by `tripId`, so the same widget pinned for two
// trips is two distinct tiles (`PinButton` keys on widget + params).
import { useMemo, useState } from 'react'
import type { Tracking } from '../../model/types'
import { tripSummary, tripDaily, type TripDay } from '../../analytics/trips'
import { daysBetween } from '../../analytics/selections'
import { useStoreState } from '../store'
import { useRateBook } from '../fxCtx'
import { useView } from '../view'
import { useNarrow } from '../responsive'
import { BarChart, BarRows, ChartCard, ChartTip, Legend, linScale, monthTicks, niceTicks, useChartTip, type BarGroup, type BarRow, type LegendItem } from '../charts'
import { EmptyState } from '../kit/EmptyState'
import { FAINT, HAIR, HAIR2, MONO, MUT, fmt, fmtK } from '../theme'
import { PinButton } from './PinButton'
import type { WidgetChrome } from './AccountsWidgets'
import type { WidgetParams } from './catalog'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMon = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`

/**
 * Trips timeline: every dated trip on one time axis, block height = spend per day.
 *
 * Rebuilt on `ChartCard` so it renders at real pixel dimensions. It used to be a
 * `viewBox="0 0 1200 148" width="100%"` SVG, which scaled its text and — worse — made every
 * measurement a viewBox unit while being reasoned about in px: the "show the €/day label when the
 * block is wider than 58" rule was comparing the wrong units and so never fired at any width.
 *
 * What you can read without hovering: when each trip was (date axis), how fast it burned money
 * (value axis + block height), and what it cost (on the label above the block, and again in the
 * legend for when labels collide).
 */
export function TripTimelineWidget({ tile, controls }: WidgetChrome) {
  const { vault } = useStoreState()
  const { goTxns } = useView()
  const rates = useRateBook()
  const narrow = useNarrow()
  const base = vault.params.baseCurrency ?? 'EUR'
  const { tip, showAt, hide } = useChartTip()

  const trips = useMemo(() => vault.trackings.filter((t) => t.kind === 'trip' && !t.archived), [vault.trackings])
  const summaries = useMemo(() => trips.map((t) => ({ tr: t, s: tripSummary(vault, t.id, base, rates) })), [trips, vault, base, rates])

  // Membership is curated, so a date range is NOT a substitute for it (route.ts) — this used to
  // drill by {from,to}, which re-showed excluded rows and every non-member in the window.
  const onOpen = (tr: Tracking) => goTxns({ tracking: tr.id })
  // The EFFECTIVE span, not the stored window: a trip tagged row-by-row has a one-day window and
  // was drawn as a 10px sliver however many weeks it actually covered.
  const dated = summaries.filter((x) => x.s.spanFrom && x.s.spanTo)
  if (dated.length === 0) return null

  const lo = dated.reduce((m, x) => (x.s.spanFrom! < m ? x.s.spanFrom! : m), dated[0]!.s.spanFrom!)
  const hi = dated.reduce((m, x) => (x.s.spanTo! > m ? x.s.spanTo! : m), dated[0]!.s.spanTo!)
  const span = Math.max(1, daysBetween(lo, hi))
  const maxPerDay = Math.max(1, ...dated.map((x) => x.s.perDay))
  const { top, ticks } = niceTicks(maxPerDay, 2)
  const sorted = [...dated].sort((a, b) => (a.s.spanFrom! < b.s.spanFrom! ? -1 : 1))
  const CHAR_W = 6.1 // px per mono char at fontSize 10
  // Name AND total on one label above the block. Putting the total under the block instead would
  // land it on the date axis — same y, overlapping text.
  const labelFor = (tr: Tracking, s: ReturnType<typeof tripSummary>) =>
    `${tr.name.split(/[·|]/)[0]!.trim()} ${fmtK(s.total)}`

  return (
    <ChartCard
      title="Trip timeline"
      subtitle="Height is spend per day (left axis) — equal heights mean an equal daily rate, not an equal total."
      explain="trips.timeline"
      testid="trips-timeline"
      height={narrow ? 190 : 220}
      ariaLabel="Trips on a time axis; block height is spend per day"
      controls={tile ? controls : <PinButton widget="trips.timeline" params={{}} />}
      footer={
        <TimelineFooter rows={sorted} onOpen={onOpen} />
      }
    >
      {(size) => {
        const pad = { l: narrow ? 46 : 54, r: 10, t: 22, b: 26 }
        const plot = { l: pad.l, r: size.width - pad.r, t: pad.t, b: size.height - pad.b }
        const x = linScale([0, span], [plot.l, plot.r])
        const y = linScale([0, top], [plot.b, plot.t])
        const xd = (d: string) => x(daysBetween(lo, d))

        // Lay labels left-to-right, stacking upward: a label takes the lowest lane whose last
        // label it does not overlap, and sits at least 13px above that lane's own last label.
        //
        // Two lanes and a y measured from the block's own top were not enough — trips a few days
        // apart put two labels on "lane 1" at identical y, still overlapping. Lanes are unbounded
        // and each is anchored to the lane below it, so the stack is always monotonic; a label
        // that would climb out of the plot is dropped rather than drawn on top of another. The
        // legend under the chart carries every trip's figures, so nothing is lost by dropping one.
        const pos = new Map<string, { x: number; y: number }>()
        const laneEnd: number[] = []
        const laneY: number[] = []
        for (const { tr, s } of sorted) {
          const bx = xd(s.spanFrom!)
          const bw = Math.max(4, xd(s.spanTo!) - bx)
          const tw = labelFor(tr, s).length * CHAR_W
          const x0 = Math.max(plot.l, Math.min(plot.r - tw, bx + bw / 2 - tw / 2))
          let ln = 0
          while (ln < laneEnd.length && x0 <= laneEnd[ln]! + 8) ln++
          const own = y(Math.min(s.perDay, top)) - 6
          const ly = ln === 0 ? own : Math.min(own, laneY[ln - 1]! - 13)
          laneEnd[ln] = x0 + tw
          laneY[ln] = ly
          if (ly >= plot.t) pos.set(tr.id, { x: x0, y: ly })
        }

        return (
          <>
          <svg width={size.width} height={size.height} style={{ display: 'block' }}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={plot.l} x2={plot.r} y1={y(v)} y2={y(v)} stroke={HAIR2} strokeWidth={1} />
                {/* Money only — a "/day" suffix on the top tick overflows the gutter and clips its
                    leading symbol. The subtitle already says the axis is a daily rate. */}
                <text x={plot.l - 8} y={y(v) + 3.5} textAnchor="end" fontFamily="IBM Plex Mono" fontSize={10} fill={FAINT}>{fmtK(v)}</text>
              </g>
            ))}
            {monthTicks(lo, hi, narrow ? 3 : 6).map((t) => (
              <g key={t.date}>
                <line x1={xd(t.date)} x2={xd(t.date)} y1={plot.t} y2={plot.b} stroke={HAIR2} strokeWidth={1} strokeDasharray="2 3" />
                <text x={xd(t.date)} y={plot.b + 15} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize={10} fill={FAINT}>{t.label}</text>
              </g>
            ))}
            <line x1={plot.l} x2={plot.r} y1={plot.b} y2={plot.b} stroke={HAIR} strokeWidth={1} />
            {sorted.map(({ tr, s }) => {
              const bx = xd(s.spanFrom!)
              const bw = Math.max(4, xd(s.spanTo!) - bx)
              const by = y(Math.min(s.perDay, top))
              const label = labelFor(tr, s)
              const at = pos.get(tr.id)
              const tipContent = (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>{tr.name}</div>
                  <div style={{ opacity: 0.75 }}>{dayMon(s.spanFrom!)} – {dayMon(s.spanTo!)}</div>
                  <div><b style={{ fontWeight: 600 }}>{fmt(s.total)}</b> · {s.days} day{s.days === 1 ? '' : 's'} · {fmt(s.perDay)}/day</div>
                  <div style={{ opacity: 0.6, marginTop: 3 }}>click to open these transactions</div>
                </>
              )
              return (
                <g key={tr.id}>
                  <rect
                    data-timeline-trip={tr.id}
                    x={bx}
                    y={by}
                    width={bw}
                    height={Math.max(0, plot.b - by)}
                    rx={3}
                    fill={tr.color ?? 'var(--ink)'}
                    opacity={0.5}
                    tabIndex={0}
                    role="button"
                    aria-label={`${tr.name}, ${dayMon(s.spanFrom!)} to ${dayMon(s.spanTo!)}, ${fmt(s.total)}: open transactions`}
                    onClick={() => onOpen(tr)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpen(tr)
                      }
                    }}
                    onPointerMove={(e) => showAt(e.clientX, e.clientY, tipContent)}
                    onPointerLeave={hide}
                    style={{ cursor: 'pointer' }}
                  />
                  {at && <text x={at.x} y={at.y} fontFamily="IBM Plex Mono" fontSize={10} fill={MUT}>{label}</text>}
                </g>
              )
            })}
          </svg>
          <ChartTip tip={tip} />
          </>
        )
      }}
    </ChartCard>
  )
}

/**
 * Every trip's figures as a legend under the plot.
 *
 * A narrow block cannot carry a label, and on a phone most blocks are narrow — so "you can read
 * each trip's cost without hovering" only holds at every width if it is stated somewhere that does
 * not depend on the block's width. Listing all of them rather than only the unlabelled ones keeps
 * this a legend (stable, in date order) instead of a set that reshuffles as the window resizes.
 */
function TimelineFooter({ rows, onOpen }: { rows: { tr: Tracking; s: ReturnType<typeof tripSummary> }[]; onOpen: (tr: Tracking) => void }) {
  if (rows.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 10, paddingTop: 8, borderTop: `1px solid ${HAIR2}` }}>
      {rows.map(({ tr, s }) => (
        <button
          key={tr.id}
          onClick={() => onOpen(tr)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 10, color: FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 2, background: tr.color ?? 'var(--cmpa)' }} />
          <span style={{ color: MUT }}>{tr.name.split(/[·|]/)[0]!.trim()}</span>
          <span>{fmt(s.total)} · {fmt(s.perDay)}/day</span>
        </button>
      ))}
    </div>
  )
}

/** The trip a per-trip widget is pointed at, or null when its `tripId` no longer resolves. */
function useTrip(params: WidgetParams): Tracking | null {
  const { vault } = useStoreState()
  const tripId = String(params.tripId ?? '')
  return vault.trackings.find((t) => t.id === tripId) ?? null
}

const gone = (
  <EmptyState basis="filtered" title="That trip no longer exists." body="Pin this chart again from a trip to point it somewhere." />
)

/**
 * Spend per day across one trip's span, stacked by category — the same shape Trends uses for a
 * month, so a day of a trip reads the way a month of the year does: a total you can compare at a
 * glance, and the mix that made it up.
 */
export function TripDailyWidget({ params, tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const { vault } = useStoreState()
  const { goTxns } = useView()
  const rates = useRateBook()
  const narrow = useNarrow()
  const base = vault.params.baseCurrency ?? 'EUR'
  const tr = useTrip(params)
  const days = useMemo(() => (tr ? tripDaily(vault, tr.id, base, rates) : []), [tr, vault, base, rates])
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [hoverCat, setHoverCat] = useState<string | null>(null)

  const cat = (id: string) => vault.categories.find((c) => c.id === id)

  if (!tr) return <ChartCard title="Daily spend" testid="trip-chart-daily" height={narrow ? 170 : 200}>{() => gone}</ChartCard>

  // Categories present in this trip, largest first — so the stack order is stable and the legend
  // reads top-down in the order the colours appear.
  const totals = new Map<string, number>()
  for (const d of days) for (const [id, v] of Object.entries(d.byCategory)) totals.set(id, (totals.get(id) ?? 0) + v)
  const catIds = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

  const dayTotal = (d: TripDay) => catIds.reduce((s, id) => s + (hidden.has(id) ? 0 : (d.byCategory[id] ?? 0)), 0)
  // Keyed by date so the tooltip is a lookup rather than a scan of every day on every hover.
  const visibleTotal = new Map(days.map((d) => [d.date, dayTotal(d)]))
  const max = Math.max(1, ...visibleTotal.values())
  const { top, ticks } = niceTicks(max, 4)
  // At most ~10 x labels: a three-week trip would otherwise print 21 overlapping dates.
  const step = Math.max(1, Math.ceil(days.length / 10))
  const groups: BarGroup[] = days.map((d, i) => ({
    key: d.date,
    label: i % step === 0 ? String(Number(d.date.slice(8, 10))) : '',
    segs: catIds.map((id) => ({ id, color: cat(id)?.color ?? 'var(--c-other)', value: d.byCategory[id] ?? 0, name: cat(id)?.name ?? '—' })),
  }))
  const legendItems: LegendItem[] = catIds.map((id) => ({
    id,
    label: cat(id)?.name ?? '—',
    color: cat(id)?.color ?? 'var(--c-other)',
    value: fmtK(totals.get(id) ?? 0),
  }))

  return (
    <ChartCard
      title={`${tr.name} · daily spend`}
      subtitle={`${days.length} day${days.length === 1 ? '' : 's'} · stacked by category · click a bar for its rows`}
      explain="trips.daily"
      testid="trip-chart-daily"
      height={narrow ? 200 : 240}
      ariaLabel={`Daily spend across ${tr.name}, by category`}
      controls={tile ? controls : <PinButton widget="trips.daily" params={{ tripId: tr.id }} name={`${tr.name} · daily spend`} />}
      footer={<Legend items={legendItems} hidden={hidden} onToggle={(id) => setHidden((h) => { const n = new Set(h); n.has(id) ? n.delete(id) : n.add(id); return n })} onHover={setHoverCat} />}
    >
      {(size) => (
        <BarChart
          width={size.width}
          height={size.height}
          groups={groups}
          yMax={top}
          yTicks={ticks.map((v) => ({ v, label: fmtK(v) }))}
          hidden={hidden}
          hoverId={hoverCat}
          onSegClick={(date, segId) => goTxns({ tracking: tr.id, cat: segId, from: date, to: date })}
          tipContent={(g, seg) => (
            <>
              <div style={{ opacity: 0.6, marginBottom: 3 }}>{seg.name} · {dayMon(g.key)}</div>
              <div><b style={{ fontWeight: 600 }}>{fmt(seg.value)}</b> of {fmt(visibleTotal.get(g.key) ?? 0)} that day</div>
              <div style={{ opacity: 0.6, marginTop: 3 }}>click to open these transactions</div>
            </>
          )}
          ariaLabel={`Daily spend across ${tr.name}, by category`}
        />
      )}
    </ChartCard>
  )
}

/** One trip's whole category mix — every category, not a top-five. */
export function TripCategoriesWidget({ params, tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const { vault } = useStoreState()
  const { goTxns } = useView()
  const rates = useRateBook()
  const narrow = useNarrow()
  const base = vault.params.baseCurrency ?? 'EUR'
  const tr = useTrip(params)
  const s = useMemo(() => (tr ? tripSummary(vault, tr.id, base, rates) : null), [tr, vault, base, rates])

  if (!tr || !s) return <ChartCard title="Trip categories" testid="trip-chart-cats" height={narrow ? 170 : 200}>{() => gone}</ChartCard>

  const max = Math.max(1, ...s.byCategory.map((c) => c.spend))
  const rows: BarRow[] = s.byCategory.map((c) => {
    const cat = vault.categories.find((x) => x.id === c.categoryId)
    return {
      key: c.categoryId,
      label: cat?.name ?? '—',
      frac: c.spend / max,
      value: fmt(c.spend),
      color: cat?.color ?? 'var(--c-other)',
      onClick: () => goTxns({ tracking: tr.id, cat: c.categoryId }),
    }
  })

  return (
    <ChartCard
      title={`${tr.name} · categories`}
      subtitle={`All ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} · click one for its rows`}
      explain="trips.categories"
      testid="trip-chart-cats"
      ariaLabel={`Category breakdown for ${tr.name}`}
      controls={tile ? controls : <PinButton widget="trips.categories" params={{ tripId: tr.id }} name={`${tr.name} · categories`} />}
    >
      {(size) => (
        <div style={size.fullscreen ? undefined : { maxHeight: 340, overflowY: 'auto' }}>
          {rows.length === 0 ? (
            <div style={{ fontSize: 12.5, color: FAINT, padding: '14px 0' }}>No spend tagged to this trip yet.</div>
          ) : (
            <BarRows rows={rows} labelWidth={130} />
          )}
        </div>
      )}
    </ChartCard>
  )
}
