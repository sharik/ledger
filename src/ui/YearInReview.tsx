// Year in review (BRIEF §16, Phase F). A composed report over existing selectors —
// no new data: yearly income/expense/net, biggest category shifts vs the prior
// year, trips recap, and the net-worth delta across the year.
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { useStoreState, useDerived } from './store'
import { useRateBook } from './fxCtx'
import { isCashflow, todayStr } from '../model/selectors'
import { DivergingRows } from './charts'
import { compare } from '../analytics/compare'
import { tripSummary } from '../analytics/trips'
import { BG, HAIR, HAIR2, INK, MONO, MUT, FAINT, SURFACE, GREEN, BRICK, ACCENT, fmt, netLbl } from './theme'

export function YearInReview({ year: initialYear, onClose }: { year: number; onClose: () => void }) {
  const { vault } = useStoreState()
  const d = useDerived()
  const rates = useRateBook()
  const today = todayStr()
  const base = vault.params.baseCurrency ?? 'EUR'
  // Any year with data is reviewable — not just the current one.
  const [year, setYear] = useState(initialYear)
  const years = useMemo(() => [...new Set(d.monthsTracked.map((mk) => Number(mk.slice(0, 4))))].sort((a, b) => b - a), [d.monthsTracked])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const totals = useMemo(() => {
    let income = 0
    let expense = 0
    const y = String(year)
    for (const t of vault.transactions) {
      if (t.date.slice(0, 4) !== y) continue
      if (!isCashflow(t)) continue
      if (t.amount > 0) income += t.amount
      else expense += -t.amount
    }
    return { income, expense, net: income - expense }
  }, [vault.transactions, year])

  // Category shifts: this year vs last year (per-category delta), biggest movers.
  const shifts = useMemo(() => {
    const r = compare(vault, { period: { year } }, { period: { year: year - 1 } }, today, { mode: 'full', rates })
    return r.byCategory.slice(0, 5)
  }, [vault, year, today, rates])

  const trips = useMemo(
    () => vault.trackings.filter((t) => t.kind === 'trip' && (t.dateFrom ?? '').slice(0, 4) === String(year)).map((t) => ({ t, s: tripSummary(vault, t.id, base, rates) })),
    [vault, year, base, rates],
  )

  const nwDelta = useMemo(() => {
    const inYear = d.netWorthByMonth.filter((m) => m.mk.slice(0, 4) === String(year))
    if (inYear.length < 2) return null
    return { start: inYear[0]!.nw, end: inYear[inYear.length - 1]!.nw, delta: inYear[inYear.length - 1]!.nw - inYear[0]!.nw }
  }, [d.netWorthByMonth, year])

  const catName = (id: string) => vault.categories.find((c) => c.id === id)?.name ?? '—'

  return createPortal(
    <div data-testid="year-in-review" role="dialog" aria-modal="true" aria-label={`Year in review ${year}`} style={{ position: 'fixed', inset: 0, zIndex: 62, background: BG, overflowY: 'auto', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 720, padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, letterSpacing: '.08em' }}>YEAR IN REVIEW</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1 style={{ margin: '4px 0 0', fontSize: 28, fontWeight: 600, color: INK }}>{year}</h1>
              {years.length > 1 && (
                <select data-testid="yir-year" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Review a different year" style={{ fontSize: 12.5, padding: '5px 8px', border: `1px solid ${HAIR}`, borderRadius: 6, background: SURFACE, color: MUT }}>
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <button data-testid="yir-close" autoFocus onClick={onClose} style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 13px', background: SURFACE, cursor: 'pointer' }}>Close</button>
        </div>

        <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px', marginBottom: 16, display: 'flex', gap: 40, flexWrap: 'wrap' }}>
          <Stat label="INCOME" value={fmt(totals.income)} />
          <Stat label="EXPENSE" value={fmt(totals.expense)} />
          <Stat label="NET" value={netLbl(totals.net)} color={totals.net >= 0 ? GREEN : BRICK} />
          {nwDelta && <Stat label="NET WORTH Δ" value={netLbl(nwDelta.delta)} color={nwDelta.delta >= 0 ? GREEN : BRICK} />}
        </section>

        {totals.income === 0 && totals.expense === 0 && trips.length === 0 && (
          <div data-testid="yir-empty" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '22px 20px', marginBottom: 16, fontSize: 13, color: MUT }}>
            Nothing to review for {year} — no transactions or trips in this year yet.
          </div>
        )}

        <Panel title="Biggest category shifts vs last year">
          {shifts.length === 0 && <Empty>Not enough history to compare.</Empty>}
          {shifts.length > 0 && (
            <DivergingRows
              labelWidth={110}
              rows={shifts.map((sh) => ({
                key: sh.categoryId,
                label: catName(sh.categoryId),
                delta: sh.delta,
                frac: Math.abs(sh.delta) / Math.max(1, ...shifts.map((x) => Math.abs(x.delta))),
                value: fmt(Math.abs(sh.delta)),
              }))}
            />
          )}
        </Panel>

        <Panel title="Trips">
          {trips.length === 0 && <Empty>No trips tagged in {year}.</Empty>}
          {trips.map(({ t, s }) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
              <span style={{ color: INK }}>{t.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: MUT }}><span>{fmt(s.total)}</span> · {s.days}d · <span>{fmt(s.perDay)}</span>/day</span>
            </div>
          ))}
        </Panel>

        <div style={{ marginTop: 18 }}>
          <button onClick={onClose} style={{ width: '100%', background: ACCENT, color: 'var(--on-accent)', fontSize: 13, fontWeight: 600, padding: '11px', borderRadius: 6, border: 'none', cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Stat({ label, value, color = INK }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, color }}>{value}</div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 4 }}>{title}</div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: FAINT, padding: '8px 0' }}>{children}</div>
}
