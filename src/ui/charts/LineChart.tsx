// LineChart (Phase G): width-aware line/area chart with the shared crosshair
// tooltip. Renders at real pixel dimensions (never viewBox-scaled), so the same
// component is legible in a card and in fullscreen. Custom annotations (gap
// bands, projections, end labels) render through the `decorate` scale hook.
import { useNarrow } from '../responsive'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { FAINT, HAIR, HAIR2, MONO, SURFACE } from '../theme'
import { linScale, type Scale } from './geometry'

export interface LineSeries {
  id: string
  color: string
  points: { x: number; y: number }[]
  strokeWidth?: number
  dash?: string
  /** Fill to the baseline under this series. */
  area?: boolean
  opacity?: number
}

export interface LineScales {
  x: Scale
  y: Scale
  plot: { l: number; r: number; t: number; b: number }
}

export interface LineChartProps {
  width: number
  height: number
  pad?: { l?: number; r?: number; t?: number; b?: number }
  series: LineSeries[]
  xDomain: [number, number]
  yDomain: [number, number]
  /** Already-formatted (blur-masked) tick labels. */
  yTicks?: { v: number; label: string }[]
  xTicks?: { v: number; label: string; emph?: boolean }[]
  /** x values the crosshair snaps to; enables the hover layer. */
  snapXs?: number[]
  /** Tooltip content for a snapped x (null → no tip at that x). */
  tipContent?: (x: number) => ReactNode
  /**
   * Plain-text mirror of `tipContent`, announced in an aria-live region as the keyboard
   * moves the crosshair. Separate because a ReactNode cannot be flattened reliably, and a
   * screen reader needs a sentence, not a layout.
   */
  liveText?: (x: number) => string | null
  onXClick?: (x: number) => void
  /** End-point dots: [seriesIdx, x, y, emphasized] */
  dots?: { x: number; y: number; color: string; open?: boolean }[]
  /** Extra SVG rendered with the scales (annotations, bands, end labels). */
  decorate?: (s: LineScales) => ReactNode
  ariaLabel: string
}

