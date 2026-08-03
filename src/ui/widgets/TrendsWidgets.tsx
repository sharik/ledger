// The three Trends charts, as components both that screen and the dashboard render.
//
// Trends is where most of the app's charts live, and until now none of them could be seen
// anywhere else. The charts themselves are unchanged; what moved is where their state comes from.
//
// Each widget seeds its controls from its params and then owns them, so pinning captures the view
// you are looking at — a monthly chart pinned in "By category" with Groceries hidden comes back
// that way. The exception is the legend, which on Trends is deliberately *shared*: hiding a
// category in the yearly legend hides it in the monthly chart too. A widget that is handed
// `shared` legend state uses it; one standing alone on the dashboard keeps its own.
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useDerived, useStoreState } from '../store'
import { useView } from '../view'
import { addMonths, daysInMonth, monthShort, todayStr } from '../../model/selectors'
import { isCashflow } from '../../model/types'
import { accountCurrencyMap, rowCurrency } from '../../import/fx'
import { useRateBook } from '../fxCtx'
import { useAnchorMonth } from '../dashPeriod'
import { monthEndProjection, yearEndProjection } from '../../analytics/project'
import { ACCENT, CHIP, FAINT, HAIR, INK, MONO, MUT, SURFACE, curSym, fmt, fmtK } from '../theme'
import { BarChart, BarRows, ChartCard, Legend, niceCeil, type BarGroup, type LegendItem } from '../charts'
import { EmptyState } from '../kit/EmptyState'
import { Explain } from '../explain'
import { PinButton } from './PinButton'
import type { WidgetChrome } from './AccountsWidgets'
import type { WidgetParams } from './catalog'

const pad2 = (n: number) => String(n).padStart(2, '0')
const monthStart = (mk: string) => `${mk}-01`
const monthEnd = (mk: string) => `${mk}-${pad2(daysInMonth(mk))}`

// --- segmented control (mirrors the mock's [data-seg] blocks) ---
const segWrap: CSSProperties = { display: 'inline-flex', gap: 1, background: CHIP, borderRadius: 6, padding: 2 }
function segBtn(on: boolean, font: number, pad: string): CSSProperties {
  return { fontSize: font, color: on ? INK : FAINT, padding: pad, borderRadius: 5, background: on ? SURFACE : 'transparent', border: 'none', cursor: 'pointer' }
}

function Seg<T extends string>({ options, value, onChange, font = 11.5, pad = '5px 10px' }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  font?: number
  pad?: string
}) {
  return (
    <div style={segWrap}>
      {options.map((o) => {
        const on = o.value === value
        return <button key={o.value} aria-pressed={on} onClick={() => onChange(o.value)} style={segBtn(on, font, pad)}>{o.label}</button>
      })}
    </div>
  )
}

export type MonthMode = 'total' | 'cat'
export type MonthWindow = '18M' | 'All'
export type DrillRange = '3M' | '1Y' | 'All'

