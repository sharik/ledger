// ChartCard (Phase G): titled card that MEASURES its plot area and hands real
// pixel dimensions to its child chart — charts render <svg width height> at true
// px (fonts and strokes stay fixed), so "expand" is bigger geometry, never CSS
// scaling of a viewBox. The expand button opens a fixed-inset dialog (Year-in-
// review overlay pattern) whose body is measured the same way.
import { useNarrow } from '../responsive'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BG, FAINT, HAIR, INK, MUT, SURFACE } from '../theme'
import { useMeasuredWidth } from './useMeasuredWidth'
import { Explain } from '../explain'
import type { ExplainId } from '../explain'

export interface ChartSize {
  width: number
  height: number
  fullscreen: boolean
}

interface ChartCardProps {
  title: ReactNode
  subtitle?: ReactNode
  controls?: ReactNode
  /** Extra content below the plot (legends, footnotes) — rendered in both modes. */
  footer?: ReactNode
  height?: number
  fullscreenHeight?: number
  testid?: string
  ariaLabel?: string
  /** Registry id for the "?" beside the title — rendered in both normal and fullscreen. */
  explain?: ExplainId
  children: (size: ChartSize) => ReactNode
}

const card: CSSProperties = { background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }
/** 40px of horizontal card padding is a tenth of a 390px screen — the plot needs it more. */
const cardNarrow: CSSProperties = { ...card, padding: '14px 10px' }

export function ChartCard({ title, subtitle, controls, footer, height = 300, fullscreenHeight, testid, ariaLabel, explain, children }: ChartCardProps) {
  const [full, setFull] = useState(false)
  const [ref, width] = useMeasuredWidth()
  const [fsRef, fsWidth] = useMeasuredWidth()
  const openBtn = useRef<HTMLButtonElement | null>(null)
  const narrow = useNarrow()

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      openBtn.current?.focus()
    }
  }, [full])

  const expandBtn = (
    <button
      ref={openBtn}
      data-testid={testid ? `${testid}-expand` : undefined}
      onClick={() => setFull(true)}
      aria-label="Expand chart to full screen"
      style={{ flex: 'none', fontSize: 12, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 5, padding: '4px 8px', background: 'none', cursor: 'pointer', lineHeight: 1 }}
    >
      ⛶
    </button>
  )

  const header = (fullscreen: boolean) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      {/* On a phone the dismiss gets its own line above everything, as a modal ✕ rather than a
          pill sitting in the control row — there it read as a third option of the segmented
          control beside it, and nothing said which thing closed the view. */}
      {fullscreen && narrow && (
        <div style={{ order: -1, flex: '1 1 100%', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            data-testid={testid ? `${testid}-close` : undefined}
            onClick={() => setFull(false)}
            autoFocus
            aria-label="Close full screen"
            style={{ fontSize: 17, lineHeight: 1, color: INK, border: `1px solid ${HAIR}`, borderRadius: 999, width: 34, height: 34, background: SURFACE, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}
      <div style={narrow ? { flex: '1 1 100%', minWidth: 0 } : undefined}>
        <div style={{ fontSize: fullscreen ? 16 : 14, fontWeight: 600, color: INK, display: 'flex', alignItems: 'center', gap: narrow ? 6 : 0 }}>
          <span style={{ flex: narrow ? 1 : undefined, minWidth: 0, display: 'inline-flex', alignItems: 'center' }}>
            {title}
            {explain && <Explain id={explain} size="sm" />}
          </span>
          {/* The expand control belongs on the title line, not adrift on a row of its own with
              the rest of it empty — which is where `space-between` + `wrap` put it at 366px. */}
          {narrow && !fullscreen && expandBtn}
        </div>
        {subtitle && <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...(narrow ? { flex: '1 1 100%' } : {}) }}>
        {controls}
        {fullscreen && narrow ? null : fullscreen ? (
          <button
            data-testid={testid ? `${testid}-close` : undefined}
            onClick={() => setFull(false)}
            autoFocus
            aria-label="Close full screen"
            style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 13px', background: SURFACE, cursor: 'pointer' }}
          >
            Close ✕
          </button>
        ) : narrow ? null : (
          expandBtn
        )}
      </div>
    </div>
  )

  // On a phone full screen buys height, not width, so it should actually use it — a capped
  // chart just trades a wasted right gutter for a wasted bottom one. 210px covers the close
  // row, title, subtitle, controls and padding.
  const fsH = narrow
    ? Math.max(300, (typeof window !== 'undefined' ? window.innerHeight : 700) - 210)
    : (fullscreenHeight ?? (typeof window !== 'undefined' ? Math.max(360, window.innerHeight - 260) : 600))

  return (
    <section style={narrow ? cardNarrow : card} data-testid={testid} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      {header(false)}
      <div ref={ref} style={{ marginTop: 10 }}>
        {width > 0 && children({ width, height, fullscreen: false })}
      </div>
      {footer}
      {full &&
        createPortal(
          <div
            data-testid={testid ? `${testid}-fullscreen` : 'chart-fullscreen'}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : 'Expanded chart'}
            style={{ position: 'fixed', inset: 0, zIndex: 62, background: BG, overflowY: 'auto' }}
          >
            <div style={{ maxWidth: 1500, margin: '0 auto', padding: narrow ? '14px 10px 28px' : '26px 40px 40px' }}>
              {header(true)}
              <div ref={fsRef} style={{ marginTop: 16 }}>
                {fsWidth > 0 && children({ width: fsWidth, height: fsH, fullscreen: true })}
              </div>
              {footer}
            </div>
          </div>,
          document.body,
        )}
    </section>
  )
}