export function LineChart(props: LineChartProps) {
  const { width, height, series, xDomain, yDomain, yTicks = [], xTicks = [], snapXs, tipContent, liveText, onXClick, dots = [], decorate, ariaLabel } = props
  const narrow = useNarrow()
  // 54px of axis gutter is a sixth of the plot on a phone. The widest tick is five mono
  // characters ('€7.5k') at 10.5px ≈ 32px, plus the 8px the label is offset from the axis —
  // so 46 clears it and hands the rest back to the data. (40 clipped the leading '€'.)
  const gutter = narrow ? 46 : 54
  const pad = { l: props.pad?.l ?? gutter, r: props.pad?.r ?? 10, t: props.pad?.t ?? 12, b: props.pad?.b ?? 24 }
  const plot = { l: pad.l, r: width - pad.r, t: pad.t, b: height - pad.b }
  const x = linScale(xDomain, [plot.l, plot.r])
  const y = linScale(yDomain, [plot.b, plot.t])
  const [hoverX, setHoverX] = useState<number | null>(null)

  const toPts = (s: LineSeries) => s.points.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const toArea = (s: LineSeries) => {
    if (s.points.length === 0) return ''
    const line = s.points.map((p) => `${x(p.x).toFixed(1)} ${y(p.y).toFixed(1)}`).join(' L')
    const x0 = x(s.points[0]!.x).toFixed(1)
    const x1 = x(s.points[s.points.length - 1]!.x).toFixed(1)
    return `M${x0} ${y(yDomain[0]).toFixed(1)} L${line} L${x1} ${y(yDomain[0]).toFixed(1)} Z`
  }

  const handleMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!snapXs || snapXs.length === 0) return
    const svg = (e.target as SVGRectElement).ownerSVGElement!
    const rect = svg.getBoundingClientRect()
    const pxX = ((e.clientX - rect.left) / rect.width) * width
    const dataX = x.domain[0] + ((pxX - plot.l) / (plot.r - plot.l)) * (x.domain[1] - x.domain[0])
    let best = snapXs[0]!
    for (const s of snapXs) if (Math.abs(s - dataX) < Math.abs(best - dataX)) best = s
    setHoverX(best)
  }

  const hoverTip = hoverX !== null && tipContent ? tipContent(hoverX) : null

  /**
   * Keyboard path to the crosshair. The tooltip already renders from `hoverX`, so stepping
   * that value is the whole feature — arrows move one snap point, Home/End jump to the ends,
   * Escape clears. Without this the line charts were pointer-only: a keyboard user could
   * reach the expand button but never read a single day's figure.
   */
  const stepHover = (dir: -1 | 1 | 'first' | 'last') => {
    if (!snapXs || snapXs.length === 0) return
    if (dir === 'first') return setHoverX(snapXs[0]!)
    if (dir === 'last') return setHoverX(snapXs[snapXs.length - 1]!)
    const i = hoverX === null ? -1 : snapXs.indexOf(hoverX)
    const next = i < 0 ? (dir === 1 ? 0 : snapXs.length - 1) : Math.min(snapXs.length - 1, Math.max(0, i + dir))
    setHoverX(snapXs[next]!)
  }

  const onKey = (e: React.KeyboardEvent<SVGRectElement>) => {
    const k = e.key
    if (k === 'ArrowRight') stepHover(1)
    else if (k === 'ArrowLeft') stepHover(-1)
    else if (k === 'Home') stepHover('first')
    else if (k === 'End') stepHover('last')
    else if (k === 'Escape') setHoverX(null)
    else if ((k === 'Enter' || k === ' ') && hoverX !== null && onXClick) onXClick(hoverX)
    else return
    e.preventDefault()
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} style={{ display: 'block' }}>
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={plot.l} x2={plot.r} y1={y(t.v)} y2={y(t.v)} stroke={t.v === yDomain[0] ? HAIR : HAIR2} strokeWidth={1} />
            <text x={plot.l - 8} y={y(t.v)} dy={3.5} textAnchor="end" fontFamily={MONO} fontSize={10.5} fill={FAINT}>
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={x(t.v)} y={plot.b + 16} textAnchor="middle" fontFamily={MONO} fontSize={10} fill={t.emph ? 'var(--accent)' : FAINT}>
            {t.label}
          </text>
        ))}
        {series.map((s) =>
          s.area ? <path key={`a-${s.id}`} d={toArea(s)} fill={s.color} opacity={0.07} /> : null,
        )}
        {series.map((s) => (
          <polyline
            key={s.id}
            points={toPts(s)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.strokeWidth ?? 2}
            strokeDasharray={s.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={s.opacity ?? 1}
          />
        ))}
        {decorate?.({ x, y, plot })}
        {dots.map((d, i) => (
          <circle key={i} cx={x(d.x)} cy={y(d.y)} r={d.open ? 3.2 : 3.4} fill={d.open ? SURFACE : d.color} stroke={d.color} strokeWidth={d.open ? 1.8 : 0} />
        ))}
        {hoverX !== null && (
          <line x1={x(hoverX)} x2={x(hoverX)} y1={plot.t} y2={plot.b} stroke={FAINT} strokeWidth={1} strokeDasharray="2 2" />
        )}
        {snapXs && snapXs.length > 0 && (
          <rect
            x={plot.l}
            y={plot.t}
            width={Math.max(0, plot.r - plot.l)}
            height={Math.max(0, plot.b - plot.t)}
            fill="transparent"
            onPointerMove={handleMove}
            onPointerDown={handleMove}
            onPointerLeave={() => setHoverX(null)}
            onClick={() => hoverX !== null && onXClick?.(hoverX)}
            onKeyDown={onKey}
            onBlur={() => setHoverX(null)}
            tabIndex={0}
            role="application"
            aria-label={`${ariaLabel}. Use the arrow keys to read individual points.`}
            // `pan-y`, not `none`. This rect covers the whole plot, and on a phone the plot is a
            // large share of the screen — with `none` the browser hands us every gesture that
            // starts here, so a finger landing on the chart could not scroll the page at all.
            // `pan-y` gives vertical scrolling back to the browser and keeps horizontal
            // movement for scrubbing, which is the only axis this crosshair reads.
            style={{ cursor: onXClick ? 'pointer' : 'crosshair', touchAction: 'pan-y' }}
          />
        )}
      </svg>
      <div data-testid="chart-live" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {hoverX !== null && liveText ? liveText(hoverX) : ''}
      </div>
      {hoverTip !== null && hoverX !== null && (
        <div
          data-testid="chart-tip"
          style={{
            position: 'absolute',
            left: `${(x(hoverX) / width) * 100}%`,
            top: -4,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            background: 'var(--ink)',
            color: 'var(--bg)',
            borderRadius: 5,
            padding: '7px 10px',
            fontFamily: MONO,
            fontSize: 10.5,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
            zIndex: 5,
          }}
        >
          {hoverTip}
        </div>
      )}
    </div>
  )
}
