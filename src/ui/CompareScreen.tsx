import { phoneMenu } from './styles'
import { useNarrow } from './responsive'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PeriodRef, SavedComparison, Selection, Vault } from '../model/types'
import { useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { paramToSelection } from './route'
import { ACCENT, CHIP, CMPA, CMPB, FAINT, HAIR, HAIR2, INK, MONO, MUT, SURFACE, curSym, fmt, fmtK } from './theme'
import { addMonths, currentMonthKey, monthFull, todayStr } from '../model/selectors'
import { compare } from '../analytics/compare'
import { selectionPeriod } from '../analytics/selections'
import { Explain } from './explain'
import { ChartCard, DivergingRows, LineChart } from './charts'
import { Tri } from './kit'
import { PeriodStepper, granOf, withGran, type PeriodValue } from './kit/PeriodStepper'
import { pctDelta } from './format'
import { ScreenIntro } from './ScreenIntro'

/** How many category rows the card opens with — the rest are behind "Show all". */
const TOP_CATS = 6

type Norm = 'total' | 'perDay' | 'perMonth'
type Mode = 'samePoint' | 'full'

/** Round up to a "nice" 1/2/5·10ⁿ ceiling for chart axes. */
function niceTop(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / p
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * p
}

function periodLabel(p: PeriodRef, cm: string): string {
  if ('month' in p) return monthFull(p.month)
  if ('year' in p) return String(p.year)
  if ('from' in p) return `${p.from} – ${p.to}`
  const y = Number(cm.slice(0, 4))
  switch (p.rel) {
    case 'thisMonth':
      return monthFull(cm)
    case 'lastMonth':
      return monthFull(addMonths(cm, -1))
    case 'thisYear':
      return String(y)
    case 'lastYear':
      return String(y - 1)
    case 'sameMonthLastYear':
      return monthFull(addMonths(cm, -12))
  }
}

/**
 * Where the ‹ › stepper starts for a side: its own absolute month/year, the one a relative ref
 * resolves to, or this month when the side is not a period at all (a trip, a category).
 *
 * Clamped to the present in both granularities — the stepper only guards its own steps, and a
 * seed from the future (a custom range the assistant opened) would step forward from there.
 */
function stepperValue(sel: Selection, cm: string): PeriodValue {
  const v = seedValue(sel.period, cm)
  const max = granOf(v) === 'year' ? cm.slice(0, 4) : cm
  return v > max ? max : v
}

function seedValue(p: PeriodRef | undefined, cm: string): PeriodValue {
  if (!p) return cm
  if ('month' in p) return p.month
  if ('year' in p) return String(p.year)
  if ('from' in p) return p.from.slice(0, 7)
  const y = Number(cm.slice(0, 4))
  switch (p.rel) {
    case 'thisMonth':
      return cm
    case 'lastMonth':
      return addMonths(cm, -1)
    case 'sameMonthLastYear':
      return addMonths(cm, -12)
    case 'thisYear':
      return String(y)
    case 'lastYear':
      return String(y - 1)
  }
}

/** Currency-card copy per side: excluded (no rate) vs approx (nearest-earlier ≈) vs clean. */
function currencyNote(side: { excludedCount: number; approxCount: number }): string {
  if (side.excludedCount > 0)
    return `${side.excludedCount} row${side.excludedCount === 1 ? '' : 's'} excluded from totals — no base-currency rate yet.`
  if (side.approxCount > 0)
    return `${side.approxCount} row${side.approxCount === 1 ? '' : 's'} converted at a nearest-earlier rate (≈).`
  return 'All rows in base currency. No approximation.'
}

function describe(sel: Selection, vault: Vault, cm: string): { tag: string; label: string } {
  if (sel.trackingIds?.length) {
    const tr = vault.trackings.find((t) => t.id === sel.trackingIds![0])
    return { tag: 'TRIP TAG', label: tr?.name ?? 'Trip' }
  }
  if (sel.categoryIds?.length) {
    const c = vault.categories.find((x) => x.id === sel.categoryIds![0])
    return { tag: 'CATEGORY', label: c?.name ?? 'Category' }
  }
  if (sel.merchantQuery) return { tag: 'SEARCH', label: sel.merchantQuery }
  if (sel.period) return { tag: 'PERIOD', label: periodLabel(sel.period, cm) }
  return { tag: 'ALL', label: 'Everything' }
}

const chipBase = { fontSize: 11.5, borderRadius: 5, padding: '5px 10px', cursor: 'pointer' } as const
const segBtn = (on: boolean) => ({
  fontSize: 11.5,
  color: on ? INK : FAINT,
  padding: '6px 12px',
  borderRadius: 5,
  border: 'none',
  background: on ? SURFACE : 'transparent',
  fontWeight: on ? 600 : 400,
  cursor: 'pointer',
})

export function CompareScreen() {
  const narrow = useNarrow()
  const store = useStore()
  const { vault } = useStoreState()
  const view = useView()
  const { goTxns } = view

  const today = todayStr()
  const cm = currentMonthKey()

  const t0 = vault.trackings[0]
  const t1 = vault.trackings[1]

  const [selA, setSelA] = useState<Selection>({ period: { rel: 'thisMonth' } })
  const [selB, setSelB] = useState<Selection>({ period: { rel: 'lastMonth' } })
  const [qs, setQs] = useState<'month' | 'sameYr' | 'yearYr' | 'trips' | 'custom'>('month')
  const [normalize, setNormalize] = useState<Norm>('total')
  const [mode, setMode] = useState<Mode>('samePoint')
  const [sortMode, setSortMode] = useState<'size' | 'delta'>('size')
  /** Both list cards show their head by default; the rest is one click away rather than absent. */
  const [allCats, setAllCats] = useState(false)
  const [allMovers, setAllMovers] = useState(false)
  const [picker, setPicker] = useState<'A' | 'B' | null>(null)

  const catById = useMemo(
    () => new Map(vault.categories.map((c) => [c.id, { name: c.name, color: c.color }])),
    [vault.categories],
  )

  // Seeds from other screens: '?trips=<trackingId>' preselects that trip as side A
  // (mirroring the Two-trips preset), '?saved=<id>' loads a saved comparison, and
  // '?cmpA='/'?cmpB=' carry an arbitrary pair of selections — how the assistant opens a
  // comparison it just computed, which neither of the other two can express.
  const seenNonce = useRef(0)
  useEffect(() => {
    const seed = view.seed
    if (!seed || seed.tab !== 'compare' || seed.nonce === seenNonce.current) return
    seenNonce.current = seed.nonce
    const cmpA = seed.query.cmpA ? paramToSelection(seed.query.cmpA) : null
    const cmpB = seed.query.cmpB ? paramToSelection(seed.query.cmpB) : null
    if (cmpA && cmpB) {
      setSelA(cmpA)
      setSelB(cmpB)
      setQs('custom')
      if (seed.query.norm === 'total' || seed.query.norm === 'perDay' || seed.query.norm === 'perMonth') {
        setNormalize(seed.query.norm)
      }
      if (seed.query.mode === 'samePoint' || seed.query.mode === 'full') setMode(seed.query.mode)
      return
    }
    const tripId = seed.query.trips
    if (tripId && vault.trackings.some((t) => t.id === tripId)) {
      const other = vault.trackings.find((t) => t.id !== tripId && !t.archived)
      setSelA({ trackingIds: [tripId] })
      if (other) setSelB({ trackingIds: [other.id] })
      setQs('trips')
      setNormalize('perDay')
    }
    const savedId = seed.query.saved
    if (savedId) {
      const sc = vault.savedComparisons.find((c) => c.id === savedId)
      if (sc) {
        setSelA(sc.selections[0]!)
        setSelB(sc.selections[1] ?? sc.selections[0]!)
        if (sc.normalize) setNormalize(sc.normalize)
        setQs('custom')
      }
    }
  }, [view.seed, vault.trackings, vault.savedComparisons])

  const rates = useRateBook()
  const r = useMemo(
    () => compare(vault, selA, selB, today, { normalize, mode, rates }),
    [vault, selA, selB, today, normalize, mode, rates],
  )

  /** Drill one side's rows for a category into Transactions, bounded by that side's period. */
  const drillSide = (side: 'A' | 'B', categoryId?: string) => {
    const sel = side === 'A' ? selA : selB
    const { from, to } = selectionPeriod(sel, vault, today)
    goTxns({ cat: categoryId, from, to: to > today ? today : to })
  }

  const dA = describe(selA, vault, cm)
  const dB = describe(selB, vault, cm)
  const isTrips = qs === 'trips'
  const excluded = r.a.excludedCount + r.b.excludedCount
  const approx = r.a.approxCount + r.b.approxCount
  // No percentage against an empty side B — "+43000%" against €1 is noise.
  const pct = pctDelta(r.a.total, r.b.total, 0)
  const up = r.delta >= 0
  const modeLabel = mode === 'samePoint' ? 'same point in time' : 'full period'

  const setSide = (side: 'A' | 'B', sel: Selection, keepOpen = false) => {
    if (side === 'A') setSelA(sel)
    else setSelB(sel)
    setQs('custom')
    if (!keepOpen) setPicker(null)
  }
  /** Stepping is exploratory — the menu stays open so the next step is one click, not three. */
  const setSidePeriod = (side: 'A' | 'B', v: PeriodValue) =>
    setSide(side, { period: granOf(v) === 'year' ? { year: Number(v) } : { month: v } }, true)
  const swap = () => {
    setSelA(selB)
    setSelB(selA)
  }

  // The pin button is a TOGGLE that reflects state — pinning twice used to
  // accumulate identical unremovable 'Comparison' cards.
  const pinnedMatch = vault.savedComparisons.find(
    (c) => c.pinned && JSON.stringify(c.selections) === JSON.stringify([selA, selB]) && (c.normalize ?? 'total') === normalize,
  )
  const pin = () => {
    if (pinnedMatch) {
      store.commit({ kind: 'setField', collection: 'savedComparisons', id: pinnedMatch.id, field: 'pinned', value: false }, { msg: 'Unpinned from dashboard', undoable: true })
      return
    }
    const rec: SavedComparison = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      updatedAt: new Date().toISOString(),
      name: `${dA.label} vs ${dB.label}`,
      selections: [selA, selB],
      normalize,
      pinned: true,
      order: vault.savedComparisons.length,
    }
    store.commit({ kind: 'restore', collection: 'savedComparisons', records: [rec] }, { msg: 'Pinned to dashboard', undoable: true })
  }

  // ----- picker options (period presets + trips) -----
  const periodOpts: { label: string; sel: Selection }[] = [
    { label: 'This month', sel: { period: { rel: 'thisMonth' } } },
    { label: 'Last month', sel: { period: { rel: 'lastMonth' } } },
    { label: 'Same month last year', sel: { period: { rel: 'sameMonthLastYear' } } },
    { label: 'This year', sel: { period: { rel: 'thisYear' } } },
    { label: 'Last year', sel: { period: { rel: 'lastYear' } } },
  ]

  // Plain render helpers, NOT components — an inline component type remounts its subtree every render.
  const sideButton = (side: 'A' | 'B', d: { tag: string; label: string }, color: string) => {
    const sv = stepperValue(side === 'A' ? selA : selB, cm)
    return (
      <div style={{ position: 'relative' }}>
        <button
          data-testid={`cmp-side-${side}`}
          onClick={() => setPicker(picker === side ? null : side)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, background: SURFACE, border: `1px solid ${HAIR}`, borderLeft: `3px solid ${color}`, borderRadius: 6, padding: '9px 14px', textAlign: 'left', cursor: 'pointer' }}
        >
          <span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 9.5, color, letterSpacing: '.05em' }}>{side} · {d.tag}</span>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: INK }}>{d.label}</span>
          </span>
          <svg width="11" height="11" viewBox="0 0 12 12" stroke={FAINT} strokeWidth="1.4" fill="none"><path d="M2 4l4 4 4-4" /></svg>
        </button>
        {picker === side && (
          <div style={{ position: 'absolute', left: 0, top: 52, zIndex: 40, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, minWidth: 300, boxShadow: '0 10px 28px rgba(10,9,7,.16)', display: 'flex', flexDirection: 'column', gap: 1 , ...phoneMenu(narrow) }}>
            {periodOpts.map((o) => (
              <button key={o.label} onClick={() => setSide(side, o.sel)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{o.label}</button>
            ))}
            {vault.trackings.map((tr) => (
              <button key={tr.id} onClick={() => setSide(side, { trackingIds: [tr.id] })} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{tr.name}</button>
            ))}
            {/* Every preset above is relative to now. "March 2024 against March 2023" was reachable
                only by asking the assistant — this is the same stepper the Dashboard and Plan carry,
                so any month or year is a side without leaving the screen. */}
            <div style={{ borderTop: `1px solid ${HAIR2}`, marginTop: 4, paddingTop: 7 }}>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.05em', padding: '0 9px 6px' }}>ANY MONTH OR YEAR</div>
              <div style={{ padding: '0 5px 4px' }}>
                <PeriodStepper
                  value={sv}
                  onChange={(v) => setSidePeriod(side, v)}
                  onGranChange={(g) => setSidePeriod(side, withGran(sv, g, cm))}
                  testidPrefix={`cmp-${side}`}
                  narrow={narrow}
                  thisMonth={cm}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // shared normalize + mode controls
  const controls = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      <div data-seg style={{ display: 'inline-flex', gap: 1, background: CHIP, borderRadius: 6, padding: 2 }}>
        {(['total', 'perDay', 'perMonth'] as Norm[]).map((n) => (
          <button key={n} onClick={() => setNormalize(n)} aria-pressed={normalize === n} style={segBtn(normalize === n)}>{n === 'total' ? 'Total' : n === 'perDay' ? 'Per day' : 'Per month'}</button>
        ))}
      </div>
      <div data-seg style={{ display: 'inline-flex', gap: 1, background: CHIP, borderRadius: 6, padding: 2 }}>
        <button onClick={() => setMode('samePoint')} aria-pressed={mode === 'samePoint'} style={segBtn(mode === 'samePoint')}>Same-point</button>
        <button onClick={() => setMode('full')} aria-pressed={mode === 'full'} style={segBtn(mode === 'full')}>Full period</button>
      </div>
    </div>
  )

  const diffBlock = (
    <div style={{ paddingBottom: 3 }}>
      <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.03em' }}>DIFFERENCE</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
        <Tri dir={up ? 'up' : 'down'} size={11} color={FAINT} />
        <span style={{ fontSize: 22, fontWeight: 600, color: INK }}>{fmt(Math.abs(r.delta))}</span>
        <span style={{ fontSize: 13, color: FAINT }}>{pct === null ? 'B is empty' : pct.text}</span>
      </div>
    </div>
  )

  // ----- category paired bars -----
  const catRows = useMemo(() => {
    // A category with nothing on either side is not a comparison — an income row spends 0 by
    // construction (#13), so it reached `byCategory` with two empty bars. The head-of-list cut
    // used to hide those; "Show all" would have put them on screen. Filtered here rather than in
    // `compare`, whose contract is "every category either side touched".
    const list = r.byCategory.filter((c) => c.a !== 0 || c.b !== 0)
    // 'Δ' relies on byCategory arriving |delta|-sorted — sort explicitly so the
    // toggle stays honest if that upstream order ever changes.
    if (sortMode === 'size') list.sort((x, y) => Math.max(y.a, y.b) - Math.max(x.a, x.b))
    else list.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    return list
  }, [r.byCategory, sortMode])
  const cats = allCats ? catRows : catRows.slice(0, TOP_CATS)
  const catMax = Math.max(1, ...cats.flatMap((c) => [c.a, c.b]))

  // ----- movers -----
  // `byCategory` arrives |delta|-sorted. A category that moved by nothing is not a mover, and
  // with the tail on screen it would be a row of pure noise — so the zero rows go, here rather
  // than in `compare` (same reasoning as `catRows`).
  const moverRows = useMemo(() => r.byCategory.filter((m) => m.delta !== 0), [r.byCategory])
  const movers = allMovers ? moverRows : moverRows.slice(0, TOP_CATS)
  const moverMax = Math.max(1, ...movers.map((m) => Math.abs(m.delta)))

  // ----- cumulative overlay data -----
  const days = Math.max(r.a.cumulative.length, r.b.cumulative.length)
  const span = Math.max(1, days - 1)
  // Refund-heavy series peak mid-way: scale to the series MAX, not the last point.
  const cumTop = niceTop(Math.max(0, ...r.a.cumulative, ...r.b.cumulative))
  const lastA = r.a.cumulative[r.a.cumulative.length - 1] ?? 0
  const lastB = r.b.cumulative[r.b.cumulative.length - 1] ?? 0
  // Short selections produced duplicate stacked ticks — dedupe.
  const dayTicks = [...new Set(Array.from({ length: 5 }, (_, k) => Math.round((span * (k + 1)) / 5)))]

  return (
    <div data-screen="compare">
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Compare</h1>
        <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>A selection is any filter — a period, a category, or a trip tag. Put two side by side.</div>
      </div>
      <ScreenIntro id="compare" />

      {/* A / swap / B + quick-start */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {sideButton('A', dA, CMPA)}
        <button aria-label="Swap A and B" onClick={swap} style={{ width: 30, height: 30, border: `1px solid ${HAIR}`, borderRadius: 6, color: MUT, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: SURFACE, cursor: 'pointer' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" fill="none"><path d="M4 6h9l-3-3M12 10H3l3 3" /></svg>
        </button>
        {sideButton('B', dB, CMPB)}
        <div style={{ flex: 1, minWidth: 16 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, marginRight: 2 }}>QUICK-START</span>
          <button onClick={() => { setSelA({ period: { rel: 'thisMonth' } }); setSelB({ period: { rel: 'lastMonth' } }); setQs('month') }} style={{ ...chipBase, ...(qs === 'month' ? { background: INK, color: SURFACE, border: `1px solid ${INK}` } : { color: MUT, border: `1px solid ${HAIR}` }) }}>This vs last month</button>
          <button onClick={() => { setSelA({ period: { rel: 'thisMonth' } }); setSelB({ period: { rel: 'sameMonthLastYear' } }); setQs('sameYr') }} style={{ ...chipBase, ...(qs === 'sameYr' ? { background: INK, color: SURFACE, border: `1px solid ${INK}` } : { color: MUT, border: `1px solid ${HAIR}` }) }}>vs same month last year</button>
          <button onClick={() => { setSelA({ period: { rel: 'thisYear' } }); setSelB({ period: { rel: 'lastYear' } }); setQs('yearYr') }} style={{ ...chipBase, ...(qs === 'yearYr' ? { background: INK, color: SURFACE, border: `1px solid ${INK}` } : { color: MUT, border: `1px solid ${HAIR}` }) }}>This year vs last</button>
          <button disabled={!t0 || !t1} onClick={() => { if (t0 && t1) { setSelA({ trackingIds: [t0.id] }); setSelB({ trackingIds: [t1.id] }); setQs('trips'); setNormalize('perDay') } }} style={{ ...chipBase, opacity: !t0 || !t1 ? 0.4 : 1, ...(qs === 'trips' ? { background: INK, color: SURFACE, border: `1px solid ${INK}` } : { color: MUT, border: `1px solid ${HAIR}` }) }}>Two trips</button>
        </div>
      </div>

      {/* header card */}
      <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '20px 24px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: CMPA, letterSpacing: '.03em' }}>{dA.label.toUpperCase()} · {r.a.daysCounted} {r.a.daysCounted === 1 ? 'DAY' : 'DAYS'}</div>
              <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-.02em', color: CMPA, marginTop: 4, lineHeight: 1 }}>{fmt(r.a.total)}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: CMPB, letterSpacing: '.03em' }}>{dB.label.toUpperCase()} · {r.b.daysCounted} {r.b.daysCounted === 1 ? 'DAY' : 'DAYS'}</div>
              <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-.02em', color: CMPB, marginTop: 4, lineHeight: 1 }}>{fmt(r.b.total)}</div>
            </div>
            {diffBlock}
          </div>
          <div style={{ textAlign: 'right' }}>
            {controls}
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 8 }}>showing {modeLabel} · {curSym()}</div>
          </div>
        </div>
        <div style={{ marginTop: 14, paddingTop: 13, borderTop: `1px solid ${HAIR2}`, fontSize: 12, color: FAINT, lineHeight: 1.5 }}>
          {isTrips ? (
            <>Trip vs trip defaults to <b style={{ color: MUT }}>per day</b> — the only fair basis when lengths differ; transfers to your own accounts aren’t trip spend.</>
          ) : (
            <>Comparing {dA.label} against {dB.label}, normalized by {normalize === 'total' ? 'total' : normalize === 'perDay' ? 'day' : 'month'}, counted at {modeLabel}.</>
          )}
          {excluded > 0 && <span style={{ color: MUT }}> · {excluded} row{excluded === 1 ? '' : 's'} excluded (no rate)</span>}
          {approx > 0 && <span style={{ color: MUT }}> · ≈ {approx} row{approx === 1 ? '' : 's'} converted</span>}
        </div>
      </section>

      {/* two-column body */}
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.7fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* by category */}
          <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>By category — {curSym()}<Explain id="compare.categories" /></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>SORT</span>
                <div data-seg style={{ display: 'inline-flex', gap: 1, background: CHIP, borderRadius: 5, padding: 2 }}>
                  <button onClick={() => setSortMode('size')} aria-pressed={sortMode === 'size'} style={{ ...segBtn(sortMode === 'size'), padding: '5px 11px' }}>Size</button>
                  <button onClick={() => setSortMode('delta')} aria-pressed={sortMode === 'delta'} style={{ ...segBtn(sortMode === 'delta'), padding: '5px 11px' }}>Δ</button>
                </div>
              </div>
            </div>
            {cats.map((c) => {
              const cat = catById.get(c.categoryId) ?? { name: '—', color: FAINT }
              return (
                <div key={c.categoryId} style={{ display: 'grid', gridTemplateColumns: narrow ? '92px 1fr' : '118px 1fr', gap: narrow ? 8 : 14, alignItems: 'center', padding: '9px 0', borderTop: `1px solid ${HAIR2}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: INK }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: cat.color, flex: 'none' }} />{cat.name}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <button data-cmp-bar={`A-${cat.name}`} onClick={() => drillSide('A', c.categoryId)} title={`Open ${cat.name} · ${dA.label} →`} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: 'none', border: 'none', padding: 0, width: '100%', textAlign: 'left' }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: CMPA, width: 18 }}>A</span>
                      <div style={{ height: 11, borderRadius: 2, background: CMPA, width: `${(c.a / catMax) * 100}%`, minWidth: 3 }} />
                      <span style={{ fontFamily: MONO, fontSize: 11, color: INK }}>{fmt(c.a)}</span>
                    </button>
                    <button data-cmp-bar={`B-${cat.name}`} onClick={() => drillSide('B', c.categoryId)} title={`Open ${cat.name} · ${dB.label} →`} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', background: 'none', border: 'none', padding: 0, width: '100%', textAlign: 'left' }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: CMPB, width: 18 }}>B</span>
                      <div style={{ height: 11, borderRadius: 2, background: CMPB, width: `${(c.b / catMax) * 100}%`, minWidth: 3 }} />
                      <span style={{ fontFamily: MONO, fontSize: 11, color: MUT }}>{fmt(c.b)}</span>
                    </button>
                  </div>
                </div>
              )
            })}
            {cats.length === 0 && <div style={{ padding: '16px 0', fontSize: 12.5, color: FAINT, borderTop: `1px solid ${HAIR2}` }}>No spending in either selection.</div>}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 11 }}>
              <div style={{ fontSize: 11, color: FAINT, flex: 1 }}>
                {catRows.length > cats.length
                  ? `Top ${cats.length} of ${catRows.length} categories — the totals above count all of them. `
                  : allCats && catRows.length > TOP_CATS
                    ? `All ${catRows.length} categories. `
                    : ''}
                Shared scale, one baseline · click any bar to drill to its transactions.
              </div>
              {/* The head is a default, not a limit: the tail was previously unreachable, and a
                  category outside the top six is exactly the one a reader comes here doubting. */}
              {catRows.length > TOP_CATS && (
                <button
                  data-testid="cmp-cats-all"
                  onClick={() => setAllCats((v) => !v)}
                  style={{ fontSize: 11.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', flex: 'none', fontWeight: 500 }}
                >
                  {allCats ? `Show top ${TOP_CATS}` : `Show all ${catRows.length}`}
                </button>
              )}
            </div>
          </section>

          {/* cumulative overlay */}
          <ChartCard
            testid="cmp-cum"
            explain="compare.normalize"
            ariaLabel="Cumulative totals, day-aligned"
            title={`Cumulative totals — ${curSym()}, day-aligned`}
            subtitle="Both start at day 1. Hover to compare any day."
            height={210}
          >
            {({ width, height }) => (
              <LineChart
                width={width}
                height={height}
                pad={{ l: narrow ? 46 : undefined, r: narrow ? 10 : 96, b: 36 }}
                series={[
                  { id: 'b', color: CMPB, strokeWidth: 2, points: r.b.cumulative.map((v, i) => ({ x: i, y: v })) },
                  { id: 'a', color: CMPA, strokeWidth: 2.6, points: r.a.cumulative.map((v, i) => ({ x: i, y: v })) },
                ]}
                xDomain={[0, span]}
                yDomain={[0, cumTop]}
                yTicks={[0, 1, 2, 3].map((k) => ({ v: (cumTop * k) / 3, label: fmtK((cumTop * k) / 3) }))}
                xTicks={dayTicks.map((dd) => ({ v: dd, label: String(dd + 1) }))}
                snapXs={Array.from({ length: days }, (_, i) => i)}
                tipContent={(i) => (
                  <>
                    <div style={{ opacity: 0.6, marginBottom: 3 }}>Day {i + 1}</div>
                    {i < r.a.cumulative.length && <div>A <b style={{ fontWeight: 600 }}>{fmt(r.a.cumulative[i] ?? 0)}</b></div>}
                    {i < r.b.cumulative.length ? (
                      <div style={{ opacity: 0.85 }}>B {fmt(r.b.cumulative[i] ?? 0)}</div>
                    ) : (
                      <div style={{ opacity: 0.6 }}>B ended on day {r.b.cumulative.length}</div>
                    )}
                  </>
                )}
                dots={[
                  { x: r.b.cumulative.length - 1, y: lastB, color: CMPB },
                  { x: r.a.cumulative.length - 1, y: lastA, color: CMPA },
                ]}
                decorate={({ x, y, plot }) => {
                  const ay = y(lastA) - 5
                  const byRaw = y(lastB) + 3.5
                  // End labels overprinted when totals were close — nudge B clear of A.
                  const by = Math.abs(byRaw - ay) < 13 ? byRaw + (byRaw >= ay ? 13 : -13) : byRaw
                  return (
                    <>
                      <text x={x(r.a.cumulative.length - 1) + 9} y={ay} fontFamily="IBM Plex Mono" fontSize="11.5" fontWeight="600" fill={CMPA}>A {fmt(lastA)}</text>
                      <text x={x(r.b.cumulative.length - 1) + 9} y={by} fontFamily="IBM Plex Mono" fontSize="11.5" fill={CMPB}>B {fmt(lastB)}</text>
                      <text x={(plot.l + plot.r) / 2} y={plot.b + 30} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="9" fill="var(--ink3)" letterSpacing="0.08em">DAY</text>
                    </>
                  )
                }}
                liveText={(i) => `Day ${i + 1}: A ${fmt(r.a.cumulative[i] ?? lastA)}, B ${i < r.b.cumulative.length ? fmt(r.b.cumulative[i] ?? 0) : 'no data'}`}
                ariaLabel="Cumulative totals, day-aligned"
              />
            )}
          </ChartCard>
        </div>

        {/* right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Movers</div>
            <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>A vs B · {modeLabel} · sorted by |Δ|</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9, color: FAINT, margin: '14px 0 2px', padding: '0 2px' }}><span>← less</span><span>more →</span></div>
            <DivergingRows
              labelWidth={92}
              rows={movers.map((mv) => {
                const cat = catById.get(mv.categoryId) ?? { name: '—', color: FAINT }
                return {
                  key: mv.categoryId,
                  label: cat.name,
                  delta: mv.delta,
                  frac: Math.abs(mv.delta) / moverMax,
                  value: fmt(Math.abs(mv.delta)),
                  title: `Open ${cat.name} · ${dA.label} →`,
                  onClick: () => drillSide('A', mv.categoryId),
                }
              })}
            />
            {moverRows.length > TOP_CATS && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 11 }}>
                <div style={{ fontSize: 11, color: FAINT, flex: 1 }}>
                  {allMovers ? `All ${moverRows.length} that moved.` : `Top ${TOP_CATS} of ${moverRows.length} that moved.`}
                </div>
                <button
                  data-testid="cmp-movers-all"
                  onClick={() => setAllMovers((v) => !v)}
                  style={{ fontSize: 11.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', flex: 'none', fontWeight: 500 }}
                >
                  {allMovers ? `Show top ${TOP_CATS}` : `Show all ${moverRows.length}`}
                </button>
              </div>
            )}
          </section>

          <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Currency</div>
            <div style={{ fontSize: 12, color: FAINT, marginTop: 2, lineHeight: 1.5 }}>Each amount converts at its own transaction-date rate. Cross-currency figures are marked.</div>
            <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: 13 }}>
              <div style={{ borderLeft: `3px solid ${CMPA}`, padding: '1px 0 1px 11px' }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: CMPA }}>{dA.label.toUpperCase()}</div>
                <div style={{ fontSize: 12.5, color: MUT, marginTop: 3, lineHeight: 1.5 }}>{currencyNote(r.a)}</div>
              </div>
              <div style={{ borderLeft: `3px solid ${CMPB}`, padding: '1px 0 1px 11px' }}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: CMPB }}>{dB.label.toUpperCase()}</div>
                <div style={{ fontSize: 12.5, color: MUT, marginTop: 3, lineHeight: 1.5 }}>{currencyNote(r.b)}</div>
              </div>
            </div>
          </section>

          <button data-testid="pin-toggle" aria-pressed={!!pinnedMatch} onClick={pin} style={{ ...chipBase, padding: '9px 14px', background: pinnedMatch ? SURFACE : INK, color: pinnedMatch ? MUT : SURFACE, border: `1px solid ${pinnedMatch ? HAIR : INK}`, fontSize: 13, fontWeight: 600 }}>{pinnedMatch ? 'Pinned ✓ — unpin' : 'Pin to dashboard'}</button>
        </div>
      </div>
    </div>
  )
}
