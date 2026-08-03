// Horizontal bar rows (Phase G): the merchant-drill / movers shapes as real,
// keyboard-operable rows with ellipsised labels and honest hit targets.
import { useNarrow } from '../responsive'
import type { ReactNode } from 'react'
import { FAINT, GREEN, BRICK, HAIR, HAIR2, INK, MONO, MUT } from '../theme'
import { Tri } from '../kit'

export interface BarRow {
  key: string
  label: string
  /** 0..1 of the shared scale. */
  frac: number
  /** Already formatted/masked. */
  value: string
  color: string
  /** Change vs a prior window; `up` colors and points the triangle, absent = plain text ("new"). */
  delta?: { text: string; up?: boolean }
  title?: string
  onClick?: () => void
}

/** Plain rows: label | bar | value, plus a Δ column when any row carries one. */
export function BarRows({ rows, labelWidth = 150 }: { rows: BarRow[]; labelWidth?: number }) {
  const narrow = useNarrow()
  const hasDelta = rows.some((r) => r.delta)
  return (
    <>
      {rows.map((r) => {
        const RowTag = r.onClick ? 'button' : 'div'
        return (
          <RowTag
            key={r.key}
            data-bar-row={r.key}
            onClick={r.onClick}
            title={r.title}
            style={{
              display: 'grid',
              // Callers size the label column for a desktop card (130px for movers). At 366px
              // that plus the 76px value column and two gaps leaves the bar too little and the
              // row overflows, so the label is capped as a share of the row instead.
              gridTemplateColumns: narrow
                ? `minmax(0,${labelWidth}px) 1fr auto${hasDelta ? ' auto' : ''}`
                : `${labelWidth}px 1fr 76px${hasDelta ? ' 64px' : ''}`,
              gap: 12,
              alignItems: 'center',
              padding: '7px 0',
              borderTop: `1px solid ${HAIR2}`,
              cursor: r.onClick ? 'pointer' : 'default',
              background: 'none',
              border: 'none',
              borderRadius: 0,
              width: '100%',
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 13, color: MUT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
            <div style={{ height: 14, borderRadius: 2, background: r.color, width: `${Math.min(100, r.frac * 100).toFixed(1)}%`, minWidth: 3, opacity: 0.9 }} />
            <div style={{ fontFamily: MONO, fontSize: 12, textAlign: 'right', color: INK }}>{r.value}</div>
            {hasDelta && (
              <div data-row-delta={r.delta ? '' : undefined} style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, textAlign: 'right', color: r.delta?.up == null ? FAINT : r.delta.up ? BRICK : GREEN, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, whiteSpace: 'nowrap' }}>
                {r.delta?.up != null && <Tri dir={r.delta.up ? 'up' : 'down'} size={7} />}
                {r.delta?.text ?? ''}
              </div>
            )}
          </RowTag>
        )
      })}
    </>
  )
}

export interface DivergingRow {
  key: string
  label: string
  /** Positive = more (right, brick), negative = less (left, green). */
  delta: number
  /** |delta| / max|delta|, 0..1. */
  frac: number
  /** Already formatted/masked, without sign. */
  value: string
  /** Row color override (defaults to brick/green by sign). */
  color?: string
  title?: string
  onClick?: () => void
}

/**
 * Diverging rows around a center axis (movers / what-changed). The value label
 * sits OUTSIDE the bar on the same side, never overprinting it.
 */
export function DivergingRows({ rows, labelWidth = 86, extra }: { rows: DivergingRow[]; labelWidth?: number; extra?: (r: DivergingRow) => ReactNode }) {
  return (
    <>
      {rows.map((r) => {
        const more = r.delta > 0
        const col = r.color ?? (more ? BRICK : GREEN)
        // Cap at 36% of the half-axis so the value label always fits OUTSIDE the bar.
        const w = Math.min(36, r.frac * 36)
        const RowTag = r.onClick ? 'button' : 'div'
        return (
          <RowTag
            key={r.key}
            data-bar-row={r.key}
            onClick={r.onClick}
            title={r.title}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', cursor: r.onClick ? 'pointer' : 'default', background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
          >
            <div style={{ width: labelWidth, flex: 'none', fontSize: 12.5, color: MUT, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, overflow: 'hidden' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
              {extra?.(r)}
            </div>
            <div style={{ flex: 1, position: 'relative', height: 18 }}>
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: HAIR }} />
              <div style={{ position: 'absolute', top: 4, height: 10, borderRadius: 2, background: col, ...(more ? { left: '50%', width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` }) }} />
              <div
               
                style={{
                  position: 'absolute',
                  top: 1,
                  fontFamily: MONO,
                  fontSize: 10.5,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  whiteSpace: 'nowrap',
                  color: col,
                  ...(more ? { left: `calc(50% + ${w}% + 5px)` } : { right: `calc(50% + ${w}% + 5px)` }),
                }}
              >
                <Tri dir={more ? 'up' : 'down'} size={7} />
                {r.value}
              </div>
            </div>
          </RowTag>
        )
      })}
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: FAINT, padding: '10px 0' }}>Nothing to compare yet.</div>}
    </>
  )
}
