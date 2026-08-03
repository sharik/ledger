// Interactive legend (Phase G): every item is a real <button aria-pressed> that
// toggles its series, plus hover-highlight. Only series actually present are
// listed (a legend must never advertise bars that don't exist).
import { FAINT, HAIR2, MONO, MUT } from '../theme'

export interface LegendItem {
  id: string
  label: string
  color: string
  /** Optional per-series total, shown muted next to the label (already formatted/masked). */
  value?: string
}

export function Legend({ items, hidden, onToggle, onHover }: {
  items: LegendItem[]
  hidden: ReadonlySet<string>
  onToggle: (id: string) => void
  onHover?: (id: string | null) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 8px', marginTop: 10, paddingTop: 12, borderTop: `1px solid ${HAIR2}` }}>
      {items.map((it) => {
        const off = hidden.has(it.id)
        return (
          <button
            key={it.id}
            data-testid={`legend-${it.id}`}
            aria-pressed={!off}
            // `aria-label`, not `title`: a tooltip is meaning a touch device never shows (mobile
            // audit rule R5), and `aria-pressed` above already carries the state to assistive tech.
            aria-label={off ? `Show ${it.label}` : `Hide ${it.label}`}
            onClick={() => onToggle(it.id)}
            onMouseEnter={() => onHover?.(it.id)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(it.id)}
            onBlur={() => onHover?.(null)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: off ? FAINT : MUT,
              opacity: off ? 0.55 : 1,
              textDecoration: off ? 'line-through' : 'none',
              background: 'none',
              border: 'none',
              borderRadius: 4,
              padding: '2px 4px',
              cursor: 'pointer',
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 2, background: it.color, opacity: off ? 0.4 : 1 }} />
            {it.label}
            {it.value && <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{it.value}</span>}
          </button>
        )
      })}
    </div>
  )
}
