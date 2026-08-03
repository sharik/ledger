// Trends (Phase G rework): full-width interactive charts. Yearly + monthly are
// ChartCards (fullscreen-capable) over the shared BarChart, with a toggleable
// legend (hidden categories re-flow the stacks AND the axis), working 18M/All
// window, per-bar tooltips, and drill-to-transactions on every bar segment.
//
// The charts themselves now live in `widgets/TrendsWidgets` so the dashboard can pin any of
// them; what is left here is the screen around them.
import { useNarrow } from './responsive'
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useDerived } from './store'
import { useView } from './view'
import { currentMonthKey } from '../model/selectors'
import { FAINT, HAIR, INK, MUT, SURFACE } from './theme'
import { YearInReview } from './YearInReview'
import { EmptyState } from './kit/EmptyState'
import { ScreenIntro } from './ScreenIntro'
import { DrillTrendWidget, MonthlyTrendWidget, YearlyTrendWidget, useSharedLegend } from './widgets/TrendsWidgets'
import { IncomeSavingsWidget, MomentumWidget, RecurringDigestStrip, SeasonalityCard, TrendHeadlineStrip } from './widgets/InsightWidgets'

export function TrendsScreen() {
  const narrow = useNarrow()
  const d = useDerived()
  const { goTab } = useView()

  const currentYear = Number(currentMonthKey().slice(0, 4))
  const [yirYear, setYirYear] = useState<number | null>(null)
  // Legend state, shared by both bar charts: hidden categories drop out of stacks
  // and axis scaling; hovering a legend item highlights its segments.
  const legend = useSharedLegend()

  const cardStyle: CSSProperties = { background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }

  return (
    <div className="rise" data-screen="trends">
      <div style={narrow ? { marginBottom: 18 } : { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Trends</h1>
          <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>Where the money goes over time — years, months, and down to the merchant.</div>
        </div>
        <button data-testid="year-in-review-btn" onClick={() => setYirYear(currentYear)} style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '8px 13px', background: SURFACE, cursor: 'pointer', whiteSpace: 'nowrap', marginTop: narrow ? 12 : 0 }}>Year in review</button>
      </div>
      {yirYear !== null && <YearInReview year={yirYear} onClose={() => setYirYear(null)} />}
      <ScreenIntro id="trends" />

      {d.monthsTracked.length === 0 && (
        <section style={cardStyle}>
          <EmptyState
            testid="trends-empty"
            dense
            basis="no-data"
            title="No transactions yet."
            body="Trends needs imported statements to show where the money goes over time."
            action={{ label: 'Import a statement', onClick: () => goTab('import') }}
          />
        </section>
      )}

      {/* The charts live in `widgets/` so the dashboard can pin them; the insight surfaces are
          `widgets/InsightWidgets`. The legend state is shared between the two bar charts, as it
          always was: hiding a category in one re-flows the other's stacks and axis too. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }}>
        {d.monthsTracked.length > 0 && <TrendHeadlineStrip />}
        <YearlyTrendWidget params={{}} shared={legend} />
        <MonthlyTrendWidget params={{}} shared={legend} />
        <MomentumWidget params={{}} />
        <IncomeSavingsWidget params={{}} />
        <SeasonalityCard params={{}} />
        <RecurringDigestStrip />
      </div>

      <DrillTrendWidget params={{}} />
    </div>
  )
}
