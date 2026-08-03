// A dashboard laid out as tiles that snap: drag one to a column slot or to a row edge, drag its
// right edge to widen it.
//
// This replaces the flat `useCardOrder` list on the Dashboard. The difference is one dimension:
// `useCardOrder` orders ids and lets `auto-fill` decide the columns, so nothing can say "this chart
// is two columns wide" and `‹ ›` mean earlier/later rather than left/right. Here a tile carries a
// span, `packRows` flows the spans into rows, and every row fills its width — so a tile alone on a
// line is full width, and widening one pushes what followed it down.
//
// Drag comes from @dnd-kit rather than the HTML5 `draggable` this replaces. That is not a taste
// call: `draggable` never fires on iOS touch, so the whole gesture was desktop-only and a phone had
// nothing but `‹ ›`. dnd-kit brings the pointer and touch sensors, an activation delay that lets a
// vertical swipe stay a scroll, and auto-scroll during a drag. Its `KeyboardSensor` is deliberately
// NOT used — see the note on the handle in `Tile`. The layout model stays ours (`dashOrder.ts`)
// because nothing off the shelf flows spans; the grid libraries all model a free x/y canvas where a
// lone tile keeps its width and leaves a hole.
import { useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { clampSpan, loadTiles, MAX_SPAN, moveId, packRows, rowTracks, saveOrder, applyOrderAnchored, type DashOrder, type OrderNs, type Span } from '../dashOrder'
import { useMeasuredWidth } from '../charts/useMeasuredWidth'
import { useCoarse } from '../responsive'
import { ACCENT, FAINT, HAIR, MONO, SURFACE } from '../theme'

export const TILE_GAP = 16

const ctl: React.CSSProperties = { fontFamily: MONO, fontSize: 11, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', lineHeight: 1 }

export interface TileGridApi {
  /** The default tiles with the saved order applied — stale ids dropped, new ones anchored. */
  ids: string[]
  order: DashOrder
  patch: (p: Partial<DashOrder>) => void
  spanOf: (id: string) => Span
}

/**
 * @param defaultSpans the span a tile has until the user resizes it — the hero chart and the plan
 *        block want the full width, a pinned card wants one column.
 * @param onReorder runs after every reorder with the new id list; the Dashboard mirrors pin order
 *        into the vault there, so cross-device pin order stays in step with the local layout.
 */
export function useTileGrid(ns: OrderNs, defaultTiles: string[], defaultSpans: Record<string, Span>, onReorder?: (ids: string[]) => void): TileGridApi {
  const [order, setOrder] = useState<DashOrder>(() => loadTiles(ns))

  const patch = (p: Partial<DashOrder>) => {
    setOrder((o) => {
      const next = { ...o, ...p }
      saveOrder(ns, next)
      return next
    })
    // Outside the updater, which has to stay pure — React is free to call it twice, and this one
    // writes to the vault.
    if (p.tiles) onReorder?.(p.tiles)
  }

  return {
    ids: applyOrderAnchored(defaultTiles, order.tiles),
    order,
    patch,
    spanOf: (id) => order.spans?.[id] ?? defaultSpans[id] ?? 1,
  }
}

export interface TileGridProps {
  grid: TileGridApi
  /** Columns available at this breakpoint. 1 on a phone, which turns off snapping and resizing. */
  cols: number
  /** Render a tile. `controls` is the reorder/resize cluster the tile should put in its header. */
  render: (id: string, controls: React.ReactNode) => React.ReactNode
  /** Human name for a tile, for the drag ghost and the control labels. */
  name: (id: string) => string
  /** An extra control to sit in the cluster — the Dashboard puts its × unpin button here. */
  extra?: (id: string) => React.ReactNode
  /** Extra DOM attributes per tile, for test hooks the screen already publishes. */
  attrs?: (id: string) => Record<string, string | undefined>
}

export function TileGrid({ grid, cols, render, name, extra, attrs }: TileGridProps) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; span: Span } | null>(null)
  const [measure, width] = useMeasuredWidth()
  // A 16px strip down the right edge of every tile is exactly the "swallows the page scroll"
  // shape the mobile audit put a ceiling on, and a column-precise drag is a fine-pointer gesture
  // anyway. Touch resizes with the grip's arrow keys, or does not resize.
  const coarse = useCoarse()
  const resizable = cols > 1 && !coarse

  // While the resize grip is held, pack with the previewed span so the whole grid reflows live.
  const spanOf = (id: string) => (preview && preview.id === id ? preview.span : grid.spanOf(id))
  const rows = packRows(grid.ids, spanOf, cols)

  const sensors = useSensors(
    // 4px of slop so a click on the handle is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // A held press, not a swipe: below this a vertical drag on a phone stays a page scroll.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  )

  const setSpan = (id: string, span: Span) => grid.patch({ spans: { ...grid.order.spans, [id]: span } })

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null)
    const id = String(e.active.id)
    const zone = /^(slot|seam):(\d+)@\d+$/.exec(String(e.over?.id ?? ''))
    if (!zone) return
    const [, kind, atRaw] = zone
    const at = Number(atRaw)
    const from = grid.ids.indexOf(id)
    if (from < 0) return
    const tiles = [...grid.ids]
    tiles.splice(from, 1)
    tiles.splice(at > from ? at - 1 : at, 0, id)
    // A row edge is the "maximise" gesture, so it stores the widest span rather than this
    // breakpoint's — the intent is full width, and a tablet reading 2 would shrink on a desktop.
    // A phone has one column, where every tile is already full width and the drag says nothing
    // about width at all.
    const spans = kind === 'seam' && cols > 1 ? { ...grid.order.spans, [id]: MAX_SPAN as Span } : grid.order.spans
    grid.patch({ tiles, spans })
  }

  let flat = 0 // running index of the tile across all rows, which is what the zones insert at
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
      // dnd-kit mounts its screen-reader live region as `position: fixed` wherever the context
      // sits, and every pane here is wrapped in `.rise`, whose keyframes animate a transform —
      // which makes that ancestor the region's containing block instead of the viewport (mobile
      // audit rule R9). Harmless for a 1px announcer, but the rule is right in general and this
      // is what it costs to keep it honest: put the region on `body`, outside the transform.
      accessibility={{ container: typeof document === 'undefined' ? undefined : document.body }}
    >
      <div ref={measure} style={{ display: 'flex', flexDirection: 'column', gap: TILE_GAP, marginBottom: 12 }}>
        {rows.map((row, r) => {
          const start = flat
          flat += row.length
          return (
            <div key={r} style={{ display: 'grid', gridTemplateColumns: rowTracks(row, spanOf, cols), gap: TILE_GAP, alignItems: 'stretch' }}>
              {row.map((id, i) => (
                <Tile
                  key={id}
                  id={id}
                  index={start + i}
                  cols={cols}
                  resizable={resizable}
                  colWidth={width > 0 ? (width - TILE_GAP * (cols - 1)) / cols : 0}
                  span={spanOf(id)}
                  name={name(id)}
                  dragging={dragId === id}
                  anyDragging={dragId !== null}
                  attrs={attrs?.(id)}
                  onNudge={(dir) => grid.patch({ tiles: moveId(grid.ids, id, dir) })}
                  onPreview={(span) => setPreview(span === null ? null : { id, span })}
                  onResize={(span) => setSpan(id, span)}
                >
                  {/* `extra` (the screen's remove action) sits BEFORE the handle so the corner —
                      where a drag affordance is expected — is the handle. It used to be the ×,
                      which put "delete this" exactly where the hand goes to move something. */}
                  {(controls) => render(id, <>{extra?.(id)}{controls}</>)}
                </Tile>
              ))}
            </div>
          )
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragId ? (
          <div style={{ ...ctl, background: SURFACE, border: `1px solid ${ACCENT}`, borderRadius: 6, padding: '7px 11px', color: ACCENT, boxShadow: '0 6px 18px rgba(0,0,0,.18)', cursor: 'grabbing' }}>⠿ {name(dragId)}</div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

interface TileProps {
  id: string
  index: number
  cols: number
  resizable: boolean
  colWidth: number
  span: Span
  name: string
  dragging: boolean
  anyDragging: boolean
  attrs?: Record<string, string | undefined>
  onNudge: (dir: -1 | 1) => void
  onPreview: (span: Span | null) => void
  onResize: (span: Span) => void
  children: (controls: React.ReactNode) => React.ReactNode
}

function Tile({ id, index, cols, resizable, colWidth, span, name, dragging, anyDragging, attrs, onNudge, onPreview, onResize, children }: TileProps) {
  const { setNodeRef, listeners, attributes } = useDraggable({ id, data: { index } })
  const gripRef = useRef<{ x: number; span: Span } | null>(null)

  // Drag is the only way to move a tile with a pointer — there are no ‹ › nudge buttons. They
  // meant earlier/later in a flat list, which is the one-dimensional idea this grid replaces: in
  // a grid "later" is neither right nor down, and neither of them could ever set a width.
  //
  // The keyboard does not lose the ability, because the handle carries it. dnd-kit's
  // `KeyboardSensor` was tried here and removed: it drives a drag by nudging a coordinate, which
  // suits a list of small sortable rows and not a grid of zones over 200px-tall tiles — it drifted
  // to whichever zone happened to be near and the drop often applied nothing. Arrow keys move the
  // tile through the same array the drop does, which is predictable and cannot miss.
  const controls = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      {/* No `touch-action: none` here, which dnd-kit would otherwise want: the TouchSensor's
          200ms delay does the same job of telling a drag from a scroll, and the audit holds the
          app to zero scroll-swallowing sites. */}
      <span
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        role="button"
        aria-label={`Move ${name} — drag, or use the arrow keys`}
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
          if (!dir) return
          e.preventDefault()
          onNudge(dir)
        }}
        style={{ ...ctl, cursor: 'grab' }}
      >
        ⠿
      </span>
    </span>
  )

  const startGrip = (e: React.PointerEvent) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    gripRef.current = { x: e.clientX, span }
  }
  const moveGrip = (e: React.PointerEvent) => {
    const g = gripRef.current
    if (!g || colWidth <= 0) return
    onPreview(clampSpan(g.span + Math.round((e.clientX - g.x) / (colWidth + TILE_GAP)), cols))
  }
  const endGrip = (e: React.PointerEvent) => {
    const g = gripRef.current
    if (!g) return
    gripRef.current = null
    onPreview(null)
    if (colWidth > 0) {
      const next = clampSpan(g.span + Math.round((e.clientX - g.x) / (colWidth + TILE_GAP)), cols)
      if (next !== g.span) onResize(next)
    }
  }

  return (
    <div
      data-dash-tile={id}
      data-span={span}
      {...attrs}
      style={{ position: 'relative', display: 'flex', minWidth: 0, opacity: dragging ? 0.45 : 1 }}
    >
      {children(controls)}

      {/* The resize grip. One column leaves no width to choose, and see `resizable` for why a
          touch pointer does not get the strip. */}
      {resizable && (
        <button
          aria-label={`Resize ${name}`}
          onPointerDown={startGrip}
          onPointerMove={moveGrip}
          onPointerUp={endGrip}
          onPointerCancel={endGrip}
          onKeyDown={(e) => {
            const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (!dir) return
            e.preventDefault()
            onResize(clampSpan(span + dir, cols))
          }}
          style={{
            position: 'absolute', top: 0, right: -TILE_GAP / 2, width: TILE_GAP, height: '100%',
            background: 'none', border: 'none', padding: 0, cursor: 'col-resize', zIndex: 2,
          }}
        >
          <span aria-hidden style={{ display: 'block', width: 2, height: 26, margin: '0 auto', borderRadius: 1, background: HAIR }} />
        </button>
      )}

      <SnapZones index={index} cols={cols} active={anyDragging && !dragging} />
    </div>
  )
}

