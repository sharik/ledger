// Stand up a budget set from history in one sitting ("From history", Plan screen).
//
// The engine proposes, this dialog lets the user dispose: every row is prefilled from what the
// category actually cost, every amount is editable, every row can be left out — and every row
// can be SWITCHED between /mo, /qr, /half and /yr, showing the real suggested figure for each
// period (the monthly one is the exact number BudgetDialog's own 6-month chip states; the
// coarser ones are run rates over the scanned complete months). The default period is the
// rhythm the engine detected — insurance paid quarterly lands as a quarterly budget. Apply
// lands the whole set as ONE batch op — one toast, one undo. Nothing is stored until Apply;
// closing forgets.
//
// The overlay mechanics (portal, Escape, focus restore) are BudgetDialog's, which took them
// from ChartCard's fullscreen dialog.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { proposeBudgets, proposalProbe, proposalFigure, type BudgetProposal } from '../analytics/budgetPropose'
import { PERIOD_MONTHS, type BudgetPeriod } from '../analytics/budgets'
import type { Op } from '../model/mutations'
import { budgetKey } from '../model/types'
import { currentMonthKey } from '../model/selectors'
import { useDerived, useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useAssistantOptional } from './assistant/ctx'
import { BudgetDialogTabs } from './BudgetDialog'
import { BG, FAINT, HAIR, INK, MONO, MUT, SURFACE, SURFACE2, fmt } from './theme'

const inputStyle = { fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK }

const CADENCE_WORD = {
  monthly: 'monthly', // never rendered — steady rows caption with the average instead
  quarterly: 'about quarterly',
  semiannual: 'about twice a year',
  yearly: 'about yearly',
} as const

const PERIOD_SHORT: Record<BudgetPeriod, string> = { month: 'mo', quarter: 'qr', half: 'half', year: 'yr' }
const PERIOD_WORD: Record<BudgetPeriod, string> = { month: 'monthly', quarter: 'quarterly', half: 'half-yearly', year: 'yearly' }
const ALL_PERIODS: BudgetPeriod[] = ['month', 'quarter', 'half', 'year']

interface RowState {
  on: boolean
  period: BudgetPeriod
  amount: string
}

/** The suggested figure for a proposal at a period — what the amount field resets to on switch. */
const suggestedAt = (p: BudgetProposal, period: BudgetPeriod): number | null => proposalFigure(p, period)

/** The op a reviewed row commits — the same shapes BudgetDialog saves, minted in bulk. */
function toAddBudgetOp(p: BudgetProposal, period: BudgetPeriod, amount: number): Op {
  if (period === 'month') return { kind: 'addBudget', categoryId: p.categoryId, amount }
  return {
    kind: 'addBudget',
    categoryId: p.categoryId,
    amount,
    scope: { kind: 'category-period', categoryId: p.categoryId, period },
  }
}

