// The Trends insight surfaces: the computed claims above and between the big charts.
//
// The three charts in `TrendsWidgets` let the user READ history; these state what it says —
// direction, movers, seasonality, recurring changes — each traceable to a QUESTIONARY item
// and each computed in `analytics/trends.ts`, complete months only. The rendering rules are
// the house ones: partial months never counted, thin data says so instead of guessing, every
// figure is a door to its transactions.
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useDerived, useStoreState } from '../store'
import { useView } from '../view'
import { addMonths, daysInMonth, monthLabel, monthName, monthShort, todayStr, visibleVault } from '../../model/selectors'
import { useAnchorMonth } from '../dashPeriod'
import { useNarrow } from '../responsive'
import { useRateBook } from '../fxCtx'
import {
  BASELINE_N,
  MOMENTUM_ABS_MIN,
  MOMENTUM_REL_MIN,
  RECENT_N,
  categoryMomentum,
  completeMonths,
  recurringDigest,
  savingsRateSeries,
  seasonality,
  trendHeadline,
  typicalMonth,
  type TrendDirection,
} from '../../analytics/trends'
import { subscriptions } from '../../analytics/subscriptions'
import { compare } from '../../analytics/compare'
import { ACCENT, BRICK, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE, curSym, fmt, fmtK } from '../theme'
import { BarChart, ChartCard, DivergingRows, niceCeil, type BarGroup } from '../charts'
import { EmptyState } from '../kit/EmptyState'
import { Explain } from '../explain'
import { PinButton } from './PinButton'
import type { WidgetChrome } from './AccountsWidgets'
import type { WidgetParams } from './catalog'

const pad2 = (n: number) => String(n).padStart(2, '0')
const monthStart = (mk: string) => `${mk}-01`
const monthEnd = (mk: string) => `${mk}-${pad2(daysInMonth(mk))}`

const cardStyle: CSSProperties = { background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 20px' }

/** ±3% is "flat" — a direction word must not oversell noise. */
const FLAT_BAND = 3

function dirWord(deltaPct: number | null): string {
  if (deltaPct == null) return ''
  if (Math.abs(deltaPct) < FLAT_BAND) return 'level with'
  return `${deltaPct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(deltaPct))}% on`
}

// ---------------------------------------------------------------- headline

/**
 * The page's thesis, in prose: spend and income direction over complete months, this year
 * against last year at the same point, and what a typical month looks like. Screen-only —
 * the Dashboard already has its own KPI cells.
 */
export function TrendHeadlineStrip() {
  const d = useDerived()
  const { vault } = useStoreState()
  const cm = useAnchorMonth()
  const today = todayStr()
  const rates = useRateBook()

  const h = useMemo(() => trendHeadline(d, cm), [d, cm])
  const typical = useMemo(() => typicalMonth(d, cm), [d, cm])
  const nComplete = useMemo(() => completeMonths(d, Infinity, cm).length, [d, cm])

  // This year vs last year, truncated to the same elapsed point (Q61) — the Dashboard's
  // cmpMain pattern. compare() scans the whole vault, so it is memoized the same way.
  const year = Number(cm.slice(0, 4))
  const yoy = useMemo(
    () => compare(vault, { period: { year } }, { period: { year: year - 1 } }, today, { mode: 'samePoint', rates }),
    [vault, year, today, rates],
  )
  const yoyPct = yoy.b.totalRaw > 0 ? ((yoy.a.totalRaw - yoy.b.totalRaw) / yoy.b.totalRaw) * 100 : null

  const spendLine = (s: TrendDirection, income: TrendDirection) => {
    if (s.basis !== 'ok') return `Only ${nComplete} finished month${nComplete === 1 ? '' : 's'} of data — not enough to call a trend.`
    const spendClause = `Spending averaged ${fmt(s.recentAvg)}/mo over the last ${RECENT_N} finished months — ${dirWord(s.deltaPct)} the ${Math.min(BASELINE_N, nComplete - RECENT_N)} before.`
    const incomeClause =
      income.deltaPct == null
        ? ''
        : Math.abs(income.deltaPct) < FLAT_BAND
          ? ' Income is flat.'
          : ` Income is ${income.deltaPct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(income.deltaPct))}%.`
    return spendClause + incomeClause
  }

  return (
    <section style={cardStyle} data-testid="trends-headline">
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.55 }}>
            {spendLine(h.spend, h.income)}
            <Explain id="trends.headline" />
          </div>
          {yoyPct != null && yoy.a.totalRaw > 0 && (
            <div style={{ fontSize: 12.5, color: MUT, marginTop: 4 }}>
              This year to date: {fmt(yoy.a.totalRaw)} vs {fmt(yoy.b.totalRaw)} at this point last year (
              {yoyPct >= 0 ? '+' : '−'}{Math.abs(Math.round(yoyPct))}%).
            </div>
          )}
        </div>
        {typical.basis !== 'empty' && (
          <div data-testid="trends-typical" style={{ fontFamily: MONO, fontSize: 11.5, color: MUT, whiteSpace: 'nowrap' }}>
            {typical.basis === 'thin' && <span style={{ color: FAINT }}>(only {typical.monthsCounted} months) </span>}
            typical month · <span style={{ color: INK }}>{fmt(typical.spendMedian)}</span> ± {fmt(typical.spendSpread)} spend
            {typical.incomeMedian > 0 && <> · <span style={{ color: INK }}>{fmt(typical.incomeMedian)}</span> income</>}
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- momentum

/** 12 complete months as 3px bars — enrichment beside the claim, dropped on narrow. */
function MiniBars({ values, months, color }: { values: number[]; months: string[]; color: string }) {
  const max = Math.max(...values, 1)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 14, flex: 'none' }}>
      {values.map((v, i) => (
        <span key={months[i]} title={`${monthShort(months[i]!)} ${months[i]!.slice(0, 4)}: ${fmt(v)}`} style={{ width: 3, height: Math.max(1, (v / max) * 14), background: color, opacity: 0.75, borderRadius: 0.5 }} />
      ))}
    </span>
  )
}

