// Dashboard — ported from specs/design/Ledger.dc.html §Dashboard (lines 94–325).
// Headline metric row · cumulative-spend hero chart · pinned comparison grid
// (what-changed / worth-a-look / pinned compares) · Plan·July goals & budgets.
import { pick, useBp } from './responsive'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Goal, PeriodRef, Selection } from '../model/types'
import { useStore, useStoreState, useDerived } from './store'
import { useView } from './view'
import { ACCENT, AMBER, BRICK, CHIP, CMPA, CMPB, FAINT, GREEN, HAIR, HAIR2, INK, MONO, MUT, SURFACE, curSym, fmt, fmtK, netLbl } from './theme'
import {
  addMonths, currentMonthKey, dayOfToday, daysInMonth, flowOfRange, isCashflow,
  monthKeyOf, monthName, monthShort, savingsRateOf, todayStr, trailingAvg,
} from '../model/selectors'
import { compare } from '../analytics/compare'
import { addDays, rebaseSelection } from '../analytics/selections'
import { MIN_PACE_DAYS, monthEndProjectionThrough, pace, yearElapsedFraction, yearEndProjection } from '../analytics/project'
import { budgetScopeLabel, budgetScopeSpent, budgetScopeYear, isMonthlyScope, monthlyEquivalent } from '../analytics/budgets'
import { budgetCategoryIds } from '../model/types'
import { DashPeriodProvider, dashPeriodOf } from './dashPeriod'
import { PeriodStepper, periodLabelOf, readPeriodParam, withGran, type PeriodValue } from './kit/PeriodStepper'
import { formatHash, parseHash, selectionToParam } from './route'
import { ChartCard, DivergingRows, LineChart, computeBudgetDomain, niceCeil } from './charts'
import type { Span } from './dashOrder'
import { TileGrid, useTileGrid } from './kit/tileGrid'
import { WIDGETS, isWidgetId, widgetParams, type WidgetId } from './widgets/catalog'
import { WIDGET_RENDER } from './widgets/render'
import { WidgetPicker } from './widgets/WidgetPicker'
import { useRateBook } from './fxCtx'
import { Explain } from './explain'
import { fmtDay, useFreshness } from './freshness'
import { dayRange, elapsedDays, pctDelta, ptsDelta } from './format'
import { MetricCell, big } from './kit/metrics'
import { Tri } from './kit'
import { goalState, goalStatus } from '../analytics/goals'
import { GoalRow, BudgetRow, groupTitle } from './kit/rows'
import { ScreenIntro } from './ScreenIntro'
import { StartHere } from './StartHere'


