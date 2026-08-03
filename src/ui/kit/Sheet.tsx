import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BG, HAIR, INK, MUT } from '../theme'
import { kicker } from '../styles'

/**
 * A bottom sheet — the phone form of every drawer, popover and menu in the app.
 *
 * Two things about it are load-bearing rather than decorative:
 *
 * **It portals to `document.body`.** `position: fixed` is viewport-relative only while no
 * ancestor establishes a containing block, and a `transform` — even the identity
 * `matrix(1,0,0,1,0,0)` that `.rise` leaves behind — is enough to establish one. Several panes
 * wrap their whole subtree in `.rise`, so a fixed sheet rendered in place would anchor to the
 * pane box instead of the screen and sit 26px low, which is exactly the defect audit rule R9
 * exists to catch. Portalling puts it above every transformed ancestor.
 *
 * **`dvh`, not `svh`.** The shell uses `svh` because it must not resize as the mobile toolbar
 * collapses. A sheet is the opposite case: it is transient and should use whatever height is
 * actually on screen right now, so `dvh` is correct here.
 *
 * Callers render this only on phone and keep their existing markup otherwise — the desktop tree
 * is untouched by construction, not by careful copying.
 */
export function Sheet({
  title,
  onClose,
  children,
  labelledBy,
  maxHeight = '86dvh',
}: {
  title?: string
  onClose: () => void
  children: ReactNode
  labelledBy?: string
  maxHeight?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  // Escape reads onClose through a ref so the effect below can run on MOUNT only.
  // Depending on `onClose` — a fresh inline arrow on every parent render — re-ran
  // the effect on every save-status tick, stealing focus back to the panel and
  // dismissing the soft keyboard mid-type.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    // Focus the panel itself rather than its first control: a sheet often opens with a list, and
    // landing on the first list item reads as "already chose one".
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreTo.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <>
      <div
        data-testid="sheet-scrim"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 90,
          background: 'rgba(10,9,7,.34)',
          animation: 'scrimIn .16s ease',
        }}
      />
      <div
        ref={panel}
        data-testid="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 91,
          maxHeight,
          display: 'flex',
          flexDirection: 'column',
          background: BG,
          borderTop: `1px solid ${HAIR}`,
          borderRadius: '14px 14px 0 0',
          boxShadow: '0 -14px 44px rgba(10,9,7,.22)',
          animation: 'sheetUp .18s cubic-bezier(.2,.7,.3,1)',
          outline: 'none',
        }}
      >
        {/* The grab handle is decoration — the sheet is not draggable — but it is the standard
            signal for "this dismisses downward", and without it a sheet reads as a stuck page. */}
        <div style={{ flex: 'none', display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: HAIR }} />
        </div>
        {title && (
          <div
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 16px 10px',
              borderBottom: `1px solid ${HAIR}`,
            }}
          >
            <div style={{ ...kicker, color: MUT }}>{title}</div>
            <button
              data-testid="sheet-close"
              onClick={onClose}
              aria-label="Close"
              style={{
                border: 'none',
                background: 'none',
                color: INK,
                fontSize: 18,
                lineHeight: 1,
                cursor: 'pointer',
                padding: '0 4px',
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div
          style={{
            overflowY: 'auto',
            // Without this, flinging past the end of the sheet scrolls the page behind it.
            overscrollBehavior: 'contain',
            padding: '10px 16px calc(18px + env(safe-area-inset-bottom))',
          }}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}

/** A full-width row for sheet menus — 44px tall, left-aligned, no bespoke styling per caller. */
export function SheetItem({
  onClick,
  children,
  selected,
  testid,
  dataAttr,
}: {
  onClick: () => void
  children: ReactNode
  selected?: boolean
  testid?: string
  dataAttr?: Record<string, string>
}) {
  return (
    <button
      data-testid={testid}
      {...dataAttr}
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: 48,
        padding: '10px 6px',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        borderBottom: `1px solid var(--hair2)`,
        color: selected ? INK : 'var(--ink2)',
        fontWeight: selected ? 600 : 400,
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
