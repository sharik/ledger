// "Add a chart" — the second way onto the dashboard.
//
// The pin button on each chart covers "I am looking at this and want to keep it". This covers the
// other direction: standing on the dashboard, wanting something, and not remembering which screen
// it lives on. Grouped by screen for exactly that reason — the same grouping the assistant skill
// applies to `EXPLAIN_IDS`.
import { useState } from 'react'
import type { PinnedWidget } from '../../model/types'
import { now, uuidv7 } from '../../model/clock'
import { useStore, useStoreState } from '../store'
import { ACCENT, FAINT, HAIR, INK, MONO, MUT, SURFACE } from '../theme'
import { WIDGETS, widgetsByScreen, type WidgetId } from './catalog'
import { findPin } from './PinButton'

export function WidgetPicker() {
  const { vault } = useStoreState()
  const store = useStore()
  const [open, setOpen] = useState(false)

  const add = (id: WidgetId) => {
    const params = { ...WIDGETS[id].defaults }
    const already = findPin(vault.pinnedWidgets, id, params)
    if (already) return
    const rec: PinnedWidget = { id: uuidv7(), updatedAt: now(), widget: id, params, name: WIDGETS[id].title, order: vault.pinnedWidgets.length }
    store.commit({ kind: 'restore', collection: 'pinnedWidgets', records: [rec] }, { msg: `${WIDGETS[id].title} pinned`, undoable: true })
    setOpen(false)
  }

  return (
    <div style={{ marginBottom: 22 }}>
      <button
        data-testid="add-widget"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ width: '100%', border: `1px dashed ${HAIR}`, borderRadius: 6, padding: '10px 14px', color: FAINT, fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9, background: 'none', cursor: 'pointer' }}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>
        <span>Add a chart from <span style={{ color: MUT, fontWeight: 500 }}>Trends, Accounts, Trips or Plan</span> — it stays live, and you can drag it anywhere</span>
      </button>

      {open && (
        <div data-testid="widget-picker" style={{ border: `1px solid ${HAIR}`, borderTop: 'none', borderRadius: '0 0 6px 6px', background: SURFACE, padding: '14px 16px' }}>
          {widgetsByScreen().map(([screen, ids]) => (
            <div key={screen} style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', marginBottom: 6 }}>{screen.toUpperCase()}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(240px,100%),1fr))', gap: 8 }}>
                {ids.map((id) => {
                  const pinned = !!findPin(vault.pinnedWidgets, id, { ...WIDGETS[id].defaults })
                  return (
                    <button
                      key={id}
                      data-testid={`add-widget-${id}`}
                      disabled={pinned}
                      onClick={() => add(id)}
                      style={{ textAlign: 'left', border: `1px solid ${HAIR}`, borderRadius: 6, padding: '9px 11px', background: 'none', cursor: pinned ? 'default' : 'pointer', opacity: pinned ? 0.5 : 1 }}
                    >
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: INK }}>{WIDGETS[id].title}{pinned && <span style={{ color: ACCENT, fontWeight: 400 }}> · on the dashboard</span>}</div>
                      <div style={{ fontSize: 11.5, color: FAINT, marginTop: 2, lineHeight: 1.4 }}>{WIDGETS[id].blurb}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