/** Legend state, hidden categories and the hover highlight. */
export interface LegendState {
  hiddenCats: ReadonlySet<string>
  toggleCat: (id: string) => void
  hoverCat: string | null
  setHoverCat: (id: string | null) => void
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * Legend state for one chart, seeded from its params.
 *
 * Called with the screen's shared state on Trends, where both charts must agree, and without it
 * on the dashboard, where a pinned chart's legend is nobody else's business.
 */
export function useLegendState(seed: string[], shared?: LegendState): LegendState {
  const [hiddenCats, setHiddenCats] = useState<ReadonlySet<string>>(() => new Set(seed))
  const [hoverCat, setHoverCat] = useState<string | null>(null)
  const own: LegendState = {
    hiddenCats,
    hoverCat,
    setHoverCat,
    toggleCat: (id) =>
      setHiddenCats((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
  }
  return shared ?? own
}

/** The screen-level legend both Trends charts share. */
export function useSharedLegend(): LegendState {
  return useLegendState([])
}

/** Spending categories: everything except Income and the Transfers pseudo-category. */
function useSpendable() {
  const { vault } = useStoreState()
  const d = useDerived()
  const spendable = useMemo(
    () => vault.categories.filter((c) => c.role !== 'income' && c.role !== 'transfers'),
    [vault.categories],
  )
  return { spendable, spentOf: (mk: string, catId: string) => d.spentByCatMonth.get(`${mk}|${catId}`) ?? 0 }
}

/**
 * Switching a legend item off does not merely hide a stack: it recomputes the figure under
 * every bar, the axis, and the year-end projection — all still labelled only with the year.
 * A reader who focused on one category would believe they were seeing that year's spending.
 * Say so whenever anything is hidden.
 */
function filteredNoteOf(items: LegendItem[], hidden: ReadonlySet<string>, tile?: boolean) {
  const shown = items.filter((i) => !hidden.has(i.id)).length
  if (shown >= items.length) return null
  return (
    <span data-testid={tile ? undefined : 'trends-legend-note'} style={{ color: 'var(--warn)' }}>
      Showing {shown} of {items.length} categories — every total here counts only those ·{' '}
    </span>
  )
}

export function YearlyTrendWidget({ params, tile, controls, shared }: { params: WidgetParams; shared?: LegendState } & WidgetChrome) {
  const d = useDerived()
  const { goTxns } = useView()
  const { spendable, spentOf } = useSpendable()
  const legend = useLegendState(asStrings(params.hiddenCats), shared)
  const { hiddenCats, toggleCat, hoverCat, setHoverCat } = legend

  // The month the screen is pointed at — `currentMonthKey()` everywhere except the dashboard,
  // where the header's stepper supplies it. `today` stays the REAL clock: `yearEndProjection`
  // already returns the year-to-date unchanged for a year that is not the current one, so an
  // anchored past year reports what it cost instead of a projection it cannot have.
  const cm = useAnchorMonth()
  const today = todayStr()
  const currentYear = Number(cm.slice(0, 4))

  const yearly = useMemo(() => {
    const years = [...new Set(d.monthsTracked.map((mk) => Number(mk.slice(0, 4))))].sort((a, b) => a - b)
    const cols = years.map((year) => {
      const segs = spendable
        .map((c) => {
          let val = 0
          for (let mo = 1; mo <= 12; mo++) val += spentOf(`${year}-${pad2(mo)}`, c.id)
          return { id: c.id, name: c.name, color: c.color, val }
        })
        .filter((s) => s.val > 0)
      return { year, segs }
    })
    // Legend lists only categories with any spend at all; totals over all years.
    const legendTotals = new Map<string, number>()
    for (const col of cols) for (const s of col.segs) legendTotals.set(s.id, (legendTotals.get(s.id) ?? 0) + s.val)
    return { years, cols, legendTotals }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, spendable])

  // Visible (legend-filtered) totals drive both the axis and the projection.
  const yearlyVisible = useMemo(() => {
    const totals = yearly.cols.map((c) => c.segs.reduce((s, x) => s + (hiddenCats.has(x.id) ? 0 : x.val), 0))
    const ytd = totals[yearly.years.indexOf(currentYear)] ?? 0
    const projected = ytd > 0 ? yearEndProjection(ytd, currentYear, today) : 0
    const axisMax = 4 * niceCeil(Math.max(1, projected, ...totals) / 4)
    return { totals, projected, axisMax }
  }, [yearly, hiddenCats, currentYear, today])

  const yearlyGroups: BarGroup[] = yearly.cols.map((col) => ({
    key: String(col.year),
    label: '', // year + total rendered via decorate (two-line label)
    segs: col.segs.map((s) => ({ id: s.id, color: s.color, value: s.val, name: s.name })),
    projTo: col.year === currentYear && yearlyVisible.projected > 0 ? yearlyVisible.projected : undefined,
    labelEmph: col.year === currentYear,
  }))

  const legendItems: LegendItem[] = spendable
    .filter((c) => (yearly.legendTotals.get(c.id) ?? 0) > 0)
    .map((c) => ({ id: c.id, label: c.name, color: c.color, value: fmtK(yearly.legendTotals.get(c.id) ?? 0) }))

  const catName = (id: string) => d.catById.get(id)?.name ?? ''

  return (
    <ChartCard
      testid={tile ? undefined : 'trend-yearly'}
      explain={tile ? undefined : 'trends.year-projection'}
      ariaLabel="Yearly spending, stacked by category"
      title={`Yearly spending — ${curSym()}`}
      subtitle={<>{filteredNoteOf(legendItems, hiddenCats, tile)}Stacked by category · {currentYear} dashed = projected year-end · YTD + recent pace ≈ <span>{fmtK(yearlyVisible.projected)}</span> · click a segment for its transactions</>}
      height={320}
      controls={tile ? controls : <PinButton widget="trends.yearly" params={{ hiddenCats: [...hiddenCats] }} />}
      footer={<Legend items={legendItems} hidden={hiddenCats} onToggle={toggleCat} onHover={setHoverCat} />}
    >
      {({ width, height }) => (
        <BarChart
          width={width}
          height={height}
          pad={{ b: 40 }}
          groups={yearlyGroups}
          yMax={yearlyVisible.axisMax}
          yTicks={[0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: f * yearlyVisible.axisMax, label: fmtK(f * yearlyVisible.axisMax) }))}
          hidden={hiddenCats}
          hoverId={hoverCat}
          onSegClick={(year, segId) => goTxns({ cat: segId, from: `${year}-01-01`, to: `${year}-12-31` })}
          tipContent={(g, seg) => (
            <>
              <div style={{ opacity: 0.6, marginBottom: 3 }}>{catName(seg.id)} · {g.key}</div>
              <div><b style={{ fontWeight: 600 }}>{fmt(seg.value)}</b> of {fmt(yearlyVisible.totals[yearly.years.indexOf(Number(g.key))] ?? 0)} that year</div>
              <div style={{ opacity: 0.6, marginTop: 3 }}>click to open these transactions</div>
            </>
          )}
          decorate={({ xc, y, plot }) => (
            <>
              {yearly.cols.map((col, ci) => (
                <g key={col.year}>
                  <text x={xc(ci)} y={plot.b + 16} textAnchor="middle" fontFamily={MONO} fontSize={11} fill={col.year === currentYear ? ACCENT : MUT}>{col.year}</text>
                  <text x={xc(ci)} y={plot.b + 30} textAnchor="middle" fontFamily={MONO} fontSize={9.5} fill={FAINT}>{fmtK(yearlyVisible.totals[ci] ?? 0)}{col.year === currentYear ? ' YTD' : ''}</text>
                </g>
              ))}
              {yearlyVisible.projected > 0 && yearly.years.includes(currentYear) && (
                <text x={xc(yearly.years.indexOf(currentYear))} y={Math.max(12, y(yearlyVisible.projected) - 6)} textAnchor="middle" fontFamily={MONO} fontSize={10} fill={FAINT}>proj {fmtK(yearlyVisible.projected)}</text>
              )}
            </>
          )}
          ariaLabel="Yearly spending, stacked by category"
        />
      )}
    </ChartCard>
  )
}

export function MonthlyTrendWidget({ params, tile, controls, shared }: { params: WidgetParams; shared?: LegendState } & WidgetChrome) {
  const d = useDerived()
  const { goTxns } = useView()
  const { spendable, spentOf } = useSpendable()
  const legend = useLegendState(asStrings(params.hiddenCats), shared)
  const { hiddenCats, toggleCat, hoverCat, setHoverCat } = legend

  const cm = useAnchorMonth()
  const today = todayStr()
  const [monthMode, setMonthMode] = useState<MonthMode>(params.monthMode === 'cat' ? 'cat' : 'total')
  const [monthWindow, setMonthWindow] = useState<MonthWindow>(params.monthWindow === 'All' ? 'All' : '18M')
  const [rollOn, setRollOn] = useState(params.rollOn === true)

  const months = useMemo(() => {
    if (monthWindow === '18M') return Array.from({ length: 18 }, (_, i) => addMonths(cm, -17 + i))
    const first = d.monthsTracked[0] ?? cm
    const out: string[] = []
    for (let mk = first; mk <= cm; mk = addMonths(mk, 1)) out.push(mk)
    return out
  }, [cm, monthWindow, d.monthsTracked])
  // The PARTIAL month is the real current month, never the anchor: stepping the
  // dashboard back to a finished month must not hatch it, project it, or drop it
  // from the rolling average. In a stepped-back window this is simply -1.
  const curIdx = months.indexOf(d.currentMonth)

  const monthExpVisible = useMemo(
    () => months.map((mk) => spendable.reduce((s, c) => s + (hiddenCats.has(c.id) ? 0 : spentOf(mk, c.id)), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [months, spendable, hiddenCats, d],
  )
  const projCur = curIdx >= 0 ? monthEndProjection(monthExpVisible[curIdx] ?? 0, d.currentMonth, today) : 0
  const axisMaxM = niceCeil(Math.max(1, projCur, ...monthExpVisible))

  // 3-month rolling average over COMPLETE months only — the partial current
  // month used to drag the line down at the right edge.
  const rolling = useMemo(
    () =>
      monthExpVisible.map((_, i) => {
        if (i === curIdx) return null
        let sum = 0
        let c = 0
        for (let j = Math.max(0, i - 2); j <= i; j++) {
          if (j === curIdx) continue
          sum += monthExpVisible[j]!
          c++
        }
        return c > 0 ? sum / c : null
      }),
    [monthExpVisible, curIdx],
  )

  const monthlyGroups: BarGroup[] = months.map((mk, i) => {
    const isCur = mk === d.currentMonth
    const label =
      monthWindow === '18M'
        ? i % 3 === 0 || isCur
          ? monthShort(mk)
          : ''
        : mk.endsWith('-01') || isCur
          ? mk.endsWith('-01')
            ? `${monthShort(mk)} ${mk.slice(2, 4)}’`
            : monthShort(mk)
          : ''
    return {
      key: mk,
      label,
      labelEmph: isCur,
      hatched: isCur,
      projTo: isCur && monthMode === 'total' ? projCur : undefined,
      segs:
        monthMode === 'total'
          ? [{ id: 'total', color: MUT, value: monthExpVisible[i]!, name: 'total' }]
          : spendable.map((c) => ({ id: c.id, color: c.color, value: spentOf(mk, c.id), name: c.name })),
    }
  })
  const janBoundaries = months.map((mk, i) => (i > 0 && mk.endsWith('-01') ? i : -1)).filter((i) => i > 0)

  const monthLegendTotals = useMemo(() => {
    const t = new Map<string, number>()
    for (const mk of months) for (const c of spendable) t.set(c.id, (t.get(c.id) ?? 0) + spentOf(mk, c.id))
    return t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, spendable, d])
  const monthLegendItems: LegendItem[] = spendable
    .filter((c) => (monthLegendTotals.get(c.id) ?? 0) > 0)
    .map((c) => ({ id: c.id, label: c.name, color: c.color, value: fmtK(monthLegendTotals.get(c.id) ?? 0) }))

  const catName = (id: string) => d.catById.get(id)?.name ?? ''

  return (
    <ChartCard
      testid={tile ? undefined : 'trend-monthly'}
      explain={tile ? undefined : 'trends.year-projection'}
      ariaLabel="Monthly spending"
      title={`Monthly spending — ${curSym()}`}
      subtitle={<>{monthMode === 'cat' ? filteredNoteOf(monthLegendItems, hiddenCats, tile) : null}{monthWindow === '18M' ? 'Last 18 months' : 'All history'}{curIdx >= 0 ? ' · current month hatched (partial)' : ''} · click a bar for its transactions</>}
      height={300}
      controls={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Seg<MonthMode> options={[{ value: 'total', label: 'Total' }, { value: 'cat', label: 'By category' }]} value={monthMode} onChange={setMonthMode} />
          <div style={segWrap}>
            <button aria-pressed={rollOn} onClick={() => setRollOn(!rollOn)} style={segBtn(rollOn, 11.5, '5px 10px')}>3-mo avg</button>
          </div>
          <Seg<MonthWindow> options={[{ value: '18M', label: '18M' }, { value: 'All', label: 'All' }]} value={monthWindow} onChange={setMonthWindow} font={11} pad="5px 9px" />
          {tile ? controls : <PinButton widget="trends.monthly" params={{ monthMode, monthWindow, rollOn, hiddenCats: [...hiddenCats] }} />}
        </div>
      }
      footer={monthMode === 'cat' ? <Legend items={monthLegendItems} hidden={hiddenCats} onToggle={toggleCat} onHover={setHoverCat} /> : rollOn ? <div style={{ fontSize: 11.5, color: ACCENT, marginTop: 6 }}>— 3-month rolling average (complete months)</div> : undefined}
    >
      {({ width, height }) => (
        <BarChart
          width={width}
          height={height}
          groups={monthlyGroups}
          yMax={axisMaxM}
          yTicks={[0, 1 / 3, 2 / 3, 1].map((f) => ({ v: f * axisMaxM, label: fmtK(f * axisMaxM) }))}
          hidden={monthMode === 'cat' ? hiddenCats : undefined}
          hoverId={monthMode === 'cat' ? hoverCat : null}
          boundaries={janBoundaries}
          overlay={rollOn ? { color: ACCENT, values: rolling } : undefined}
          onSegClick={(mk, segId) =>
            segId === 'total'
              ? goTxns({ from: monthStart(mk), to: monthEnd(mk) })
              : goTxns({ cat: segId, from: monthStart(mk), to: monthEnd(mk) })
          }
          tipContent={(g, seg) => (
            <>
              <div style={{ opacity: 0.6, marginBottom: 3 }}>{seg.id === 'total' ? '' : `${catName(seg.id)} · `}{monthShort(g.key)} {g.key.slice(0, 4)}{g.key === d.currentMonth ? ' (partial)' : ''}</div>
              <div><b style={{ fontWeight: 600 }}>{fmt(seg.value)}</b>{seg.id !== 'total' && <> of {fmt(monthExpVisible[months.indexOf(g.key)] ?? 0)} that month</>}</div>
              {g.key === d.currentMonth && monthMode === 'total' && <div style={{ opacity: 0.6, marginTop: 3 }}>proj ≈ {fmt(projCur)}</div>}
              <div style={{ opacity: 0.6, marginTop: 3 }}>click to open these transactions</div>
            </>
          )}
          ariaLabel="Monthly spending"
        />
      )}
    </ChartCard>
  )
}

export function DrillTrendWidget({ params, tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const { vault } = useStoreState()
  const d = useDerived()
  const rb = useRateBook()
  const { goTxns } = useView()
  const { spendable } = useSpendable()
  const cm = useAnchorMonth()

  const [drillRange, setDrillRange] = useState<DrillRange>(params.drillRange === '3M' ? '3M' : params.drillRange === 'All' ? 'All' : '1Y')
  // A pinned category that has since been deleted falls back the same way a fresh screen does.
  const seedCat = typeof params.drillCat === 'string' ? params.drillCat : ''
  const [drillCat, setDrillCat] = useState<string>(
    () => (seedCat && spendable.some((c) => c.id === seedCat) ? seedCat : spendable.find((c) => c.name === 'Groceries')?.id ?? spendable[0]?.id ?? ''),
  )

  const drill = useMemo(() => {
    const back = drillRange === '3M' ? 3 : drillRange === '1Y' ? 12 : 240
    const from = addMonths(cm, -(back - 1)) + '-01'
    // Bounded at BOTH ends. Only `from` was ever checked, which was invisible while the window
    // always ended at today — anchored to a past month it put later transactions inside a range
    // labelled "3M", so the bars did not belong to the window named above them.
    const to = monthEnd(cm)
    // The equal-length window before this one, for the Δ column. Keyed by the same raw
    // `t.merchant` as the bars — grouping by a normalized key here would desynchronize the
    // Δ from the exact-match filter `goTxns({ merchant })` opens. "All" has no prior window.
    const hasPrev = drillRange !== 'All'
    const prevFrom = addMonths(cm, -(2 * back - 1)) + '-01'
    const prevTo = monthEnd(addMonths(cm, -back))
    const byMerchant = new Map<string, number>()
    const prevByMerchant = new Map<string, number>()
    // Same read model as the chart above: cashflow rows only (a transfer leg with a
    // category must not appear as a "merchant"), converted to base at the row's date —
    // a ¥59,290 charge is ~€360 here, not 59,290. No rate ⇒ excluded honestly.
    const accountCur = accountCurrencyMap(vault)
    for (const t of vault.transactions) {
      if (t.categoryId !== drillCat || t.amount >= 0 || !isCashflow(t)) continue
      const inWindow = t.date >= from && t.date <= to
      const inPrev = hasPrev && t.date >= prevFrom && t.date <= prevTo
      if (!inWindow && !inPrev) continue
      const conv = rb.convert(t.amount, rowCurrency(t, accountCur, rb.base), t.date)
      if (!conv) continue
      const map = inWindow ? byMerchant : prevByMerchant
      map.set(t.merchant, (map.get(t.merchant) ?? 0) - conv.value)
    }
    const rows = [...byMerchant.entries()]
      .map(([name, val]) => ({ name, val, prev: hasPrev ? (prevByMerchant.get(name) ?? 0) : null }))
      .sort((a, b) => b.val - a.val)
      .slice(0, 8)
    const max = rows.length ? rows[0]!.val : 1
    // total over ALL merchants in the window, not just the top-8 shown
    const total = [...byMerchant.values()].reduce((s, v) => s + v, 0)
    const cat = d.catById.get(drillCat)
    // `merchantCount` exists so the caption can say "top 8 of N": the heading totals every
    // merchant, but only eight get a bar, so the rows visibly do not sum to the figure above.
    return { rows, max, total, merchantCount: byMerchant.size, from: drillRange === 'All' ? undefined : from, to, color: cat?.color ?? FAINT, name: cat?.name ?? '' }
  }, [vault, drillCat, drillRange, cm, d, rb])

  return (
    <section data-testid={tile ? undefined : 'trend-drill'} style={{ flex: 1, minWidth: 0, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Category drill-down — {curSym()}{!tile && <Explain id="trends.drill" />}</div>
            <div style={{ fontFamily: MONO, fontSize: 11.5, color: MUT }}>{drill.name} · <span>{fmt(drill.total)}</span></div>
          </div>
          <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }} data-testid={tile ? undefined : 'drill-caption'}>
            {drill.merchantCount > drill.rows.length
              ? `Top ${drill.rows.length} of ${drill.merchantCount} merchants — the figure above totals all of them`
              : `By merchant · ${drill.rows.length} in this window`}{' '}
            · {drillRange} · sorted descending{drillRange !== 'All' && <> · Δ vs prior {drillRange}</>} · click a bar for its transactions
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            data-testid={tile ? undefined : 'drill-cat'}
            aria-label="Category to drill into"
            value={drillCat}
            onChange={(e) => setDrillCat(e.target.value)}
            style={{ fontSize: 12.5, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 6, background: SURFACE, color: INK }}
          >
            {spendable.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <Seg<DrillRange> options={[{ value: '3M', label: '3M' }, { value: '1Y', label: '1Y' }, { value: 'All', label: 'All' }]} value={drillRange} onChange={setDrillRange} font={11} pad="5px 9px" />
          {tile ? controls : <PinButton widget="trends.drill" params={{ drillCat, drillRange }} />}
        </div>
      </div>
      <BarRows
        rows={drill.rows.map((r) => ({
          key: r.name,
          label: r.name,
          frac: r.val / drill.max,
          value: fmt(r.val),
          color: drill.color,
          delta:
            r.prev == null
              ? undefined
              : r.prev === 0
                ? { text: 'new' }
                : Math.abs(r.val - r.prev) < 0.5
                  ? { text: '±0' }
                  : { text: fmt(Math.abs(r.val - r.prev)), up: r.val > r.prev },
          title: 'Open these transactions →',
          onClick: () => goTxns({ merchant: r.name, cat: drillCat, from: drill.from, to: drill.to }),
        }))}
      />
      {drill.rows.length === 0 && (
        <EmptyState
          testid={tile ? undefined : 'trends-drill-empty'}
          basis={d.monthsTracked.length === 0 ? 'no-data' : 'filtered'}
          title={`No ${drill.name} spending in the last ${drillRange === '3M' ? '3 months' : drillRange === '1Y' ? 'year' : 'of your history'}.`}
          body={d.monthsTracked.length === 0 ? undefined : 'Try a wider window, or a different category.'}
        />
      )}
    </section>
  )
}
