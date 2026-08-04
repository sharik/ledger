// Add or edit a budget, with room to explain itself.
//
// It replaces an inline strip of three unlabelled controls that could only ever make a
// single-category budget, could not edit one at all, and hid whole capabilities the model already
// had. Everything here is in service of one idea: you should be able to tell what a budget will
// count BEFORE you save it. So each kind says what it measures in a sentence, the amount comes
// with what you actually spent, overlap is stated where the decision is made, and the row you are
// about to create is rendered live from your real transactions.
//
// The overlay mechanics (portal, Escape, focus restore) are lifted from ChartCard's fullscreen
// dialog rather than reinvented.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { budgetRollup, budgetScopeLabel, budgetScopeSpent, budgetScopeYear, isMonthlyScope, monthlyEquivalent, scopeTrailingAvg } from '../analytics/budgets'
import { monthEndProjectionThrough, yearElapsedFraction, yearEndProjection } from '../analytics/project'
import { currentMonthKey, daysInMonth, dayOfToday, round2, todayStr } from '../model/selectors'
import type { Budget, Category } from '../model/types'
import { budgetCategoryIds, budgetKey, CAT_TRANSFERS } from '../model/types'
import { useDerived, useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { computeBudgetDomain } from './charts'
import { useFreshness } from './freshness'
import { BudgetRow } from './kit/rows'
import { BG, FAINT, HAIR, INK, MONO, MUT, SURFACE, SURFACE2, fmt } from './theme'

type Kind =
  | 'monthly'
  | 'annual'
  | 'group-m'
  | 'group-y'
  | 'recurring-m'
  | 'recurring-y'
  | 'recurring-cat-m'
  | 'recurring-cat-y'
  | 'tracking'

/**
 * The option list, in plain language, each with the one line that decides whether it is the
 * right choice. The `value`s of the pre-existing kinds are unchanged: they are the contract the
 * e2e suite drives, and a rename would be churn with no reader benefit.
 */
const KINDS: { value: Kind; label: string; help: string }[] = [
  { value: 'monthly', label: 'One category, every month', help: 'The usual kind. Counts everything filed under one category, in the month you are looking at.' },
  { value: 'annual', label: 'One category, for a whole year', help: 'For spending that arrives in lumps — insurance, taxes, holidays. Counts the whole calendar year, so it is held out of the monthly total.' },
  { value: 'group-m', label: 'Several categories, every month', help: 'One limit covering a few categories at once, e.g. "Fun" over Dining out and Entertainment.' },
  { value: 'group-y', label: 'Several categories, for a whole year', help: 'The same, but measured over the calendar year rather than the month.' },
  { value: 'recurring-m', label: 'Everything you marked monthly-recurring', help: 'Every subscription and standing charge you have marked monthly, across all categories.' },
  { value: 'recurring-y', label: 'Everything you marked yearly-recurring', help: 'The same for yearly charges, measured over the calendar year.' },
  { value: 'recurring-cat-m', label: 'One category’s monthly-recurring charges', help: 'Only the repeating part of one category — the Netflix in Entertainment, not the cinema tickets.' },
  { value: 'recurring-cat-y', label: 'One category’s yearly-recurring charges', help: 'The same for yearly charges in one category.' },
  { value: 'tracking', label: 'One trip or event', help: 'Counts the rows you have put in a trip, over its whole span rather than a month.' },
]

const needsOneCategory = (k: Kind) => k === 'monthly' || k === 'annual' || k === 'recurring-cat-m' || k === 'recurring-cat-y'
const needsManyCategories = (k: Kind) => k === 'group-m' || k === 'group-y'
/** Kinds whose SAVED amount is a year total — the /mo⇄/yr entry toggle applies to all of them. */
const yearlyKind = (k: Kind) => k === 'annual' || k === 'group-y' || k === 'recurring-y' || k === 'recurring-cat-y'

const inputStyle = { fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK }
const label = { fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em', display: 'block', marginBottom: 5 }

function kindOf(b: Budget): Kind {
  const s = b.scope
  if (!s) return 'monthly'
  if (s.kind === 'category-year') return 'annual'
  if (s.kind === 'tracking') return 'tracking'
  if (s.kind === 'group') return s.year != null ? 'group-y' : 'group-m'
  if (s.categoryId) return s.cadence === 'yearly' ? 'recurring-cat-y' : 'recurring-cat-m'
  return s.cadence === 'yearly' ? 'recurring-y' : 'recurring-m'
}

export function BudgetDialog({
  budget,
  onClose,
  onEditOther,
  onFromHistory,
}: {
  budget?: Budget
  onClose: () => void
  /** Re-point the dialog at an existing budget — the way out of a duplicate. */
  onEditOther: (id: string) => void
  /** Swap to the bulk "from history" review. Rendered as a tab, create mode only. */
  onFromHistory?: () => void
}) {
  const store = useStore()
  const { vault } = useStoreState()
  const d = useDerived()
  const rb = useRateBook()
  const fresh = useFreshness()
  const cm = currentMonthKey()
  const today = todayStr()
  const through = fresh.through ?? today

  const spendable = vault.categories.filter((c) => c.role !== 'transfers' && c.role !== 'income')
  const housingId = vault.categories.find((c) => c.role === 'housing')?.id

  const [kind, setKind] = useState<Kind>(budget ? kindOf(budget) : 'monthly')
  // Preselect a category that can actually be saved. Every category is offered — a category may
  // legitimately carry both a monthly and an annual budget — but opening on one that already has
  // a plain monthly budget would land the reader straight on the duplicate guard.
  const [catId, setCatId] = useState(() => {
    if (budget) return budgetCategoryIds(budget)[0] ?? spendable[0]?.id ?? ''
    const taken = new Set(vault.budgets.filter((b) => !b.scope).map((b) => b.categoryId))
    return (spendable.find((c) => !taken.has(c.id)) ?? spendable[0])?.id ?? ''
  })
  const [catIds, setCatIds] = useState<string[]>(budget?.scope?.kind === 'group' ? budget.scope.categoryIds : [])
  const [name, setName] = useState(budget?.name ?? '')
  const [amount, setAmount] = useState(budget ? String(budget.amount) : '')
  /** Entry unit for yearly kinds — the record always stores the year total. */
  const [unit, setUnit] = useState<'mo' | 'yr'>('yr')
  const [trackId, setTrackId] = useState(
    budget?.scope?.kind === 'tracking' ? budget.scope.trackingId : (vault.trackings[0]?.id ?? ''),
  )
  const [collision, setCollision] = useState<Budget | null>(null)

  const panelRef = useRef<HTMLDivElement | null>(null)
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

  const year = Number(cm.slice(0, 4))

  /** The budget this form currently describes — the single source for preview, suggestion,
   *  overlap and save, so none of them can describe something different from the others. */
  const candidate = useMemo((): Budget => {
    const base = { id: budget?.id ?? 'preview', updatedAt: budget?.updatedAt ?? '', fixed: budget?.fixed }
    const raw = Number(amount) || 0
    // A figure typed at /mo describes the same budget as its ×12 at /yr; the record stores the
    // year total, and rounding here means €2,500/yr → 208.33/mo → €2,500 survives a round trip.
    const amt = yearlyKind(kind) && unit === 'mo' ? Math.round(raw * 12) : raw
    const trimmed = name.trim() || undefined
    if (kind === 'tracking') return { ...base, categoryId: CAT_TRANSFERS, amount: amt, name: trimmed, scope: { kind: 'tracking', trackingId: trackId } }
    if (kind === 'recurring-m' || kind === 'recurring-y') {
      return {
        ...base,
        categoryId: CAT_TRANSFERS,
        amount: amt,
        name: trimmed,
        scope: { kind: 'recurring', cadence: kind === 'recurring-y' ? 'yearly' : 'monthly', excludeCategoryIds: housingId ? [housingId] : [] },
      }
    }
    if (needsManyCategories(kind)) {
      return {
        ...base,
        categoryId: CAT_TRANSFERS,
        amount: amt,
        name: trimmed,
        scope: { kind: 'group', categoryIds: catIds, ...(kind === 'group-y' ? { year } : {}) },
      }
    }
    if (kind === 'recurring-cat-m' || kind === 'recurring-cat-y') {
      return { ...base, categoryId: catId, amount: amt, name: trimmed, scope: { kind: 'recurring', cadence: kind === 'recurring-cat-y' ? 'yearly' : 'monthly', categoryId: catId } }
    }
    if (kind === 'annual') {
      const y = budget?.scope?.kind === 'category-year' ? budget.scope.year : year
      return { ...base, categoryId: catId, amount: amt, name: trimmed, scope: { kind: 'category-year', categoryId: catId, year: y } }
    }
    return { ...base, categoryId: catId, amount: amt, name: trimmed }
  }, [kind, catId, catIds, name, amount, unit, trackId, budget, housingId, year])

  const spent = budgetScopeSpent(vault, candidate, cm, rb)
  const monthly = isMonthlyScope(candidate)
  const scopeYear = budgetScopeYear(candidate, cm)
  const proj = monthly
    ? monthEndProjectionThrough(spent, cm, through)
    : scopeYear != null
      ? yearEndProjection(spent, scopeYear, today)
      : spent
  const avg3 = scopeTrailingAvg(vault, candidate, 3, cm, rb)
  const avg6 = scopeTrailingAvg(vault, candidate, 6, cm, rb)

  // Which member categories already carry a counted budget of their own — the overlap the
  // roll-up will report, said here instead, while it is still a choice.
  const alreadyBudgeted = useMemo(() => {
    const mine = new Set(budgetCategoryIds(candidate))
    const counted = budgetRollup(vault, cm, (s) => s, rb).rows
    const names: string[] = []
    for (const r of counted) {
      if (r.budgetId === budget?.id) continue
      const other = vault.budgets.find((b) => b.id === r.budgetId)
      if (!other) continue
      for (const id of budgetCategoryIds(other)) if (mine.has(id)) names.push(d.catById.get(id)?.name ?? '—')
    }
    return [...new Set(names)]
  }, [candidate, vault, cm, budget?.id, d])

  const amtNum = Number(amount)
  const amtOk = amount.trim() !== '' && Number.isFinite(amtNum) && amtNum >= 0
  const problem =
    !amtOk
      ? 'Enter an amount (0 is allowed — it tracks the category without a limit).'
      : needsManyCategories(kind) && catIds.length < 2
        ? 'Pick at least two categories — for one, use “One category, every month”.'
        : needsOneCategory(kind) && !catId
          ? 'Pick a category.'
          : kind === 'tracking' && !trackId
            ? 'Pick a trip.'
            : null

  const save = () => {
    if (problem) return
    // The UI's uniqueness test and the merge's dedupe identity are the same function, so the
    // form can never mint a record the next sync would silently tombstone.
    const key = budgetKey(candidate)
    const clash = vault.budgets.find((b) => b.id !== budget?.id && budgetKey(b) === key)
    if (clash) {
      setCollision(clash)
      return
    }
    const { categoryId, amount: amt, name: nm, scope } = candidate
    if (budget) {
      store.commit({ kind: 'updateBudget', id: budget.id, categoryId, amount: amt, name: nm, scope }, { msg: 'Budget updated', undoable: true })
    } else {
      store.commit({ kind: 'addBudget', categoryId, amount: amt, name: nm, scope }, { msg: 'Budget added', undoable: true })
    }
    onClose()
  }

  const toggleCat = (id: string) =>
    setCatIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const activeKind = KINDS.find((k) => k.value === kind)!

  return createPortal(
    <div
      data-testid="budget-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={budget ? 'Edit budget' : 'Add a budget'}
      style={{ position: 'fixed', inset: 0, zIndex: 64, background: BG, overflowY: 'auto' }}
    >
      <div ref={panelRef} style={{ maxWidth: 720, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, letterSpacing: '.08em' }}>PLAN</div>
            <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 600, color: INK }}>{budget ? 'Edit budget' : 'Add a budget'}</h1>
            <div style={{ fontSize: 12.5, color: FAINT, marginTop: 4 }}>
              A budget is a limit you choose. What you have spent against it is always derived from your
              transactions — you never type it in.
            </div>
          </div>
          <button
            data-testid="budget-cancel"
            onClick={onClose}
            autoFocus
            aria-label="Close"
            style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 13px', background: SURFACE, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>

        {/* Editing has no bulk counterpart, so the tabs only exist while creating. */}
        {!budget && onFromHistory && <BudgetDialogTabs active="one" onHistory={onFromHistory} />}

        <Field title="WHAT SHOULD IT COUNT?">
          <select
            data-testid="budget-scope"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as Kind
              setKind(next)
              // A stale /mo on a non-yearly kind would silently ×12 the typed figure.
              if (!yearlyKind(next)) setUnit('yr')
            }}
            style={{ ...inputStyle, width: '100%' }}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value} disabled={k.value === 'tracking' && vault.trackings.length === 0}>
                {k.label}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: MUT, marginTop: 6, lineHeight: 1.5 }}>{activeKind.help}</div>
        </Field>

        {needsOneCategory(kind) && (
          <Field title="CATEGORY">
            {/* Every category, not only the un-budgeted ones: a category may legitimately carry
                both a monthly and an annual budget, and the old form made that unreachable. */}
            <select data-testid="budget-category" value={catId} onChange={(e) => setCatId(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              {spendable.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}

        {needsManyCategories(kind) && (
          <Field title={`CATEGORIES · ${catIds.length} SELECTED`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {spendable.map((c) => (
                <CatToggle key={c.id} cat={c} on={catIds.includes(c.id)} onClick={() => toggleCat(c.id)} />
              ))}
            </div>
          </Field>
        )}

        {kind === 'tracking' && (
          <Field title="TRIP">
            <select data-testid="budget-tracking" value={trackId} onChange={(e) => setTrackId(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              {vault.trackings.map((tr) => (
                <option key={tr.id} value={tr.id}>{tr.name}</option>
              ))}
            </select>
          </Field>
        )}

        {(kind === 'recurring-m' || kind === 'recurring-y') && (
          <div style={{ fontSize: 12, color: MUT, marginBottom: 16 }}>
            Counts every charge you have marked {kind === 'recurring-y' ? 'yearly' : 'monthly'}-recurring
            {housingId ? ', except Housing — so a recurring rent or mortgage does not swamp the total' : ''}.
          </div>
        )}

        <Field title="NAME (OPTIONAL)">
          <input
            data-testid="budget-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={needsManyCategories(kind) ? 'e.g. Fun' : 'Defaults to the category name'}
            style={{ ...inputStyle, width: '100%' }}
          />
        </Field>

        <Field title="AMOUNT">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" style={{ ...inputStyle, width: 160, fontFamily: MONO }} />
            {yearlyKind(kind) && (
              <span style={{ display: 'inline-flex', border: `1px solid ${HAIR}`, borderRadius: 5, overflow: 'hidden' }}>
                {(['mo', 'yr'] as const).map((u) => (
                  <button
                    key={u}
                    data-testid="budget-amount-unit"
                    data-unit={u}
                    aria-pressed={unit === u}
                    onClick={() => {
                      if (unit === u) return
                      // Converting the typed figure keeps the DESCRIBED budget the same across a
                      // toggle; an empty field just switches the unit.
                      const n = Number(amount)
                      if (amount.trim() !== '' && Number.isFinite(n)) {
                        setAmount(String(u === 'mo' ? round2(n / 12) : Math.round(n * 12)))
                      }
                      setUnit(u)
                    }}
                    style={{
                      fontFamily: MONO,
                      fontSize: 10.5,
                      padding: '6px 9px',
                      border: 'none',
                      cursor: 'pointer',
                      background: unit === u ? INK : SURFACE,
                      color: unit === u ? SURFACE : MUT,
                    }}
                  >
                    /{u}
                  </button>
                ))}
              </span>
            )}
          </div>
          {yearlyKind(kind) && amtOk && amtNum > 0 && (
            <div data-testid="budget-amount-equiv" style={{ fontSize: 11.5, color: FAINT, marginTop: 6 }}>
              {unit === 'mo'
                ? `≈ ${fmt(Math.round(amtNum * 12))}/yr — saved as the year's total`
                : `≈ ${fmt(round2(amtNum / 12))}/mo`}
            </div>
          )}
          {(avg3 !== null || avg6 !== null) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              <span style={{ fontSize: 11.5, color: FAINT }}>What this actually cost you:</span>
              {avg3 !== null && <UseAmount label={`3-month average ${fmt(avg3)}`} onUse={() => setAmount(String(Math.round(avg3)))} />}
              {avg6 !== null && <UseAmount label={`6-month average ${fmt(avg6)}`} onUse={() => setAmount(String(Math.round(avg6)))} />}
            </div>
          )}
          {avg3 === null && avg6 === null && monthly && (
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 8 }}>
              Not enough history yet to say what this usually costs.
            </div>
          )}
        </Field>

        {alreadyBudgeted.length > 0 && (
          <div data-testid="budget-overlap" style={{ fontSize: 12, color: MUT, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '10px 12px', marginBottom: 16, lineHeight: 1.55 }}>
            <strong style={{ color: INK, fontWeight: 600 }}>{alreadyBudgeted.join(', ')}</strong>{' '}
            {alreadyBudgeted.length === 1 ? 'already has' : 'already have'} a budget. Both will be listed, and each
            transaction is counted once in the “All budgets” total — the narrower budget reads as a limit inside this
            one rather than extra plan.
          </div>
        )}

        {/* The row it will become, from real derived spend. The cheapest way to answer "what am
            I actually making?" is to show it. */}
        <Field title="PREVIEW">
          <div style={{ border: `1px solid ${HAIR}`, borderRadius: 6, padding: '2px 14px', background: SURFACE }}>
            <BudgetRow
              cat={candidate.name ?? previewTitle(candidate, d, vault.trackings)}
              caption={
                candidate.scope
                  ? monthlyEquivalent(candidate, cm) != null
                    ? `${budgetScopeLabel(vault, candidate)} · ≈ ${fmt(monthlyEquivalent(candidate, cm)!)}/mo`
                    : budgetScopeLabel(vault, candidate)
                  : undefined
              }
              color={candidate.scope?.kind === 'group' || candidate.scope?.kind === 'recurring' ? 'var(--accent)' : (d.catById.get(candidate.categoryId)?.color ?? 'var(--c-other)')}
              colors={candidate.scope?.kind === 'group' ? candidate.scope.categoryIds.map((id) => d.catById.get(id)?.color ?? 'var(--c-other)') : undefined}
              spent={spent}
              budget={candidate.amount}
              proj={proj}
              domainMax={computeBudgetDomain([{ spent, budget: candidate.amount, proj }])}
              first
              elapsed={monthly ? dayOfToday() / daysInMonth(cm) : scopeYear != null ? yearElapsedFraction(scopeYear, today) : 1}
            />
          </div>
        </Field>

        {collision && (
          <div data-testid="budget-collision" style={{ fontSize: 12.5, color: INK, background: SURFACE2, border: `1px solid var(--warn)`, borderRadius: 6, padding: '10px 12px', marginBottom: 14 }}>
            You already have this exact budget{collision.name ? ` (“${collision.name}”)` : ''}. Two budgets that measure
            the same thing would be merged into one the next time your devices sync, so this one is not created.
            <div style={{ marginTop: 8 }}>
              <button
                data-testid="budget-collision-edit"
                onClick={() => {
                  setCollision(null)
                  onEditOther(collision.id)
                }}
                style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                Edit that one instead →
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            data-testid="budget-save"
            onClick={save}
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
            {budget ? 'Save changes' : 'Add budget'}
          </button>
          {problem && <span data-testid="budget-problem" style={{ fontSize: 12, color: MUT }}>{problem}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function previewTitle(b: Budget, d: ReturnType<typeof useDerived>, trackings: { id: string; name: string }[]): string {
  const s = b.scope
  if (s?.kind === 'tracking') return trackings.find((t) => t.id === s.trackingId)?.name ?? 'Trip'
  if (s?.kind === 'recurring' && !s.categoryId) return 'Recurring'
  if (s?.kind === 'group') {
    const names = s.categoryIds.map((id) => d.catById.get(id)?.name ?? '—')
    if (names.length === 0) return 'No categories yet'
    return names.length <= 2 ? names.join(' + ') : `${names.slice(0, 2).join(' + ')} +${names.length - 2} more`
  }
  return d.catById.get(b.categoryId)?.name ?? '—'
}

/** The One budget ⇄ From your history tab bar, shared with BudgetSetupDialog — the two are one
 *  "add budgets" surface to the user, even though each mode is its own component. */
export function BudgetDialogTabs({ active, onOne, onHistory }: { active: 'one' | 'history'; onOne?: () => void; onHistory?: () => void }) {
  const tabs = [
    { key: 'one' as const, label: 'One budget', go: onOne },
    { key: 'history' as const, label: 'From your history', go: onHistory },
  ]
  return (
    <div style={{ display: 'flex', gap: 20, borderBottom: `1px solid ${HAIR}`, marginBottom: 18 }}>
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            data-testid="budget-dialog-tab"
            data-tab={t.key}
            aria-selected={on}
            onClick={() => !on && t.go?.()}
            style={{
              fontSize: 12.5,
              fontWeight: on ? 600 : 400,
              color: on ? INK : MUT,
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${on ? INK : 'transparent'}`,
              marginBottom: -1,
              padding: '0 0 8px',
              cursor: on ? 'default' : 'pointer',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <span style={label}>{title}</span>
      {children}
    </div>
  )
}

function CatToggle({ cat, on, onClick }: { cat: Category; on: boolean; onClick: () => void }) {
  return (
    <button
      data-testid="budget-cat-option"
      data-on={on ? '1' : '0'}
      aria-pressed={on}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        padding: '5px 10px',
        borderRadius: 999,
        border: `1px solid ${on ? INK : HAIR}`,
        background: on ? INK : SURFACE,
        color: on ? SURFACE : MUT,
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color, flex: 'none' }} />
      {cat.name}
      {on && <span aria-hidden>✓</span>}
    </button>
  )
}

function UseAmount({ label: text, onUse }: { label: string; onUse: () => void }) {
  return (
    <button
      data-testid="budget-suggest"
      onClick={onUse}
      aria-label="Use this amount"
      style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
    >
      {text}
    </button>
  )
}