/**
 * The four places a tile can land, laid over the tile it is dropped on: the top and bottom bands
 * open a new full-width row before or after it, the left and right halves take the column slot
 * beside it. Overlays rather than gaps in the flow, so nothing shifts under the cursor mid-drag.
 *
 * A phone has one column and therefore no slots — top and bottom halves are the whole vocabulary.
 *
 * They stay mounted when no drag is in flight rather than appearing with one. dnd-kit measures its
 * droppables when the drag *starts*, so a zone mounted in response to that same event is measured
 * too late to be a candidate and the drop silently does nothing. Staying mounted costs nothing:
 * collision detection intersects the pointer with measured rects, so a zone never needs to receive
 * a pointer event, and `pointerEvents: none` keeps it clear of the tile's own controls.
 *
 * The `@index` suffix on every id is load-bearing. Two neighbours describe the same insertion
 * point — the seam after the first tile is the seam before the second — and a droppable id has to
 * be unique or the later registration silently replaces the earlier one in dnd-kit's registry.
 */
function SnapZones({ index, cols, active }: { index: number; cols: number; active: boolean }) {
  const at = (kind: 'slot' | 'seam', n: number) => `${kind}:${n}@${index}`
  if (cols < 2) {
    return (
      <>
        <Zone id={at('slot', index)} active={active} style={{ top: 0, left: 0, right: 0, height: '50%' }} bar={{ top: 0, left: 0, right: 0, height: 3 }} />
        <Zone id={at('slot', index + 1)} active={active} style={{ bottom: 0, left: 0, right: 0, height: '50%' }} bar={{ bottom: 0, left: 0, right: 0, height: 3 }} />
      </>
    )
  }
  return (
    <>
      <Zone id={at('seam', index)} active={active} style={{ top: 0, left: 0, right: 0, height: '26%' }} bar={{ top: 0, left: 0, right: 0, height: 3 }} />
      <Zone id={at('seam', index + 1)} active={active} style={{ bottom: 0, left: 0, right: 0, height: '26%' }} bar={{ bottom: 0, left: 0, right: 0, height: 3 }} />
      <Zone id={at('slot', index)} active={active} style={{ top: '26%', bottom: '26%', left: 0, width: '50%' }} bar={{ top: '26%', bottom: '26%', left: 0, width: 3 }} />
      <Zone id={at('slot', index + 1)} active={active} style={{ top: '26%', bottom: '26%', right: 0, width: '50%' }} bar={{ top: '26%', bottom: '26%', right: 0, width: 3 }} />
    </>
  )
}

/**
 * Deliberately never `disabled`: dnd-kit leaves a disabled droppable out of the rect snapshot it
 * takes when a drag starts, so gating on "is a drag in flight" is self-defeating in the same way
 * mounting on it is. `active` only decides whether the snap bar is allowed to show.
 */
function Zone({ id, active, style, bar }: { id: string; active: boolean; style: React.CSSProperties; bar: React.CSSProperties }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <>
      <div ref={setNodeRef} data-snap-zone={id} style={{ position: 'absolute', zIndex: 3, pointerEvents: 'none', ...style }} />
      {isOver && active && <div style={{ position: 'absolute', zIndex: 4, borderRadius: 2, background: ACCENT, pointerEvents: 'none', ...bar }} />}
    </>
  )
}
