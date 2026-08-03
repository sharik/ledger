// The Accounts charts, as components both that screen and the dashboard render.
//
// They were inline in `AccountsScreen`, which meant they could only ever be seen there. Lifting
// them changes nothing about what they draw: they still read `useDerived()` — the same hook the
// screen uses — so a pinned copy costs no extra derivation, and still shows live figures rather
// than whatever was true when it was pinned.
//
// Each widget owns the state its controls drive, seeded from its params. That is what makes the
// pin capture what you are looking at: the button reads the same state the chart just rendered.
import { useMemo, useState } from 'react'
import type { BalanceSnapshot } from '../../model/types'
import { avgMonthlyExpenses, emergencyFundMonths } from '../../model/selectors'
import { useDerived, useRawVault, useStoreState } from '../store'
import { useNarrow } from '../responsive'
import { useAsOfToday } from '../dashPeriod'
import { AMBER, CHIP, FAINT, GREEN, HAIR, HAIR2, INK, MONO, MUT, SURFACE, fmt, fmtK, netLbl } from '../theme'
import { ChartCard, LineChart } from '../charts'
import { Explain } from '../explain'
import { EmptyState } from '../kit/EmptyState'
import { SegControl } from '../kit'
import { PinButton } from './PinButton'
import type { WidgetParams } from './catalog'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMon = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`
const monthYr = (mk: string) => `${MONTHS[Number(mk.slice(5, 7)) - 1]} ’${mk.slice(2, 4)}`

export type Range = '1y' | 'all'

interface GapRun {
  startIdx: number
  endIdx: number
}

/**
 * How a widget is being shown.
 *
 * `tile` is the dashboard: the reorder cluster replaces the pin button, and the test ids and the
 * "?" stay behind on the home screen so a pinned copy cannot make either ambiguous.
 */
export interface WidgetChrome {
  tile?: boolean
  controls?: React.ReactNode
}

/**
 * "as of today" — for a tile whose figures cannot follow the Dashboard's period.
 *
 * Rendered only as a tile, and only when the header sits somewhere other than now: on its own
 * screen there is no period to be out of step with.
 */
export function AsOfToday({ tile }: { tile?: boolean }) {
  const asOf = useAsOfToday()
  if (!tile || !asOf) return null
  return (
    <span data-testid="as-of-today" style={{ fontFamily: MONO, fontSize: 9, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '2px 6px', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>
      as of today
    </span>
  )
}

/** Snapshots grouped by account, each list ascending by date. */
function groupSnapshots(snapshots: BalanceSnapshot[]): Map<string, BalanceSnapshot[]> {
  const m = new Map<string, BalanceSnapshot[]>()
  for (const s of snapshots) {
    const arr = m.get(s.accountId) ?? []
    arr.push(s)
    m.set(s.accountId, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return m
}

/** Longest interior run of series-months with no snapshot for any single account. */
function findGap(series: { mk: string }[], byAccount: Map<string, BalanceSnapshot[]>): GapRun | null {
  const n = series.length
  let best: GapRun | null = null
  let bestLen = 1
  for (const snaps of byAccount.values()) {
    const has = new Set(snaps.map((s) => s.date.slice(0, 7)))
    let first = -1
    let last = -1
    for (let i = 0; i < n; i++) {
      if (has.has(series[i]!.mk)) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0 || last <= first) continue
    let runStart = -1
    for (let i = first + 1; i < last; i++) {
      const empty = !has.has(series[i]!.mk)
      if (empty && runStart < 0) runStart = i
      if ((!empty || i === last - 1) && runStart >= 0) {
        const runEnd = empty ? i : i - 1
        const len = runEnd - runStart + 1
        if (len > bestLen) {
          bestLen = len
          best = { startIdx: runStart, endIdx: runEnd }
        }
        runStart = -1
      }
    }
  }
  return best
}

interface NwChartData {
  vals: number[]
  top: number
  bot: number
  gap: GapRun | null
  pre: { x: number; y: number }[]
  post: { x: number; y: number }[]
}

/** Net-worth line: pre/post-gap split, hatched no-statements band, crosshair tooltip. */
function NetWorthChart({ width, height, chart, series }: {
  width: number
  height: number
  chart: NwChartData
  series: { mk: string }[]
}) {
  const narrow = useNarrow()
  const n = series.length
  const yTicks = [0, 1, 2, 3].map((k) => {
    const v = chart.bot + ((chart.top - chart.bot) * k) / 3
    return { v, label: fmtK(v) }
  })
  const lineSeries = [
    ...(chart.pre.length > 1 ? [{ id: 'pre', color: MUT, points: chart.pre, strokeWidth: 2.4 }] : []),
    { id: 'post', color: INK, points: chart.post, strokeWidth: 2.4 },
  ]
  return (
    <LineChart
      width={width}
      height={height}
      pad={{ l: narrow ? 58 : 64, r: narrow ? 10 : 72 }}
      series={lineSeries}
      xDomain={[0, Math.max(1, n - 1)]}
      yDomain={[chart.bot, chart.top]}
      yTicks={yTicks}
      snapXs={Array.from({ length: n }, (_, i) => i)}
      tipContent={(i) =>
        chart.gap && i >= chart.gap.startIdx && i <= chart.gap.endIdx ? (
          <div style={{ whiteSpace: 'normal', lineHeight: 1.5, maxWidth: 200 }}>Statements missing here. Net worth uses anchors; transactions in the gap are absent.</div>
        ) : (
          <div>
            <span style={{ opacity: 0.6 }}>{monthYr(series[i]!.mk)}</span> · <b>{fmt(chart.vals[i]!)}</b>
          </div>
        )
      }
      dots={[
        ...(n > 1 ? [{ x: 0, y: chart.vals[0]!, color: MUT }] : []),
        { x: n - 1, y: chart.vals[n - 1]!, color: INK },
      ]}
      decorate={({ x, y, plot }) => {
        const bandX = chart.gap ? Math.max(plot.l, x(chart.gap.startIdx - 0.5)) : 0
        const bandW = chart.gap ? Math.min(plot.r, x(chart.gap.endIdx + 0.5)) - bandX : 0
        return (
          <>
            <defs>
              <pattern id="nwhatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" stroke={AMBER} strokeWidth="1" opacity="0.38" />
              </pattern>
            </defs>
            {chart.gap && bandW > 4 && (
              <>
                <rect x={bandX} y={plot.t} width={bandW} height={plot.b - plot.t} fill="url(#nwhatch)" />
                <rect x={bandX} y={plot.t} width={bandW} height={plot.b - plot.t} fill="transparent" stroke={AMBER} strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
                {bandW > 150 && (
                  <>
                    <text x={bandX + bandW / 2} y={(plot.t + plot.b) / 2 - 4} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="11" fill={AMBER}>statements missing</text>
                    <text x={bandX + bandW / 2} y={(plot.t + plot.b) / 2 + 12} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="10" fill={FAINT}>anchors only · no interpolation</text>
                  </>
                )}
                {bandW <= 150 && (
                  <title>statements missing — anchors only, no interpolation</title>
                )}
              </>
            )}
            {/* With no right gutter on a phone there is nowhere to hang this outside the plot,
                so it tucks above-left of the final point instead of being clipped by the edge. */}
            <text
              x={narrow ? x(n - 1) - 4 : x(n - 1) + 6}
              y={y(chart.vals[n - 1]!)}
              dy={narrow ? -8 : 3.5}
              textAnchor={narrow ? 'end' : 'start'}
              fontFamily="IBM Plex Mono"
              fontSize="11"
              fontWeight="600"
              fill={INK}
              stroke={narrow ? SURFACE : undefined}
              strokeWidth={narrow ? 3 : undefined}
              style={narrow ? { paintOrder: 'stroke' } : undefined}
              data-testid="nw-chart-last"
            >
              {fmtK(chart.vals[n - 1]!)}
            </text>
            <text x={plot.l} y={plot.b + 16} fontFamily="IBM Plex Mono" fontSize="10" fill={FAINT}>{monthYr(series[0]!.mk)}</text>
            <text x={plot.r} y={plot.b + 16} textAnchor="end" fontFamily="IBM Plex Mono" fontSize="10" fill={FAINT}>{monthYr(series[n - 1]!.mk)}</text>
          </>
        )
      }}
      ariaLabel="Net worth over time"
    />
  )
}

export function NetWorthWidget({ params, tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const narrow = useNarrow()
  const vault = useRawVault()
  const { vault: vv } = useStoreState()
  const d = useDerived()
  const hiddenCount = vault.accounts.length - vv.accounts.length
  const [range, setRange] = useState<Range>(params.range === 'all' ? 'all' : '1y')

  // Visible: the chart's gap band describes the series drawn above it, which excludes hidden accounts.
  const visSnapsByAccount = useMemo(() => groupSnapshots(vv.snapshots), [vv.snapshots])
  const fullSeries = d.netWorthByMonth
  // Stable identity: slicing inline defeated the chart memo on every render.
  const series = useMemo(() => (range === '1y' ? fullSeries.slice(-12) : fullSeries), [fullSeries, range])
  const n = series.length

  // Data-only — pixel geometry lives in the width-aware <LineChart>.
  const chart = useMemo(() => {
    if (n === 0) return null
    const vals = series.map((s) => s.nw)
    let maxV = Math.max(...vals)
    let minV = Math.min(...vals)
    if (maxV === minV) {
      const pad = Math.max(1, Math.abs(maxV) * 0.1)
      maxV += pad
      minV -= pad
    }
    const pad = (maxV - minV) * 0.15
    const top = maxV + pad
    const bot = minV - pad
    const gap = findGap(series, visSnapsByAccount)
    const pts = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => ({ x: from + k, y: vals[from + k]! }))
    const pre = gap ? pts(0, gap.startIdx) : []
    const post = gap ? pts(gap.endIdx, n - 1) : pts(0, n - 1)
    return { vals, top, bot, gap, pre, post }
  }, [series, n, visSnapsByAccount])

  // freshness footnote
  const balDates = [...d.currentBalance.values()].map((b) => b.date).sort()
  const latestDate = balDates[balDates.length - 1]
  const oldestDate = balDates[0]
  const startNw = series[0]?.nw ?? 0

  return (
    <ChartCard
      testid={tile ? undefined : 'nw-card'}
      ariaLabel="Net worth over time"
      height={240}
      title={
        // `alignItems: flex-end` with a "latest … · oldest …" line that wraps at this width
        // pushed ASSETS and LIABILITIES to different heights — the figures appeared to jump.
        // On a phone the headline gets its own block and the two totals share a row below it.
        <div style={narrow ? { display: 'block' } : { display: 'flex', gap: 36, alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 7 }}>NET WORTH{!tile && <Explain id="accounts.net-worth" size="sm" />}<AsOfToday tile={tile} /></div>
            <div data-testid={tile ? undefined : 'kpi-networth'} style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1, marginTop: 5, color: INK }}>{netLbl(d.netWorth)}</div>
            {latestDate && oldestDate && (
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 4 }}>latest {dayMon(latestDate)} · oldest {dayMon(oldestDate)}</div>
            )}
          </div>
          <div style={narrow ? { display: 'flex', gap: 28, marginTop: 12 } : { display: 'contents' }}>
            <div style={{ paddingBottom: 3 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>ASSETS</div>
              <div data-testid={tile ? undefined : 'kpi-assets'} style={{ fontSize: 16, fontWeight: 600, marginTop: 3, color: INK }}>{fmt(d.assets)}</div>
            </div>
            <div style={{ paddingBottom: 3 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>LIABILITIES</div>
              <div data-testid={tile ? undefined : 'kpi-liabilities'} style={{ fontSize: 16, fontWeight: 600, marginTop: 3, color: INK }}>{fmt(d.liabilities)}</div>
            </div>
          </div>
        </div>
      }
      controls={
        <div style={{ display: 'flex', flexDirection: narrow ? 'column-reverse' : 'column', alignItems: narrow ? 'stretch' : 'flex-end', gap: 8, width: narrow ? '100%' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SegControl<Range>
              options={[{ value: '1y', label: '1Y' }, { value: 'all', label: 'All' }]}
              value={range}
              onChange={setRange}
            />
            {tile ? controls : <PinButton widget="accounts.net-worth" params={{ range }} />}
          </div>
          {/* Right-aligned inside a 240px box is a desktop idiom; on a phone it read as text
              jammed left with the rest of the row empty. Full width, ranged left. */}
          <div style={{ fontSize: 11.5, color: FAINT, maxWidth: narrow ? 'none' : 240, textAlign: narrow ? 'left' : 'right', lineHeight: 1.5 }}>
            Δ <span>{netLbl(d.netWorth - startNw)}</span> since {series[0] ? monthYr(series[0].mk) : '—'}. Manual snapshots count; a liability nets against its matching asset.
          </div>
          {/* Without this the totals silently disagree with the rows listed below them. */}
          {hiddenCount > 0 && (
            <div data-testid={tile ? undefined : 'hidden-accounts-note'} style={{ fontFamily: MONO, fontSize: 10, color: FAINT, textAlign: 'right' }}>
              {hiddenCount} hidden account{hiddenCount === 1 ? '' : 's'} excluded
            </div>
          )}
        </div>
      }
    >
      {({ width, height }) =>
        chart ? (
          <NetWorthChart width={width} height={height} chart={chart} series={series} />
        ) : (
          <EmptyState
            testid={tile ? undefined : 'nw-empty'}
            dense
            basis={vault.accounts.length === 0 ? 'no-data' : 'thin-history'}
            title={vault.accounts.length === 0 ? 'No accounts yet.' : 'No balance history yet.'}
            body={
              vault.accounts.length === 0
                ? 'Net worth comes from dated balance snapshots — add an account to start one.'
                : 'Net worth is drawn from balance snapshots. Add one to an account below, or import a statement so Ledger can anchor it.'
            }
          />
        )
      }
    </ChartCard>
  )
}

/** Months of expenses the liquid accounts cover, against the target in Settings. */
export function EmergencyFundWidget({ tile, controls }: WidgetChrome) {
  const vault = useRawVault()
  const d = useDerived()
  const efMonths = emergencyFundMonths(d)
  const efTarget = vault.params.efTarget || 6
  const efSixMo = avgMonthlyExpenses(d) * efTarget

  return (
    <section style={{ flex: 1, minWidth: 0, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK, display: 'flex', alignItems: 'center', gap: 7 }}>Emergency fund{!tile && <Explain id="accounts.months-cover" size="sm" />}<AsOfToday tile={tile} /></div>
        {tile ? controls : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>liquid ÷ expenses</span>
            <PinButton widget="accounts.emergency" params={{}} />
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 8 }}>
        <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1, color: INK }}>{efMonths === null ? '—' : efMonths.toFixed(1)}</div>
        <div style={{ fontSize: 12, color: FAINT, paddingBottom: 2 }}>{efMonths === null ? 'no expense history yet' : `of ${efTarget} months covered`}</div>
      </div>
      <div style={{ position: 'relative', height: 10, background: CHIP, borderRadius: 5, marginTop: 14 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, ((efMonths ?? 0) / efTarget) * 100)}%`, background: GREEN, borderRadius: 5 }} />
        <div style={{ position: 'absolute', left: '100%', top: -4, bottom: -4, width: 1.5, background: FAINT, transform: 'translateX(-1px)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>{fmt(d.liquid)}</span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: MUT }}>{efTarget} mo = {fmt(efSixMo)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 'auto', paddingTop: 14, borderTop: `1px solid ${HAIR2}` }}>
        Liquid balance ÷ avg monthly expenses (<b>{fmt(avgMonthlyExpenses(d))}/mo</b>). {efTarget} months = <b>{fmt(efSixMo)}</b>.
      </div>
    </section>
  )
}
