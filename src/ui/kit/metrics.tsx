// The Dashboard headline metric row's cell chrome — the one definition of "a labelled
// figure with a ? beside it".
//
// The four cells were hand-rolled divs sharing two style constants declared inside the
// screen component. Three consequences this fixes: the display figure had drifted into
// two sources (one cell re-typed `big`'s properties inline rather than spreading it), no
// cell carried a test handle so nothing could assert on the row's happy path, and every
// cell inherited the grid's `auto` min-content floor — which is why a long caption pushed
// the column wider instead of wrapping inside it.
import type { CSSProperties, ReactNode } from 'react'
import { FAINT, HAIR, MONO } from '../theme'

/** 11px mono, letter-spaced, uppercase — the label above a headline figure. */
export const eyebrow: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: FAINT,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
}

/**
 * The 34px display figure. BRIEF §13.2 puts headline KPIs at 28–40 semibold; hierarchy
 * comes from weight and size, never colour, so callers that tint it (net cash flow is
 * signed money) spread it rather than replace it.
 */
export const big: CSSProperties = { fontSize: 34, fontWeight: 600, letterSpacing: '-.02em', marginTop: 8, lineHeight: 1 }

/**
 * One cell of the headline metric row. `minWidth: 0` is load-bearing: grid items default
 * to a min-content floor, so without it the widest caption sets the column width and the
 * numbers beside it are squeezed until they break mid-figure.
 *
 * The eyebrow stays inline flow rather than flex — `<Explain>`'s trigger positions itself
 * with `vertical-align: middle`, which only means anything in an inline formatting context.
 */
export function MetricCell({
  testid,
  label,
  explain,
  divider = true,
  children,
}: {
  testid: string
  label: ReactNode
  explain?: ReactNode
  divider?: boolean
  children: ReactNode
}) {
  return (
    <div
      data-testid={testid}
      style={{
        padding: '18px 22px',
        borderRight: divider ? `1px solid ${HAIR}` : undefined,
        minWidth: 0,
        position: 'relative',
      }}
    >
      <div style={eyebrow}>
        {label}
        {explain}
      </div>
      {children}
    </div>
  )
}
