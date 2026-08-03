// Select-or-create trip picker. Presentational: it owns only its open/creating
// state and calls back for every mutation, so the import review (pending tags)
// and the transaction detail (immediate commit) can each supply their own
// semantics. Modeled on the in-import category menu (select existing + inline
// "+ New …"), so a trip named once is pickable on every following row.
import { useRef, useState } from 'react'
import { ACCENT, CHIP, FAINT, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2 } from './theme'
import { MENU_MAX, noRoomBelow } from './styles'

export interface PickerTrip {
  id: string
  name: string
  color?: string
}

export function TripPicker({
  trips,
  isOn,
  onToggle,
  onCreate,
  compact = false,
  testid = 'trip-picker',
}: {
  trips: PickerTrip[]
  isOn: (trackingId: string) => boolean
  onToggle: (trackingId: string) => void
  onCreate: (name: string) => void
  compact?: boolean
  testid?: string
}) {
  const [open, setOpen] = useState(false)
  const [newTrip, setNewTrip] = useState<string | null>(null)
  const [dropUp, setDropUp] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const fs = compact ? 9.5 : 12
  const close = () => {
    setOpen(false)
    setNewTrip(null)
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btnRef}
        data-testid={`${testid}-open`}
        onClick={() => {
          if (btnRef.current) setDropUp(noRoomBelow(btnRef.current))
          setOpen((o) => !o)
        }}
        aria-label="Add to a trip, or create one"
        style={{
          fontFamily: MONO,
          fontSize: fs,
          padding: compact ? '2px 7px' : '4px 10px',
          borderRadius: 12,
          cursor: 'pointer',
          color: FAINT,
          background: 'transparent',
          border: `1px dashed ${HAIR}`,
        }}
      >
        trip ▾
      </button>
      {open && (
        <>
          {/* click-away catcher */}
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 29 }} />
          <div
            data-testid={`${testid}-menu`}
            style={{
              position: 'absolute',
              right: 0,
              ...(dropUp ? { bottom: 26 } : { top: 26 }),
              zIndex: 30,
              background: SURFACE2,
              border: `1px solid ${HAIR}`,
              borderRadius: 6,
              padding: 5,
              minWidth: 180,
              maxHeight: MENU_MAX,
              overflowY: 'auto',
              boxShadow: '0 10px 28px rgba(10,9,7,.16)',
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            {trips.length === 0 && (
              <div style={{ fontSize: 12, color: FAINT, padding: '7px 9px' }}>No trips yet.</div>
            )}
            {trips.map((tr) => {
              const on = isOn(tr.id)
              return (
                <button
                  key={tr.id}
                  data-testid="trip-picker-item"
                  data-on={on ? '1' : '0'}
                  onClick={() => onToggle(tr.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textAlign: 'left',
                    fontSize: 12.5,
                    color: on ? INK : MUT,
                    padding: '7px 9px',
                    borderRadius: 4,
                    background: on ? CHIP : 'none',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: tr.color ?? 'var(--cmpa)', opacity: on ? 1 : 0.4, flex: 'none' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tr.name.split(/[·|]/)[0]!.trim()}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: on ? ACCENT : 'transparent' }}>✓</span>
                </button>
              )
            })}
            <div style={{ borderTop: `1px solid ${HAIR2}`, marginTop: 3, paddingTop: 3 }}>
              {newTrip === null ? (
                <button
                  data-testid="trip-picker-new"
                  onClick={() => setNewTrip('')}
                  style={{ textAlign: 'left', width: '100%', fontSize: 12.5, color: ACCENT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  + New trip…
                </button>
              ) : (
                <input
                  data-testid="trip-picker-new-name"
                  autoFocus
                  value={newTrip}
                  placeholder="Trip name, then Enter"
                  onChange={(e) => setNewTrip(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNewTrip(null)
                    if (e.key !== 'Enter') return
                    const name = newTrip.trim()
                    if (name) onCreate(name)
                    close()
                  }}
                  style={{ width: '100%', boxSizing: 'border-box', height: 28, border: `1px solid ${HAIR}`, borderRadius: 4, background: SURFACE, color: INK, fontSize: 12.5, padding: '0 7px' }}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
