// One trip, in full — the surface the Trips page never had.
//
// This replaces `TripMode`, which was a fixed-inset overlay held in a `useState` in App: not in
// the route, so it could not be linked to, did not survive a reload and did not answer to Back,
// and it always opened whichever trip happened to be last in vault order. Everything it showed
// (day N, spent vs projected, the category mix, recent rows) is here, plus the things it could
// not do: real charts, every category, drill-downs, and editing which rows belong.
//
// Rendered as a sibling of the trips list inside the same pane, so pane-level display:none and
// scroll restoration keep working.
import { useMemo, useState } from 'react'
import { useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { useNarrow } from './responsive'
import { todayStr } from '../model/selectors'
import { CAT_TRANSFERS, type Category, type Transaction } from '../model/types'
import { members, inWindow } from '../model/trackings'
import { tripSummary, tripForecast } from '../analytics/trips'
import { addDays, daysBetween } from '../analytics/selections'
import { TripCategoriesWidget, TripDailyWidget } from './widgets/TripsWidgets'
import { EmptyState } from './kit/EmptyState'
import { CatMenu, popoverMenu } from './TransactionsScreen'
import { ACCENT, CHIP, FAINT, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2, fmt } from './theme'
import { noRoomBelow, phoneMenu } from './styles'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayMon = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`

/** How many days either side of the trip count as "might belong to it" — the flight out, the taxi home. */
const NEAR_DAYS = 3
const PAGE = 20

export function TripDetail({ tripId, onBack }: { tripId: string; onBack: () => void }) {
  const narrow = useNarrow()
  const { vault } = useStoreState()
  const store = useStore()
  const { go, goTxns } = useView()
  const rates = useRateBook()
  const today = todayStr()
  const base = vault.params.baseCurrency ?? 'EUR'

  const trip = vault.trackings.find((t) => t.id === tripId) ?? null
  const s = useMemo(() => (trip ? tripSummary(vault, trip.id, base, rates) : null), [trip, vault, base, rates])
  const mem = useMemo(() => (trip ? members(trip.id, vault) : new Set<string>()), [trip, vault])
  // Same category list and same menu the Transactions rows use — recategorizing from here has to
  // mean exactly what it means there.
  const cats = useMemo(() => vault.categories.filter((c) => c.id !== CAT_TRANSFERS), [vault.categories])
  const transfersCat = vault.categories.find((c) => c.id === CAT_TRANSFERS)

  const [menu, setMenu] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const memberRows = useMemo(
    () => vault.transactions.filter((t) => mem.has(t.id)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [vault.transactions, mem],
  )
  // Candidates to add: everything not already a member, inside the trip's span ± a few days.
  const nearRows = useMemo(() => {
    if (!s?.spanFrom || !s.spanTo) return []
    const lo = addDays(s.spanFrom, -NEAR_DAYS)
    const hi = addDays(s.spanTo, NEAR_DAYS)
    return vault.transactions
      .filter((t) => !mem.has(t.id) && t.date >= lo && t.date <= hi)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
  }, [vault.transactions, mem, s?.spanFrom, s?.spanTo])

  if (!trip || !s) {
    return (
      <EmptyState
        basis="filtered"
        title="That trip no longer exists."
        body="It may have been deleted on another device."
        action={{ label: 'All trips', onClick: onBack }}
        testid="trip-detail-gone"
      />
    )
  }

  const forecast = tripForecast(
    vault,
    vault.trackings.filter((t) => t.kind === 'trip' && !t.archived && t.id !== trip.id).map((t) => t.id),
    s.days,
    base,
    rates,
  )
  const inTrip = s.spanFrom != null && s.spanTo != null && today >= s.spanFrom && today <= s.spanTo
  const dayN = s.spanFrom ? Math.max(1, Math.min(s.days, daysBetween(s.spanFrom, today) + 1)) : 0
  const daysLeft = s.spanTo ? Math.max(0, daysBetween(today, s.spanTo)) : 0

  // The same window-aware branch the transaction chips use: an in-window row is removed by an
  // `exclude`, one that is only here via an `include` by clearing that assignment. Getting this
  // backwards writes an assignment that does nothing.
  const remove = (txnId: string, date: string) =>
    store.commit(
      { kind: 'setAssignment', trackingId: trip.id, txnId, dir: inWindow(date, trip) ? 'exclude' : 'clear' },
      { msg: `Removed from ${trip.name}`, undoable: true },
    )
  const add = (txnId: string, date: string) =>
    store.commit(
      { kind: 'setAssignment', trackingId: trip.id, txnId, dir: inWindow(date, trip) ? 'clear' : 'include' },
      { msg: `Added to ${trip.name}`, undoable: true },
    )

  const rowBtn = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left' as const,
    padding: '11px 0', minHeight: 44, borderTop: `1px solid ${HAIR2}`, background: 'none',
    border: 'none', cursor: 'pointer', color: INK,
  }

  return (
    <div data-testid="trip-detail" style={{ maxWidth: narrow ? undefined : 900, margin: '0 auto' }}>
      <button
        data-testid="trip-detail-back"
        onClick={onBack}
        style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 12px', background: SURFACE, cursor: 'pointer', marginBottom: 14 }}
      >
        ← All trips
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, position: 'relative' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: trip.color ?? 'var(--cmpa)', flex: 'none' }} />
            <button
              data-testid="trip-detail-rows"
              onClick={() => goTxns({ tracking: trip.id })}
              aria-label={`All ${s.memberCount} transactions in ${trip.name}`}
              style={{ margin: 0, fontSize: 22, fontWeight: 600, color: INK, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            >
              {trip.name}
            </button>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 4 }}>
            {s.spanFrom && s.spanTo ? `${dayMon(s.spanFrom)} – ${dayMon(s.spanTo)} · ` : ''}
            {inTrip ? `Day ${dayN} of ${s.days}` : `${s.days} day${s.days === 1 ? '' : 's'}`} · {fmt(s.perDay)}/day
            {inTrip && daysLeft > 0 ? ` · ${daysLeft} days left` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <button onClick={() => go('compare', { trips: trip.id })} style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 12px', background: SURFACE, cursor: 'pointer' }}>Compare →</button>
          <button onClick={() => { setMenu((m) => !m); setConfirmDel(false) }} aria-label={`Options for ${trip.name}`} style={{ color: FAINT, fontSize: 16, lineHeight: 0.5, padding: '6px 5px', background: 'none', border: 'none', cursor: 'pointer' }}>⋯</button>
        </div>
        {menu && (
          <div style={{ position: 'absolute', right: 0, top: 38, zIndex: 30, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, background: SURFACE2, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 180, boxShadow: '0 10px 28px rgba(10,9,7,.16)', ...phoneMenu(narrow) }}>
            {confirmDel ? (
              <>
                <div style={{ fontSize: 11.5, color: MUT, padding: '6px 8px' }}>Delete “{trip.name}” and its {s.memberCount} tags?</div>
                <button data-testid="trip-detail-delete-confirm" onClick={() => { store.commit({ kind: 'removeTracking', trackingId: trip.id }, { msg: `“${trip.name}” deleted`, undoable: true }); onBack() }} style={{ textAlign: 'left', fontSize: 12.5, color: 'var(--neg)', fontWeight: 600, padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Yes, delete</button>
                <button onClick={() => setConfirmDel(false)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Keep it</button>
              </>
            ) : (
              <button data-testid="trip-detail-delete" onClick={() => setConfirmDel(true)} style={{ textAlign: 'left', fontSize: 12.5, color: 'var(--neg)', padding: '6px 8px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>Delete trip</button>
            )}
          </div>
        )}
      </div>

      <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 18px', marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>SPENT</div>
            <div data-testid="trip-detail-total" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1, marginTop: 3, color: INK }}>{fmt(s.total)}</div>
          </div>
          {forecast.projected > 0 && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>TYPICAL FOR {s.days} DAYS</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4, color: s.total > forecast.projected ? 'var(--neg)' : INK }}>≈ {fmt(forecast.projected)}</div>
            </div>
          )}
          <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, flex: 1, minWidth: 160, textAlign: narrow ? 'left' : 'right' }}>
            {s.currencies.length > 0
              ? <><span style={{ fontSize: 11 }}>≈</span> {s.currencies.join(', ')} {s.foreignCount > 0 ? `· ${s.foreignCount} unconverted` : 'converted'}{s.approxCount > 0 ? ` · ${s.approxCount} at a nearest-earlier rate` : ''}</>
              : `${s.memberCount} rows`}
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(0,3fr) minmax(0,2fr)', gap: 14, marginTop: 14, alignItems: 'start' }}>
        <TripDailyWidget params={{ tripId: trip.id }} />
        <TripCategoriesWidget params={{ tripId: trip.id }} />
      </div>

      <section data-testid="trip-members" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 18px', marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Rows in this trip · {s.memberCount}</div>
          <button onClick={() => goTxns({ tracking: trip.id })} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>Edit in Transactions →</button>
        </div>
        <div style={{ fontSize: 12, color: FAINT, marginTop: 2, marginBottom: 4 }}>Change a category with its chip, or ✕ to take the row out of the trip. Undo restores it.</div>
        {memberRows.length === 0 && <div style={{ fontSize: 12.5, color: FAINT, padding: '10px 0' }}>No rows tagged yet.</div>}
        {(showAll ? memberRows : memberRows.slice(0, PAGE)).map((t) => (
          <TripRow
            key={t.id}
            t={t}
            tripName={trip.name}
            cats={cats}
            transfersCat={transfersCat}
            onRecat={(c) => store.commit({ kind: 'recategorizeBatch', txnIds: [t.id], categoryId: c.id }, { msg: `${t.merchant} → ${c.name}`, undoable: true })}
            onRemove={() => remove(t.id, t.date)}
          />
        ))}
        {memberRows.length > PAGE && (
          <button onClick={() => setShowAll((v) => !v)} style={{ marginTop: 10, fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            {showAll ? 'Show fewer' : `Show all ${memberRows.length}`}
          </button>
        )}
      </section>

      <section data-testid="trip-add-rows" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 18px', marginTop: 14, marginBottom: 16 }}>
        <button
          data-testid="trip-add-toggle"
          onClick={() => setAddOpen((v) => !v)}
          aria-expanded={addOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: INK }}>Add rows</span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, flex: 1 }}>
            {nearRows.length} not in the trip, within {NEAR_DAYS} days of it
          </span>
          <span style={{ color: FAINT, fontSize: 12 }}>{addOpen ? '▾' : '▸'}</span>
        </button>
        {addOpen && (
          <div style={{ marginTop: 8 }}>
            {nearRows.length === 0 && <div style={{ fontSize: 12.5, color: FAINT, padding: '10px 0' }}>Nothing nearby that is not already in.</div>}
            {nearRows.map((t) => {
              // An in-window row that is not a member can only be there because of an `exclude` —
              // worth saying, since re-adding it is undoing an earlier decision.
              const excluded = inWindow(t.date, trip)
              const cat = vault.categories.find((c) => c.id === t.categoryId)
              return (
                <button key={t.id} data-testid="trip-add-row" onClick={() => add(t.id, t.date)} style={rowBtn} aria-label={`Add ${t.merchant} to ${trip.name}`}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, width: 52, flex: 'none' }}>{dayMon(t.date).replace(/ \d{4}$/, '')}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</span>
                  {excluded && <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, flex: 'none' }}>excluded</span>}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: MUT, flex: 'none' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: cat?.color ?? 'var(--c-other)' }} />{cat?.name ?? '—'}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12.5, width: 84, textAlign: 'right', flex: 'none' }}>{fmt(t.amount, true)}</span>
                  <span style={{ color: ACCENT, fontSize: 13, width: 14, textAlign: 'right', flex: 'none' }}>+</span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * A member row, shaped like a Transactions row: merchant, date, amount, and the same
 * recategorize chip — so "what is this and what is it filed under" is answered in the same place
 * and the same way on both screens. The extra affordance here is ✕, which takes it out of the trip.
 *
 * The row is not itself clickable. Making the whole row "remove" put a destructive action under
 * every stray tap, next to a chip that has to be tapped deliberately.
 */
function TripRow({ t, tripName, cats, transfersCat, onRecat, onRemove }: {
  t: Transaction
  tripName: string
  cats: Category[]
  transfersCat?: Category
  onRecat: (c: Category) => void
  onRemove: () => void
}) {
  const narrow = useNarrow()
  const { vault } = useStoreState()
  const [menu, setMenu] = useState<{ dropUp: boolean } | null>(null)
  const cat = vault.categories.find((c) => c.id === t.categoryId)
  const transfer = t.categoryId === CAT_TRANSFERS

  return (
    <div
      data-testid="trip-member-row"
      data-txn-id={t.id}
      data-merchant={t.merchant}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', minHeight: 44, borderTop: `1px solid ${HAIR2}`, flexWrap: narrow ? 'wrap' : 'nowrap' }}
    >
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, width: 52, flex: 'none' }}>{dayMon(t.date).replace(/ \d{4}$/, '')}</span>
      <span style={{ flex: 1, minWidth: narrow ? 120 : 0, fontSize: 13, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.merchant}</span>
      <div style={{ position: 'relative', flex: 'none' }}>
        <button
          data-testid="recat-chip"
          aria-label={`Recategorize ${t.merchant} — currently ${transfer ? 'Transfer' : (cat?.name ?? '—')}`}
          onClick={(e) => setMenu({ dropUp: noRoomBelow(e.currentTarget) })}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, background: CHIP, border: 'none', color: transfer ? MUT : INK, borderRadius: 12, padding: '4px 10px', cursor: 'pointer' }}
        >
          {transfer ? '⇄ Transfer' : <><span style={{ width: 7, height: 7, borderRadius: 2, background: cat?.color ?? 'var(--c-other)' }} />{cat?.name ?? '—'}</>}
        </button>
        {menu && (
          <>
            <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
            <div onClick={() => setMenu(null)}>
              <CatMenu cats={cats} transfersCat={transfersCat} onPick={(c) => { setMenu(null); onRecat(c) }} style={popoverMenu(menu.dropUp, narrow)} />
            </div>
          </>
        )}
      </div>
      <span style={{ fontFamily: MONO, fontSize: 12.5, color: t.amount >= 0 ? 'var(--pos)' : INK, width: 84, textAlign: 'right', flex: 'none' }}>{fmt(t.amount, true)}</span>
      <button
        data-testid="trip-member-remove"
        onClick={onRemove}
        aria-label={`Remove ${t.merchant} from ${tripName}`}
        style={{ flex: 'none', width: 32, height: 32, borderRadius: 6, border: `1px solid ${HAIR}`, background: SURFACE, color: FAINT, fontSize: 12, cursor: 'pointer' }}
      >
        ✕
      </button>
    </div>
  )
}
