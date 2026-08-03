// Trip/tracking chips (ANALYTICS §8.2/§1.4). Three states per candidate tracking:
//   • member (filled)      — in the window (or explicitly included)
//   • excluded (hollow)    — in the window but a live exclude assignment removes it
//   • out (dashed)         — outside the window, taggable
// One tap flips membership through `setAssignment`, always keeping the single
// live-assignment-per-(tracking,txn) invariant. Existing assignments are never
// re-flagged as suggestions here — only the raw current state is shown.
import { useMemo } from 'react'
import type { Transaction, Vault } from '../model/types'
import { members, inWindow } from '../model/trackings'
import { useStore, useStoreState } from './store'
import { TripPicker } from './TripPicker'
import { MONO, MUT, FAINT, INK, HAIR } from './theme'

const TRIP_PALETTE = ['var(--cmpa)', 'var(--cmpb)', 'var(--c-rest)', 'var(--c-util)']

type ChipState = 'member' | 'excluded' | 'out'

interface Candidate {
  trackingId: string
  name: string
  color: string
  state: ChipState
}

function candidatesFor(vault: Vault, txn: Transaction): Candidate[] {
  const out: Candidate[] = []
  for (const tr of vault.trackings) {
    if (tr.archived) continue
    const windowContains = inWindow(txn.date, tr)
    const hasAssignment = vault.trackingAssignments.some((a) => a.trackingId === tr.id && a.txnId === txn.id)
    if (!windowContains && !hasAssignment) continue
    const isMember = members(tr.id, vault).has(txn.id)
    const state: ChipState = isMember ? 'member' : windowContains ? 'excluded' : 'out'
    out.push({ trackingId: tr.id, name: tr.name, color: tr.color ?? 'var(--cmpa)', state })
  }
  return out
}

export function TrackingChips({ txn, showAll = false }: { txn: Transaction; showAll?: boolean }) {
  const { vault } = useStoreState()
  const store = useStore()
  // `showAll` also offers every non-window trip as a taggable candidate.
  const candidates = useMemo(() => {
    const base = candidatesFor(vault, txn)
    if (!showAll) return base
    const have = new Set(base.map((c) => c.trackingId))
    const extra: Candidate[] = vault.trackings
      .filter((tr) => !tr.archived && !have.has(tr.id))
      .map((tr) => ({ trackingId: tr.id, name: tr.name, color: tr.color ?? 'var(--cmpa)', state: 'out' as ChipState }))
    return [...base, ...extra]
  }, [vault, txn, showAll])

  const flip = (c: Candidate) => {
    const windowContains = inWindow(txn.date, vault.trackings.find((t) => t.id === c.trackingId)!)
    if (c.state === 'member') {
      store.commit({ kind: 'setAssignment', trackingId: c.trackingId, txnId: txn.id, dir: windowContains ? 'exclude' : 'clear' }, { msg: `Removed from ${c.name}`, undoable: true })
    } else {
      store.commit({ kind: 'setAssignment', trackingId: c.trackingId, txnId: txn.id, dir: windowContains ? 'clear' : 'include' }, { msg: `Added to ${c.name}`, undoable: true })
    }
  }

  // Toggle any existing trip by id (used by the picker), and create-and-add a new one — a
  // single-day window at the txn's date, so the row joins by construction.
  const toggleById = (trackingId: string) => {
    const tr = vault.trackings.find((t) => t.id === trackingId)
    if (!tr) return
    flip({ trackingId, name: tr.name, color: tr.color ?? 'var(--cmpa)', state: members(tr.id, vault).has(txn.id) ? 'member' : inWindow(txn.date, tr) ? 'excluded' : 'out' })
  }
  const createTrip = (name: string) => {
    const color = TRIP_PALETTE[vault.trackings.filter((t) => t.kind === 'trip').length % TRIP_PALETTE.length]
    store.commit({ kind: 'addTracking', tracking: { name, kind: 'trip', color, dateFrom: txn.date, dateTo: txn.date } }, { msg: `Trip “${name}” created`, undoable: true })
  }
  const pickerTrips = vault.trackings.filter((t) => t.kind === 'trip' && !t.archived).map((t) => ({ id: t.id, name: t.name, color: t.color }))
  const isMember = (trackingId: string) => members(trackingId, vault).has(txn.id)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }} data-testid="trip-chips">
      {candidates.map((c) => {
        const on = c.state === 'member'
        return (
          <button
            key={c.trackingId}
            data-testid={`trip-chip-${c.trackingId}`}
            data-state={c.state}
            onClick={() => flip(c)}
            aria-label={c.state === 'excluded' ? 'Excluded — tap to re-include' : c.state === 'out' ? 'Tap to tag' : 'Tap to remove'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: MONO,
              fontSize: 10.5,
              padding: '3px 9px',
              borderRadius: 12,
              cursor: 'pointer',
              color: on ? INK : c.state === 'excluded' ? MUT : FAINT,
              background: on ? 'var(--chip)' : 'transparent',
              border: on ? `1px solid ${HAIR}` : `1px dashed ${HAIR}`,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, opacity: on ? 1 : 0.4 }} />
            {c.name}
          </button>
        )
      })}
      <TripPicker trips={pickerTrips} isOn={isMember} onToggle={toggleById} onCreate={createTrip} />
    </div>
  )
}
