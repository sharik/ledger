// Trips & Trackings (mock 665–820, ANALYTICS §8). Timeline + per-trip cards +
// editable forecast + retroactive creation flow (pick range → preview → suggested
// exclusions → one atomic addTracking). Trip spend converts through the RateBook.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tracking } from '../model/types'
import { useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { parseHash } from './route'
import { todayStr } from '../model/selectors'
import { tripSummary, suggestExcludes, tripForecast, type ExcludeSuggestion } from '../analytics/trips'
import { detectTrips, detectHomeTrips, type TripCandidate } from '../analytics/tripDetect'
import { ACCENT, AMBER, FAINT, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2, fmt, netLbl } from './theme'
import { btnOutline, phoneMenu } from './styles'
import { useNarrow } from './responsive'
import { ScreenIntro } from './ScreenIntro'
import { TripDetail } from './TripDetail'
import { Explain } from './explain'
import { TripTimelineWidget } from './widgets/TripsWidgets'
import { candidateKey, dismissCandidate, isCandidateDismissed, loadHelp, saveHelp } from './uiPrefs'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMon = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
const input = { fontSize: 13, padding: '7px 11px', border: `1px solid ${HAIR}`, borderRadius: 6, background: SURFACE, color: INK, fontFamily: MONO }
const primary = { background: ACCENT, color: 'var(--on-accent)', fontSize: 13, fontWeight: 500, padding: '9px 16px', borderRadius: 6, border: 'none', cursor: 'pointer' } as const

export function TripsScreen() {
  const narrow = useNarrow()
  const { vault } = useStoreState()
  const store = useStore()
  const view = useView()
  const { go, goTxns } = view
  const today = todayStr()
  const base = vault.params.baseCurrency ?? 'EUR'
  const rates = useRateBook()

  const trips = useMemo(() => vault.trackings.filter((t) => t.kind === 'trip' && !t.archived), [vault.trackings])
  const summaries = useMemo(() => trips.map((t) => ({ tr: t, s: tripSummary(vault, t.id, base, rates) })), [trips, vault, base, rates])
  // Archiving is gone (there was never an un-archive anywhere, so it was a one-way hide dressed up
  // as the safe option). Anything archived by the old menu would otherwise be stranded — this strip
  // is the way back out, and it disappears for good once it is empty.
  const archivedTrips = useMemo(() => vault.trackings.filter((t) => t.kind === 'trip' && t.archived), [vault.trackings])

  // Which trip is open, as a route query rather than local state — so it deep-links, survives a
  // reload and answers to Back. (Trip mode used to be a `useState` in App with none of that.)
  const [openTrip, setOpenTrip] = useState<string | null>(() => parseHash(location.hash).query.trip ?? null)
  const seenNonce = useRef(0)
  useEffect(() => {
    const seed = view.seed
    if (!seed || seed.tab !== 'trips' || seed.nonce === seenNonce.current) return
    seenNonce.current = seed.nonce
    // Unlike the Transactions drill, an EMPTY query is meaningful here: '#/trips' is the list and
    // '#/trips?trip=x' is one trip, so a query-less seed must close the detail. Early-returning on
    // it (the pattern that screen uses) would make both the nav button and Back do nothing.
    setOpenTrip(seed.query.trip ?? null)
  }, [view.seed])

  // The one-tap entry the "Trip mode" button existed for: the trip you are on, else the latest.
  const currentTripId = useMemo(() => {
    const active = trips.find((t) => t.dateFrom && t.dateTo && today >= t.dateFrom && today <= t.dateTo)
    return (active ?? [...trips].sort((a, b) => ((a.dateTo ?? '') < (b.dateTo ?? '') ? 1 : -1))[0])?.id
  }, [trips, today])

  // forecast controls
  const [fDays, setFDays] = useState(10)
  const [fPlan, setFPlan] = useState('')
  const forecast = useMemo(() => tripForecast(vault, trips.map((t) => t.id), fDays, base, rates), [vault, trips, fDays, base, rates])
  const planTarget = Number(fPlan) || 0

  // creation flow
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [name, setName] = useState('')
  const [drop, setDrop] = useState<Set<string>>(new Set())

  const winTxns = useMemo(
    () => vault.transactions.filter((t) => t.date >= from && t.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1)),
    [vault.transactions, from, to],
  )
  const suggestions: ExcludeSuggestion[] = useMemo(
    () => (step === 3 ? suggestExcludes(vault, { id: 'draft', dateFrom: from, dateTo: to }) : []),
    [vault, from, to, step],
  )

  // The wizard lives at the bottom of the screen, below the timeline, the cards and the forecast.
  // "+ New trip" at the top opened it there and nothing moved, so the button read as broken —
  // bring the form to the user rather than expecting them to go looking for it.
  const createRef = useRef<HTMLElement>(null)
  const startCreate = () => {
    setStep(1)
    setFrom(today)
    setTo(today)
    setName('')
    setDrop(new Set())
    requestAnimationFrame(() => createRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  // Local trip detection over the whole ledger (§8): foreign-currency spend clustered by date.
  // Candidates already covered by an existing trip (same name, or overlapping window) are dropped.
  const [candidates, setCandidates] = useState<TripCandidate[] | null>(null)
  const [review, setReview] = useState<{ cand: TripCandidate; name: string; include: Set<string> } | null>(null)
  const runDetect = () => {
    const proj = vault.transactions.map((t) => ({ id: t.id, date: t.date, amount: t.amount, currency: t.original?.currency, merchant: t.merchant }))
    // Foreign-currency trips (§8), plus a best-effort pass for same-currency-zone trips that
    // carry no foreign rows — a conservative spending-density signal (#16a). Both only suggest.
    const found = [...detectTrips(proj, { home: base }), ...detectHomeTrips(proj, { home: base })]
    const covered = (c: TripCandidate) =>
      trips.some((tr) => tr.name.toLowerCase() === c.name.toLowerCase() || (tr.dateFrom != null && tr.dateTo != null && !(c.dateTo < tr.dateFrom || c.dateFrom > tr.dateTo)))
    // A home-density burst can overlap a foreign trip in the same window — keep the foreign one.
    const foreignWindows = found.filter((c) => c.kind === 'foreign')
    const deduped = found.filter((c) => c.kind === 'foreign' || !foreignWindows.some((f) => !(c.dateTo < f.dateFrom || c.dateFrom > f.dateTo)))
    const prefs = loadHelp()
    setCandidates(deduped.filter((c) => !covered(c) && !isCandidateDismissed(prefs, candidateKey(c))))
  }
  const dismissOne = (c: TripCandidate) => {
    saveHelp(dismissCandidate(loadHelp(), candidateKey(c)))
    setCandidates((cs) => (cs ? cs.filter((x) => candidateKey(x) !== candidateKey(c)) : cs))
  }
  // Review & create: open a review of the window's transactions with the detected ones pre-included
  // and everything else pre-excluded. Nothing is written until the user confirms.
  const reviewCandidate = (c: TripCandidate) => {
    setReview({ cand: c, name: c.name, include: new Set(c.txnIds) })
    setCandidates(null)
  }
  const createReviewed = () => {
    if (!review) return
    const { cand, include } = review
    const name = review.name.trim() || cand.name
    const color = ['var(--cmpa)', 'var(--cmpb)', 'var(--c-rest)', 'var(--c-util)'][trips.length % 4]
    // Windowed trip, but exclude every in-window row the user didn't keep — so only the detected
    // (and any the user added) are members.
    const assignments = vault.transactions
      .filter((t) => t.date >= cand.dateFrom && t.date <= cand.dateTo && !include.has(t.id))
      .map((t) => ({ txnId: t.id, dir: 'exclude' as const }))
    store.commit(
      { kind: 'addTracking', tracking: { name, kind: 'trip', color, dateFrom: cand.dateFrom, dateTo: cand.dateTo }, assignments },
      { msg: `Trip “${name}” created`, undoable: true },
    )
    setReview(null)
  }

  const create = () => {
    const trimmed = name.trim() || `Trip · ${dayMon(from)}`
    const color = ['var(--cmpa)', 'var(--cmpb)', 'var(--c-rest)', 'var(--c-util)'][trips.length % 4]
    const assignments = [...drop].map((txnId) => ({ txnId, dir: 'exclude' as const }))
    store.commit(
      { kind: 'addTracking', tracking: { name: trimmed, kind: 'trip', color, dateFrom: from, dateTo: to }, assignments },
      { msg: `Trip “${trimmed}” created`, undoable: true },
    )
    setStep(0)
  }

  // One trip, full screen. A sibling render rather than an overlay, so the pane's display:none and
  // scroll restoration keep working and the route stays the single source of truth.
  if (openTrip) {
    return (
      <div data-screen="trips">
        <TripDetail tripId={openTrip} onBack={() => go('trips', {})} />
      </div>
    )
  }

  return (
    <div data-screen="trips">
      <div style={narrow ? { marginBottom: 18 } : { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Trips &amp; Trackings</h1>
          <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>A trip is a tag with a date window. Rows inside it join automatically; compare any two.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: narrow ? 12 : 0 }}>
          {currentTripId && (
            <button data-testid="open-current-trip" onClick={() => go('trips', { trip: currentTripId })} style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '8px 13px', background: SURFACE, cursor: 'pointer' }}>Open current trip</button>
          )}
          <button className="hov-invert" data-testid="detect-trips" onClick={runDetect} style={btnOutline} aria-label="Find trips from foreign-currency spend in your history">Detect trips</button>
          <button data-testid="new-trip" onClick={startCreate} style={primary}>+ New trip</button>
        </div>
      </div>
      <ScreenIntro id="trips" />

      {candidates !== null && (
        <section data-testid="detected-trips" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 20px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Detected trips</div>
            <button data-testid="detected-dismiss" onClick={() => setCandidates(null)} style={{ fontSize: 12, color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>Dismiss</button>
          </div>
          {candidates.length === 0 && <div style={{ fontSize: 12.5, color: FAINT }}>No new trips found in your history.</div>}
          {/* Foreign-currency runs are near-certain; density guesses are not. Mixing them in one
              list gave both the same weight, and the guesses are the ones that get things wrong. */}
          {(['foreign', 'density'] as const).map((kind) => {
            const group = candidates.filter((c) => c.kind === kind)
            if (group.length === 0) return null
            return (
              <div key={kind} style={{ marginTop: kind === 'density' ? 14 : 0 }}>
                {kind === 'density' && (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', marginBottom: 6 }}>
                    POSSIBLE TRIPS AT HOME · guessed from spending, not from a foreign currency
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {group.map((c) => (
                    <div key={candidateKey(c)} data-testid="detected-trip" data-kind={c.kind} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${HAIR2}`, borderRadius: 6, padding: '11px 14px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, color: INK }}>✈️ {c.name}</span>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, flex: 1, minWidth: 180 }}>
                        {dayMon(c.dateFrom)} – {dayMon(c.dateTo)} · {c.count} {c.kind === 'foreign' ? `${c.currency} ` : ''}payments · {fmt(c.total)}
                        {/* Never "57 EUR payments": for a density guess the currency IS the base one. */}
                        {c.kind === 'density' && c.rateMultiple != null && (
                          <span style={{ display: 'block', marginTop: 2 }}>why: spending ran {c.rateMultiple}× your usual daily rate</span>
                        )}
                      </span>
                      <button data-testid="detected-review" onClick={() => reviewCandidate(c)} style={{ ...primary, padding: '7px 13px', fontSize: 12.5 }}>Review &amp; create →</button>
                      <button
                        data-testid="detected-dismiss-one"
                        onClick={() => dismissOne(c)}
                        aria-label={`Not a trip: ${c.name}, ${dayMon(c.dateFrom)} to ${dayMon(c.dateTo)}`}
                        style={{ fontSize: 13, lineHeight: 1, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 10px', background: SURFACE, cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {review && (
        <DetectedReview
          cand={review.cand}
          name={review.name}
          include={review.include}
          onName={(name) => setReview((r) => (r ? { ...r, name } : r))}
          onToggle={(id) => setReview((r) => { if (!r) return r; const include = new Set(r.include); include.has(id) ? include.delete(id) : include.add(id); return { ...r, include } })}
          onCancel={() => setReview(null)}
          onCreate={createReviewed}
        />
      )}

      {/* timeline */}
      {/* Extracted to `widgets/` so the dashboard can pin the same timeline. */}
      <TripTimelineWidget />

      {/* trip cards */}
      {/* 360px, not 280: three columns at the content max instead of four, so a card has room for
          a real category list rather than five hairlines. Two at tablet, one on a phone. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(360px,100%),1fr))', gap: 14, marginBottom: 16 }}>
        {summaries.map(({ tr, s }) => (
          <TripCard
            key={tr.id}
            tr={tr}
            s={s}
            onOpen={() => go('trips', { trip: tr.id })}
            onCompare={() => go('compare', { trips: tr.id })}
            onRows={() => goTxns({ tracking: tr.id })}
            onCategory={(categoryId) => goTxns({ tracking: tr.id, cat: categoryId })}
            onDelete={() => store.commit({ kind: 'removeTracking', trackingId: tr.id }, { msg: `“${tr.name}” deleted`, undoable: true })}
          />
        ))}
        {summaries.length === 0 && (
          <div style={{ gridColumn: '1/-1', padding: '28px 0', textAlign: 'center', fontSize: 13, color: FAINT }}>No trips yet — mark one below.</div>
        )}
      </div>

      {archivedTrips.length > 0 && (
        <section data-testid="archived-trips" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '14px 18px', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 2 }}>Archived trips</div>
          <div style={{ fontSize: 12, color: FAINT, marginBottom: 10 }}>Archiving has been removed — these were hidden by the old menu. Bring one back, or delete it.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {archivedTrips.map((tr) => (
              <div key={tr.id} data-testid="archived-trip" style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${HAIR2}`, borderRadius: 6, padding: '9px 12px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: INK, flex: 1, minWidth: 120 }}>{tr.name}</span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{tr.dateFrom && tr.dateTo ? `${dayMon(tr.dateFrom)} – ${dayMon(tr.dateTo)}` : 'no window'}</span>
                <button
                  data-testid="archived-restore"
                  onClick={() => store.commit({ kind: 'setField', collection: 'trackings', id: tr.id, field: 'archived', value: false }, { msg: `“${tr.name}” restored`, undoable: true })}
                  style={{ fontSize: 12, color: ACCENT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '6px 11px', background: SURFACE, cursor: 'pointer' }}
                >
                  Restore
                </button>
                <button
                  onClick={() => store.commit({ kind: 'removeTracking', trackingId: tr.id }, { msg: `“${tr.name}” deleted`, undoable: true })}
                  style={{ fontSize: 12, color: 'var(--neg)', border: `1px solid ${HAIR}`, borderRadius: 6, padding: '6px 11px', background: SURFACE, cursor: 'pointer' }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* forecast */}
      {trips.length > 0 && (
        <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK, display: 'inline-flex', alignItems: 'center' }}>Planned trip · forecast<Explain id="trips.forecast" size="sm" /></div>
            <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '2px 6px' }}>EDITABLE</span>
          </div>
          <div style={{ fontSize: 12, color: FAINT, marginBottom: 13 }}>Projected from the per-day median of past trips — every figure editable, nothing stored.</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 26, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>DAYS PLANNED</div>
              <input data-testid="forecast-days" type="number" min={1} value={fDays} onChange={(e) => setFDays(Math.max(1, Number(e.target.value) || 1))} style={{ ...input, width: 80, marginTop: 5 }} />
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>PROJECTED</div>
              <div data-testid="forecast-projected" style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, marginTop: 3, color: INK }}>≈ {fmt(forecast.projected)}</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>PER-DAY MEDIAN</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 5, color: INK }}>{fmt(forecast.perDayMedian)} / day</div>
            </div>
            <div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>YOUR PLAN</div>
              <input data-testid="forecast-plan" value={fPlan} onChange={(e) => setFPlan(e.target.value)} placeholder="budget" style={{ ...input, width: 100, marginTop: 5 }} />
            </div>
            <div style={{ flex: 1, minWidth: 200, fontSize: 12, color: MUT, lineHeight: 1.5 }}>
              {planTarget > 0 ? (
                <span data-testid="forecast-vs-plan">Projected is <b style={{ color: forecast.projected > planTarget ? 'var(--neg)' : 'var(--pos)' }}>{netLbl(forecast.projected - planTarget)}</b> vs your <span>{fmt(planTarget)}</span> plan.</span>
              ) : (
                <>From {forecast.comparableCount} past trip{forecast.comparableCount === 1 ? '' : 's'}. Set a plan to compare, or adjust days.</>
              )}
            </div>
          </div>
        </section>
      )}

      {/* creation flow */}
      <section ref={createRef} style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 22px', scrollMarginTop: 12 }} data-testid="trip-create">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Mark a trip (retroactively)</div>
          {step === 0 && <button onClick={startCreate} style={{ fontSize: 12.5, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>Start →</button>}
        </div>

        {step > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              {([1, 2, 3] as const).map((s, i) => (
                <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => step >= s && setStep(s)} aria-pressed={step === s} disabled={step < s} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: `1px solid ${step === s ? INK : HAIR}`, borderRadius: 20, padding: '6px 13px', fontSize: 12.5, color: step === s ? INK : MUT, background: 'none', cursor: step >= s ? 'pointer' : 'default', opacity: step < s ? 0.55 : 1 }}>
                    <span style={{ fontFamily: MONO, fontSize: 11 }}>{s}</span>{['Pick range', 'Preview', 'Suggested exclusions'][i]}
                  </button>
                  {i < 2 && <div style={{ width: 24, height: 1, background: HAIR }} />}
                </div>
              ))}
            </div>

            {step === 1 && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>NAME</div>
                  <input data-testid="trip-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Italy" style={{ ...input, marginTop: 5, fontFamily: 'inherit' }} />
                </div>
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>FROM</div>
                  {/* Reset the exclusions with the range: they are txn ids drawn from the OLD
                      window, and keeping them writes excludes for rows the trip never contained. */}
                  <input data-testid="trip-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setDrop(new Set()) }} style={{ ...input, marginTop: 5 }} />
                </div>
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>TO</div>
                  <input data-testid="trip-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setDrop(new Set()) }} style={{ ...input, marginTop: 5 }} />
                </div>
                <div style={{ flex: 1, minWidth: 180, fontSize: 13, color: MUT }}><b>{winTxns.length} transactions</b> fall in this window.</div>
                <button data-testid="trip-to-preview" onClick={() => setStep(2)} style={primary}>Preview →</button>
              </div>
            )}

            {step === 2 && (
              <div>
                <div style={{ fontSize: 13, color: MUT, marginBottom: 10 }}>Every row in the window is a member by construction — <b>{winTxns.length} will be tagged</b>. Nothing is written yet.</div>
                <div style={{ border: `1px solid ${HAIR}`, borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', background: SURFACE2, fontFamily: MONO, fontSize: 10, color: FAINT }}>
                    <span>{winTxns.length} IN WINDOW</span><span>{dayMon(from)} – {dayMon(to)}</span>
                  </div>
                  {winTxns.slice(0, 6).map((tx) => (
                    <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', fontSize: 12.5, borderTop: `1px solid ${HAIR2}`, color: INK }}>
                      <span>{tx.merchant}</span><span style={{ fontFamily: MONO }}>{fmt(tx.amount, true)}</span>
                    </div>
                  ))}
                  {winTxns.length > 6 && <div style={{ padding: '9px 14px', fontSize: 12, color: FAINT, borderTop: `1px solid ${HAIR2}` }}>+ {winTxns.length - 6} more</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}><button data-testid="trip-to-excl" onClick={() => setStep(3)} style={primary}>Review exclusions →</button></div>
              </div>
            )}

            {step === 3 && (
              <div>
                <div style={{ fontSize: 13, color: MUT, marginBottom: 4 }}>Recurring bills don’t pause because you’re away. Ledger suggests excluding these — flip any back with one tap.</div>
                {/* The question this screen never answered: what "excluded" actually removes. */}
                <div style={{ fontSize: 12, color: FAINT, marginBottom: 12 }}>The trip includes every transaction in the window. Excluding drops just that payee’s charges — nothing else by that merchant, and nothing outside the trip.</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {suggestions.length === 0 && <div style={{ fontSize: 12.5, color: FAINT }}>No recurring bills detected in this window.</div>}
                  {suggestions.map((sug) => {
                    const key = sug.txnIds[0]!
                    const isExcluded = sug.txnIds.every((id) => drop.has(id))
                    return (
                      <div key={key} data-testid="excl-suggestion" style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px dashed ${AMBER}`, borderRadius: 6, padding: '11px 14px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 500, color: INK }}>
                            {sug.merchant} <span style={{ fontFamily: MONO, fontWeight: 400, color: MUT }}>{fmt(sug.total, true)}</span>
                            {sug.txnIds.length > 1 && <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}> · {sug.txnIds.length} charges</span>}
                          </div>
                          <div style={{ fontFamily: MONO, fontSize: 10.5, color: AMBER, marginTop: 2 }}>{sug.reason}</div>
                        </div>
                        <button
                          data-testid="excl-toggle"
                          onClick={() => setDrop((d) => {
                            const n = new Set(d)
                            for (const id of sug.txnIds) isExcluded ? n.delete(id) : n.add(id)
                            return n
                          })}
                          style={{ fontSize: 11.5, color: isExcluded ? AMBER : MUT, border: `1px dashed ${isExcluded ? AMBER : HAIR}`, borderRadius: 12, padding: '4px 10px', background: 'none', cursor: 'pointer' }}
                        >
                          {isExcluded ? 'Excluded' : 'Included'}
                        </button>
                      </div>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 13, borderTop: `1px solid ${HAIR2}` }}>
                  <div style={{ fontSize: 12, color: FAINT }}>One batch mutation · normal undo, save, sync.</div>
                  <button data-testid="trip-create-go" onClick={create} style={{ ...primary, fontWeight: 600 }}>Create Trip · {winTxns.length - drop.size} rows{drop.size ? `, ${drop.size} excluded` : ''}</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

/**
 * Curated review of a detected trip: every transaction in the window, with the detected
 * foreign-currency rows pre-ticked and everything else left out. The user adds any that belong,
 * edits the name, and confirms — creating a windowed trip whose members are exactly the ticked rows.
 */
function DetectedReview({ cand, name, include, onName, onToggle, onCancel, onCreate }: {
  cand: TripCandidate
  name: string
  include: Set<string>
  onName: (s: string) => void
  onToggle: (id: string) => void
  onCancel: () => void
  onCreate: () => void
}) {
  const { vault } = useStoreState()
  const detectedIds = useMemo(() => new Set(cand.txnIds), [cand])
  const rows = useMemo(
    () => vault.transactions.filter((t) => t.date >= cand.dateFrom && t.date <= cand.dateTo).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    [vault.transactions, cand],
  )
  const kept = rows.filter((t) => include.has(t.id)).length
  return (
    <section data-testid="detected-review" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15 }}>✈️</span>
        <input data-testid="review-name" value={name} onChange={(e) => onName(e.target.value)} style={{ ...input, fontFamily: 'inherit', fontWeight: 600 }} />
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{dayMon(cand.dateFrom)} – {dayMon(cand.dateTo)}</span>
      </div>
      <div style={{ fontSize: 12.5, color: MUT, marginBottom: 10 }}>
        The <b>{cand.count} {cand.kind === 'foreign' ? `${cand.currency} ` : ''}payments</b> are pre-selected. Other spend in these dates is left out — tick any that were also part of the trip.
      </div>
      <div style={{ border: `1px solid ${HAIR}`, borderRadius: 6, maxHeight: 340, overflowY: 'auto' }}>
        {rows.map((t) => {
          const on = include.has(t.id)
          return (
            <button
              key={t.id}
              data-testid="review-txn"
              data-on={on ? '1' : '0'}
              onClick={() => onToggle(t.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 14px', borderTop: `1px solid ${HAIR2}`, background: on ? SURFACE2 : 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <span style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${on ? ACCENT : HAIR}`, background: on ? ACCENT : 'transparent', color: '#fff', fontSize: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{on ? '✓' : ''}</span>
              <span style={{ flex: 1, fontSize: 12.5, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</span>
              {detectedIds.has(t.id) && cand.kind === 'foreign' && <span style={{ fontFamily: MONO, fontSize: 9, color: ACCENT }}>{cand.currency}</span>}
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, width: 46 }}>{dayMon(t.date).replace(/ \d{4}$/, '')}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: MUT, width: 80, textAlign: 'right' }}>{fmt(t.amount, true)}</span>
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <button data-testid="review-cancel" onClick={onCancel} style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '8px 13px', background: SURFACE, cursor: 'pointer' }}>Cancel</button>
        <button data-testid="review-create" onClick={onCreate} style={{ ...primary, fontWeight: 600 }}>Create Trip · {kept} row{kept === 1 ? '' : 's'}</button>
      </div>
    </section>
  )
}


const CARD_CATS = 5

function TripCard({ tr, s, onOpen, onCompare, onRows, onCategory, onDelete }: {
  tr: Tracking
  s: ReturnType<typeof tripSummary>
  onOpen: () => void
  onCompare: () => void
  onRows: () => void
  onCategory: (categoryId: string) => void
  onDelete: () => void
}) {
  const narrow = useNarrow()
  const { vault } = useStoreState()
  const [menu, setMenu] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const catName = (id: string) => vault.categories.find((c) => c.id === id)?.name ?? '—'
  const catColor = (id: string) => vault.categories.find((c) => c.id === id)?.color ?? 'var(--c-other)'
  const max = Math.max(1, ...s.byCategory.map((c) => c.spend))
  // The *effective* span, not the stored window: a trip built row-by-row from the txn chips has a
  // single-day window and would otherwise read "1 day" with 30 rows in it (see `trackingSpan`).
  const range = s.spanFrom && s.spanTo ? `${dayMon(s.spanFrom)} – ${dayMon(s.spanTo)}` : 'no window'
  return (
    <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 18px', position: 'relative' }} data-testid="trip-card" data-trip={tr.id}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: tr.color ?? 'var(--cmpa)', flex: 'none' }} />
          {/* The title drills to the trip's rows; the body opens the trip. Two different questions
              — "what did I spend this on" and "show me this trip" — so two different targets. */}
          <button
            data-testid="trip-card-rows"
            onClick={onRows}
            aria-label={`All ${s.memberCount} transactions in ${tr.name}`}
            style={{ fontSize: 14, fontWeight: 600, color: INK, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {tr.name}
          </button>
        </div>
        <button onClick={() => { setMenu((m) => !m); setConfirmDel(false) }} title="Trip options" aria-label={`Options for ${tr.name}`} style={{ color: FAINT, fontSize: 16, lineHeight: 0.5, padding: '2px 3px', background: 'none', border: 'none', cursor: 'pointer', flex: 'none' }}>⋯</button>
      </div>
      {menu && (
        <div style={{ position: 'absolute', right: 12, top: 40, zIndex: 30, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, background: SURFACE2, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 170, boxShadow: '0 10px 28px rgba(10,9,7,.16)' , ...phoneMenu(narrow) }}>
          {/* Delete is the only lifecycle action: it tombstones, syncs and undoes. Archive set a
              flag no screen could ever unset. */}
          {confirmDel ? (
            <>
              <div style={{ fontSize: 11.5, color: MUT, padding: '6px 8px' }}>Delete “{tr.name}” and its {s.memberCount} tags?</div>
              <button data-testid="trip-delete-confirm" onClick={() => { setMenu(false); setConfirmDel(false); onDelete() }} style={{ textAlign: 'left', fontSize: 12.5, color: 'var(--neg)', fontWeight: 600, padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Yes, delete</button>
              <button onClick={() => setConfirmDel(false)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Keep it</button>
            </>
          ) : (
            <button data-testid="trip-delete" onClick={() => setConfirmDel(true)} style={{ textAlign: 'left', fontSize: 12.5, color: 'var(--neg)', padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Delete trip</button>
          )}
        </div>
      )}
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 3 }}>{range}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 11 }}>
        <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, color: INK }}>{fmt(s.total)}</div>
        <div style={{ fontSize: 12, color: FAINT, paddingBottom: 2 }}>{s.days} day{s.days === 1 ? '' : 's'} · <span>{fmt(s.perDay)}</span>/day</div>
      </div>
      {/* Every button gets a 44px `::after` hit overlay (index.html). Stacked 6px apart these
          15px rows had overlapping overlays, so the row below swallowed the tap meant for the one
          above — the target has to actually FIT on a phone, not just be claimed. */}
      <div style={{ marginTop: 13, display: 'flex', flexDirection: 'column', gap: narrow ? 0 : 6 }}>
        {s.byCategory.slice(0, CARD_CATS).map((c) => (
          <button
            key={c.categoryId}
            data-testid="trip-card-cat"
            onClick={() => onCategory(c.categoryId)}
            aria-label={`${catName(c.categoryId)} in ${tr.name}`}
            style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 8, alignItems: 'center', fontSize: 11.5, width: '100%', minHeight: narrow ? 44 : undefined, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: INK }}
          >
            <span style={{ color: MUT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{catName(c.categoryId)}</span>
            <span style={{ height: 7, background: catColor(c.categoryId), borderRadius: 2, width: `${(c.spend / max) * 100}%`, minWidth: 3 }} />
            <span style={{ fontFamily: MONO }}>{fmt(c.spend)}</span>
          </button>
        ))}
      </div>
      {/* The rest of the categories live in the trip view; an expander here would jump card
          heights and re-flow the whole grid. The line doubles as the way in. */}
      <button
        data-testid="trip-card-open"
        onClick={onOpen}
        style={{ marginTop: 10, fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        {s.byCategory.length > CARD_CATS ? `+${s.byCategory.length - CARD_CATS} more categories →` : 'Open trip →'}
      </button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 13, paddingTop: 11, borderTop: `1px solid ${HAIR2}` }}>
        <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>
          {s.currencies.length > 0 ? <><span style={{ fontSize: 11 }}>≈</span> {s.currencies.join(', ')} {s.foreignCount > 0 ? `· ${s.foreignCount} unconverted` : 'converted'}{s.approxCount > 0 ? ` · ${s.approxCount} at a nearest-earlier rate` : ''}</> : `${s.memberCount} rows`}
        </span>
        <button onClick={onCompare} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>Compare →</button>
      </div>
    </section>
  )
}
