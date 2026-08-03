// Recurring & subscriptions — the highest-leverage unbuilt surface in the questionary
// (§9: thirteen questions, a detector that already existed).
//
// It lives on Plan, not a ninth tab: Plan is the committed-money screen, and budgets already
// carry a `recurring` scope reading the same `t.recurring` field, so the budget row and this
// list are the same subject. Reachable directly via `#/plan` + the `recurring` section anchor.
import { useNarrow } from './responsive'
import { useMemo, useState } from 'react'
import { ACCENT, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE, fmt } from './theme'
import { useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { daysBetween } from '../analytics/selections'
import { todayStr } from '../model/selectors'
import { subscriptions, type SubRow, type SubState } from '../analytics/subscriptions'
import { fmtDaySmart, fmtDayYear } from './format'
import { Explain } from './explain'
import { EmptyState } from './kit/EmptyState'
import { MergeMerchantDialog } from './MergeMerchantDialog'

const STATE_COPY: Record<SubState, { label: string; color: string } | null> = {
  steady: null,
  new: { label: 'NEW', color: 'var(--accent)' },
  increased: { label: 'WENT UP', color: 'var(--neg)' },
  decreased: { label: 'WENT DOWN', color: GREEN },
  lapsed: { label: 'STOPPED', color: 'var(--warn)' },
}

export function SubscriptionsSection() {
  const narrow = useNarrow()
  const { vault } = useStoreState()
  const rb = useRateBook()
  const { goTxns } = useView()
  const today = todayStr()
  const subs = useMemo(() => subscriptions(vault, today, rb), [vault, today, rb])
  const [open, setOpen] = useState<string | null>(null)
  /** The merchant being merged into another spelling (#merchant-split), or null. */
  const [merge, setMerge] = useState<string | null>(null)

  // A stopped charge is not a change, so it gets its own group. Eleven dead subscriptions used
  // to head the "changed" list and bury the six live ones underneath.
  const changed = subs.rows.filter((r) => r.state !== 'steady' && r.state !== 'lapsed')
  const steady = subs.rows.filter((r) => r.state === 'steady')
  const stopped = subs.rows.filter((r) => r.state === 'lapsed')
  const active = subs.rows.length - stopped.length
  const max = Math.max(1, ...subs.rows.map((r) => (r.cadence === 'monthly' ? r.typical : r.typical / 12)))

  const openRow = (r: SubRow) => goTxns({ merchant: r.merchant, status: 'recurring' })

  const row = (r: SubRow, showBar: boolean) => {
    const tag = STATE_COPY[r.state]
    const expanded = open === r.key
    const months = Math.max(1, Math.round(daysBetween(r.lastDate, today) / 30))
    return (
      <div key={r.key} style={{ borderTop: `1px solid var(--hair2)` }}>
        <div
          data-testid="sub-row"
          data-sub-state={r.state}
          data-confirmed={r.confirmed ? '1' : '0'}
          style={
            narrow
              ? // Flex, not grid: the six children include two that are display:none on a phone,
                // and sizing three tracks around that kept squeezing the amount to 21px while the
                // row still overflowed. Wrapping puts the meta line underneath with no tracks to fight.
                { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 0' }
              : { display: 'grid', gridTemplateColumns: '1.4fr 90px 1fr 92px 132px 18px', gap: 10, alignItems: 'center', padding: '9px 0' }
          }
        >
          <button
            onClick={() => openRow(r)}
            aria-label={`Open ${r.merchant}`}
            style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', ...(narrow ? { flex: '1 1 auto', minWidth: 0 } : {}) }}
          >
            <span style={{ fontSize: 13, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.merchant}</span>
            {tag && (
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.06em', color: tag.color, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '1px 4px', flex: 'none' }}>
                {tag.label}
              </span>
            )}
          </button>
          <span style={{ fontFamily: MONO, fontSize: 12, color: INK, ...(narrow ? { flex: 'none' } : {}) }}>{fmt(r.typical)}</span>
          <span style={{ display: narrow ? 'none' : undefined }}>
            {showBar && (
              <span style={{ display: 'block', height: 8, borderRadius: 2, background: r.state === 'lapsed' ? HAIR : 'var(--c-ent)', width: `${Math.max(3, ((r.cadence === 'monthly' ? r.typical : r.typical / 12) / max) * 100)}%` }} />
            )}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, ...(narrow ? { flex: '1 1 100%' } : {}) }}>
            {r.cadence === 'monthly' ? 'monthly' : 'yearly'}
            {r.deltaPct !== null && <span style={{ color: r.deltaPct > 0 ? 'var(--neg)' : GREEN }}> {r.deltaPct > 0 ? '+' : '−'}{Math.abs(r.deltaPct)}%</span>}
          </span>
          {/* With the year: "last 19 Aug" on a July screen was a charge from eleven months
              earlier, rendered exactly like one from this month. */}
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, textAlign: narrow ? 'left' : 'right', whiteSpace: 'nowrap', display: narrow ? 'none' : undefined }}>
            {r.state === 'lapsed' ? `none since ${fmtDayYear(r.lastDate)}` : `expected ≈ ${fmtDaySmart(r.expectedNext, today)}`}
          </span>
          <button
            data-testid="sub-expand"
            aria-expanded={expanded}
            onClick={() => setOpen((cur) => (cur === r.key ? null : r.key))}
            aria-label={expanded ? 'Hide details' : 'How long, how many, how much'}
            style={{ color: FAINT, fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0, ...(narrow ? { flex: 'none' } : {}) }}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </div>
        {expanded && (
          <div data-testid="sub-detail" style={{ padding: '2px 0 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: MUT, lineHeight: 1.6 }}>
              <B>{r.count}</B> charges counted, from <B>{fmtDayYear(r.firstDate)}</B> to <B>{fmtDayYear(r.lastDate)}</B> —{' '}
              <B>{fmt(r.totalCounted)}</B> in total.
              {r.state === 'lapsed' && (
                <>
                  {' '}Nothing has arrived for about {months} month{months === 1 ? '' : 's'}, so it is no longer counted
                  in the total above. Ledger cannot tell whether you cancelled it — only that no charge came.
                </>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em' }}>BY YEAR</div>
              {r.byYear.map((y) => (
                <button
                  key={y.year}
                  data-testid="sub-year"
                  onClick={() => goTxns({ merchant: r.merchant, status: 'recurring', from: `${y.year}-01-01`, to: `${y.year}-12-31` })}
                  title={`Open ${r.merchant} in ${y.year} →`}
                  style={{ display: 'grid', gridTemplateColumns: '60px 1fr 90px', gap: 10, alignItems: 'center', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', textAlign: 'left', fontFamily: MONO, fontSize: 11.5, color: MUT }}
                >
                  <span>{y.year}</span>
                  <span>{y.count} charge{y.count === 1 ? '' : 's'}</span>
                  <span style={{ textAlign: 'right', color: INK }}>{fmt(y.total)}</span>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: FAINT, lineHeight: 1.5 }}>
              Counted, not billed: these cover the charges you have imported and marked recurring, so they begin where
              your statements begin — not necessarily when you first subscribed.
            </div>
            {/* One subscription whose merchant string changed reads as two rows here — a STOPPED run
                at the old spelling and a STEADY one at the new. Merging is offered, never applied on
                its own: a prefix rule that caught `Deezerfr Y6bsn5` → `DEEZER` would also merge
                merchants that only look alike. */}
            <button
              data-testid="sub-merge"
              onClick={() => setMerge(r.merchant)}
              title="Same subscription under another spelling?"
              style={{ alignSelf: 'flex-start', fontSize: 11.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              Merge with another merchant…
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <section
      data-cf-section="recurring"
      data-testid="subscriptions"
      style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 22px', marginBottom: 16 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: INK, display: 'flex', alignItems: 'center' }}>
          Recurring &amp; subscriptions
          <Explain id="plan.subscriptions" size="sm" />
        </div>
        {/* This said "N confirmed" while counting only the LIVE rows — with eleven stopped ones
            listed right beneath it. It now names which set the number describes. */}
        <div data-testid="sub-total" style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>
          <span style={{ color: INK, fontWeight: 600 }}>{fmt(subs.monthlyTotal)}</span> / month ·{' '}
          <span>{fmt(subs.annualisedTotal)}</span> / year · {active} active
          {stopped.length > 0 && ` · ${stopped.length} stopped, not counted`}
        </div>
      </div>

      {subs.rows.length === 0 && subs.unconfirmed.length === 0 ? (
        <EmptyState
          testid="subs-empty"
          dense
          basis={vault.transactions.length === 0 ? 'no-data' : 'thin-history'}
          title={vault.transactions.length === 0 ? 'Nothing imported yet.' : 'No repeating charges spotted yet.'}
          body="Ledger looks for a merchant charging you at least three times, roughly monthly or yearly, at a steady amount."
        />
      ) : (
        <>
          {changed.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>CHANGED</div>
              {changed.map((r) => row(r, false))}
            </div>
          )}
          {steady.length > 0 && (
            <div style={{ marginTop: changed.length > 0 ? 14 : 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>STEADY</div>
                {/* A yearly row is drawn at a twelfth of the amount printed beside it, so a €108
                    yearly charge drew a shorter bar than a €23 monthly one with nothing saying why. */}
                <div style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>bar = € per month</div>
              </div>
              {steady.map((r) => row(r, true))}
            </div>
          )}
          {stopped.length > 0 && (
            <div style={{ marginTop: 14 }} data-testid="subs-stopped">
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>
                STOPPED — NOT IN THE TOTAL
              </div>
              {stopped.map((r) => row(r, false))}
            </div>
          )}
          {subs.unconfirmed.length > 0 && (
            <div style={{ marginTop: 16 }} data-testid="subs-unconfirmed">
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>
                NOT COUNTED YET — {subs.unconfirmed.length} SUGGESTION{subs.unconfirmed.length === 1 ? '' : 'S'}
              </div>
              <div style={{ fontSize: 11.5, color: MUT, margin: '4px 0 2px', lineHeight: 1.5 }}>
                Ledger spotted these but you have not confirmed them, so they are not in the total above.
                Mark one from its transaction row to include it.
              </div>
              {subs.unconfirmed.map((r) => row(r, false))}
            </div>
          )}
        </>
      )}

      <div style={{ fontSize: 11, color: FAINT, marginTop: 12, lineHeight: 1.5 }}>
        “Expected ≈” is a pattern in your own history, not a due date — Ledger has no billing calendar.
      </div>

      {merge && <MergeMerchantDialog merchant={merge} onClose={() => setMerge(null)} />}
    </section>
  )
}

function B({ children }: { children: React.ReactNode }) {
  return <strong style={{ color: INK, fontWeight: 600 }}>{children}</strong>
}
