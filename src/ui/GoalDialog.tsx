// Add or edit a goal, with enough on screen to know what you are making.
//
// The form this replaces was three unlabelled inputs — name, target, monthly — which could only
// ever produce a `saved: 0` manual goal that no UI could then move. So every goal created in the
// app rendered an empty middle column and read "no trajectory yet · behind" forever, while the
// empty state right above advertised the two account-linked kinds the model supports and the form
// could not reach. This exposes all four, says what each one measures, and warns before saving
// when the data a kind depends on is not there yet.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { goalState, goalStatus } from '../analytics/goals'
import { todayStr } from '../model/selectors'
import type { Goal } from '../model/types'
import { useDerived, useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { GoalRow } from './kit/rows'
import { BG, FAINT, HAIR, INK, MONO, MUT, SURFACE, SURFACE2, fmt } from './theme'

type Kind = 'save-up' | 'pay-off' | 'contribute' | 'manual'

const KINDS: { value: Kind; label: string; help: string; example: string }[] = [
  {
    value: 'save-up',
    label: 'Save up to a balance',
    help: 'Progress is the balance of an account you choose, read from the balances you enter. Nothing to keep updating by hand.',
    example: 'e.g. “Emergency fund” — my savings account, up to €40,000.',
  },
  {
    value: 'pay-off',
    label: 'Pay off a debt',
    help: 'Progress is how far a debt has come down from where it started, and the finish date is fitted from your last six months of balances.',
    example: 'e.g. “Mortgage” — down to €0.',
  },
  {
    value: 'contribute',
    label: 'Add up contributions',
    help: 'Progress is everything you have spent in one category, or on one trip — useful when the saving leaves your account rather than sitting in one.',
    example: 'e.g. “Wedding fund” — every transaction in the Wedding category, up to €12,000.',
  },
  {
    value: 'manual',
    label: 'Track it yourself',
    help: 'You type in how much you have set aside and how much you add each month. Ledger does the arithmetic but cannot check it against anything.',
    example: 'e.g. “New kitchen” — €3,200 saved, €400 a month, target €8,000.',
  },
]

const inputStyle = { fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK }
const labelStyle = { fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em', display: 'block', marginBottom: 5 }

function kindOf(g: Goal): Kind {
  const s = g.source
  if (s?.kind === 'balance') return s.direction === 'up' ? 'save-up' : 'pay-off'
  if (s?.kind === 'flow') return 'contribute'
  return 'manual'
}

export function GoalDialog({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const store = useStore()
  const { vault } = useStoreState()
  const d = useDerived()
  const rb = useRateBook()
  const today = todayStr()

  const [kind, setKind] = useState<Kind>(goal ? kindOf(goal) : 'save-up')
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(goal ? String(goal.target) : '')
  const [monthly, setMonthly] = useState(goal ? String(goal.monthly) : '')
  const [saved, setSaved] = useState(goal ? String(goal.saved) : '')
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [acctId, setAcctId] = useState(
    goal?.source?.kind === 'balance' ? goal.source.accountId : (vault.accounts.find((a) => !a.hidden)?.id ?? ''),
  )
  const [flowCat, setFlowCat] = useState(goal?.source?.kind === 'flow' ? (goal.source.categoryId ?? '') : '')
  const [flowTrip, setFlowTrip] = useState(goal?.source?.kind === 'flow' ? (goal.source.trackingId ?? '') : '')

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

  const liabilities = vault.accounts.filter((a) => a.liab && !a.hidden)
  const assets = vault.accounts.filter((a) => !a.liab && !a.hidden)
  const accounts = kind === 'pay-off' ? (liabilities.length > 0 ? liabilities : vault.accounts) : assets.length > 0 ? assets : vault.accounts
  const spendable = vault.categories.filter((c) => c.role !== 'transfers' && c.role !== 'income')

  /** The goal this form describes — one source for the preview, the warning and the save. */
  const candidate = useMemo((): Goal => {
    const base: Goal = {
      id: goal?.id ?? 'preview',
      updatedAt: goal?.updatedAt ?? '',
      name: name.trim() || 'Untitled goal',
      target: Number(target) || 0,
      saved: kind === 'manual' ? Number(saved) || 0 : 0,
      monthly: kind === 'manual' ? Number(monthly) || 0 : 0,
      ...(targetDate ? { targetDate } : {}),
    }
    if (kind === 'save-up') return { ...base, source: { kind: 'balance', accountId: acctId, direction: 'up', target: Number(target) || 0 } }
    if (kind === 'pay-off') return { ...base, source: { kind: 'balance', accountId: acctId, direction: 'down', target: Number(target) || 0 } }
    if (kind === 'contribute') {
      return { ...base, source: { kind: 'flow', ...(flowTrip ? { trackingId: flowTrip } : { categoryId: flowCat }) } }
    }
    return base
  }, [kind, name, target, saved, monthly, targetDate, acctId, flowCat, flowTrip, goal])

  const st = goalStatus(vault, candidate, today, rb)

  // Balance-linked kinds need at least two snapshots before any trajectory exists. Saying so
  // here beats the row saying "not enough history yet" after the fact.
  const snapCount = vault.snapshots.filter((s) => s.accountId === acctId).length
  const thinHistory = (kind === 'save-up' || kind === 'pay-off') && snapCount < 2

  const targetNum = Number(target)
  const problem =
    !name.trim()
      ? 'Give the goal a name.'
      : !Number.isFinite(targetNum) || target.trim() === ''
        ? 'Enter a target amount.'
        : (kind === 'save-up' || kind === 'pay-off') && !acctId
          ? 'Pick the account this goal tracks.'
          : kind === 'contribute' && !flowCat && !flowTrip
            ? 'Pick the category or trip the contributions come from.'
            : null

  const save = () => {
    if (problem) return
    const { name: nm, target: tg, monthly: mo, saved: sv, source, targetDate: td } = candidate
    if (goal) {
      // `updateGoal` covers the three plain fields; `source`, `saved` and `targetDate` ride the
      // generic setField arm, batched so the whole edit is one undo.
      store.commit(
        {
          kind: 'batch',
          ops: [
            { kind: 'updateGoal', id: goal.id, name: nm, target: tg, monthly: mo },
            { kind: 'setField', collection: 'goals', id: goal.id, field: 'saved', value: sv },
            { kind: 'setField', collection: 'goals', id: goal.id, field: 'source', value: source },
            { kind: 'setField', collection: 'goals', id: goal.id, field: 'targetDate', value: td },
          ],
        },
        { msg: `${nm} updated`, undoable: true },
      )
    } else {
      // One op, so one undo: `addGoal` carries the linked fields rather than being patched
      // afterwards by id it has not minted yet.
      store.commit(
        { kind: 'addGoal', name: nm, target: tg, monthly: mo, saved: sv, source, targetDate: td },
        { msg: `${nm} added`, undoable: true },
      )
    }
    onClose()
  }

  const rowKind = kind === 'pay-off' ? 'down' : kind === 'save-up' ? 'up' : 'legacy'

  return createPortal(
    <div
      data-testid="goal-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={goal ? 'Edit goal' : 'Add a goal'}
      style={{ position: 'fixed', inset: 0, zIndex: 64, background: BG, overflowY: 'auto' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, letterSpacing: '.08em' }}>PLAN</div>
            <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 600, color: INK }}>{goal ? 'Edit goal' : 'Add a goal'}</h1>
            <div style={{ fontSize: 12.5, color: FAINT, marginTop: 4 }}>
              A goal is an amount you are working toward. Pick where its progress should be read from and Ledger keeps
              it up to date for you.
            </div>
          </div>
          <button
            data-testid="goal-cancel"
            onClick={onClose}
            autoFocus
            aria-label="Close"
            style={{ fontSize: 12.5, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '7px 13px', background: SURFACE, cursor: 'pointer' }}
          >
            Cancel
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <span style={labelStyle}>WHERE DOES PROGRESS COME FROM?</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {KINDS.map((k) => (
              <button
                key={k.value}
                data-testid="goal-kind"
                data-kind={k.value}
                data-on={kind === k.value ? '1' : '0'}
                aria-pressed={kind === k.value}
                onClick={() => setKind(k.value)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${kind === k.value ? INK : HAIR}`,
                  borderRadius: 6,
                  background: kind === k.value ? SURFACE2 : SURFACE,
                  padding: '10px 12px',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 500, color: INK }}>{k.label}</div>
                <div style={{ fontSize: 12, color: MUT, marginTop: 3, lineHeight: 1.5 }}>{k.help}</div>
                <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>{k.example}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <span style={labelStyle}>NAME</span>
          <input data-testid="goal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Goal name" style={{ ...inputStyle, width: '100%' }} />
        </div>

        {(kind === 'save-up' || kind === 'pay-off') && (
          <div style={{ marginBottom: 16 }}>
            <span style={labelStyle}>{kind === 'pay-off' ? 'DEBT ACCOUNT' : 'ACCOUNT'}</span>
            <select data-testid="goal-account" value={acctId} onChange={(e) => setAcctId(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {thinHistory && (
              <div data-testid="goal-thin-history" style={{ fontSize: 12, color: MUT, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '9px 11px', marginTop: 8, lineHeight: 1.5 }}>
                This account has {snapCount === 0 ? 'no recorded balance' : 'only one recorded balance'}. Progress will
                show, but no finish date can be worked out until there are at least two — add balances on the Accounts
                screen as your statements arrive.
              </div>
            )}
          </div>
        )}

        {kind === 'contribute' && (
          <div style={{ marginBottom: 16 }}>
            <span style={labelStyle}>CONTRIBUTIONS COME FROM</span>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <select
                data-testid="goal-flow-category"
                value={flowTrip ? '' : flowCat}
                onChange={(e) => {
                  setFlowCat(e.target.value)
                  setFlowTrip('')
                }}
                style={inputStyle}
              >
                <option value="">— a category —</option>
                {spendable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {vault.trackings.length > 0 && (
                <select
                  data-testid="goal-flow-trip"
                  value={flowCat ? '' : flowTrip}
                  onChange={(e) => {
                    setFlowTrip(e.target.value)
                    setFlowCat('')
                  }}
                  style={inputStyle}
                >
                  <option value="">— or a trip —</option>
                  {vault.trackings.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <span style={labelStyle}>{kind === 'pay-off' ? 'DOWN TO' : 'TARGET'}</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target" style={{ ...inputStyle, width: 140, fontFamily: MONO }} />
          </div>
          {kind === 'manual' && (
            <>
              <div>
                <span style={labelStyle}>SAVED SO FAR</span>
                {/* The field that made a manual goal usable: `saved` could never be changed from
                    anywhere in the app, so every one of them sat at 0 for life. */}
                <input data-testid="goal-saved" value={saved} onChange={(e) => setSaved(e.target.value)} placeholder="Saved" style={{ ...inputStyle, width: 140, fontFamily: MONO }} />
              </div>
              <div>
                <span style={labelStyle}>PER MONTH</span>
                <input value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="Monthly" style={{ ...inputStyle, width: 140, fontFamily: MONO }} />
              </div>
            </>
          )}
          <div>
            <span style={labelStyle}>BY WHEN (OPTIONAL)</span>
            <input
              data-testid="goal-target-date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              placeholder="2027-06"
              style={{ ...inputStyle, width: 140, fontFamily: MONO }}
            />
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: FAINT, marginBottom: 16, lineHeight: 1.5 }}>
          Without a date, the row shows the month it is projected to land and makes no judgement. With one, it says
          whether that projection lands before it.
        </div>

        <div style={{ marginBottom: 16 }}>
          <span style={labelStyle}>PREVIEW</span>
          <div style={{ border: `1px solid ${HAIR}`, borderRadius: 6, padding: '0 14px', background: SURFACE }}>
            <GoalRow
              name={candidate.name}
              detail={detailOf(candidate, vault, d)}
              kind={rowKind}
              fill={st.fraction}
              projected={st.eta != null}
              eta={st.eta}
              state={goalState(candidate, st)}
            />
          </div>
          <div style={{ fontSize: 11.5, color: FAINT, marginTop: 6 }}>
            {st.kind === 'legacy'
              ? `${fmt(st.progress)} of ${fmt(st.target)} by your own figures.`
              : `${fmt(st.progress)} of ${fmt(st.target)}, read from your data${st.asOf ? ` as of ${st.asOf}` : ''}.`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            data-testid="goal-save"
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
            {goal ? 'Save changes' : 'Add goal'}
          </button>
          {problem && <span data-testid="goal-problem" style={{ fontSize: 12, color: MUT }}>{problem}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The mono caption under a goal's name: where its progress is read from. */
export function detailOf(g: Goal, vault: { accounts: { id: string; name: string }[]; trackings: { id: string; name: string }[] }, d: ReturnType<typeof useDerived>): string {
  const s = g.source
  if (s?.kind === 'balance') return `balance-linked · ${vault.accounts.find((a) => a.id === s.accountId)?.name ?? '—'}`
  if (s?.kind === 'flow') {
    if (s.trackingId) return `contributions · ${vault.trackings.find((t) => t.id === s.trackingId)?.name ?? '—'}`
    return `contributions · ${d.catById.get(s.categoryId ?? '')?.name ?? '—'}`
  }
  return 'tracked by hand'
}
