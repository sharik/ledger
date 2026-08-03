// THE chart tooltip (Phase G) — replaces the three per-screen crosshair
// implementations. One fixed-position dark card, pointer-events-none, fed by
// pointer events (mouse AND touch), dismissed on leave/Escape.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { INK, MONO } from '../theme'

export interface ChartTipState {
  x: number // viewport px
  y: number
  content: ReactNode
  /**
   * 'above' (default) puts the card above `y`, which is right for a tip following a pointer.
   * 'below' is for a tip anchored to a BUTTON: above it lies whatever the button sits under, and
   * an <Explain> "?" on a section heading covered the action button of the block above it.
   */
  place?: 'above' | 'below'
}

export interface ChartTipApi {
  tip: ChartTipState | null
  /** Show `content` near a viewport point (typically e.clientX/Y). */
  showAt: (clientX: number, clientY: number, content: ReactNode, place?: 'above' | 'below') => void
  hide: () => void
}

export function useChartTip(): ChartTipApi {
  const [tip, setTip] = useState<ChartTipState | null>(null)
  const showAt = useCallback((x: number, y: number, content: ReactNode, place?: 'above' | 'below') => setTip({ x, y, content, place }), [])
  const hide = useCallback(() => setTip(null), [])
  useEffect(() => {
    if (!tip) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTip(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tip])
  return { tip, showAt, hide }
}

/**
 * Render once per chart region. Positions itself above-right of the pointer, clamped to the
 * viewport.
 *
 * Portalled to `document.body`, and that is a fix rather than a tidy-up: three screens wrap
 * their pane in `.rise`, whose animation leaves a computed `matrix(1,0,0,1,0,0)` behind.
 * An identity transform still establishes a containing block, so a `position: fixed` tip
 * rendered in place was being positioned against the PANE while its `left`/`top` were computed
 * against the VIEWPORT. On a 390px screen that put the card at 216→460 — off the right edge.
 * Audit rule R9.
 */
export function ChartTip({ tip }: { tip: ChartTipState | null }) {
  if (!tip) return null
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const pad = 14
  // Clamp both edges. The old form only clamped the right, so a tip raised near the left edge of
  // a narrow screen could still start off-screen.
  const left = Math.max(8, Math.min(tip.x + pad, vw - 190))
  const below = tip.place === 'below'
  const top = below ? tip.y + 8 : Math.max(8, tip.y - 14)
  return createPortal(
    <div
      data-testid="chart-tip"
      style={{
        position: 'fixed',
        left,
        top,
        transform: below ? undefined : 'translateY(-100%)',
        zIndex: 80,
        pointerEvents: 'none',
        background: INK,
        color: 'var(--bg)',
        borderRadius: 5,
        padding: '7px 10px',
        fontFamily: MONO,
        fontSize: 10.5,
        lineHeight: 1.5,
        // A phone cannot afford `nowrap` on a two-clause tip; cap it and let it wrap instead of
        // running off the edge.
        maxWidth: 'min(260px, calc(100vw - 16px))',
        whiteSpace: 'normal',
        boxShadow: '0 6px 18px rgba(0,0,0,.18)',
      }}
    >
      {tip.content}
    </div>,
    document.body,
  )
}