function periodLabel(p?: PeriodRef): string {
  if (!p) return 'All'
  if ('rel' in p) {
    return { thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year', lastYear: 'Last year', sameMonthLastYear: 'Same month LY' }[p.rel]
  }
  if ('month' in p) return p.month
  if ('year' in p) return String(p.year)
  return `${p.from}–${p.to}`
}

function buildSpark(snaps?: number[]): string {
  if (!snaps || snaps.length === 0) return ''
  const min = Math.min(...snaps)
  const max = Math.max(...snaps)
  const span = max - min || 1
  return snaps.map((v, i) => `${i},${Math.round(6 + (1 - (v - min) / span) * 28)}`).join(' ')
}

export function DashboardScreen() {
  const bp = useBp()
  const narrow = bp === 'phone'
  const { vault } = useStoreState()
  const d = useDerived()
  const view = useView()
  const { goTab, goTxns, go } = view
  /**
   * The real clock, always. `compare()` uses `today` both to resolve refs and to decide which side
   * is in progress, so a synthetic anchor date would make a finished month look live and truncate
   * the side it is measured against (`resolveSide`). What moves is the period ref, never the clock.
   */
  const today = todayStr()
  const thisMonth = currentMonthKey()
  /**
   * The period the screen is reading. It lives in the route (`#/dash?mk=2026-06`) rather than in
   * component state alone, so a month is shareable, survives reload, and steps back through the
   * browser's own history — the same treatment Plan and every drill already get.
   */
  const [pv, setPv] = useState<PeriodValue>(() => readPeriodParam(parseHash(location.hash).query.mk, thisMonth) ?? thisMonth)
  const dp = dashPeriodOf(pv, thisMonth)
  const { anchorMonth: cm, gran: seg, isCurrent } = dp
  const seenNonce = useRef(0)
  useEffect(() => {
    const seed = view.seed
    if (!seed || seed.tab !== 'dash' || seed.nonce === seenNonce.current) return
    seenNonce.current = seed.nonce
    // An empty query is plain navigation (the tab bar) and leaves the period alone — the same
    // rule Plan and the Transactions filters apply.
    const v = readPeriodParam(seed.query.mk, thisMonth)
    if (v) setPv(v)
  }, [view.seed, thisMonth])
  useEffect(() => {
    if (view.tab !== 'dash') return
    const h = formatHash({ tab: 'dash', query: pv === thisMonth ? {} : { mk: pv } })
    if (location.hash !== h) history.replaceState(history.state, '', h)
  }, [pv, thisMonth, view.tab])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const store = useStore()

  const catInfo = (id: string) => d.catById.get(id) ?? { name: '—', color: FAINT }

  const fresh = useFreshness()
  const rates = useRateBook()

  // --- headline spend (the period's expense cash-flow magnitude) ---
  // One source for the figure, the delta, the percentage and the bar. A second
  // reduce over `vault.transactions` used to feed the big number: it was blind to
  // `t.currency` and counted the whole month, while the delta beside it was
  // FX-converted and truncated to the elapsed day — so the subtraction the row
  // reads as ("€10,700 … +€625 … vs €10,075") need not hold. `a` is the in-progress
  // side, so `daysCounted` is the elapsed length: spend from the 1st through today.
  const cmpMain = useMemo(
    () => compare(vault, { period: dp.period }, { period: dp.prevPeriod }, today, { rates }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, today, rates, dp.value],
  )
  const headline = cmpMain.a.totalRaw
  // Projected over the window the statements cover, not the calendar month — the same change
  // Plan makes, so the two screens keep reporting one pace (the reason `freshness.ts` exists).
  // Both projections already return the partial total unchanged for a period that is not the
  // current one, so a finished month reports what it cost rather than a fabricated pace.
  const through = fresh.through ?? today
  const spendProj = seg === 'year' ? yearEndProjection(headline, dp.anchorYear, today) : monthEndProjectionThrough(headline, cm, through)
  const spendPct = pctDelta(cmpMain.a.totalRaw, cmpMain.b.totalRaw)
  // Both windows as dates rather than as the phrase "same point". Selections here are
  // calendar periods starting on the 1st, so the counted length IS the end day-of-month —
  // and on the 31st, when there is no 31 June to align to, B keeps its own 30 days and
  // this caption says "1–30 Jun" instead of claiming a parity that was never computed
  // (ANALYTICS §5.3: the header always states which mode is active). On a finished period
  // neither side is in progress, so both run their full length and nothing is aligned.
  const spendATo = addDays(cmpMain.a.from, cmpMain.a.daysCounted - 1)
  const spendBTo = addDays(cmpMain.b.from, cmpMain.b.daysCounted - 1)
  const spendAWindow = dayRange(cmpMain.a.from, spendATo)
  const spendBWindow = dayRange(cmpMain.b.from, spendBTo)
  // A finished period has nothing left to project, and too few elapsed days is noise either way.
  const canProject = isCurrent && cmpMain.a.daysCounted >= MIN_PACE_DAYS
  /** What the period is called, wherever a cell used to say "this month". */
  const periodName = periodLabelOf(pv, thisMonth)
  const prevName = periodLabelOf(seg === 'year' ? String(dp.anchorYear - 1) : addMonths(cm, -1), thisMonth)
  /** Opening Transactions on exactly the window a figure was measured over. */
  const periodDrill = { from: dp.from, to: dp.to }

  // --- cash flow cell ---
  // No projection here. `pace()` extrapolates a daily rate, and BRIEF §8 sanctions that for
  // spend; income arrives in lumps, so pacing a salary that landed on the 1st projected
  // ~€7,750 against a real ~€5,800 and carried that error into the month-end net.
  // In year granularity this sums the year's months — `flowByMonth` is full-history, so the
  // figure is exact rather than an extrapolation from one month.
  const periodFlow = useMemo(() => flowOfRange(d, dp.months), [d, dp.months])
  const inV = periodFlow.income
  const outV = periodFlow.expense
  const cf = inV - outV
  const cfMax = Math.max(inV, outV, 1)

  // --- savings rate cell ---
  const srIncome = inV
  // Σ over Σ, never the mean of the monthly rates — that would weight a €200 month like a €6,000 one.
  const sr = savingsRateOf(periodFlow)
  const srTarget = vault.params.srTarget
  const avg3 = trailingAvg(d, 3, (f) => (f.income > 0 ? ((f.income - f.expense) / f.income) * 100 : 0), cm)
  // 0–100% domain, so the target is a mark ON the scale rather than the scale itself. The
  // bar used to divide by the target and clamp at 100, which pinned the "target" tick to the
  // right edge where it read as decoration and made beating the target unrepresentable.
  const srFill = Math.max(0, Math.min(sr, 100))
  // `trailingAvg` returns 0 with nothing to average, which is indistinguishable from a real
  // 0% — so count what it actually had before printing the figure.
  const srAvgMonths = useMemo(() => {
    let n = 0
    for (let i = 1; i <= 3; i++) {
      const mk = addMonths(cm, -i)
      if (mk < (d.monthsTracked[0] ?? mk)) break
      if (d.flowByMonth.get(mk)) n++
    }
    return n
  }, [d, cm])

  // --- plan status cell ---
  // NOTE: this keys `${cm}|${categoryId}` directly — legacy-monthly arithmetic — so it shows
  // only legacy monthly budgets. A scoped budget (annual, per-trip, group, recurring) counts a
  // different period or a different set of rows; drawing it against this month's category spend
  // rendered an annual €2,400 as blown every month. Plan is the surface that knows how to read
  // those (rollup memo lines, year pacing); the Dashboard cell shows what it can show honestly.
  //
  // Budgets are monthly amounts, so this stays month-scoped even in year granularity, reading
  // the year's last elapsed month. Rolling twelve monthly budgets into an annual figure is a
  // different question with its own scope rules (`analytics/budgetRollup.ts`); inventing a second
  // answer to it here is how two screens start disagreeing.
  const overPace = useMemo(
    () => vault.budgets
      .filter((b) => !b.scope)
      .filter((b) => monthEndProjectionThrough(d.spentByCatMonth.get(`${cm}|${b.categoryId}`) ?? 0, cm, through) > b.amount)
      .map((b) => catInfo(b.categoryId).name),
    [vault.budgets, d, cm, through],
  )
  const activeGoals = vault.goals.filter((g) => !g.archived).length
  const goalsBehind = useMemo(
    () => vault.goals.filter((g) => !g.archived && goalStatus(vault, g, today, rates).eta == null).length,
    [vault.goals, vault, today, rates],
  )

  // --- hero cumulative chart (data only — geometry lives in <LineChart>) ---
  const chart = useMemo(() => {
    const selA: Selection = { period: dp.period }
    const selB: Selection = { period: dp.prevPeriod }
    // `full` mode so the prior period runs its whole length as a reference line (this side
    // stays at its elapsed length either way). The same-point figure lives in the metric card
    // above (`cmpMain`), so the chart is free to show last period's complete trajectory.
    const cmp = compare(vault, selA, selB, today, { mode: 'full', rates })
    const aCum = cmp.a.cumulative
    const bCum = cmp.b.cumulative
    const elapsed = aCum.length
    const aLast = aCum[elapsed - 1] ?? 0
    const bLast = bCum[bCum.length - 1] ?? 0
    const yr = Number(cmp.a.from.slice(0, 4))
    const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0
    const totalDays = seg === 'month' ? daysInMonth(cm) : isLeap ? 366 : 365
    // A finished period has run its course: the dashed projection would be a claim about a
    // future that already happened, so it collapses to the actual total and is not drawn.
    const projTotal = isCurrent ? pace(aLast, elapsed, totalDays) : aLast
    const yMax = niceCeil(Math.max(aLast, bLast, projTotal, 1))
    return { aCum, bCum, elapsed, aLast, bLast, totalDays, projTotal, yMax, yr }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, seg, today, cm, rates, dp.value, isCurrent])

  // --- pinned comparison grid (compare() memoized — it scans the whole vault) ---
  // Each pin's selections are re-read against the anchor: a pin saying "this month vs last month"
  // means "relative to what I am looking at", while one saying "2026 vs 2025" is absolute and
  // `rebaseSelection` returns it untouched. `rebased` is true only when something actually moved,
  // so the marker on the card never appears for a pin that did not change.
  const pinnedCards = useMemo(
    () =>
      vault.savedComparisons
        .filter((c) => c.pinned)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((p) => {
          const a0 = p.selections[0]!
          const b0 = p.selections[1] ?? a0
          const selA = rebaseSelection(a0, cm)
          const selB = rebaseSelection(b0, cm)
          // Not an identity check: rebasing a relative always allocates, so `selA !== a0` would
          // be true even at the current month, where it resolves to the very same window. A
          // relative only MOVES once the anchor leaves the current month.
          const isRel = (s: Selection) => !!s.period && 'rel' in s.period
          return {
            p,
            selA,
            selB,
            rebased: cm !== thisMonth && (isRel(a0) || isRel(b0)),
            cmp: compare(vault, selA, selB, today, { normalize: p.normalize, rates }),
          }
        }),
    [vault, today, rates, cm, thisMonth],
  )

  // --- movers (what changed) ---
  const movers = useMemo(() => {
    const top = cmpMain.byCategory.slice(0, 4)
    const maxAbs = Math.max(...top.map((m) => Math.abs(m.delta)), 1)
    return top.map((m) => ({
      id: m.categoryId,
      name: catInfo(m.categoryId).name,
      col: catInfo(m.categoryId).color,
      delta: m.delta,
      w: (Math.abs(m.delta) / maxAbs) * 46,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpMain])

  // --- insights (worth a look): categories running >130% of last month ---
  const insights = useMemo(() => {
    const pm = addMonths(cm, -1)
    const out: { id: string; name: string; col: string; pct: number }[] = []
    for (const c of vault.categories) {
      if (c.role === 'income' || c.role === 'transfers') continue
      if (c.excludeFromBreakdown ?? c.role === 'housing') continue // breakdown exclusion is a user preference (#12a)
      const cur = d.spentByCatMonth.get(`${cm}|${c.id}`) ?? 0
      const prev = d.spentByCatMonth.get(`${pm}|${c.id}`) ?? 0
      if (prev > 0 && cur > prev * 1.3 && cur > 50) out.push({ id: c.id, name: c.name, col: c.color, pct: Math.round((cur / prev - 1) * 100) })
    }
    return out.sort((a, b) => b.pct - a.pct).slice(0, 2)
  }, [vault.categories, d, cm])
  const visibleInsights = insights.filter((i) => !dismissed.has(i.id))
  // An empty insight list means "nothing stood out" only when there was something to
  // stand out against: `insights` needs a prior month with spend to fire at all.
  const insightBasis = useMemo(() => {
    if (vault.transactions.length === 0) return 'empty'
    const pm = addMonths(cm, -1)
    return vault.transactions.some((t) => monthKeyOf(t.date) === pm && isCashflow(t) && t.amount < 0) ? 'ok' : 'thin'
  }, [vault.transactions, cm])

  /**
   * The plan block is month-scoped whatever the header's granularity, so its "elapsed" is about
   * the anchor MONTH, not about the period. In year granularity the anchor month is the year's
   * last elapsed one, which is current only inside the current year.
   */
  const planIsCurrent = cm === thisMonth
  const planElapsed = planIsCurrent ? dayOfToday() / daysInMonth(cm) : 1

  /**
   * Nothing in the anchored period, and the most recent month that does have something.
   *
   * `monthsTracked` is ascending and holds only months with cash flow in them, so its last entry
   * is the newest month worth looking at. In year granularity the offer is that month's YEAR —
   * stepping to a month while the header says "year" would silently change two things at once.
   */
  const emptyPeriod = cmpMain.a.totalRaw === 0 && inV === 0 && outV === 0
  const newestTracked = d.monthsTracked[d.monthsTracked.length - 1]
  const latestWithData = useMemo(() => {
    if (!emptyPeriod || !newestTracked) return null
    const v = seg === 'year' ? newestTracked.slice(0, 4) : newestTracked
    return v === pv ? null : v
  }, [emptyPeriod, newestTracked, seg, pv])

  const planLine = (color: string, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 14 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flex: 'none' }} />
      <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.01em', lineHeight: 1.2, color: INK, minWidth: 0 }}>{text}</span>
    </div>
  )


  const changedCard = (ctl: React.ReactNode) => (
          <div style={{ flex: 1, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK, display: 'flex', alignItems: 'center' }}>What changed<Explain id="dash.movers" /></div>
              {ctl}
            </div>
            {/* Derived, not fixed. On a finished period neither side is in progress, so nothing
                is aligned to a "same point" — and the freshness clause goes with it: how current
                the vault is, is a fact about now, so "through 12 Jul" printed under a March
                comparison is exactly the lie `freshness.ts` exists to prevent. */}
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2 }}>
              vs {prevName}{isCurrent ? <> · same point · through {fmtDay(through)}</> : <> · full {seg}</>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9, color: FAINT, margin: '13px 0 2px', padding: '0 2px' }}><span>← less</span><span>more →</span></div>
            <DivergingRows
              labelWidth={96}
              rows={movers.map((mv) => ({
                key: mv.id,
                label: mv.name,
                delta: mv.delta,
                frac: mv.w / 46,
                value: fmt(Math.abs(mv.delta)),
                color: mv.col,
                title: `Open ${mv.name} in ${periodName} →`,
                onClick: () => goTxns({ cat: mv.id, ...periodDrill }),
              }))}
              extra={(r) => <span style={{ width: 8, height: 8, borderRadius: 2, flex: 'none', background: (r as { color?: string }).color }} />}
            />
          </div>
  )

  const worthCard = (ctl: React.ReactNode) => (
          <div style={{ flex: 1, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>WORTH A LOOK</div>
              {ctl}
            </div>
            {visibleInsights.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 2px 4px' }} data-testid="insights-empty" data-basis={insightBasis}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: insightBasis === 'ok' ? 'var(--pos)' : FAINT }} />
                <span style={{ fontSize: 13, color: MUT }}>
                  {insightBasis === 'empty'
                    ? 'No transactions yet — import a statement to see what stands out.'
                    : insightBasis === 'thin'
                      ? 'Not enough history yet — comparisons start after a full month.'
                      : 'Nothing unusual — spending matches recent months.'}
                </span>
              </div>
            )}
            {visibleInsights.map((i) => (
              <div key={i.id} style={{ display: 'flex', gap: 10, padding: '11px 0', borderTop: `1px solid ${HAIR2}` }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: i.col, flex: 'none', marginTop: 4 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button onClick={() => goTxns({ cat: i.id, ...periodDrill })} style={{ fontSize: 12.5, color: INK, textAlign: 'left', lineHeight: 1.45, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{i.name} is running {i.pct}% above last month.</button>
                  <div style={{ marginTop: 5 }}><button onClick={() => goTxns({ cat: i.id, ...periodDrill })} style={{ fontSize: 11.5, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Review →</button></div>
                </div>
                <button onClick={() => setDismissed((s) => new Set(s).add(i.id))} title="Dismiss" style={{ color: FAINT, fontSize: 14, lineHeight: 1, flex: 'none', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
              </div>
            ))}
          </div>
  )

  const pinCard = ({ p, cmp, selA, selB, rebased }: (typeof pinnedCards)[number], ctl: React.ReactNode) => {
    const has2 = p.selections.length > 1
    const aCum = cmp.a.cumulative
    const bCum = cmp.b.cumulative
    const aLast = aCum[aCum.length - 1] ?? 0
    const bLast = bCum[bCum.length - 1] ?? 0
    const maxV = Math.max(aLast, has2 ? bLast : 0, 1)
    const more = cmp.delta >= 0
    const days = Math.max(aCum.length, has2 ? bCum.length : 0)
    const labelA = periodLabel(selA.period)
    const labelB = periodLabel(selB.period)
    return (
      // A ChartCard like every other chart, rather than the bespoke card this used to be. That is
      // what buys the crosshair tooltip, the fullscreen expand and the "?" — all of which this one
      // chart lacked purely because it was hand-rolled. It is also why the body no longer navigates
      // on click: reading a point and leaving the screen were the same gesture, so hovering to see
      // a day's figure took you to Compare instead. Opening it is now its own control.
      // A block wrapper, not a flex row. As a flex item the ChartCard sizes to its content
      // (`flex: 0 1 auto`), and ChartCard measures its own plot area to size the chart — so the
      // card settled at whatever the header happened to need and the chart never filled the
      // column. `display: block` breaks that loop: the card fills the tile, the plot measures the
      // card. Same reason `heroTile` uses one.
      <div style={{ flex: 1, minWidth: 0 }}>
        <ChartCard
          explain="dash.pinned"
          ariaLabel={
            has2
              ? `${labelA} ${fmt(cmp.a.total)} against ${labelB} ${fmt(cmp.b.total)}, cumulative`
              : `${labelA} ${fmt(cmp.a.total)}, cumulative`
          }
          title={
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{p.name ?? labelA}</span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '2px 6px', letterSpacing: '.05em' }}>{has2 ? 'A/B' : 'WATCH'}</span>
              {/* Only when something actually moved. A pin saved as "2026 vs 2025" is absolute and
                  reads the same at every anchor, so it never carries this. */}
              {rebased && (
                <span data-testid="pin-rebased" style={{ fontFamily: MONO, fontSize: 9, color: ACCENT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '2px 6px', letterSpacing: '.05em' }}>
                  ↻ {periodName}
                </span>
              )}
            </span>
          }
          subtitle={
            <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap', marginTop: 4 }}>
              <span><span style={{ display: 'block', fontFamily: MONO, fontSize: 9.5, color: CMPA }}>{labelA}</span><span style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.1, color: INK }}>{fmt(cmp.a.total)}</span></span>
              {has2 && <span><span style={{ display: 'block', fontFamily: MONO, fontSize: 9.5, color: CMPB }}>{labelB}</span><span style={{ fontSize: 21, fontWeight: 600, lineHeight: 1.1, color: MUT }}>{fmt(cmp.b.total)}</span></span>}
              {has2 && (
                <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Tri dir={more ? 'up' : 'down'} size={8} color={FAINT} />{fmt(Math.abs(cmp.delta))}
                </span>
              )}
            </span>
          }
          height={110}
          controls={
            <>
              {/* A rebased card must not open the STORED comparison — the tile would say March
                  and Compare would say July. `?saved=` names a record; the two sides the tile
                  actually drew travel as selections instead, which the hash already supports. */}
              <button
                onClick={() => go('compare', rebased ? { cmpA: selectionToParam(selA), cmpB: selectionToParam(selB) } : { saved: p.id })}
                style={{ flex: 'none', fontSize: 12, color: ACCENT, fontWeight: 500, border: `1px solid ${HAIR}`, borderRadius: 5, padding: '4px 9px', background: 'none', cursor: 'pointer', lineHeight: 1.3 }}
              >
                Open in Compare →
              </button>
              {ctl}
            </>
          }
          footer={<div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 6 }}>{cmp.a.daysCounted}d counted · {has2 ? 'same point' : 'watch'}</div>}
        >
          {({ width, height }) => (
            <LineChart
              width={width}
              height={height}
              pad={{ l: 44, r: 12, t: 8, b: 18 }}
              series={[
                ...(has2 ? [{ id: 'b', color: CMPB, strokeWidth: 1.6, points: bCum.map((v, i) => ({ x: i, y: v })) }] : []),
                { id: 'a', color: CMPA, strokeWidth: 2, points: aCum.map((v, i) => ({ x: i, y: v })) },
              ]}
              xDomain={[0, Math.max(1, days - 1)]}
              yDomain={[0, maxV]}
              yTicks={[0, maxV].map((v) => ({ v, label: fmtK(v) }))}
              snapXs={Array.from({ length: days }, (_, i) => i)}
              tipContent={(i) => (
                <>
                  <div style={{ opacity: 0.6, marginBottom: 3 }}>Day {i + 1}</div>
                  {i < aCum.length && <div><span style={{ color: CMPA }}>■</span> {labelA} <b style={{ fontWeight: 600 }}>{fmt(aCum[i] ?? 0)}</b></div>}
                  {has2 && i < bCum.length && <div style={{ opacity: 0.85 }}><span style={{ color: CMPB }}>■</span> {labelB} {fmt(bCum[i] ?? 0)}</div>}
                </>
              )}
              dots={[
                ...(has2 ? [{ x: bCum.length - 1, y: bLast, color: CMPB }] : []),
                { x: aCum.length - 1, y: aLast, color: CMPA, open: true },
              ]}
              liveText={(i) => `Day ${i + 1}: ${labelA} ${fmt(aCum[i] ?? aLast)}${has2 ? `, ${labelB} ${fmt(bCum[i] ?? bLast)}` : ''}`}
              ariaLabel={has2 ? `${labelA} against ${labelB}, cumulative` : `${labelA}, cumulative`}
            />
          )}
        </ChartCard>
      </div>
    )
  }

  // --- dashboard layout: one grid of tiles, ordered and sized by the user ---
  /** Cross-device pin order lives in the vault; keep it in step with the local layout. */
  const syncPinOrder = (ids: string[]) => {
    ids
      .filter((i) => i.startsWith('pin:'))
      .forEach((pid, idx) => {
        const id = pid.slice(4)
        const rec = vault.savedComparisons.find((c) => c.id === id)
        if (rec && rec.order !== idx) store.commit({ kind: 'setField', collection: 'savedComparisons', id, field: 'order', value: idx })
      })
  }
  // Charts pinned from Trends, Accounts, Trips or Plan. Unlike a pinned comparison these are not
  // a query — they are a catalogue id plus the screen state the chart was showing, replayed here.
  const widgetTiles = vault.pinnedWidgets
    .filter((w) => isWidgetId(w.widget))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  // The hero chart and the plan block earn the full width; a card is one column until resized,
  // and a pinned chart starts at whatever its catalogue entry says suits it.
  const defaultSpans: Record<string, Span> = { hero: 3, plan: 3 }
  for (const w of widgetTiles) defaultSpans[`widget:${w.id}`] = WIDGETS[w.widget as WidgetId].defaultSpan
  // "Worth a look" asks which categories ran >130% of LAST MONTH. There is no year analogue of
  // that question — a year against a year is what the hero chart already draws — so rather than
  // relabel a monthly rule as an annual one, the tile stands down in year granularity.
  const tiles = useTileGrid(
    'dash',
    [
      'hero',
      'changed',
      ...pinnedCards.map(({ p }) => `pin:${p.id}`),
      ...widgetTiles.map((w) => `widget:${w.id}`),
      ...(seg === 'year' ? [] : ['worth']),
      'plan',
    ],
    defaultSpans,
    syncPinOrder,
  )
  const unpin = (id: string) =>
    store.commit({ kind: 'setField', collection: 'savedComparisons', id, field: 'pinned', value: false }, { msg: 'Unpinned from dashboard', undoable: true })
  const unpinWidget = (id: string, title: string) =>
    store.commit({ kind: 'delete', collection: 'pinnedWidgets', ids: [id] }, { msg: `${title} removed from dashboard`, undoable: true })
  const widgetOf = (tid: string) => (tid.startsWith('widget:') ? widgetTiles.find((w) => `widget:${w.id}` === tid) : undefined)
  const tileNames: Record<string, string> = { hero: 'the spend chart', changed: 'what changed', worth: 'worth a look', plan: 'the plan block' }
  const tileName = (id: string) =>
    tileNames[id] ?? widgetOf(id)?.name ?? pinnedCards.find(({ p }) => `pin:${p.id}` === id)?.p.name ?? 'card'
  const unpinControl = (id: string) => {
    const w = widgetOf(id)
    if (w) return <RemoveTile label={tileName(id)} onRemove={() => unpinWidget(w.id, tileName(id))} />
    const pc = pinnedCards.find(({ p }) => `pin:${p.id}` === id)
    if (!pc) return null
    return <RemoveTile label={tileName(id)} onRemove={() => unpin(pc.p.id)} />
  }
  const renderTile = (tid: string, ctl: React.ReactNode) => {
    if (tid === 'hero') return heroTile(ctl)
    if (tid === 'plan') return planTile(ctl)
    if (tid === 'changed') return changedCard(ctl)
    if (tid === 'worth') return worthCard(ctl)
    const w = widgetOf(tid)
    if (w) {
      const id = w.widget as WidgetId
      // Wrapped, because a widget renders its own card and the tile is a flex row around it.
      return <div style={{ flex: 1, minWidth: 0 }}>{WIDGET_RENDER[id](widgetParams(id, w.params), { tile: true, controls: ctl })}</div>
    }
    const pc = pinnedCards.find(({ p }) => `pin:${p.id}` === tid)
    return pc ? pinCard(pc, ctl) : null
  }

  const heroTile = (ctl: React.ReactNode) => (
    <>
      {/* HERO chart */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <ChartCard
          testid="hero-chart"
          explain="dash.hero-chart"
          ariaLabel="Cumulative spend, this period vs last"
          title={`Cumulative spend — ${curSym()}`}
          subtitle={
            // A finished period has no pace left to run. Claiming "projected month-end … at
            // current pace" over a month that ended in March would be a forecast of the past.
            isCurrent
              ? <>Projected {seg === 'month' ? 'month' : 'year'}-end <b style={{ color: MUT, fontWeight: 600 }}>{fmt(chart.projTotal)}</b> · at current pace</>
              : <>{periodName} · <b style={{ color: MUT, fontWeight: 600 }}>{fmt(chart.aLast)}</b> against {prevName} <b style={{ color: MUT, fontWeight: 600 }}>{fmt(chart.bLast)}</b></>
          }
          height={300}
          // The Month/Year toggle that used to live here is now the header's, so one control
          // moves the whole screen instead of this chart disagreeing with the cells above it.
          controls={ctl}
        >
          {({ width, height }) => (
            <LineChart
              width={width}
              height={height}
              // 96px of right gutter exists only to hold the end labels. On a phone that is a
              // quarter of the chart spent on three numbers the subtitle already states
              // ("Projected month-end €4,167") and the crosshair gives per day — so the labels
              // go and the plot takes the width back.
              pad={{ l: narrow ? 46 : 56, r: narrow ? 10 : 96, t: 12, b: 26 }}
              series={[
                { id: 'b', color: CMPB, strokeWidth: 1.8, points: chart.bCum.map((v, i) => ({ x: i, y: v })) },
                { id: 'a', color: CMPA, strokeWidth: 2.8, area: true, points: chart.aCum.map((v, i) => ({ x: i, y: v })) },
                // The dashed run-out is a forecast; a finished period has nothing to forecast.
                ...(isCurrent
                  ? [{ id: 'proj', color: CMPA, strokeWidth: 1.8, dash: '5 4', opacity: 0.6, points: [{ x: chart.elapsed - 1, y: chart.aLast }, { x: chart.totalDays - 1, y: chart.projTotal }] }]
                  : []),
              ]}
              xDomain={[0, Math.max(1, chart.totalDays - 1)]}
              yDomain={[0, chart.yMax]}
              yTicks={[0.25, 0.5, 0.75, 1].map((f) => ({ v: f * chart.yMax, label: fmtK(f * chart.yMax) }))}
              xTicks={
                seg === 'month'
                  ? [0, 1, 2, 3].map((k) => {
                      const day = Math.round((k / 3) * (chart.totalDays - 1))
                      return { v: day, label: String(day + 1) }
                    })
                  : [0, 3, 6, 9].map((mi) => ({ v: Math.round((mi / 12) * chart.totalDays), label: monthShort(`${chart.yr}-${String(mi + 1).padStart(2, '0')}`) }))
              }
              snapXs={Array.from({ length: chart.totalDays }, (_, i) => i)}
              tipContent={(i) => (
                <>
                  <div style={{ opacity: 0.6, marginBottom: 3 }}>{seg === 'month' ? `Day ${i + 1}` : `Day ${i + 1} of ${chart.totalDays}`}</div>
                  {i < chart.aCum.length && <div>{periodName} <b style={{ fontWeight: 600 }}>{fmt(chart.aCum[i] ?? 0)}</b></div>}
                  {i < chart.bCum.length && <div style={{ opacity: 0.85 }}>{prevName} {fmt(chart.bCum[i] ?? 0)}</div>}
                  {isCurrent && i >= chart.aCum.length && <div style={{ opacity: 0.85 }}>proj ≈ {fmt(chart.projTotal)}</div>}
                </>
              )}
              dots={[
                { x: chart.bCum.length - 1, y: chart.bLast, color: CMPB },
                { x: chart.elapsed - 1, y: chart.aLast, color: CMPA },
                ...(isCurrent ? [{ x: chart.totalDays - 1, y: chart.projTotal, color: CMPA, open: true }] : []),
              ]}
              decorate={({ x, y }) => {
                if (narrow) return null
                const halo = { paintOrder: 'stroke' } as const
                const aY = y(chart.aLast)
                const bYraw = y(chart.bLast)
                const bY = Math.abs(bYraw - aY) < 13 ? bYraw + (bYraw >= aY ? 13 : -13) : bYraw
                return (
                  <>
                    <text x={x(chart.bCum.length - 1) + 9} y={bY - 4} fontFamily={MONO} fontSize={11} fill={CMPB} stroke={SURFACE} strokeWidth={3} style={halo}>{fmt(chart.bLast)}</text>
                    <text x={x(chart.elapsed - 1) + 9} y={aY + 3.5} fontFamily={MONO} fontSize={11} fontWeight={600} fill={CMPA} stroke={SURFACE} strokeWidth={3} style={halo}>{fmt(chart.aLast)}</text>
                    {isCurrent && <text x={x(chart.totalDays - 1) + 9} y={y(chart.projTotal) + 14} fontFamily={MONO} fontSize={10} fill={CMPA} opacity={0.75} stroke={SURFACE} strokeWidth={3} style={halo}>{fmt(chart.projTotal)}</text>}
                  </>
                )
              }}
              liveText={(i) => `Day ${i + 1}: ${periodName} ${fmt(chart.aCum[i] ?? chart.aLast)}, ${prevName} ${fmt(chart.bCum[i] ?? chart.bLast)}`}
              ariaLabel="Cumulative spend, this period vs last"
            />
          )}
        </ChartCard>
      </div>
    </>
  )

  const planTile = (ctl: React.ReactNode) => (
    <>
      {/* PLAN · JULY */}
      <section style={{ flex: 1, minWidth: 0, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 22px' }}>
        {/* Wraps because the tile's reorder cluster now sits on the right of this row: the
            heading plus its two buttons and the freshness line already filled a phone's width,
            and the extra ~40px ran past the card edge (mobile audit R7). */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Plan · {monthName(cm)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => goTab('plan')} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>+ Budget</button>
              <span style={{ color: HAIR }}>·</span>
              <button onClick={() => goTab('plan')} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>+ Goal</button>
            </div>
          </div>
          {/* A finished month is 100% elapsed by definition, and the freshness caption describes
              how current the vault is rather than that month — the same rule Plan applies. */}
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 14 }}>
            {planIsCurrent ? (
              <>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 2, height: 11, background: FAINT, display: 'inline-block' }} />time elapsed {Math.round(planElapsed * 100)}%</span>
                {fresh.through && <span>{fresh.label}</span>}
              </>
            ) : (
              <span data-testid="dash-plan-complete">month complete · actual against budget</span>
            )}
            {ctl}
          </div>
        </div>

        <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', marginBottom: 2 }}>GOALS</div>
        {vault.goals.filter((g) => !g.archived).map((g) => {
          const st = goalStatus(vault, g, today, rates)
          const src = g.source
          const kind: 'up' | 'down' | 'legacy' = src?.kind === 'balance' ? (src.direction === 'up' ? 'up' : 'down') : 'legacy'
          return (
            <GoalRow
              key={g.id}
              name={g.name}
              detail={goalDetail(vault, g, catInfo)}
              kind={kind}
              fill={st.fraction}
              spark={kind === 'down' ? buildSpark(st.snapshots) : undefined}
              projected={st.eta != null}
              eta={st.eta}
              state={goalState(g, st)}
            />
          )
        })}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '18px 0 2px' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>BUDGETS</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: MONO, fontSize: 9.5, color: FAINT }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 1, height: 10, background: FAINT }} />today</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ display: 'inline-block', width: 0, height: 11, borderLeft: `2px dashed ${FAINT}` }} />projected</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 2, height: 11, background: 'var(--ink2)' }} />budget</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--neg)', borderRadius: 1 }} />spent past budget</span>
          </span>
        </div>
        {(() => {
          // Every budget draws with ITS period's arithmetic, mirroring Plan: monthly scopes
          // (legacy, group, recurring) pace against this month via their real scope spend;
          // year scopes (annual, annual group, yearly recurring) show their year's spend,
          // a marker at the year's elapsed fraction, a year-end pace and the ≈ €/mo caption —
          // never against one month's spend, which rendered an annual €2,400 as blown every
          // month. Only per-trip budgets stay on Plan: their span is not a calendar period.
          const rows = vault.budgets.flatMap((b) => {
            if (b.scope?.kind === 'tracking') return []
            const year = budgetScopeYear(b, cm)
            const spent = b.scope ? budgetScopeSpent(vault, b, cm, rates) : (d.spentByCatMonth.get(`${cm}|${b.categoryId}`) ?? 0)
            const proj = isMonthlyScope(b)
              ? monthEndProjectionThrough(spent, cm, through)
              : year != null
                ? yearEndProjection(spent, year, today)
                : spent
            return [{ b, year, spent, proj }]
          })
          const domainMax = computeBudgetDomain(rows.map((r) => ({ spent: r.spent, budget: r.b.amount, proj: r.proj })))
          return rows.map(({ b, year, spent, proj }, i) => {
            const catId = budgetCategoryIds(b)[0]
            const perMonth = monthlyEquivalent(b, cm)
            // A group budget keeps the same identity Plan gives it — composite title, accent,
            // member swatches — not its first member's name and color.
            const grp = b.scope?.kind === 'group' ? b.scope : undefined
            const members = grp ? grp.categoryIds.map((id) => catInfo(id)) : []
            return (
              <BudgetRow
                key={b.id}
                cat={b.name ?? (grp ? groupTitle(members) : catId ? catInfo(catId).name : 'Recurring')}
                caption={b.scope ? `${budgetScopeLabel(vault, b)}${perMonth != null ? ` · ≈ ${fmt(perMonth)}/mo` : ''}` : undefined}
                color={grp || !catId ? 'var(--accent)' : catInfo(catId).color}
                colors={grp ? members.map((m) => m.color) : undefined}
                spent={spent}
                budget={b.amount}
                proj={proj}
                domainMax={domainMax}
                done={!!b.fixed}
                first={i === 0}
                elapsed={year != null ? yearElapsedFraction(year, today) : planElapsed}
                // Same "data through" marker as Plan: the monthly projection is measured over
                // the imported window, so the bar shows where that window stops. A year row
                // paces by calendar instead, so it carries no coverage marker (as on Plan).
                covered={year != null ? undefined : through.slice(0, 7) === cm ? Number(through.slice(8, 10)) / daysInMonth(cm) : through > cm ? 1 : 0}
                canDelete={false}
              />
            )
          })
        })()}
      </section>
    </>
  )

  return (
    // The provider is what carries the anchor into the pinned widget tiles below. Outside it —
    // Trends, Accounts, Plan — the same components read the live month, so nothing there moves.
    <DashPeriodProvider value={dp}>
    <div className="rise" data-screen="dash">
      {/* header */}
      {/* Stacked on a phone: the heading, the stepper and the freshness line together need far
          more than 366px, the same squeeze the Plan header hit (mobile audit R7). */}
      <div style={narrow ? { marginBottom: 20 } : { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Dashboard</h1>
          {/* The month used to be a caption. It is the screen's one control now: every figure
              below reads the period it names, and stepping it is how you look at a month that
              has data when the current one does not yet. */}
          <div style={{ marginTop: 4 }}>
            <PeriodStepper value={pv} onChange={setPv} onGranChange={(g) => setPv((v) => withGran(v, g, thisMonth))} testidPrefix="dash" narrow={narrow} thisMonth={thisMonth} />
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, letterSpacing: '.02em', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: narrow ? 10 : 0 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: FAINT }} />
          <span data-testid="dash-freshness">{fresh.label}</span>
          {d.fxApprox > 0 && <span title="Includes foreign-currency rows converted at nearest-date rates">· ≈ FX</span>}
          {d.fxExcluded > 0 && <span style={{ color: 'var(--warn)' }} title="Foreign-currency rows with no exchange rate are excluded from totals">· {d.fxExcluded} rows excluded (no FX rate)</span>}
        </div>
      </div>

      {/* The reported symptom: on the 1st of a month every figure below reads zero, and nothing
          on the screen says why or offers a way out. A period with nothing in it says so, and
          points at the nearest one that has something. */}
      {emptyPeriod && (
        <div data-testid="dash-empty-period" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: `1px solid ${HAIR}`, background: SURFACE, borderRadius: 6, padding: '10px 14px', marginBottom: 18 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: FAINT, flex: 'none' }} />
          <span style={{ fontSize: 12.5, color: MUT }}>
            No transactions in {periodName} yet{vault.transactions.length === 0 ? '.' : ' — every figure below is zero for that reason.'}
          </span>
          {latestWithData && (
            <button data-testid="dash-goto-latest" onClick={() => setPv(latestWithData)} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Show {periodLabelOf(latestWithData, thisMonth)} →
            </button>
          )}
        </div>
      )}

      <ScreenIntro id="dash" />
      <StartHere vault={vault} />

      {/* HEADLINE METRIC ROW */}
      {/* Four cells side by side resolve to ~84–96px each on a phone, which is narrower than
          the numerals they hold — the figures overlapped and the fourth column fell off the
          screen. One per row below 720, two across on a tablet, unchanged above. */}
      <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, display: 'grid', gridTemplateColumns: pick(bp, { phone: '1fr', tablet: '1fr 1fr', desktop: '1.15fr 1fr 1fr 1.1fr' }), marginBottom: 22 }}>
        {/* Spend vs the same days last month */}
        <MetricCell testid="metric-spend" label={`Spend · ${periodName}`} explain={<Explain id="dash.spend" />}>
          <div style={big}>{fmt(headline)}</div>
          {/* No prior-month spend means there is no percentage and no comparison — saying
              "+0.0% vs €0" would assert a parity that was never computed (AUDIT §2.1). */}
          {spendPct ? (
            <>
              {/* The figures never shrink or wrap: at this column's ~243px the browser used to
                  break "+€625" between the sign and the amount, both being prefix-numeric. The
                  comparison basis gets its own line instead of competing for the same one. */}
              <div data-testid="dash-spend-delta" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexShrink: 0, whiteSpace: 'nowrap' }}>
                <Tri dir={cmpMain.delta < 0 ? 'down' : 'up'} size={9} color={FAINT} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{netLbl(cmpMain.delta)}</span>
                <span style={{ fontSize: 12, color: MUT }}>· {spendPct.text}</span>
              </div>
              <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>vs <span>{fmt(cmpMain.b.totalRaw)}</span> over {spendBWindow}</div>
            </>
          ) : (
            <div data-testid="dash-spend-nobasis" style={{ fontSize: 12, color: FAINT, marginTop: 9 }}>
              No spending in {prevName} to compare against.
            </div>
          )}
          {/* The assumption sits on its own line under the figure, because it is the part a
              first-time reader has to be given: a projection is only as good as "at this rate".
              A finished period has no rate left to run, so it states what it cost instead — the
              figure IS the total, and calling it "projected" would be a forecast of the past. */}
          <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, marginTop: 7 }}>
            {!isCurrent
              ? <>{periodName} complete</>
              : canProject
                ? <><span style={{ fontSize: 12 }}>≈</span> <span>{fmt(spendProj)}</span> projected {seg}-end</>
                : <>too early to project</>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, marginTop: 2 }}>
            {canProject ? 'at current pace · ' : ''}{elapsedDays(cmpMain.a.daysCounted, chart.totalDays)}
          </div>
          <SamePointBar
            a={headline}
            b={cmpMain.b.totalRaw}
            aLabel={spendAWindow}
            bLabel={spendBWindow}
            aAmount={fmt(headline)}
            bAmount={fmt(cmpMain.b.totalRaw)}
            onA={() => goTxns({ from: cmpMain.a.from, to: spendATo })}
            onB={() => goTxns({ from: cmpMain.b.from, to: spendBTo })}
          />
        </MetricCell>

        {/* Cash flow */}
        <MetricCell testid="metric-cashflow" label={`Cash flow · ${periodName}`} explain={<Explain id="dash.cashflow" />}>
          <div style={{ ...big, color: cf >= 0 ? GREEN : BRICK }}>{netLbl(cf)}</div>
          {/* The arithmetic behind the figure above it, rather than four projected numbers. */}
          <div style={{ fontSize: 12.5, color: FAINT, marginTop: 9 }}>
            <span style={{ color: INK, fontWeight: 500 }}>{fmt(inV)}</span> in − <span style={{ color: INK, fontWeight: 500 }}>{fmt(outV)}</span> out
          </div>
          <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <MiniBar label="IN" w={(inV / cfMax) * 100} amount={fmt(inV)} bar={GREEN} amtCol={MUT} barOpacity={0.9} ariaLabel={`Money in over ${periodName}`} title={`Open income for ${periodName} →`} onClick={() => goTxns({ ...periodDrill, cat: d.catIdByRole.get('income') })} />
            <MiniBar label="OUT" w={(outV / cfMax) * 100} amount={fmt(outV)} bar={MUT} amtCol={FAINT} ariaLabel={`Money out over ${periodName}`} title={`Open transactions for ${periodName} →`} onClick={() => goTxns({ ...periodDrill })} />
          </div>
        </MetricCell>

        {/* Savings rate */}
        <MetricCell testid="metric-savings" label="Savings rate" explain={<Explain id="dash.savings-rate" />}>
          {/* A month with no income has no savings rate — `savingsRate` returns 0 for it, which
              renders identically to genuinely keeping nothing. The panel already says so. */}
          {srIncome > 0 ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
                <div style={{ ...big, marginTop: 0, color: INK }}>{Math.round(sr)}%</div>
                <div style={{ fontSize: 12, color: FAINT }}>of income kept</div>
              </div>
              <div style={{ fontSize: 12.5, color: FAINT, marginTop: 9 }}>
                target {srTarget}%
                {srAvgMonths > 0
                  ? <> · vs {Math.round(avg3)}% over the last {srAvgMonths} complete month{srAvgMonths === 1 ? '' : 's'} · {ptsDelta(sr, avg3)}</>
                  : <> · no complete months to compare with yet</>}
              </div>
            </>
          ) : (
            <>
              <div style={{ ...big, color: FAINT }}>—</div>
              <div data-testid="dash-savings-noincome" style={{ fontSize: 12, color: FAINT, marginTop: 9 }}>No income recorded in {periodName}, so there is no rate to show.</div>
            </>
          )}
          <div style={{ position: 'relative', marginTop: 16, height: 8, background: CHIP, borderRadius: 4 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${srFill.toFixed(1)}%`, background: MUT, borderRadius: 4 }} />
            <div title={`target ${srTarget}%`} style={{ position: 'absolute', left: `${Math.min(srTarget, 100)}%`, top: -4, bottom: -4, width: 1.5, background: INK, transform: 'translateX(-1px)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>0%</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: MUT }}>100%</span>
          </div>
        </MetricCell>

        {/* Plan status */}
        <MetricCell testid="metric-plan" label={`Plan · ${monthName(cm)}`} explain={<Explain id="dash.plan" />} divider={false}>
          {/* An empty plan is not a plan being met: with no budgets and no goals this cell used
              to render "Goals on schedule ✓" — a pass for work never set up (known_issues #2). */}
          {/* "over pace" is a claim about a month still running — it means "projected to exceed".
              A finished month either did exceed its budget or did not, and there is no pace left
              to be over. */}
          {vault.budgets.length === 0
            ? planLine(FAINT, 'No budgets yet')
            : overPace.length > 0
              ? planLine(BRICK, `${overPace.slice(0, 2).join(' · ')}${overPace.length > 2 ? ` +${overPace.length - 2} more` : ''} over ${planIsCurrent ? 'pace' : 'budget'}`)
              : planLine(GREEN, `All ${vault.budgets.length} budget${vault.budgets.length === 1 ? '' : 's'} ${planIsCurrent ? 'on pace' : 'within budget'}`)}
          {activeGoals === 0
            ? planLine(FAINT, 'No goals yet')
            : goalsBehind === 0
              ? planLine(GREEN, 'Goals on schedule ✓')
              : planLine(AMBER, `${goalsBehind} goal${goalsBehind === 1 ? '' : 's'} behind`)}
          <button onClick={() => goTab('plan')} style={{ marginTop: 14, fontSize: 12.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>View plan →</button>
        </MetricCell>
      </section>

      {/* Everything below the headline is one grid: the hero chart, the cards and the plan block
          are all tiles, dragged and resized the same way. They used to be two vocabularies on one
          screen — ‹ › within the card grid, ↑ ↓ for the coarse sections — which meant the chart
          could never sit beside a card and a card could never span the width. */}
      <TileGrid
        grid={tiles}
        cols={pick(bp, { phone: 1, tablet: 2, desktop: 3 })}
        render={renderTile}
        name={tileName}
        extra={unpinControl}
        attrs={(id) => ({ 'data-dash-card': id === 'hero' || id === 'plan' ? undefined : id })}
      />

      <WidgetPicker />

      <button onClick={() => goTab('compare')} style={{ width: '100%', border: `1px dashed ${HAIR}`, borderRadius: 6, padding: '10px 14px', marginBottom: 22, color: FAINT, fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, background: 'none', cursor: 'pointer' }}>
        <svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>
        <span>Build any comparison in <span style={{ color: MUT, fontWeight: 500 }}>Compare</span>, then pin it here — drop it on a card's edge to share the line, or on a row's edge to take the width</span>
      </button>
    </div>
    </DashPeriodProvider>
  )
}

/**
 * Remove a tile from the dashboard, in two steps.
 *
 * A bare × removed the chart on a single click. There *was* an undo — the toast carries one — but
 * it sits at the bottom of a tall page for 3.5s while the eye is at the card's top-right corner,
 * so the chart simply vanished as far as anyone watching was concerned. Asking once costs a click
 * only when the intent was real, and the undo stays as the second net.
 */
function RemoveTile({ label, onRemove }: { label: string; onRemove: () => void }) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (!armed) {
    return (
      <button
        aria-label={`Remove ${label} from the dashboard`}
        onClick={(e) => { e.stopPropagation(); setArmed(true) }}
        style={{ fontFamily: MONO, fontSize: 11, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', lineHeight: 1 }}
      >
        ×
      </button>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={(e) => e.stopPropagation()}>
      <span style={{ fontSize: 11, color: FAINT }}>Remove?</span>
      <button
        aria-label="Unpin from dashboard"
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        style={{ fontSize: 11, fontWeight: 600, color: BRICK, background: 'none', border: `1px solid ${HAIR}`, borderRadius: 4, padding: '2px 7px', cursor: 'pointer', lineHeight: 1.3 }}
      >
        Remove
      </button>
      <button
        aria-label="Keep on the dashboard"
        onClick={(e) => { e.stopPropagation(); setArmed(false) }}
        style={{ fontSize: 11, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', lineHeight: 1.3 }}
      >
        Keep
      </button>
    </span>
  )
}

function goalDetail(vault: ReturnType<typeof useStoreState>['vault'], g: Goal, catInfo: (id: string) => { name: string; color: string }): string {
  const src = g.source
  if (!src) return 'manual'
  if (src.kind === 'balance') {
    const acc = vault.accounts.find((a) => a.id === src.accountId)
    return `balance-linked · ${acc?.name ?? '—'}`
  }
  if (src.categoryId) return `flow-linked · ${catInfo(src.categoryId).name}`
  return 'flow-linked'
}

/**
 * This period against the prior one: a zero-based track, the current window as a fill, the
 * prior window as a reference tick at the same height.
 *
 * It replaced two stacked bars. Those asked the reader to compare two lengths across rows —
 * the weakest judgement available — and the difference they carried was ~6%, so the pair
 * read as "two identical bars" while the text beside them already gave the number. Worse,
 * the prior-month bar was filled with `--hair`, the same token as the row's own 1px
 * dividers: at ~13% opacity it is a border, not a data mark, and it fails WCAG 1.4.11's 3:1
 * for non-text graphics. One bar plus a tick turns the question into a position judgement
 * and makes the gap between them the thing you actually see.
 *
 * `cmp-a`/`cmp-b` because BRIEF §13.2 reserves them for comparison selections and forbids
 * the semantic pair here — "a comparison is not a verdict" — and because the hero chart
 * directly below already uses these two colours to mean this period vs the last one.
 * The swatches carry the identity; the labels stay in text ink (never the data colour).
 */
function SamePointBar({ a, b, aLabel, bLabel, aAmount, bAmount, onA, onB }: { a: number; b: number; aLabel: string; bLabel: string; aAmount: string; bAmount: string; onA: () => void; onB: () => void }) {
  const domain = Math.max(a, b, 1) * 1.04 // headroom so the longer mark never sits flush at the edge
  const key: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: MONO, fontSize: 11, color: FAINT, minWidth: 0 }
  return (
    <div style={{ marginTop: 12 }}>
      {/* The label names what the bar IS, not its figure — the figures are already on screen. */}
      <div role="img" aria-label={`Spend over ${aLabel} against ${bLabel}`} style={{ position: 'relative', height: 10, background: CHIP, borderRadius: 2 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${((a / domain) * 100).toFixed(1)}%`, minWidth: 2, background: CMPA, borderRadius: 2 }} />
        {b > 0 && <div style={{ position: 'absolute', left: `${((b / domain) * 100).toFixed(1)}%`, top: -3, bottom: -3, width: 2, background: CMPB, transform: 'translateX(-1px)' }} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6 }}>
        <button data-testid="spend-bar-a" onClick={onA} aria-label={`Open transactions for ${aLabel} →`} style={key}>
          <span style={{ width: 7, height: 7, borderRadius: 1, background: CMPA, flex: 'none' }} />
          {aLabel}<span style={{ color: MUT }}>{aAmount}</span>
        </button>
        <button data-testid="spend-bar-b" onClick={onB} aria-label={`Open transactions for ${bLabel} →`} style={key}>
          <span style={{ width: 2, height: 9, background: CMPB, flex: 'none' }} />
          {bLabel}<span style={{ color: MUT }}>{bAmount}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * A labelled magnitude against a shared scale. The track is drawn even where the fill is
 * short, so a small value reads as "little of the whole" rather than as a stub floating in
 * blank space — and `aria-label` names what the bar IS, never its figure, which the adjacent
 * amount already states.
 */
function MiniBar({ label, w, amount, bar, amtCol, barOpacity, onClick, title, ariaLabel }: { label: string; w: number; amount: string; bar: string; amtCol: string; barOpacity?: number; onClick?: () => void; title?: string; ariaLabel?: string }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} title={title} aria-label={ariaLabel} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, width: '100%', cursor: onClick ? 'pointer' : 'default', textAlign: 'left' }}>
      <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT, width: 30, flex: 'none' }}>{label}</span>
      <div style={{ flex: 1, height: 7, background: CHIP, borderRadius: 2, minWidth: 0 }}><div style={{ height: 7, width: `${Math.min(w, 100).toFixed(0)}%`, background: bar, borderRadius: 2, opacity: barOpacity }} /></div>
      <span style={{ fontFamily: MONO, fontSize: 11, color: amtCol, textAlign: 'right', flex: 'none' }}>{amount}</span>
    </Tag>
  )
}
