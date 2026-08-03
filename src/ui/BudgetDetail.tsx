// What a budget has done over time — the panel behind a budget row's disclosure.
//
// `budgetHistory`/`budgetPace` were computed and never rendered (flagged P2 in the comprehension
// audit), and TECH-SPEC §7.4 asked for "6-month mini bars from derived history + dashed budget
// line" that never shipped. This is that, generalised: months for a monthly budget, calendar
// years for an annual one, measured through `budgetScopeSpent` so the panel and the row's bar
// are produced by one arithmetic and cannot disagree.
import { budgetPeriodHistory, isMonthlyScope, scopeTrailingAvg } from '../analytics/budgets'
import type { Budget } from '../model/types'
import { budgetCategoryIds } from '../model/types'
import { useDerived, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { BarChart, niceTicks, useMeasuredWidth } from './charts'
import { BRICK, FAINT, INK, MONO, MUT, fmt } from './theme'

/** A monthly budget shows a year; an annual one shows the years the vault actually has. */
const MONTHLY_PERIODS = 12
const ANNUAL_PERIODS = 4

export function BudgetDetail({
  budget,
  mk,
  onDrillPeriod,
  onDrillCategory,
  onUseAmount,
}: {
  budget: Budget
  mk: string
  /** A bar click opens that period's transactions. */
  onDrillPeriod: (periodKey: string) => void
  /** A multi-category budget cannot drill as a whole, so its members drill one at a time. */
  onDrillCategory: (categoryId: string) => void
  /** Fill the edit dialog's amount with a suggestion. */
  onUseAmount?: (amount: number) => void
}) {
  const { vault } = useStoreState()
  const d = useDerived()
  const rb = useRateBook()
  const [ref, width] = useMeasuredWidth()

  const monthly = isMonthlyScope(budget)
  const history = budgetPeriodHistory(vault, budget, mk, monthly ? MONTHLY_PERIODS : ANNUAL_PERIODS, rb)
  const avg3 = scopeTrailingAvg(vault, budget, 3, mk, rb)
  const avg6 = scopeTrailingAvg(vault, budget, 6, mk, rb)
  const members = budgetCategoryIds(budget)
  const isGroup = budget.scope?.kind === 'group'

  const yMax = Math.max(budget.amount, ...history.map((p) => p.spent), 1)
  const { top, ticks } = niceTicks(yMax)

  return (
    <div data-testid="budget-detail" style={{ padding: '4px 0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {history.length === 0 ? (
        // A per-trip budget covers one span, not a series. Drawing a trend through a single
        // point would be inventing a shape the data does not have.
        <div style={{ fontSize: 12, color: FAINT }}>
          A per-trip budget covers one stretch of time rather than a repeating period, so there is no history to
          chart. Its bar above already counts the whole trip.
        </div>
      ) : (
        <>
          <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em' }}>
            {monthly ? `LAST ${MONTHLY_PERIODS} MONTHS` : `LAST ${ANNUAL_PERIODS} YEARS`} · BAR = SPENT · LINE = THIS BUDGET
          </div>
          <div ref={ref}>
            {width > 0 && (
              <BarChart
                width={width}
                height={150}
                pad={{ l: 46, r: 10, t: 8, b: 20 }}
                groups={history.map((p) => ({
                  key: p.key,
                  label: p.label,
                  labelEmph: p.key === mk || p.key === mk.slice(0, 4),
                  // The current period is still partial — hatched, as everywhere else in the app.
                  hatched: p.key === mk || p.key === mk.slice(0, 4),
                  segs: [{ id: 'spent', name: 'spent', color: p.spent > p.budget ? BRICK : 'var(--accent)', value: p.spent }],
                }))}
                yMax={top}
                yTicks={ticks.map((v) => ({ v, label: fmt(v) }))}
                overlay={{ color: 'var(--ink2)', values: history.map(() => budget.amount) }}
                onSegClick={(groupKey) => onDrillPeriod(groupKey)}
                tipContent={(g, s) => `${g.label} · ${fmt(s.value)} of ${fmt(budget.amount)}`}
                ariaLabel={`Spend against this budget over the last ${history.length} ${monthly ? 'months' : 'years'}`}
              />
            )}
          </div>
          <div style={{ fontSize: 11, color: FAINT }}>
            {history.filter((p) => p.spent > p.budget).length} of {history.length} over. The newest bar is hatched
            because that period is not finished.
          </div>
        </>
      )}

      {/* Q120, "what should this budget be?" — the app's own arithmetic, one tap away, and the
          number is never presented as a recommendation. */}
      {(avg3 !== null || avg6 !== null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: MUT }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em' }}>TYPICAL</span>
          {avg3 !== null && <Suggest label={`3-month average ${fmt(avg3)}`} amount={avg3} onUse={onUseAmount} />}
          {avg6 !== null && <Suggest label={`6-month average ${fmt(avg6)}`} amount={avg6} onUse={onUseAmount} />}
          <span style={{ fontSize: 11, color: FAINT }}>complete months only — the number is yours to choose</span>
        </div>
      )}

      {isGroup && members.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em' }}>CATEGORIES IN THIS BUDGET</div>
          {members.map((id) => {
            const c = d.catById.get(id)
            return (
              <button
                key={id}
                data-testid="budget-member"
                onClick={() => onDrillCategory(id)}
                title={`Open ${c?.name ?? '—'} →`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', textAlign: 'left', fontSize: 12.5, color: INK }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 2, background: c?.color ?? 'var(--c-other)', flex: 'none' }} />
                {c?.name ?? '—'}
                <span style={{ color: FAINT, fontSize: 11 }}>→</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Suggest({ label, amount, onUse }: { label: string; amount: number; onUse?: (n: number) => void }) {
  if (!onUse) return <span style={{ fontFamily: MONO, fontSize: 11.5, color: MUT }}>{label}</span>
  return (
    <button
      data-testid="budget-suggest"
      onClick={() => onUse(amount)}
      title="Use this as the budget amount"
      style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
    >
      {label}
    </button>
  )
}
