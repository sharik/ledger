// The ‹ month › stepper, and the guard that keeps it out of the future.
//
// Lifted from `PlanScreen`, which grew it first (Q121 — "did I stay in budget last month?"). The
// Dashboard needs the same control, and two hand-rolled copies of "never the future" would drift:
// that rule is a correctness invariant, not styling. A period that has not happened has no spend
// in it, and a hand-edited hash must not be able to produce one.
//
// Plan renders it without `onGranChange`, which is what keeps its look unchanged — no toggle.
import { addMonths, currentMonthKey } from '../../model/selectors'
import type { MonthKey } from '../../model/types'
import { ACCENT, FAINT, HAIR, INK, MONO, MUT, SURFACE } from '../theme'

export type Gran = 'month' | 'year'

/** '2026-03' | '2026' — a month key or a bare year, the two shapes the route carries. */
export type PeriodValue = string

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const granOf = (v: PeriodValue): Gran => (v.length === 4 ? 'year' : 'month')

/**
 * A period from the route, or `null` when there is nothing usable there.
 *
 * One param carries both shapes ('2026-03' and '2026') so granularity is derived from the string
 * rather than stored beside it — two fields could disagree, and then something has to decide which
 * one wins. Never the future, in either granularity.
 */
export function readPeriodParam(raw: string | undefined, thisMonth: MonthKey = currentMonthKey()): PeriodValue | null {
  if (!raw) return null
  if (/^\d{4}$/.test(raw)) return raw <= thisMonth.slice(0, 4) ? raw : null
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const mo = Number(raw.slice(5, 7))
    if (mo < 1 || mo > 12) return null
    return raw <= thisMonth ? raw : null
  }
  return null
}

/** The current period at a given granularity — what "Today" steps back to, and the forward stop. */
export function currentPeriod(gran: Gran, thisMonth: MonthKey = currentMonthKey()): PeriodValue {
  return gran === 'year' ? thisMonth.slice(0, 4) : thisMonth
}

/** Step by one unit of the value's own granularity. */
export function stepPeriod(v: PeriodValue, n: number): PeriodValue {
  return granOf(v) === 'year' ? String(Number(v) + n) : addMonths(v, n)
}

/**
 * Switch granularity without losing where you were: a month keeps its year, a year drops to its
 * last elapsed month (its December, or this month when it is the current year).
 */
export function withGran(v: PeriodValue, gran: Gran, thisMonth: MonthKey = currentMonthKey()): PeriodValue {
  if (granOf(v) === gran) return v
  if (gran === 'year') return v.slice(0, 4)
  const yr = v.slice(0, 4)
  return yr === thisMonth.slice(0, 4) ? thisMonth : `${yr}-12`
}

/**
 * The label. A month says its year only when it is not this one — inside the current year the
 * year says nothing, and the screen's own heading already names the screen.
 */
export function periodLabelOf(v: PeriodValue, thisMonth: MonthKey = currentMonthKey()): string {
  if (granOf(v) === 'year') return v
  const idx = Number(v.slice(5, 7)) - 1
  return `${MONTHS_FULL[idx]}${v.slice(0, 4) === thisMonth.slice(0, 4) ? '' : ` ${v.slice(0, 4)}`}`
}

const stepBtn: React.CSSProperties = { fontFamily: MONO, fontSize: 14, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px', lineHeight: 1 }
// A chip, not a bare text link: it sits inside the stepper cluster, and styled like the screen's
// other action links it read as one more unrelated verb in the header instead of "go back".
const todayBtn: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  letterSpacing: '0.05em',
  color: ACCENT,
  fontWeight: 500,
  background: 'none',
  border: `1px solid ${HAIR}`,
  borderRadius: 999,
  padding: '3px 10px',
  cursor: 'pointer',
  marginLeft: 2,
}

export function PeriodStepper({
  value,
  onChange,
  onGranChange,
  testidPrefix,
  narrow = false,
  thisMonth = currentMonthKey(),
}: {
  value: PeriodValue
  onChange: (v: PeriodValue) => void
  /** Omit to render no granularity toggle — the shape Plan uses. */
  onGranChange?: (g: Gran) => void
  testidPrefix: string
  narrow?: boolean
  thisMonth?: MonthKey
}) {
  const gran = granOf(value)
  const isCurrent = value === currentPeriod(gran, thisMonth)
  const unit = gran === 'year' ? 'year' : 'month'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        data-testid={`${testidPrefix}-prev-month`}
        onClick={() => onChange(stepPeriod(value, -1))}
        title={`Previous ${unit}`}
        aria-label={`Previous ${unit}`}
        style={stepBtn}
      >
        ‹
      </button>
      {/* Fixed width, centred: the label grows by a year when you step out of this one, and
          arrows that shuffle sideways as you use them are hard to click twice. */}
      <div data-testid={`${testidPrefix}-month`} style={{ fontSize: 15, fontWeight: 600, color: INK, minWidth: narrow ? 0 : 112, textAlign: 'center' }}>
        {periodLabelOf(value, thisMonth)}
      </div>
      <button
        data-testid={`${testidPrefix}-next-month`}
        onClick={() => onChange(stepPeriod(value, 1))}
        disabled={isCurrent}
        title={isCurrent ? `This is the current ${unit}` : `Next ${unit}`}
        aria-label={`Next ${unit}`}
        style={{ ...stepBtn, color: isCurrent ? HAIR : FAINT, cursor: isCurrent ? 'default' : 'pointer' }}
      >
        ›
      </button>
      {!isCurrent && (
        <button
          data-testid={`${testidPrefix}-this-month`}
          onClick={() => onChange(currentPeriod(gran, thisMonth))}
          title={`Back to the current ${unit}`}
          style={todayBtn}
        >
          ↩ today
        </button>
      )}
      {onGranChange && (
        <div data-testid={`${testidPrefix}-gran`} style={{ display: 'inline-flex', border: `1px solid ${HAIR}`, borderRadius: 999, padding: 2, marginLeft: 4 }}>
          {(['month', 'year'] as const).map((g) => {
            const on = g === gran
            return (
              <button
                key={g}
                aria-pressed={on}
                onClick={() => onGranChange(g)}
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
                {g === 'month' ? 'Month' : 'Year'}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
