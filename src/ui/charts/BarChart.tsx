// BarChart (Phase G): width-aware vertical bars — plain or stacked — with the
// shared tooltip, keyboard focus, hidden-series support and hover-dimming.
// Every bar/segment is a real interactive target (Enter/Space activates).
import { useNarrow } from '../responsive'
import type { KeyboardEvent, ReactNode } from 'react'
import { FAINT, HAIR, HAIR2, MONO } from '../theme'
import { linScale, stack } from './geometry'
import { useChartTip, ChartTip } from './Tooltip'

export interface BarSeg {
  id: string
  color: string
  value: number
  /** Human name for the accessible label. Without it the label falls back to `id`, which
   *  for a category segment is an opaque record id — a screen reader would read "cat-7f2". */
  name?: string
}

export interface BarGroup {
  key: string
  /** x-axis label; empty string = no label for this group. */
  label: string
  labelEmph?: boolean
  segs: BarSeg[]
  /** Hatch the whole group (partial period). */
  hatched?: boolean
  /** Dashed projection outline from the group's top to this value. */
  projTo?: number
}

export interface BarChartProps {
  width: number
  height: number
  pad?: { l?: number; r?: number; t?: number; b?: number }
  groups: BarGroup[]
  yMax: number
  /** Already formatted/masked. */
  yTicks: { v: number; label: string }[]
  hidden?: ReadonlySet<string>
  /** Dim segments not matching this id (legend hover). */
  hoverId?: string | null
  onSegClick?: (groupKey: string, segId: string) => void
  tipContent?: (group: BarGroup, seg: BarSeg) => ReactNode
  /** Overlay polyline, one value per group index (null skips the point). */
  overlay?: { color: string; values: (number | null)[] }
  /** Dashed vertical separators BEFORE these group indexes (year boundaries). */
  boundaries?: number[]
  /** Extra SVG on top (projection labels etc.). */
  decorate?: (s: { xc: (i: number) => number; y: (v: number) => number; barW: number; plot: { l: number; r: number; t: number; b: number } }) => ReactNode
  ariaLabel: string
}

const SEG_GAP = 1 // px half-gap between stacked segments (2px visual)

export function BarChart(props: BarChartProps) {
  const { width, height, groups, yMax, yTicks, hidden, hoverId, onSegClick, tipContent, overlay, boundaries, decorate, ariaLabel } = props
  const narrow = useNarrow()
  // 54px of axis gutter is a sixth of the plot on a phone. The widest tick is five mono
  // characters ('€7.5k') at 10.5px ≈ 32px, plus the 8px the label is offset from the axis —
  // so 46 clears it and hands the rest back to the data. (40 clipped the leading '€'.)
  const gutter = narrow ? 46 : 54
  const pad = { l: props.pad?.l ?? gutter, r: props.pad?.r ?? 8, t: props.pad?.t ?? 12, b: props.pad?.b ?? 24 }
  const plot = { l: pad.l, r: width - pad.r, t: pad.t, b: height - pad.b }
  const y = linScale([0, Math.max(1, yMax)], [plot.b, plot.t])
  const n = Math.max(1, groups.length)
  const slot = (plot.r - plot.l) / n
  const barW = Math.max(4, Math.min(90, slot * 0.6))
  const xc = (i: number) => plot.l + slot * (i + 0.5)
  const { tip, showAt, hide } = useChartTip()

  const keyActivate = (e: KeyboardEvent<SVGRectElement>, groupKey: string, segId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSegClick?.(groupKey, segId)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
        <defs>
          <pattern id="barhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--warn)" strokeWidth={1} opacity={0.4} />
          </pattern>
        </defs>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={plot.l} x2={plot.r} y1={y(t.v)} y2={y(t.v)} stroke={t.v === 0 ? HAIR : HAIR2} strokeWidth={1} />
            <text x={plot.l - 8} y={y(t.v)} dy={3.5} textAnchor="end" fontFamily={MONO} fontSize={10.5} fill={FAINT}>{t.label}</text>
          </g>
        ))}
        {boundaries?.map((bi) => (
          <line key={`b${bi}`} x1={plot.l + slot * bi} x2={plot.l + slot * bi} y1={plot.t} y2={plot.b} stroke={HAIR} strokeWidth={1} strokeDasharray="2 3" />
        ))}
        {groups.map((g, gi) => {
          const segs = stack(g.segs, hidden)
          const total = segs.length ? segs[segs.length - 1]!.y1 : 0
          const x0 = xc(gi) - barW / 2
          return (
            <g key={g.key}>
              {segs.map((sg, si) => {
                const yTop = y(sg.y1)
                const yBot = y(sg.y0)
                const h0 = yBot - yTop
                // Segment gaps only when there's room — a sliver must stay a
                // visible, clickable ≥1px mark, never get eaten to height 0.
                const gapT = h0 > 6 && si < segs.length - 1 ? SEG_GAP : 0
                const gapB = h0 > 6 && si > 0 ? SEG_GAP : 0
                const h = Math.max(h0 > 0 ? 1.2 : 0, h0 - gapT - gapB)
                const dim = hoverId != null && hoverId !== sg.item.id
                return (
                  <rect
                    key={sg.item.id}
                    data-group={g.key}
                    data-seg={sg.item.id}
                    x={x0}
                    y={yTop + gapT}
                    width={barW}
                    height={h}
                    rx={1.5}
                    fill={sg.item.color}
                    opacity={(g.hatched ? 0.55 : 1) * (dim ? 0.3 : 1)}
                    tabIndex={onSegClick ? 0 : undefined}
                    role={onSegClick ? 'button' : undefined}
                    aria-label={`${g.label || g.key}: ${sg.item.name ?? sg.item.id}`}
                    onClick={() => onSegClick?.(g.key, sg.item.id)}
                    onKeyDown={(e) => keyActivate(e, g.key, sg.item.id)}
                    onPointerMove={(e) => tipContent && showAt(e.clientX, e.clientY, tipContent(g, sg.item))}
                    onPointerLeave={hide}
                    style={{ cursor: onSegClick ? 'pointer' : 'default', outlineOffset: 2 }}
                  />
                )
              })}
              {g.hatched && total > 0 && (
                <rect x={x0} y={y(total)} width={barW} height={Math.max(0, plot.b - y(total))} rx={1.5} fill="url(#barhatch)" pointerEvents="none" />
              )}
              {g.projTo != null && g.projTo > total && (
                <rect x={x0} y={y(g.projTo)} width={barW} height={Math.max(0, y(total) - y(g.projTo))} rx={1.5} fill="none" stroke={FAINT} strokeWidth={1.2} strokeDasharray="3 3" pointerEvents="none" />
              )}
              {g.label && (
                <text x={xc(gi)} y={plot.b + 16} textAnchor="middle" fontFamily={MONO} fontSize={9.5} fill={g.labelEmph ? 'var(--accent)' : FAINT}>{g.label}</text>
              )}
            </g>
          )
        })}
        {overlay && (
          <polyline
            points={overlay.values.map((v, i) => (v == null ? null : `${xc(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ')}
            fill="none"
            stroke={overlay.color}
            strokeWidth={2.4}
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}
        {decorate?.({ xc, y, barW, plot })}
      </svg>
      <ChartTip tip={tip} />
    </div>
  )
}
