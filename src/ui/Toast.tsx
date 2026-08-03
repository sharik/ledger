import { useEffect } from 'react'
import { MONO, INK, BG } from './theme'
import { useStore, useStoreState } from './store'
import { useNarrow } from './responsive'
import { MOBILE_NAV_HEIGHT } from './MobileNav'

export function Toast() {
  const { toast } = useStoreState()
  const store = useStore()
  const narrow = useNarrow()

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => store.hideToast(), 3500)
    return () => clearTimeout(t)
  }, [toast?.key, store])

  if (!toast) return null
  return (
    <div
      data-testid="toast"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        // Clear the bottom nav bar and the home indicator. Both terms are 0 on desktop, so the
        // toast stays exactly 24px up from the bottom there.
        bottom: `calc(24px + ${narrow ? MOBILE_NAV_HEIGHT : 0}px + env(safe-area-inset-bottom))`,
        zIndex: 30,
        display: 'flex',
        gap: 18,
        alignItems: 'center',
        background: INK,
        color: BG,
        borderRadius: 2,
        padding: '12px 18px',
        fontSize: 13,
        // Had no width limit at all, so a long message ran off both edges of a phone.
        maxWidth: 'calc(100vw - 24px)',
        boxSizing: 'border-box',
        animation: 'toastIn .2s ease',
      }}
    >
      <span>{toast.msg}</span>
      {toast.undo && (
        <button
          data-testid="toast-undo"
          onClick={() => store.undoToast()}
          style={{
            border: 'none',
            background: 'none',
            color: BG,
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '.06em',
            cursor: 'pointer',
            fontFamily: MONO,
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          UNDO
        </button>
      )}
    </div>
  )
}
