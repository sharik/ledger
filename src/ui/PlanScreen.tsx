import { useNarrow } from './responsive'
import { useEffect, useRef, useState } from 'react'
import { ACCENT, BRICK, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE, fmt } from './theme'
import { useDerived, useStore, useStoreState } from './store'
import { currentMonthKey, dayOfToday, daysInMonth, todayStr } from '../model/selectors'
import { monthEndProjectionThrough, yearElapsedFraction, yearEndProjection } from '../analytics/project'
import { daysBetween } from '../analytics/selections'
import { goalState, goalStatus } from '../analytics/goals'
import { budgetRollup, budgetScopeSpent, budgetScopeLabel, budgetScopeYear, isMonthlyScope, monthlyEquivalent, recurringBreakdown } from '../analytics/budgets'
import { GoalRow, BudgetRow } from './kit/rows'
import { BarRows, DivergingRows, computeBudgetDomain } from './charts'
import { useFreshness } from './freshness'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { EmptyState } from './kit/EmptyState'
import { CAT_TRANSFERS } from '../model/types'
import type { Budget, MonthKey } from '../model/types'
import { formatHash, parseHash, type TxnFilter } from './route'
import { BudgetDetail } from './BudgetDetail'
import { BudgetDialog } from './BudgetDialog'
import { BudgetSetupDialog } from './BudgetSetupDialog'
import { GoalDialog, detailOf } from './GoalDialog'
import { Explain } from './explain'
import { ScreenIntro } from './ScreenIntro'
import { RulesOfThumb } from './widgets/PlanWidgets'
import { useCardOrder, type CardOrder } from './kit/cardOrder'
import { SubscriptionsSection } from './SubscriptionsSection'
import { PeriodStepper, granOf, readPeriodParam } from './kit/PeriodStepper'

/** Label column of the off-plan chart. Shared with its axis captions so they line up. */
const MOVER_LABEL_W = 130

/**
 * The transactions a budget covers, as a Transactions filter — so clicking a row shows exactly
 * the rows its bar was measured from. It lives here rather than in `analytics/budgets` because
 * `TxnFilter` is a UI/route type and analytics must not depend on the UI layer.
 *
 * Never `null` any more: a multi-category ("group") budget travels as `cats`, the comma-joined set.
 * It used to return `null` there while the call site spread `?? {}`, so a group's history bar
 * opened *every* transaction in the month — a filter promised and not applied.
 */
function budgetDrill(b: Budget, mk: MonthKey): TxnFilter {
  const scope = b.scope
  const from = `${mk}-01`
  const to = `${mk}-${String(daysInMonth(mk)).padStart(2, '0')}`
  if (!scope) return { cat: b.categoryId, from, to }
  if (scope.kind === 'category-year') return { cat: scope.categoryId, from: `${scope.year}-01-01`, to: `${scope.year}-12-31` }
  if (scope.kind === 'tracking') return { tracking: scope.trackingId }
  if (scope.kind === 'recurring') {
    const yearly = scope.cadence === 'yearly'
    return {
      status: 'recurring',
      from: yearly ? `${mk.slice(0, 4)}-01-01` : from,
      to: yearly ? `${mk.slice(0, 4)}-12-31` : to,
      ...(scope.categoryId ? { cat: scope.categoryId } : {}),
    }
  }
  if (scope.kind === 'group') {
    const yr = scope.year != null
    return { cats: scope.categoryIds.join(','), from: yr ? `${scope.year}-01-01` : from, to: yr ? `${scope.year}-12-31` : to }
  }
  return { from, to } // unreachable: every scope kind has an arm (the `budgetKey` discipline)
}

/** A group budget with no name of its own: first two members, then "+N more". */
function groupTitle(members: ({ name: string } | undefined)[]): string {
  const names = members.map((m) => m?.name ?? '—')
  return names.length <= 2 ? names.join(' + ') : `${names.slice(0, 2).join(' + ')} +${names.length - 2} more`
}