export function MomentumWidget({ tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const d = useDerived()
  const { goTxns } = useView()
  const cm = useAnchorMonth()
  const narrow = useNarrow()

  const r = useMemo(() => categoryMomentum(d, cm), [d, cm])
  const nComplete = useMemo(() => completeMonths(d, Infinity, cm).length, [d, cm])
  const catInfo = (id: string) => d.catById.get(id) ?? { name: '—', color: FAINT }

  const maxAbs = Math.max(...[...r.risers, ...r.fallers].map((m) => Math.abs(m.deltaAbs)), 1)
  const rowOf = (m: (typeof r.risers)[number]) => ({
    key: m.categoryId,
    label: catInfo(m.categoryId).name,
    delta: m.deltaAbs,
    frac: Math.abs(m.deltaAbs) / maxAbs,
    // "was → now", not the abstract delta — the reader should not have to do arithmetic
    // to learn what the category used to cost and costs now.
    value: m.deltaPct == null ? `new · ${fmt(m.recentAvg)}/mo` : `${fmt(m.baselineAvg)} → ${fmt(m.recentAvg)}/mo`,
    color: catInfo(m.categoryId).color,
    title: `Open ${catInfo(m.categoryId).name} over these months →`,
    onClick: () => goTxns({ cat: m.categoryId, from: monthStart(m.seriesMonths[0]!), to: monthEnd(m.seriesMonths[m.seriesMonths.length - 1]!) }),
  })
  const extra = narrow
    ? undefined
    : (row: { key: string }) => {
        const m = [...r.risers, ...r.fallers].find((x) => x.categoryId === row.key)
        return m ? <MiniBars values={m.series} months={m.seriesMonths} color={catInfo(m.categoryId).color} /> : null
      }

  const groupHead: CSSProperties = { fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', margin: '10px 0 2px' }
  const nothingMoved = r.basis === 'ok' && r.risers.length === 0 && r.fallers.length === 0

  return (
    <section style={{ ...cardStyle, flex: 1, minWidth: 0 }} data-testid={tile ? undefined : 'trend-momentum'}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>What’s moving — {curSym()}{!tile && <Explain id="trends.momentum" />}</div>
          <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>
            What each category costs per month lately (avg of the last {RECENT_N} finished months) vs before (the {BASELINE_N} prior) · only moves of ≥{MOMENTUM_REL_MIN * 100}% and ≥{fmt(MOMENTUM_ABS_MIN)}/mo show · click a row for its transactions
          </div>
        </div>
        {tile ? controls : <PinButton widget="trends.momentum" params={{}} />}
      </div>

      {r.basis === 'empty' && (
        <EmptyState testid={tile ? undefined : 'momentum-empty'} dense basis="no-data" title="No complete months yet." body="Momentum needs finished months to compare." />
      )}
      {r.basis === 'thin' && (
        <div style={{ fontSize: 12.5, color: FAINT, padding: '12px 0' }}>
          Only {nComplete} finished month{nComplete === 1 ? '' : 's'} of data — not enough to call a trend.
        </div>
      )}
      {nothingMoved && (
        <div data-testid={tile ? undefined : 'momentum-steady'} style={{ fontSize: 12.5, color: MUT, padding: '12px 0' }}>
          No category’s monthly average moved more than {MOMENTUM_REL_MIN * 100}% and {fmt(MOMENTUM_ABS_MIN)} — steady.
        </div>
      )}

      {r.risers.length > 0 && (
        <>
          <div style={groupHead}>SPENDING MORE ON</div>
          <DivergingRows labelWidth={narrow ? 96 : 150} rows={r.risers.map(rowOf)} extra={extra} />
        </>
      )}
      {r.fallers.length > 0 && (
        <>
          <div style={groupHead}>SPENDING LESS ON</div>
          <DivergingRows labelWidth={narrow ? 96 : 150} rows={r.fallers.map(rowOf)} extra={extra} />
        </>
      )}
      {r.records.map((m) => (
        <div key={m.categoryId} style={{ fontSize: 12, color: FAINT, marginTop: 8 }}>
          <span style={{ color: ACCENT }}>●</span> Record high: {catInfo(m.categoryId).name}’s biggest month in your data was {monthLabel(m.recordMonth!)} ({fmt(m.series[m.series.length - 1] ?? 0)}).
        </div>
      ))}
    </section>
  )
}

// ---------------------------------------------------------------- income & savings rate

type IncomeWindow = '18M' | 'All'

/** The private %-scale for the savings-rate line: [rMin, 100] mapped onto the plot. */
function rateScale(rates: (number | null)[], plot: { t: number; b: number }) {
  const worst = Math.min(0, ...rates.filter((r): r is number => r != null))
  const rMin = Math.max(-50, Math.floor(worst / 10) * 10) // clamp the DRAWN domain, never the figure
  const rY = (r: number) => plot.t + (1 - (Math.max(rMin, r) - rMin) / (100 - rMin)) * (plot.b - plot.t)
  return { rMin, rY }
}

export function IncomeSavingsWidget({ params, tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const d = useDerived()
  const { goTxns } = useView()
  const cm = useAnchorMonth()
  const [win, setWin] = useState<IncomeWindow>(params.window === 'All' ? 'All' : '18M')

  const months = useMemo(() => {
    if (win === '18M') return Array.from({ length: 18 }, (_, i) => addMonths(cm, -17 + i))
    const first = d.monthsTracked[0] ?? cm
    const out: string[] = []
    for (let mk = first; mk <= cm; mk = addMonths(mk, 1)) out.push(mk)
    return out
  }, [cm, win, d.monthsTracked])

  const flows = useMemo(() => months.map((mk) => d.flowByMonth.get(mk) ?? { income: 0, expense: 0 }), [months, d])
  // Anchor deliberately NOT passed: a stepped-back finished month has a perfectly
  // computable rate — only the real current month is partial.
  const rates = useMemo(() => savingsRateSeries(d, months), [d, months])
  const axisMax = niceCeil(Math.max(1, ...flows.map((f) => Math.max(f.income, f.expense))))

  const groups: BarGroup[] = months.map((mk, i) => {
    const isCur = mk === d.currentMonth
    const label =
      win === '18M'
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
      segs: [{ id: 'income', color: GREEN, value: flows[i]!.income, name: 'income' }],
    }
  })
  const janBoundaries = months.map((mk, i) => (i > 0 && mk.endsWith('-01') ? i : -1)).filter((i) => i > 0)

  // The rate polyline breaks on nulls (partial month, no-income month, gap) — the shared
  // `overlay` prop bridges them, which would draw a rate through a month that has none.
  const rateSegments = useMemo(() => {
    const segs: { i: number; r: number }[][] = []
    let cur: { i: number; r: number }[] = []
    rates.forEach((r, i) => {
      if (r == null) {
        if (cur.length) segs.push(cur)
        cur = []
      } else cur.push({ i, r })
    })
    if (cur.length) segs.push(cur)
    return segs
  }, [rates])

  const segWrap: CSSProperties = { display: 'inline-flex', gap: 1, background: 'var(--chip)', borderRadius: 6, padding: 2 }

  return (
    <ChartCard
      testid={tile ? undefined : 'trend-income'}
      explain={tile ? undefined : 'trends.income-savings'}
      ariaLabel="Income, spending and savings rate by month"
      title={`Income & savings rate — ${curSym()}`}
      subtitle={<>{win === '18M' ? 'Last 18 months' : 'All history'}{months.includes(d.currentMonth) ? ' · current month hatched (partial)' : ''} · rate = (income − spending) ÷ income · click a bar for its transactions</>}
      height={300}
      controls={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={segWrap}>
            {(['18M', 'All'] as const).map((w) => (
              <button key={w} aria-pressed={win === w} onClick={() => setWin(w)} style={{ fontSize: 11, color: win === w ? INK : FAINT, padding: '5px 9px', borderRadius: 5, background: win === w ? SURFACE : 'transparent', border: 'none', cursor: 'pointer' }}>{w}</button>
            ))}
          </div>
          {tile ? controls : <PinButton widget="trends.income" params={{ window: win }} />}
        </div>
      }
      footer={
        <div style={{ fontSize: 11.5, color: FAINT, marginTop: 6 }}>
          <span style={{ color: GREEN }}>■</span> income · <span style={{ color: BRICK }}>—</span> spending · <span style={{ color: ACCENT }}>—</span> savings rate (right scale, finished months)
        </div>
      }
    >
      {({ width, height }) => (
        <BarChart
          width={width}
          height={height}
          pad={{ r: 40 }}
          groups={groups}
          yMax={axisMax}
          yTicks={[0, 1 / 3, 2 / 3, 1].map((f) => ({ v: f * axisMax, label: fmtK(f * axisMax) }))}
          boundaries={janBoundaries}
          overlay={{ color: BRICK, values: flows.map((f) => f.expense) }}
          onSegClick={(mk) => goTxns({ from: monthStart(mk), to: monthEnd(mk) })}
          tipContent={(g) => {
            const i = months.indexOf(g.key)
            const f = flows[i]!
            const r = rates[i]
            return (
              <>
                <div style={{ opacity: 0.6, marginBottom: 3 }}>{monthShort(g.key)} {g.key.slice(0, 4)}{g.key === d.currentMonth ? ' (partial)' : ''}</div>
                <div>in <b style={{ fontWeight: 600 }}>{fmt(f.income)}</b> · out <b style={{ fontWeight: 600 }}>{fmt(f.expense)}</b></div>
                <div style={{ opacity: 0.8, marginTop: 3 }}>{r == null ? (g.key === d.currentMonth ? 'partial month — no rate yet' : 'no income — no rate') : `savings rate ${Math.round(r)}%`}</div>
                <div style={{ opacity: 0.6, marginTop: 3 }}>click to open this month’s transactions</div>
              </>
            )
          }}
          decorate={({ xc, plot }) => {
            const { rMin, rY } = rateScale(rates, plot)
            return (
              <>
                {rateSegments.map((seg, si) => (
                  <polyline
                    key={si}
                    data-testid={si === 0 ? 'sr-line' : undefined}
                    points={seg.map((p) => `${xc(p.i).toFixed(1)},${rY(p.r).toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke={ACCENT}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                ))}
                {/* Lone complete months (neighbours null) get a dot — a 1-point polyline draws nothing. */}
                {rateSegments.filter((s) => s.length === 1).map((s) => (
                  <circle key={`dot${s[0]!.i}`} cx={xc(s[0]!.i)} cy={rY(s[0]!.r)} r={2.4} fill={ACCENT} pointerEvents="none" />
                ))}
                {[0, 50].filter((t) => t >= rMin).map((t) => (
                  <text key={t} x={plot.r + 6} y={rY(t)} dy={3.5} fontFamily={MONO} fontSize={9.5} fill={ACCENT} opacity={0.75}>{t}%</text>
                ))}
              </>
            )
          }}
          ariaLabel="Income, spending and savings rate by month"
        />
      )}
    </ChartCard>
  )
}

// ---------------------------------------------------------------- seasonality

const CAL_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export function SeasonalityCard({ tile, controls }: { params: WidgetParams } & WidgetChrome) {
  const d = useDerived()
  const { goTxns } = useView()
  const cm = useAnchorMonth()

  const s = useMemo(() => seasonality(d, cm), [d, cm])
  // Latest complete instance of each calendar month — the door a bar can actually open
  // (TxnFilter cannot express "every December"; the tooltip says which one it opens).
  const latestOf = useMemo(() => {
    const map = new Map<number, string>()
    for (const mk of completeMonths(d, Infinity, cm)) map.set(Number(mk.slice(5)), mk)
    return map
  }, [d, cm])

  if (!s) {
    // Below threshold the screen shows nothing — correct silence. A pinned tile must still
    // explain itself rather than sit blank (the trips.daily precedent).
    return tile ? (
      <section style={{ ...cardStyle, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Seasonality</div>
        <div style={{ fontSize: 12.5, color: FAINT, marginTop: 8 }}>Needs two observations of every calendar month (≈ two full years) — still collecting.</div>
        <div style={{ marginTop: 8 }}>{controls}</div>
      </section>
    ) : null
  }

  const peakName = monthName(`2000-${pad2(s.peak.m)}`)
  const axisMax = niceCeil(Math.max(1, ...s.byCalMonth.map((b) => b.avg)))
  const groups: BarGroup[] = s.byCalMonth.map((b) => ({
    key: String(b.m),
    label: CAL_LETTERS[b.m - 1]!,
    labelEmph: b.m === s.peak.m,
    segs: [{ id: 'avg', color: b.m === s.peak.m ? ACCENT : MUT, value: b.avg, name: `${monthName(`2000-${pad2(b.m)}`)} average` }],
  }))

  return (
    <ChartCard
      testid={tile ? undefined : 'trend-seasonality'}
      explain={tile ? undefined : 'trends.seasonality'}
      ariaLabel="Average spending per calendar month"
      title="Seasonality"
      subtitle={
        <>
          Averaged over your complete months, {peakName} runs highest (≈{fmtK(s.peak.avg)})
          {s.peak.years > 0 && <> — your most expensive month in {s.peak.topYears} of {s.peak.years} full year{s.peak.years === 1 ? '' : 's'}</>}
        </>
      }
      height={170}
      controls={tile ? controls : <PinButton widget="trends.seasonality" params={{}} />}
    >
      {({ width, height }) => (
        <BarChart
          width={width}
          height={height}
          groups={groups}
          yMax={axisMax}
          yTicks={[0, 0.5, 1].map((f) => ({ v: f * axisMax, label: fmtK(f * axisMax) }))}
          onSegClick={(m) => {
            const mk = latestOf.get(Number(m))
            if (mk) goTxns({ from: monthStart(mk), to: monthEnd(mk) })
          }}
          tipContent={(g) => {
            const b = s.byCalMonth[Number(g.key) - 1]!
            const mk = latestOf.get(b.m)
            return (
              <>
                <div style={{ opacity: 0.6, marginBottom: 3 }}>{monthName(`2000-${pad2(b.m)}`)} · avg over {b.n} months</div>
                <div><b style={{ fontWeight: 600 }}>{fmt(b.avg)}</b></div>
                {mk && <div style={{ opacity: 0.6, marginTop: 3 }}>click to open {monthLabel(mk)}</div>}
              </>
            )
          }}
          ariaLabel="Average spending per calendar month"
        />
      )}
    </ChartCard>
  )
}

// ---------------------------------------------------------------- recurring digest

/** One-line recurring recap with a door to Plan's Subscriptions section. Screen-only. */
export function RecurringDigestStrip() {
  const { vault } = useStoreState()
  const rates = useRateBook()
  const { goTab } = useView()
  const today = todayStr()

  // subscriptions() walks the raw vault, so the hidden-account projection is applied here.
  const dig = useMemo(() => recurringDigest(subscriptions(visibleVault(vault), today, rates), today), [vault, today, rates])
  if (!dig.hasAny) return null

  const changes = [
    dig.newCount > 0 ? `${dig.newCount} new` : null,
    dig.increasedCount > 0 ? `${dig.increasedCount} increased` : null,
    dig.decreasedCount > 0 ? `${dig.decreasedCount} decreased` : null,
    dig.lapsedCount > 0 ? `${dig.lapsedCount} lapsed` : null,
  ].filter(Boolean)

  return (
    <section style={cardStyle} data-testid="trends-recurring-digest">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, color: MUT, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: INK }}>Recurring:</span>{' '}
          <span style={{ fontFamily: MONO }}>{fmt(dig.monthlyTotal)}/mo</span> <span style={{ color: FAINT }}>(≈{fmt(dig.annualisedTotal)}/yr)</span>
          {' · '}last 60 days: {changes.length ? changes.join(' · ') : 'no changes'}
          <Explain id="trends.recurring" />
        </div>
        <button
          onClick={() => goTab('plan', 'recurring')}
          style={{ fontSize: 12, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '6px 11px', background: SURFACE, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Subscriptions →
        </button>
      </div>
    </section>
  )
}
