import type { CSSProperties } from 'react'
import { FAINT, HAIR, HAIR2, INK, MONO, MUT, SERIF } from './theme'

export const mono = (size: number, extra?: CSSProperties): CSSProperties => ({
  fontFamily: MONO,
  fontSize: size,
  ...extra,
})

/** Small uppercase mono section label. */
export const kicker: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: MUT,
}

export const cardTitle: CSSProperties = { fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }

export const serif = (size: number, extra?: CSSProperties): CSSProperties => ({
  fontFamily: SERIF,
  fontSize: size,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  ...extra,
})

export const italicNote: CSSProperties = {
  fontFamily: SERIF,
  fontStyle: 'italic',
  fontSize: 12.5,
  color: MUT,
}

export const linkAction: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: INK,
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  border: 'none',
  background: 'none',
  padding: 0,
}

export const btnGhost: CSSProperties = {
  height: 32,
  padding: '0 14px',
  borderRadius: 2,
  border: `1px solid ${HAIR}`,
  background: 'transparent',
  color: MUT,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

export const btnOutline: CSSProperties = {
  ...btnGhost,
  border: `1px solid ${INK}`,
  color: INK,
}

export const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: `1px solid ${INK}`,
  background: INK,
  color: 'var(--bg)',
}

export const stepBtn: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 2,
  border: `1px solid ${HAIR}`,
  background: 'transparent',
  color: MUT,
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
}

export const chip = (on: boolean): CSSProperties => ({
  padding: '5px 11px',
  borderRadius: 2,
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  fontWeight: 500,
  cursor: 'pointer',
  border: `1px solid ${on ? INK : HAIR}`,
  background: on ? INK : 'transparent',
  color: on ? 'var(--bg)' : MUT,
})

export const underTab = (on: boolean): CSSProperties => ({
  border: 'none',
  background: 'none',
  padding: '0 0 3px',
  cursor: 'pointer',
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: '.1em',
  textTransform: 'uppercase' as const,
  color: on ? INK : MUT,
  borderBottom: on ? `1.5px solid ${INK}` : '1.5px solid transparent',
})

export const inputUnderline: CSSProperties = {
  height: 30,
  border: 'none',
  borderBottom: `1px solid ${HAIR}`,
  background: 'transparent',
  padding: '0 2px',
  fontSize: 12.5,
  outline: 'none',
  color: INK,
}

export const numInput: CSSProperties = {
  width: 110,
  height: 28,
  border: 'none',
  borderBottom: `1.5px solid ${INK}`,
  background: 'transparent',
  padding: '0 2px',
  fontFamily: MONO,
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'right',
  outline: 'none',
  color: INK,
}

export const sectionRule: CSSProperties = { borderTop: `1.5px solid ${INK}`, paddingTop: 14, minWidth: 0 }
export const hairBottom: CSSProperties = { borderBottom: `1px solid ${HAIR2}` }

/**
 * Turn a right-anchored drawer into a bottom sheet on a phone.
 *
 * Spread AFTER the drawer's own style so these win. Returns `{}` off-phone, so the desktop
 * object is the drawer's own, untouched — the reason this is a spread rather than a rewrite of
 * each call site.
 *
 * A 420px drawer already had `maxWidth: 90vw`, so it did not clip; it was just wrong. It covered
 * almost the whole screen while still being anchored to the top-right and hanging off the bottom
 * edge, and `top: 58` was a desktop header height that the phone header no longer has.
 *
 * `dvh` here, deliberately, where the shell uses `svh`: the shell must not resize as the mobile
 * toolbar collapses, but a transient panel should use the height that is actually on screen.
 */
export const phoneSheet = (narrow: boolean): CSSProperties =>
  narrow
    ? {
        top: 'auto',
        left: 0,
        right: 0,
        bottom: 0,
        width: 'auto',
        maxWidth: 'none',
        maxHeight: '88dvh',
        // max-height sizes the CONTENT box, so without this the padding and border land on top
        // of the limit and the panel overshoots the screen by exactly that much.
        boxSizing: 'border-box',
        borderLeft: 'none',
        borderTop: `1px solid ${HAIR}`,
        borderRadius: '14px 14px 0 0',
        boxShadow: '0 -14px 44px rgba(10,9,7,.22)',
        animation: 'sheetUp .18s cubic-bezier(.2,.7,.3,1)',
        paddingBottom: 'calc(18px + env(safe-area-inset-bottom))',
        overscrollBehavior: 'contain',
      }
    : {}

/** Tallest the category popover may grow before it scrolls — a vault can hold many categories. */
export const MENU_MAX = 320

/** True when the popover would not fit under the chip but would fit above it. */
export const noRoomBelow = (anchor: HTMLElement): boolean => {
  const r = anchor.getBoundingClientRect()
  return window.innerHeight - r.bottom < MENU_MAX + 24 && r.top > MENU_MAX / 2
}

/**
 * Make an anchored popover usable on a phone.
 *
 * Anchoring is the problem, not width: a menu pinned to a chip two-thirds down a 390px screen
 * has nowhere to go, and `noRoomBelow`'s flip only trades one clipped edge for another. So on a
 * phone the menu stops being anchored at all and spans the bottom of the screen, which is also
 * where a thumb already is.
 *
 * Spread over the existing absolute-positioned style, so the desktop object is untouched.
 */
export const phoneMenu = (narrow: boolean): CSSProperties =>
  narrow
    ? {
        position: 'fixed',
        left: 0,
        right: 0,
        top: 'auto',
        bottom: 0,
        zIndex: 91,
        maxHeight: '70dvh',
        boxSizing: 'border-box',
        minWidth: 0,
        borderRadius: '14px 14px 0 0',
        borderBottom: 'none',
        boxShadow: '0 -14px 44px rgba(10,9,7,.22)',
        padding: '8px 10px calc(14px + env(safe-area-inset-bottom))',
        animation: 'sheetUp .18s cubic-bezier(.2,.7,.3,1)',
        overscrollBehavior: 'contain',
      }
    : {}

export { FAINT, HAIR, HAIR2 }
