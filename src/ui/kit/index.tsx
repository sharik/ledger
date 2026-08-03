// Small, reused UI primitives for the Ledger.dc.html design (Phase A, A.3).
// All colors resolve from the CSS token blocks in index.html, so every primitive
// follows the active light/dark theme.
import type { CSSProperties, ReactNode } from 'react'
import { ACCENT, HAIR, INK, MONO, MUT, SURFACE, SURFACE2 } from '../theme'
import { phoneMenu } from '../styles'
import { useNarrow } from '../responsive'

/** Surface panel: background + hairline border + 6px radius (the mock's card). */
export function Card({
  children,
  style,
  pad = 16,
  'data-testid': testId,
}: {
  children: ReactNode
  style?: CSSProperties
  pad?: number | string
  'data-testid'?: string
}) {
  return (
    <div
      data-testid={testId}
      style={{
        background: SURFACE,
        border: `1px solid ${HAIR}`,
        borderRadius: 6,
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** 11px IBM Plex Mono, letter-spaced, uppercase — section eyebrows and labels. */
export function MonoLabel({
  children,
  color = MUT,
  size = 11,
  style,
}: {
  children: ReactNode
  color?: string
  size?: number
  style?: CSSProperties
}) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: size,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** Color dot + name, with an optional provenance slot (e.g. rule / AI badge). */
export function CategoryChip({
  name,
  color,
  provenance,
  style,
}: {
  name: string
  color: string
  provenance?: ReactNode
  style?: CSSProperties
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: INK, ...style }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: 'none' }} />
      <span>{name}</span>
      {provenance}
    </span>
  )
}

export interface SegOption<T extends string> {
  value: T
  label: string
}

/** Segmented pill control (the Month / Year toggle). */
export function SegControl<T extends string>({
  options,
  value,
  onChange,
  'data-testid': testId,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  'data-testid'?: string
}) {
  return (
    <div
      data-testid={testId}
      style={{ display: 'inline-flex', border: `1px solid ${HAIR}`, borderRadius: 999, padding: 2 }}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: 'none',
              cursor: 'pointer',
              borderRadius: 999,
              padding: '3px 12px',
              fontFamily: MONO,
              fontSize: 10.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: on ? INK : 'transparent',
              color: on ? SURFACE : MUT,
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Up/down triangle — one geometry for the whole app. Three screens hand-rolled this
 * glyph with three different paths and a fourth existed here unused.
 *
 * Always `aria-hidden`: direction has to be carried by the text beside it too (a signed
 * figure, a word), so the meaning survives a screen reader and colour-blindness. The
 * triangle is reinforcement, never the only signal.
 */
export function Tri({ dir, size = 9, color }: { dir: 'up' | 'down'; size?: number; color?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" fill="currentColor" style={color ? { color } : undefined}>
      <path d={dir === 'up' ? 'M6 2 10 9 2 9z' : 'M6 10 2 3 10 3z'} />
    </svg>
  )
}

/** Small mono, hairline-bordered badge (e.g. the EUR currency badge). */
export function Badge({
  children,
  color = MUT,
  border = HAIR,
  style,
  'data-testid': testId,
}: {
  children: ReactNode
  color?: string
  border?: string
  style?: CSSProperties
  'data-testid'?: string
}) {
  return (
    <span
      data-testid={testId}
      style={{
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: '0.08em',
        color,
        border: `1px solid ${border}`,
        borderRadius: 3,
        padding: '1px 5px',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

// ---------- filter chip + menu item (shared by Transactions and import review) ----------

/**
 * A labelled dropdown button. The caller owns open/close via a single `menu` state.
 *
 * On a phone the panel leaves its anchor and spans the bottom of the screen (`phoneMenu`), plus
 * a scrim so a tap outside dismisses it — with a menu that no longer sits under its chip, there
 * is otherwise nothing to say "this is on top of the page".
 */
export function FilterChip({ testid, label, open, onClick, children }: { testid: string; label: string; open: boolean; onClick: () => void; children: ReactNode }) {
  const narrow = useNarrow()
  return (
    <div style={{ position: 'relative' }}>
      {/* Above its own scrim when open: otherwise the scrim swallows the tap that would close
          the menu, and the chip — the obvious thing to press again — stops responding. */}
      <button data-testid={testid} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, borderRadius: 6, padding: '8px 12px', border: `1px solid ${HAIR}`, background: SURFACE, color: MUT, cursor: 'pointer', position: open && narrow ? 'relative' : undefined, zIndex: open && narrow ? 92 : undefined }}>{label} ▾</button>
      {open && narrow && <div onClick={onClick} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,9,7,.34)' }} />}
      {open && (
        <div style={{ position: 'absolute', left: 0, top: 42, zIndex: 30, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, minWidth: 168, boxShadow: '0 10px 28px rgba(10,9,7,.16)', display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 320, overflowY: 'auto', ...phoneMenu(narrow) }}>
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return <button data-menu-item={label} onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 13, color: MUT, padding: '9px 10px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{label}</button>
}

// ---------- external lookup ----------

/**
 * A user-clicked pair of external-search links for one transaction. Renders plain
 * anchors (no app fetch): only the given query text reaches Google. `query` should
 * come from `lookupQuery` in ../import/lookup.
 */
export function LookupLinks({ query, style }: { query: string; style?: CSSProperties }) {
  if (!query) return null
  const q = encodeURIComponent(query)
  const link: CSSProperties = { fontSize: 'inherit', color: ACCENT, textDecoration: 'none' }
  return (
    <span style={{ display: 'inline-flex', gap: 12, fontSize: 12, ...style }}>
      <a data-testid="lookup-web" href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noopener noreferrer" style={link}>
        Search ↗
      </a>
      <a data-testid="lookup-maps" href={`https://www.google.com/maps/search/?api=1&query=${q}`} target="_blank" rel="noopener noreferrer" style={link}>
        Maps ↗
      </a>
    </span>
  )
}

/** Shared accent color re-export so kit consumers don't reach past the kit. */
export { ACCENT }