export function BudgetSetupDialog({ onClose, onOneBudget }: {
  onClose: () => void
  /** Swap back to the single-budget form — the other tab of the same "add budgets" surface. */
  onOneBudget?: () => void
}) {
  const store = useStore()
  const { vault } = useStoreState()
  const d = useDerived()
  const rb = useRateBook()
  const assistant = useAssistantOptional()
  const cm = currentMonthKey()

  // Computed ONCE on open — the review is a stable worksheet, not a live preview. A sync merge
  // landing mid-review must not reshuffle rows under the user's cursor; Apply re-checks against
  // the vault of that moment instead.
  const [result] = useState(() => proposeBudgets(d, cm, rb))

  // Nothing is pre-chosen: a suggestion is an offer, and choosing is the user's gesture. Each
  // row's ADD toggles it into the set; "Add all" covers the bulk case.
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      result.proposals.map((p) => [p.categoryId, { on: false, period: p.period, amount: String(suggestedAt(p, p.period)) }]),
    ),
  )
  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows((cur) => ({ ...cur, [id]: { ...cur[id]!, ...patch } }))
  const setAll = (on: boolean) =>
    setRows((cur) => Object.fromEntries(Object.entries(cur).map(([id, r]) => [id, { ...r, on }])))
  const switchPeriod = (p: BudgetProposal, period: BudgetPeriod) => {
    // Switching resets the amount to that period's suggestion — the point of the switch is to
    // SEE the other period's number, and a stale hand-edit would silently masquerade as it.
    setRow(p.categoryId, { period, amount: String(suggestedAt(p, period)) })
  }

  const openerRef = useRef<Element | null>(null)
  useEffect(() => {
    openerRef.current = document.activeElement
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      ;(openerRef.current as HTMLElement | null)?.focus?.()
    }
  }, [onClose])

  // Which period is unavailable per category: no figure to suggest, or that exact budget
  // already exists (its key is taken, and applying would be tombstoned by the next merge).
  const takenNow = new Set(vault.budgets.map(budgetKey))
  const periodBlocked = (p: BudgetProposal, period: BudgetPeriod): string | null => {
    if (suggestedAt(p, period) == null)
      return period === 'month'
        ? 'Nothing to average in the last 6 months'
        : period === 'quarter'
          ? 'Needs at least 6 complete months'
          : 'Needs a full year of complete months'
    if (takenNow.has(budgetKey(proposalProbe({ categoryId: p.categoryId, period }))))
      return `Already has a ${PERIOD_WORD[period]} budget`
    return null
  }

  const included = result.proposals.filter((p) => rows[p.categoryId]?.on)
  const amountOf = (p: BudgetProposal) => Number(rows[p.categoryId]?.amount)
  const amountOk = (p: BudgetProposal) => {
    const raw = rows[p.categoryId]?.amount ?? ''
    const n = Number(raw)
    return raw.trim() !== '' && Number.isFinite(n) && n >= 0
  }
  const problem =
    included.length === 0
      ? 'Add at least one budget first.'
      : included.some((p) => !amountOk(p))
        ? 'Enter an amount for every added budget (0 is allowed — it tracks the category without a limit).'
        : null

  const periodOf = (p: BudgetProposal): BudgetPeriod => rows[p.categoryId]?.period ?? p.period
  const totalAt = (period: BudgetPeriod) =>
    included.filter((p) => periodOf(p) === period && amountOk(p)).reduce((a, p) => a + amountOf(p), 0)

  const apply = () => {
    if (problem) return
    // Re-check against the CURRENT vault: a sync merge or an assistant approval may have added
    // budgets while this dialog sat open, and a clash would be tombstoned by the next merge.
    const taken = new Set(vault.budgets.map(budgetKey))
    const ops = included
      .filter((p) => !taken.has(budgetKey(proposalProbe({ categoryId: p.categoryId, period: periodOf(p) }))))
      .map((p) => toAddBudgetOp(p, periodOf(p), amountOf(p)))
    if (ops.length > 0) {
      store.commit({ kind: 'batch', ops }, { msg: `${ops.length} budget${ops.length === 1 ? '' : 's'} added`, undoable: true })
    }
    onClose()
  }

  const catName = (id: string) => d.catById.get(id)?.name ?? '—'
  const namesFor = (reason: 'already-budgeted' | 'irregular') =>
    result.skipped.filter((s) => s.reason === reason).map((s) => catName(s.categoryId))
  const alreadyNames = namesFor('already-budgeted')
  const irregularNames = namesFor('irregular')

  const body =
    result.basis !== 'ok' ? (
      <div data-testid="budget-setup-empty" data-basis={result.basis} style={{ fontSize: 12.5, color: MUT, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '14px 16px', lineHeight: 1.6 }}>
        Not enough complete months of data to suggest budgets yet — suggestions need at least three
        full months of transactions before the current one. Import more history, or add budgets one
        at a time with “+ Budget”.
      </div>
    ) : result.proposals.length === 0 ? (
      <div data-testid="budget-setup-empty" data-basis={result.basis} style={{ fontSize: 12.5, color: MUT, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '14px 16px', lineHeight: 1.6 }}>
        Every category with enough history already has a budget — there is nothing new to suggest.
      </div>
    ) : (
      <>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
            {included.length} of {result.proposals.length} chosen
          </span>
          <span style={{ display: 'flex', gap: 14 }}>
            <button
              data-testid="budget-setup-add-all"
              onClick={() => setAll(true)}
              style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              Add all
            </button>
            {included.length > 0 && (
              <button
                data-testid="budget-setup-clear"
                onClick={() => setAll(false)}
                style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                Clear
              </button>
            )}
          </span>
        </div>
        <div style={{ border: `1px solid ${HAIR}`, borderRadius: 6, background: SURFACE }}>
          {result.proposals.map((p, i) => {
            const row = rows[p.categoryId]!
            const cat = d.catById.get(p.categoryId)
            // The /mo equivalent reads off the row's LIVE amount (edits update it), never
            // p.monthly — that is an independent 6-month mean, not the total ÷ N.
            const perMonth =
              row.period !== 'month' && amountOk(p) && Number(row.amount) > 0
                ? ` · ≈ ${fmt(Number(row.amount) / PERIOD_MONTHS[row.period])}/mo`
                : ''
            const caption =
              row.period === 'month'
                ? `6-month average · spend in ${p.monthsWithSpend} of ${result.monthsCovered} months`
                : p.mixed
                  ? `steady base + ${CADENCE_WORD[p.cadence]} lumps · suggested per ${PERIOD_WORD[row.period]}${perMonth}`
                  : `paid ${CADENCE_WORD[p.cadence]} · suggested per ${PERIOD_WORD[row.period]}${perMonth}`
            return (
              <div
                key={p.categoryId}
                data-testid="budget-setup-row"
                data-period={row.period}
                data-cat={catName(p.categoryId)}
                data-on={row.on ? '1' : '0'}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: i === 0 ? 'none' : `1px solid ${HAIR}`, background: row.on ? SURFACE2 : undefined }}
              >
                <button
                  data-testid="budget-setup-add"
                  aria-pressed={row.on}
                  onClick={() => setRow(p.categoryId, { on: !row.on })}
                  aria-label={row.on ? `Remove ${catName(p.categoryId)} from the set` : `Add ${catName(p.categoryId)}`}
                  style={{
                    flex: 'none',
                    width: 68,
                    fontSize: 11.5,
                    fontWeight: 500,
                    padding: '5px 0',
                    borderRadius: 5,
                    border: `1px solid ${row.on ? 'var(--accent)' : HAIR}`,
                    background: row.on ? 'var(--accent)' : SURFACE,
                    color: row.on ? 'var(--on-accent)' : 'var(--accent)',
                    cursor: 'pointer',
                  }}
                >
                  {row.on ? 'Added ✓' : '+ Add'}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: INK }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: cat?.color ?? 'var(--c-other)', flex: 'none' }} />
                    {catName(p.categoryId)}
                  </div>
                  <div style={{ fontSize: 11, color: FAINT, marginTop: 3 }}>
                    {caption}
                    {row.period === 'month' && p.median != null && (
                      <>
                        {' · '}
                        <button
                          data-testid="budget-setup-median"
                          onClick={() => setRow(p.categoryId, { amount: String(p.median) })}
                          aria-label="Use the median instead"
                          style={{ fontFamily: MONO, fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                        >
                          12-month median {fmt(p.median)}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                  <input
                    data-testid="budget-setup-amount"
                    value={row.amount}
                    onChange={(e) => setRow(p.categoryId, { amount: e.target.value })}
                    aria-label={`Amount for ${catName(p.categoryId)}`}
                    style={{ ...inputStyle, width: 90, fontFamily: MONO, textAlign: 'right' as const }}
                  />
                  <span style={{ display: 'inline-flex', border: `1px solid ${HAIR}`, borderRadius: 5, overflow: 'hidden' }}>
                    {ALL_PERIODS.map((k) => {
                      const blocked = periodBlocked(p, k)
                      const active = row.period === k
                      return (
                        <button
                          key={k}
                          data-testid="budget-setup-period"
                          data-period={k}
                          aria-pressed={active}
                          disabled={blocked != null}
                          title={blocked ?? `Suggested: ${fmt(suggestedAt(p, k) ?? 0)}/${PERIOD_SHORT[k]}`}
                          onClick={() => !active && switchPeriod(p, k)}
                          style={{
                            fontFamily: MONO,
                            fontSize: 10.5,
                            padding: '5px 8px',
                            border: 'none',
                            cursor: blocked != null ? 'not-allowed' : 'pointer',
                            background: active ? INK : SURFACE,
                            color: blocked != null ? HAIR : active ? SURFACE : MUT,
                          }}
                        >
                          /{PERIOD_SHORT[k]}
                        </button>
                      )
                    })}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {(alreadyNames.length > 0 || irregularNames.length > 0) && (
          <div data-testid="budget-setup-skipped" style={{ fontSize: 11.5, color: FAINT, marginTop: 10, lineHeight: 1.6 }}>
            {alreadyNames.length > 0 && <>Already budgeted: {alreadyNames.join(', ')}</>}
            {alreadyNames.length > 0 && irregularNames.length > 0 && ' · '}
            {irregularNames.length > 0 && <>No steady rhythm to suggest from: {irregularNames.join(', ')}</>}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 18 }}>
          <button
            data-testid="budget-setup-apply"
            onClick={apply}
            disabled={!!problem}
            style={{
              fontSize: 12.5,
              color: 'var(--on-accent)',
              background: problem ? 'var(--ink3)' : 'var(--accent)',
              padding: '9px 16px',
              borderRadius: 5,
              fontWeight: 500,
              border: 'none',
              cursor: problem ? 'not-allowed' : 'pointer',
            }}
          >
            Add {included.length} budget{included.length === 1 ? '' : 's'}
          </button>
          <span data-testid="budget-setup-total" style={{ fontFamily: MONO, fontSize: 11.5, color: MUT }}>
            {/* Only the periods actually in the set — "€0/qr +" would be noise. The monthly
                figure stays when the whole set is empty so the line never goes blank. */}
            {ALL_PERIODS.map((k) => ({ k, total: totalAt(k) }))
              .filter(({ k, total }) => total > 0 || (k === 'month' && ALL_PERIODS.every((x) => totalAt(x) === 0)))
              .map(({ k, total }) => `${fmt(total)}/${PERIOD_SHORT[k]}`)
              .join(' + ')}
            {result.typicalIncome > 0 ? ` · typical monthly income ${fmt(result.typicalIncome)}` : ''}
          </span>
          {problem && <span data-testid="budget-setup-problem" style={{ fontSize: 12, color: MUT }}>{problem}</span>}
        </div>
      </>
    )

  return createPortal(
    <div
      data-testid="budget-setup-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Budgets from your history"
      style={{ position: 'fixed', inset: 0, zIndex: 64, background: BG, overflowY: 'auto' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, letterSpacing: '.08em' }}>PLAN</div>
            <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 600, color: INK }}>Budgets from your history</h1>
            <div style={{ fontSize: 12.5, color: FAINT, marginTop: 4, maxWidth: 480 }}>
              Suggested from your complete months — the numbers are yours to change, and nothing is
              created until you apply. Pick the ones you want with Add; each row can be a monthly,
              quarterly, half-yearly or yearly budget, and switching shows that period’s own figure.
              Categories paid in lumps default to the rhythm they were paid at.
            </div>
            {assistant && vault.settings.assist?.chat && (
              <button
                data-testid="budget-setup-ask-assistant"
                onClick={() => {
                  onClose()
                  assistant.setOpen(true)
                  assistant.send(
                    'Look at my spending rhythm and suggest a set of budgets — monthly, quarterly, half-yearly or yearly per category, as the spending warrants.',
                  )
                }}
                style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, marginTop: 8, cursor: 'pointer' }}
              >
                Ask the assistant instead →
              </button>
            )}
          </div>
          <button
            data-testid="budget-setup-cancel"
            onClick={onClose}
            autoFocus
            aria-label="Close"
            style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 13px', background: SURFACE, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>
        {onOneBudget && <BudgetDialogTabs active="history" onOne={onOneBudget} />}
        {body}
      </div>
    </div>,
    document.body,
  )
}
