// Plan cards that the dashboard can also show.
//
// Lifted verbatim out of `PlanScreen`. The one structural difference is chrome: on Plan the card
// border comes from `PlanCard`, on the dashboard from the tile — so the widget draws its own only
// when it is a tile, and otherwise renders bare content into whatever wraps it.
import { emergencyFundMonths, savingsRate } from '../../model/selectors'
import { useDerived, useStoreState } from '../store'
import { useAnchorMonth } from '../dashPeriod'
import { FAINT, HAIR, INK, MONO, MUT, SURFACE } from '../theme'
import { PinButton } from './PinButton'
import type { WidgetChrome } from './AccountsWidgets'

/**
 * BRIEF §9 rules-of-thumb reference lines — optional, off by default. Neutral copy,
 * derived only: housing < 30% of income, savings ≥ target, emergency fund ≥ target.
 */
export function RulesOfThumb({ tile, controls }: WidgetChrome) {
  const { vault } = useStoreState()
  const d = useDerived()
  const cm = useAnchorMonth()
  const flow = d.flowByMonth.get(cm) ?? { income: 0, expense: 0 }
  const housingId = d.catIdByRole.get('housing')
  const housing = housingId ? d.spentByCatMonth.get(`${cm}|${housingId}`) ?? 0 : 0
  const housingRatio = flow.income > 0 ? (housing / flow.income) * 100 : 0
  const sr = savingsRate(d, cm)
  const ef = emergencyFundMonths(d)
  const srTarget = vault.params.srTarget || 20
  const efTarget = vault.params.efTarget || 6

  const lines: { label: string; value: string; ok: boolean; ref: string }[] = [
    // No income recorded means no ratio exists — not a ratio of zero. Both of these divide by
    // income, and a "0% of income" or a "−74%" printed with no basis reads as a measurement.
    {
      label: 'Housing',
      value: flow.income > 0 ? `${housingRatio.toFixed(0)}% of income` : 'no income recorded that month',
      ok: flow.income > 0 && housingRatio <= 30,
      ref: 'rule of thumb: under 30%',
    },
    {
      label: 'Savings rate',
      value: flow.income > 0 ? `${sr.toFixed(0)}%` : 'no income recorded that month',
      ok: flow.income > 0 && sr >= srTarget,
      ref: flow.income > 0 && sr < 0 ? `target ≥ ${srTarget}% · spending exceeded income` : `target ≥ ${srTarget}%`,
    },
    // The two rows above move with the anchored month; this one cannot. It divides TODAY's liquid
    // balance by a trailing average, and there is no historical liquid balance to divide instead —
    // so it says which basis it used rather than silently sitting on "now" beside two rows that
    // moved (`emergencyFundMonths` reads `d.liquid`, an Account.balance fact about the present).
    {
      label: 'Emergency fund',
      value: ef === null ? 'no expense history yet' : `${ef.toFixed(1)} months`,
      ok: ef !== null && ef >= efTarget,
      ref: `target ≥ ${efTarget} months · liquid balance today`,
    },
  ]

  // A card of its own now (#Plan-4), so it carries no top rule of its own — it used to be a block
  // appended inside the budgets card, which is why it could be neither moved nor collapsed.
  const body = (
    <div data-testid={tile ? undefined : 'rules-of-thumb'}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>RULES OF THUMB</div>
        {tile ? controls : <PinButton widget="plan.rules" params={{}} />}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((l) => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
            <span style={{ color: INK, fontWeight: 500, width: 130 }}>{l.label}</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: l.ok ? 'var(--pos)' : MUT }}>{l.value}</span>
            <span style={{ fontSize: 11, color: FAINT, flex: 1, textAlign: 'right' }}>{l.ref}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: FAINT, marginTop: 8 }}>Reference lines only — never a judgment. Toggle in Settings.</div>
    </div>
  )

  if (!tile) return body
  return <section style={{ flex: 1, minWidth: 0, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 22px' }}>{body}</section>
}
