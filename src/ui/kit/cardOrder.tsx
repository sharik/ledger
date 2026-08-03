// Card ordering for a screen composed of pinnable cards (Dashboard, Plan).
//
// The Dashboard proved the interaction — ‹ › to nudge, ⠿ to drag, order persisted per device in
// localStorage — and Plan wanted exactly the same thing, so it lives here rather than being written
// a second time. The pure parts (`applyOrder`, `moveId`) stay in `dashOrder.ts`, unit-tested and
// namespace-free; this is the React shell around them: state, persistence, and the controls.
import { useState } from 'react'
import { applyOrder, loadOrder, moveId, saveOrder, type DashOrder, type OrderNs } from '../dashOrder'
import { FAINT, MONO } from '../theme'

const ctl: React.CSSProperties = { fontFamily: MONO, fontSize: 11, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', lineHeight: 1 }

export interface CardOrder {
  /** The default ids with the saved order applied — stale ids dropped, new ones appended. */
  ids: string[]
  /** The whole stored preference, for a screen that keeps more than card order in it. */
  order: DashOrder
  patch: (p: Partial<DashOrder>) => void
  /** ‹ › ⠿ for one card, plus whatever extra control the screen wants inside the same cluster. */
  controls: (id: string, extra?: React.ReactNode) => React.ReactNode
  /** Spread onto the card's container so a drag can land on it. */
  dropTarget: (id: string) => { onDragOver: (e: React.DragEvent) => void; onDrop: () => void }
  isDragging: (id: string) => boolean
}

/**
 * @param onReorder runs after every reorder with the new id list — the Dashboard mirrors pin order
 *        into the vault there, so a cross-device pin order stays in step with the local layout.
 */
export function useCardOrder(ns: OrderNs, defaultIds: string[], onReorder?: (ids: string[]) => void): CardOrder {
  const [order, setOrder] = useState<DashOrder>(() => loadOrder(ns))
  const [dragId, setDragId] = useState<string | null>(null)

  const patch = (p: Partial<DashOrder>) =>
    setOrder((o) => {
      const next = { ...o, ...p }
      saveOrder(ns, next)
      return next
    })

  const ids = applyOrder(defaultIds, order.cards)
  const apply = (next: string[]) => {
    patch({ cards: next })
    onReorder?.(next)
  }

  const dropOn = (target: string) => {
    if (!dragId || dragId === target) return
    const next = ids.filter((c) => c !== dragId)
    const idx = next.indexOf(target)
    next.splice(idx < 0 ? next.length : idx, 0, dragId)
    apply(next)
    setDragId(null)
  }

  const controls = (id: string, extra?: React.ReactNode) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <button aria-label="Move card earlier" onClick={(e) => { e.stopPropagation(); apply(moveId(ids, id, -1)) }} style={ctl}>‹</button>
      <button aria-label="Move card later" onClick={(e) => { e.stopPropagation(); apply(moveId(ids, id, 1)) }} style={ctl}>›</button>
      {extra}
      <span
        draggable
        onDragStart={(e) => {
          setDragId(id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDragId(null)}
        aria-label="Drag to reorder"
        style={{ ...ctl, cursor: 'grab' }}
      >
        ⠿
      </span>
    </span>
  )

  return {
    ids,
    order,
    patch,
    controls,
    dropTarget: (id) => ({
      onDragOver: (e) => {
        if (dragId) e.preventDefault()
      },
      onDrop: () => dropOn(id),
    }),
    isDragging: (id) => dragId === id,
  }
}