const addBtn = { fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }
/**
 * A month from the route, or `null` when there is nothing usable there. Never the future: a month
 * that has not happened has no spend to plan against, and a hand-edited hash must not produce one.
 *
 * `readPeriodParam` also accepts a bare year, which is the Dashboard's shape — Plan is month-only,
 * so a `?mk=2026` here is junk and gets rejected like any other.
 */
function readMk(raw: string | undefined, thisMonth: MonthKey): MonthKey | null {
  const v = readPeriodParam(raw, thisMonth)
  return v && granOf(v) === 'month' ? v : null
}

export function PlanScreen() {
  const narrow = useNarrow()
  const store = useStore()
  const { vault } = useStoreState()
  const d = useDerived()
  const view = useView()
  const { goTxns } = view

  const thisMonth = currentMonthKey()
  const today = todayStr()
  /**
   * The month the screen is reading. It lives in the route (`#/plan?mk=2026-06`) rather than in
   * component state alone, so a month is shareable, survives reload, and steps back through the
   * browser's own history — the treatment every other drill on this app already gets.
   */
  const [cm, setCm] = useState<MonthKey>(() => readMk(parseHash(location.hash).query.mk, thisMonth) ?? thisMonth)
  const seenNonce = useRef(0)
  useEffect(() => {
    const seed = view.seed
    if (!seed || seed.tab !== 'plan' || seed.nonce === seenNonce.current) return
    seenNonce.current = seed.nonce
    // An empty query is plain navigation (the tab bar) and leaves the month alone — the same rule
    // the Transactions screen applies to its filters.
    const mk = readMk(seed.query.mk, thisMonth)
    if (mk) setCm(mk)
  }, [view.seed, thisMonth])
  useEffect(() => {
    if (view.tab !== 'plan') return
    const h = formatHash({ tab: 'plan', query: cm === thisMonth ? {} : { mk: cm } })
    if (location.hash !== h) history.replaceState(history.state, '', h)
  }, [cm, thisMonth, view.tab])

  /** A past month is finished: no pace, no projection, no "today" marker — just what it cost. */
  const isCurrent = cm === thisMonth
  const fresh = useFreshness()
  const rb = useRateBook()
  const elapsed = isCurrent ? dayOfToday() / daysInMonth(cm) : 1
  const elapsedPct = Math.round(elapsed * 100)

  /**
   * Every pace figure on this screen divides by the window the STATEMENTS cover, not by the
   * calendar month. The header has always printed both "time elapsed 97%" and "data through
   * 23 Jul" and reconciled neither: dividing 23 days of charges by 30 elapsed days understated
   * every projection here by ~30%. With nothing imported there is no statement window, so it
   * falls back to today and behaves exactly as before.
   */
  const through = fresh.through ?? today
  // A past month is not projected at all: extrapolating a month that has already ended would state
  // a figure about the past. Where its statements stop is still shown, by the coverage marker.
  const projectTo = (spent: number) => (isCurrent ? monthEndProjectionThrough(spent, cm, through) : spent)
  // 0..1 of THIS month the statements reach: full when coverage has passed the month, none when
  // it has not reached it. Drives the second marker on the bars.
  const coveredFrac =
    through.slice(0, 7) === cm ? Number(through.slice(8, 10)) / daysInMonth(cm) : through > cm ? 1 : 0
  const coveredDays = through.slice(0, 7) === cm ? Number(through.slice(8, 10)) : null
  const paceBasis = coveredDays !== null && coveredFrac < elapsed ? `${coveredDays} days of data` : undefined

  /** The goal dialog: `null` closed, `{}` adding, `{ id }` editing. */
  const [gdlg, setGdlg] = useState<{ id?: string } | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const [openB, setOpenB] = useState<string | null>(null) // budget id whose history panel is open
  /** The budget dialog: `null` closed, `{}` adding, `{ id }` editing that budget. */
  const [dlg, setDlg] = useState<{ id?: string } | null>(null)
  const [setup, setSetup] = useState(false) // the bulk "budgets from history" review

  const goals = vault.goals.filter((g) => !g.archived)
  const archivedGoals = vault.goals.filter((g) => g.archived)
  // Scoped (tracking/annual) budgets are kept even though a tracking budget parks
  // its nominal categoryId on CAT_TRANSFERS — its spend is scope-driven, not category.
  const budgets = vault.budgets.filter((b) => b.scope != null || b.categoryId !== CAT_TRANSFERS)

  const archiveG = (id: string, name: string) =>
    store.commit({ kind: 'setField', collection: 'goals', id, field: 'archived', value: true }, { msg: `${name} archived`, undoable: true })
  const unarchiveG = (id: string, name: string) =>
    store.commit({ kind: 'setField', collection: 'goals', id, field: 'archived', value: false }, { msg: `${name} restored`, undoable: true })

  // Plan is composed of cards, ordered per device — the machinery the Dashboard already proves.
  // `rules` only exists while the Settings toggle is on; `applyOrder` drops an id that is not in
  // the default list, so turning it off and on again does not lose its place in the order.
  const cards = useCardOrder('plan', ['goals', 'budgets', ...(vault.params.rulesOfThumb ? ['rules'] : [])])

  /** GOALS — its own card so it can be moved, or put after the budgets it competes with. */
  const goalsCard = (
    <>
      <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', marginBottom: 2 }}>GOALS</div>
      {goals.length === 0 && (
        <EmptyState
          testid="plan-goals-empty"
          dense
          basis="no-data"
          title="No goals yet."
          body="A goal can follow an account's balance up, a debt's balance down, the contributions you make to a category or trip, or a figure you keep yourself."
          action={{ label: 'Add a goal', onClick: () => setGdlg({}) }}
        />
      )}
      {goals.map((g) => {
        const st = goalStatus(vault, g, today, rb)
        const src = g.source
        const dir = src && src.kind === 'balance' ? src.direction : undefined
        const kind: 'up' | 'down' | 'legacy' = dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'legacy'
        let spark: string | undefined
        const snaps = st.snapshots
        if (kind === 'down' && snaps && snaps.length >= 2) {
          const max = Math.max(...snaps)
          const min = Math.min(...snaps)
          const span = max - min || 1
          spark = snaps.map((v, i) => `${i},${(8 + (1 - (v - min) / span) * 26).toFixed(1)}`).join(' ')
        }
        return (
          <GoalRow
            key={g.id}
            name={g.name}
            detail={detailOf(g, vault, d)}
            kind={kind}
            fill={st.fraction}
            spark={spark}
            projected={st.eta != null}
            eta={st.eta}
            state={goalState(g, st)}
            onEdit={() => setGdlg({ id: g.id })}
            onArchive={() => archiveG(g.id, g.name)}
            onDelete={() => store.commit({ kind: 'delete', collection: 'goals', ids: [g.id] }, { msg: `${g.name} deleted`, undoable: true })}
          />
        )
      })}
      {archivedGoals.length > 0 && (
        <div style={{ padding: '8px 0', borderTop: `1px solid var(--hair2)` }}>
          <button data-testid="goals-archived-toggle" onClick={() => setShowArchived(!showArchived)} style={{ fontSize: 11.5, color: FAINT, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {archivedGoals.length} archived goal{archivedGoals.length === 1 ? '' : 's'} · {showArchived ? 'hide' : 'show'}
          </button>
          {showArchived && archivedGoals.map((g) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 12.5, color: FAINT }}>
              <span style={{ flex: 1 }}>{g.name}</span>
              <button onClick={() => unarchiveG(g.id, g.name)} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>Unarchive</button>
            </div>
          ))}
        </div>
      )}
    </>
  )

  /** BUDGETS — the roll-up, the rows, and the off-plan chart that reads them. */
  const budgetsCard = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '18px 0 2px' }}>
        {/* One "?" per figure. Both ids used to hang off this one label, two identical glyphs
            side by side distinguished only by their aria-label; `plan.rollup` now sits on the
            "All budgets" row it actually explains. */}
        <span data-testid="budgets-kicker" style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', display: 'inline-flex', alignItems: 'center' }}>BUDGETS<Explain id="plan.budget-bar" size="sm" /></span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: MONO, fontSize: 9.5, color: FAINT }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 1, height: 10, background: 'var(--ink3)' }} />today
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 0, height: 11, borderLeft: '2px dashed var(--ink3)' }} />projected
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 2, height: 11, background: 'var(--ink2)' }} />budget
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--neg)', borderRadius: 1 }} />spent past budget
          </span>
        </span>
      </div>
      <div>
        {budgets.length === 0 && (
          <EmptyState
            testid="plan-budgets-empty"
            dense
            basis="no-data"
            title="No budgets yet."
            body="A budget can cover one category or several, a month or a whole year, a recurring cadence, or one trip. Spend is always derived from your transactions, never typed in."
            action={{ label: 'Add a budget', onClick: () => setDlg({}) }}
            secondaryAction={{ label: 'Suggest from history', onClick: () => setSetup(true) }}
          />
        )}
        {budgets.length > 0 && (() => {
          const roll = budgetRollup(vault, cm, projectTo, rb)
          const memoParts = [
            roll.memo.annual > 0 && `annual ${fmt(roll.memo.annual)} (≈ ${fmt(roll.memo.annual / 12)}/mo)`,
            roll.memo.perTrip > 0 && `per-trip ${fmt(roll.memo.perTrip)}`,
            roll.memo.crossCategoryRecurring > 0 && `recurring across categories ${fmt(roll.memo.crossCategoryRecurring)}`,
          ].filter(Boolean) as string[]

          const rows = budgets.map((b) => {
            // A budget covering a different period than this month has no MONTHLY pace — but a
            // year-scoped one has a year of its own to pace against: its marker sits at that
            // year's elapsed fraction (calendar days) and its dashed marker is a year-end pace.
            // Only a per-trip budget keeps no time context at all.
            const monthly = isMonthlyScope(b)
            const spent = budgetScopeSpent(vault, b, cm, rb)
            const year = budgetScopeYear(b, cm)
            const yElapsed = year != null ? yearElapsedFraction(year, today) : null
            const proj = monthly ? projectTo(spent) : year != null ? yearEndProjection(spent, year, today) : spent
            return { b, monthly, spent, proj, year, yElapsed }
          })

          // ONE domain across the roll-up row AND every category row. Two separate calls put
          // the roll-up's budget tick at 61% of its track while the rows sat at 29%, so the
          // roll-up bar could not be compared with anything — while the screen intro and the
          // "?" both promised "all bars share one scale".
          const domainMax = computeBudgetDomain([
            { spent: roll.totalSpent, budget: roll.totalBudget, proj: roll.totalProj },
            ...rows.map((r) => ({ spent: r.spent, budget: r.b.amount, proj: r.proj })),
          ])

          const nameOf = (r: (typeof roll.rows)[number]) => r.name ?? d.catById.get(r.categoryId)?.name ?? '—'
          const offPlan = roll.rows.filter((r) => Math.abs(r.delta) > 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          const moverMax = Math.max(1, ...offPlan.map((r) => Math.abs(r.delta)))
          const overs = offPlan.filter((r) => r.delta > 0)
          const unders = offPlan.filter((r) => r.delta < 0)
          const overSum = overs.reduce((s, r) => s + r.delta, 0)
          const underSum = unders.reduce((s, r) => s - r.delta, 0)
          const bothWays = overs.length > 0 && unders.length > 0
          const moverRow = (r: (typeof roll.rows)[number]) => {
            const name = nameOf(r)
            // A multi-category budget has no single category to filter by, so it carries no
            // drill rather than a misleading one.
            const drillable = !r.name
            return {
              key: r.budgetId,
              label: name,
              delta: r.delta,
              frac: Math.abs(r.delta) / moverMax,
              value: `${fmt(Math.abs(r.delta))} ${r.delta > 0 ? 'over' : 'left'}`,
              title: drillable ? `Open ${name} this month →` : undefined,
              onClick: drillable
                ? () => goTxns({ cat: r.categoryId, from: `${cm}-01`, to: `${cm}-${String(daysInMonth(cm)).padStart(2, '0')}` })
                : undefined,
            }
          }

          return (
            <>
              {(roll.rows.length > 0 || memoParts.length > 0) && (
                <div data-testid="budget-rollup" style={{ borderBottom: `1.5px solid ${INK}`, paddingBottom: 12, marginBottom: 4 }}>
                  <BudgetRow
                    cat="All budgets"
                    explain="plan.rollup"
                    color={INK}
                    spent={roll.totalSpent}
                    budget={roll.totalBudget}
                    proj={roll.totalProj}
                    domainMax={domainMax}
                    first
                    elapsed={elapsed}
                    covered={coveredFrac}
                    paceBasis={paceBasis}
                    canDelete={false}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: -4 }}>
                    <span data-testid="rollup-summary">
                      {roll.overCount} of {roll.rows.length} over
                      {roll.adherencePct !== null ? ` · ${roll.adherencePct}% of plan used` : ''}
                    </span>
                    {memoParts.length > 0 && (
                      <span data-testid="rollup-memo">· not in this total: {memoParts.join(' · ')}</span>
                    )}
                  </div>
                  {/* Where the figure's own arithmetic needs stating: overlapping budgets are
                      both shown, and the money they share is counted once. */}
                  {roll.rows.some((r) => r.subLimit) && (
                    <div data-testid="rollup-dedup" style={{ fontSize: 11, color: FAINT, marginTop: 6 }}>
                      Each transaction is counted once:{' '}
                      {roll.rows.filter((r) => r.subLimit).map(nameOf).join(', ')} sits inside a wider budget, so its
                      amount is a limit within that one rather than extra plan.
                    </div>
                  )}
                  {roll.overlapCategoryIds.length > 0 && (
                    <div data-testid="rollup-overlap" style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
                      Two budgets both cover{' '}
                      {roll.overlapCategoryIds.map((id) => d.catById.get(id)?.name ?? '—').join(', ')}, and neither is
                      inside the other — spend counts once, but the plan above counts that limit twice.
                    </div>
                  )}
                </div>
              )}

              {rows.map(({ b, monthly, spent, proj, year, yElapsed }, i) => {
                const rec = b.scope?.kind === 'recurring' ? b.scope : undefined
                // A recurring budget is cross-category ("Recurring", with a breakdown) unless it
                // targets one category (#12c), in which case it reads like an ordinary category row.
                const recTotal = rec && !rec.categoryId
                const grp = b.scope?.kind === 'group' ? b.scope : undefined
                const trackId = b.scope?.kind === 'tracking' ? b.scope.trackingId : undefined
                const track = trackId ? vault.trackings.find((tr) => tr.id === trackId) : undefined
                const cat = d.catById.get(b.categoryId)
                const members = grp ? grp.categoryIds.map((id) => d.catById.get(id)) : []
                const label = budgetScopeLabel(vault, b)
                const perMonth = monthlyEquivalent(b, cm)
                const breakdown = recTotal ? recurringBreakdown(vault, rec.cadence, cm, rec.excludeCategoryIds, rb) : []
                return (
                  <div key={b.id}>
                    <BudgetRow
                      cat={b.name ?? (recTotal ? 'Recurring' : grp ? groupTitle(members) : (track?.name ?? cat?.name ?? '—'))}
                      caption={b.scope ? (perMonth != null ? `${label} · ≈ ${fmt(perMonth)}/mo` : label) : undefined}
                      color={recTotal || grp ? 'var(--accent)' : (track?.color ?? cat?.color ?? 'var(--c-other)')}
                      colors={grp ? members.map((m) => m?.color ?? 'var(--c-other)') : undefined}
                      spent={spent}
                      budget={b.amount}
                      proj={proj}
                      domainMax={domainMax}
                      first={i === 0}
                      elapsed={monthly ? elapsed : (yElapsed ?? 1)}
                      covered={monthly ? coveredFrac : undefined}
                      paceBasis={
                        monthly
                          ? paceBasis
                          : year != null && yElapsed! > 0 && yElapsed! < 1
                            ? `${daysBetween(`${year}-01-01`, today) + 1} days of ${year} (calendar)`
                            : undefined
                      }
                      onOpen={() => goTxns(budgetDrill(b, cm))}
                      expanded={openB === b.id}
                      onToggle={() => setOpenB((cur) => (cur === b.id ? null : b.id))}
                      onEdit={() => setDlg({ id: b.id })}
                      canDelete
                      onDelete={() => store.commit({ kind: 'delete', collection: 'budgets', ids: [b.id] }, { msg: 'Budget removed', undoable: true })}
                    />
                    {openB === b.id && (
                      <BudgetDetail
                        budget={b}
                        mk={cm}
                        onDrillPeriod={(key) =>
                          // A month key drills that month; a year key drills the whole year.
                          goTxns(
                            key.length === 7
                              ? { ...budgetDrill(b, key), from: `${key}-01`, to: `${key}-${String(daysInMonth(key)).padStart(2, '0')}` }
                              : { ...budgetDrill(b, `${key}-01`), from: `${key}-01-01`, to: `${key}-12-31` },
                          )
                        }
                        onDrillCategory={(categoryId) =>
                          goTxns({ cat: categoryId, from: `${cm}-01`, to: `${cm}-${String(daysInMonth(cm)).padStart(2, '0')}` })
                        }
                      />
                    )}
                    {recTotal && breakdown.length > 0 && (
                      <div data-testid="recurring-breakdown" style={{ padding: '4px 0 12px 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {breakdown.map((r) => {
                          const rc = d.catById.get(r.categoryId)
                          return (
                            <div key={r.categoryId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ width: 7, height: 7, borderRadius: 2, background: rc?.color ?? 'var(--c-other)' }} />
                                <span style={{ color: MUT }}>{rc?.name ?? '—'}</span>
                              </span>
                              <span style={{ fontFamily: MONO, fontSize: 12, color: MUT }}>{fmt(r.spent)}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}

              {/*
                The variance chart (Q124), retitled and moved BELOW the list. It used to sit
                between the total and the budgets it sums, unlabelled, at 9–10px, with euros
                that looked like spend but were distance-from-budget — so it read as a second,
                redundant copy of the list. Now it says what it is, in words, after the list.
              */}
              {offPlan.length > 0 && (
                <div data-testid="budget-offplan" style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid var(--hair2)` }}>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em', display: 'inline-flex', alignItems: 'center' }}>
                    OFF PLAN THIS MONTH<Explain id="plan.movers" size="sm" />
                  </div>
                  <div style={{ fontSize: 11.5, color: FAINT, margin: '3px 0 10px', lineHeight: 1.5 }}>
                    How far each budget is from its own limit — not what you spent. Biggest gap first.
                  </div>
                  {bothWays && (
                    <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                      {/* Aligned to the BAR track, not the whole block: these captions used to
                          span the label column too, putting "← under" nowhere near the axis. */}
                      <div style={{ width: MOVER_LABEL_W, flex: 'none' }} />
                      <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: FAINT }}>
                        <span>← under budget</span>
                        <span>over budget →</span>
                      </div>
                    </div>
                  )}
                  {/*
                    A diverging axis earns its keep only when there is something on both
                    sides of it. With one sign every bar grows from the centre line and half
                    the width is dead — which is what the original did with 4-of-4 over. So a
                    single-sign list is drawn left-anchored across the full width instead, and
                    the direction is carried by the words ("over" / "left") and the colour.
                  */}
                  {bothWays ? (
                    <DivergingRows labelWidth={MOVER_LABEL_W} rows={offPlan.map(moverRow)} />
                  ) : (
                    <BarRows
                      labelWidth={MOVER_LABEL_W}
                      rows={offPlan.map((r) => {
                        const m = moverRow(r)
                        return { key: m.key, label: m.label, frac: m.frac, value: m.value, color: r.delta > 0 ? BRICK : GREEN, title: m.title, onClick: m.onClick }
                      })}
                    />
                  )}
                  <div data-testid="offplan-summary" style={{ fontSize: 12, color: MUT, marginTop: 10 }}>
                    {overs.length > 0 && `${overs.length} over by ${fmt(overSum)}`}
                    {overs.length > 0 && unders.length > 0 && ' · '}
                    {unders.length > 0 && `${unders.length} with ${fmt(underSum)} still to spend`}
                  </div>
                </div>
              )}
            </>
          )
        })()}
      </div>
    </>
  )

  return (
    <div data-screen="plan">
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Plan</h1>
        <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>Spend is always derived — an import can never leave a budget stale.</div>
      </div>
      <ScreenIntro id="plan" />

      {/* The header spans every card, so it sits above them rather than inside whichever one
          happens to be first after a reorder. */}
      {/* Four groups on one baseline — stepper, + Budget/+ Goal, elapsed, freshness — needs far
          more than 366px, so the last of them ("data through 12 Jul") was simply cut off the
          right edge. Stacked, with the meta line wrapping under. */}
      <div style={narrow ? { marginBottom: 12 } : { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: narrow ? 'wrap' : 'nowrap', justifyContent: narrow ? 'space-between' : undefined }}>
          {/* Q121 — "did I stay in budget last month?" is answerable on the screen that owns
              budgets. Forward stops at the current month: there is no plan for a month that
              has not happened. */}
          <PeriodStepper value={cm} onChange={(v) => setCm(v)} testidPrefix="plan" narrow={narrow} thisMonth={thisMonth} />
          {/* Actions live behind a hairline so the stepper (with its "↩ today" chip) reads as
              one control and these as another. Bulk "from history" is a tab inside + Budget. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderLeft: `1px solid ${HAIR}`, paddingLeft: 14 }}>
            <button onClick={() => setDlg({})} style={addBtn}>+ Budget</button>
            <span style={{ color: HAIR }}>·</span>
            <button onClick={() => setGdlg({})} style={addBtn}>+ Goal</button>
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: narrow ? 8 : 0 }}>
          {isCurrent ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 2, height: 11, background: 'var(--ink3)', display: 'inline-block' }} />time elapsed {elapsedPct}%
              </span>
              <span data-testid="plan-freshness">{fresh.label}</span>
            </>
          ) : (
            // Neither figure applies to a finished month: elapsed is always 100%, and the
            // freshness caption describes how current the vault is, not this month.
            <span data-testid="plan-month-complete">month complete · actual against budget</span>
          )}
        </div>
      </div>

      {cards.ids.map((cid) => (
        <PlanCard key={cid} id={cid} order={cards}>
          {cid === 'goals' && goalsCard}
          {cid === 'budgets' && budgetsCard}
          {cid === 'rules' && <RulesOfThumb />}
        </PlanCard>
      ))}

      <SubscriptionsSection />

      {gdlg && (
        <GoalDialog
          goal={gdlg.id ? vault.goals.find((g) => g.id === gdlg.id) : undefined}
          onClose={() => setGdlg(null)}
        />
      )}

      {dlg && (
        <BudgetDialog
          budget={dlg.id ? vault.budgets.find((b) => b.id === dlg.id) : undefined}
          onClose={() => setDlg(null)}
          onEditOther={(id) => setDlg({ id })}
          onFromHistory={() => {
            setDlg(null)
            setSetup(true)
          }}
        />
      )}

      {setup && (
        <BudgetSetupDialog
          onClose={() => setSetup(false)}
          onOneBudget={() => {
            setSetup(false)
            setDlg({})
          }}
        />
      )}
    </div>
  )
}

/**
 * One card of the Plan screen, carrying the reorder controls in its top-right corner — the same
 * ‹ › ⠿ cluster the Dashboard's cards use, from the same hook.
 */
function PlanCard({ id, order, children }: { id: string; order: CardOrder; children: React.ReactNode }) {
  return (
    <section
      data-plan-card={id}
      {...order.dropTarget(id)}
      style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 22px', marginBottom: 16, opacity: order.isDragging(id) ? 0.45 : 1 }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', height: 0 }}>{order.controls(id)}</div>
      {children}
    </section>
  )
}
