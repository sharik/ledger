// GoalRow + BudgetRow — ported from specs/design/GoalRow.dc.html and BudgetRow.dc.html.
// Dumb presentational rows: the screen computes analytics → these display props.
import { phoneMenu } from '../styles'
import { useNarrow } from '../responsive'
import { useState } from 'react'
import { AMBER, BRICK, CHIP, FAINT, GREEN, HAIR, INK, MONO, MUT, NEGBG, SURFACE2, fmt } from '../theme'
import { Explain } from '../explain'
import type { ExplainId } from '../explain'
import type { GoalState } from '../../analytics/goals'

/**
 * Word and colour per state, in one place — both Plan and the Dashboard used to build these
 * strings themselves, from a two-way `eta ? 'on schedule' : 'behind'`.
 */
const STATE_COPY: Record<GoalState, { label: string; color: string }> = {
  done: { label: 'reached', color: GREEN },
  'on-schedule': { label: 'on schedule', color: GREEN },
  behind: { label: 'behind its date', color: AMBER },
  // An ETA with no target date is a projection, not a verdict: there is no schedule to be on.
  projected: { label: 'no target date', color: FAINT },
  unknown: { label: 'not enough history yet', color: FAINT },
  'account-removed': { label: 'account removed', color: AMBER },
}

export interface GoalRowProps {
  name: string
  detail: string
  kind: 'up' | 'down' | 'legacy'
  /**
   * Progress as a fraction, 0..1+. CLAMPED here rather than by each caller: a goal past its
   * target has a fraction above 1, and rendering that raw made a 422%-wide fill that overflowed
   * the track and covered the row's own ⋯ menu. Over-target is carried by `state: 'done'`.
   */
  fill?: number
  spark?: string // 'down' trajectory points "x,y x,y …"
  /** True when a real ETA exists — draws the dashed payoff projection. */
  projected?: boolean
  /** The month the goal is projected to land, or null when nothing can be projected. */
  eta?: string | null
  state: GoalState
  onEdit?: () => void
  onArchive?: () => void
  onDelete?: () => void
}

export function GoalRow({ name, detail, kind, fill = 0, spark, projected = false, eta, state, onEdit, onArchive, onDelete }: GoalRowProps) {
  const narrow = useNarrow()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const copy = STATE_COPY[state]
  const stateCol = copy.color
  const dotCol = state === 'done' || state === 'on-schedule' ? 'var(--pos)' : state === 'projected' || state === 'unknown' ? 'var(--ink3)' : 'var(--warn)'
  const sub = eta ? `ETA ${eta}` : state === 'account-removed' ? 'account removed' : 'no date yet'

  // 'down' trajectory: solid actuals in the left third scaled to x∈[0,108]; dashed
  // projection to €0 only when the caller has a real ETA. Fewer than 2 snapshots
  // is no trajectory — never draw an invented line.
  let sparkA = ''
  let sparkP = ''
  let nowX = 0
  const pts = (spark ?? '').trim() ? (spark ?? '').trim().split(/\s+/).map((s) => s.split(',').map(Number)) : []
  const hasTrajectory = kind === 'down' && pts.length >= 2
  if (hasTrajectory) {
    const maxX = Math.max(...pts.map((q) => q[0]!)) || 1
    const A = pts.map((q) => [Math.round((q[0]! / maxX) * 108), Math.round(q[1]!)])
    sparkA = A.map((q) => q.join(',')).join(' ')
    const last = A[A.length - 1]!
    nowX = last[0]!
    sparkP = projected ? `${last.join(',')} 356,38` : ''
  }

  return (
    <div data-goal-row={name} style={{ position: 'relative', borderTop: `1px solid var(--hair2)` }}>
      {/* 190 + 300 fixed px plus gaps needs ~522, so at 390 the state column and its ⋯ menu sat
          off-screen. Stacked, the name leads, the bar spans the width it deserves, and the state
          row lands under them. */}
      <div
        style={
          narrow
            ? { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0' }
            : { display: 'grid', gridTemplateColumns: '190px 1fr 300px', gap: 16, alignItems: 'center', padding: '12px 0' }
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: dotCol }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: INK }}>{name}</div>
            <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{detail}</div>
          </div>
        </div>
        <div>
          {(kind === 'up' || kind === 'legacy') && (
            <div style={{ position: 'relative', height: 10, background: CHIP, borderRadius: 5 }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 5, width: `${(Math.min(1, Math.max(0, fill)) * 100).toFixed(1)}%` }} />
              <div aria-hidden style={{ position: 'absolute', left: '100%', top: -4, bottom: -4, width: 1.5, background: INK, transform: 'translateX(-1px)' }} />
            </div>
          )}
          {kind === 'down' && hasTrajectory && (
            <svg viewBox="0 0 360 40" width="100%" height={34} preserveAspectRatio="none" style={{ display: 'block', minWidth: 140, overflow: 'visible' }}>
              <line x1={nowX} y1={0} x2={nowX} y2={40} stroke="var(--ink3)" strokeWidth={1} strokeDasharray="2 2" opacity={0.45} />
              <polyline points={sparkA} fill="none" stroke="var(--ink2)" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              {sparkP && <polyline points={sparkP} fill="none" stroke="var(--ink3)" strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" />}
            </svg>
          )}
          {kind === 'down' && !hasTrajectory && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>not enough balance history to chart</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: narrow ? 'flex-start' : 'flex-end', gap: 8, whiteSpace: 'nowrap', flexWrap: narrow ? 'wrap' : 'nowrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: MUT }}>{sub}</span>
          <span style={{ color: HAIR }}>·</span>
          <span style={{ fontSize: 10.5, color: stateCol }}>{copy.label}</span>
          <button onClick={() => { setMenu((m) => !m); setConfirm(false) }} aria-label="Goal options" style={{ color: FAINT, fontSize: 17, lineHeight: 0.3, padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}>⋯</button>
        </div>
      </div>
      {menu && (
        <div style={{ position: 'absolute', right: 0, top: 46, zIndex: 30, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, background: SURFACE2, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 158, boxShadow: '0 10px 28px rgba(10,9,7,.16)' , ...phoneMenu(narrow) }}>
          {onEdit && <MenuBtn onClick={() => { setMenu(false); onEdit() }}>Edit goal…</MenuBtn>}
          {onArchive && <MenuBtn onClick={() => { setMenu(false); onArchive() }}>Archive</MenuBtn>}
          {onDelete && <MenuBtn danger onClick={() => { setMenu(false); setConfirm(true) }}>Delete…</MenuBtn>}
        </div>
      )}
      {confirm && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', marginBottom: 11, background: NEGBG, borderRadius: 6 }}>
          <span style={{ fontSize: 12.5, color: MUT, flex: 1 }}>Delete “{name}”? Removes the goal only — never the account it tracks.</span>
          <button onClick={() => { setConfirm(false); onDelete?.() }} style={{ fontSize: 12, color: '#fff', background: 'var(--neg)', padding: '6px 12px', borderRadius: 5, fontWeight: 600, border: 'none', cursor: 'pointer' }}>Delete</button>
          <button onClick={() => setConfirm(false)} style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
    </div>
  )
}

function MenuBtn({ children, danger, onClick }: { children: React.ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ textAlign: 'left', fontSize: 12.5, color: danger ? 'var(--neg)' : MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>
      {children}
    </button>
  )
}

/** A group budget with no name of its own: first two members, then "+N more". */
export function groupTitle(members: ({ name: string } | undefined)[]): string {
  const names = members.map((m) => m?.name ?? '—')
  return names.length <= 2 ? names.join(' + ') : `${names.slice(0, 2).join(' + ')} +${names.length - 2} more`
}

export interface BudgetRowProps {
  cat: string
  caption?: string // scope caption (annual / per-event); absent ⇒ monthly
  /** Registry id for a "?" beside the label — the slot `ChartCard` already has for a titled
   *  figure. The roll-up row uses it so `plan.rollup` sits on the figure it describes. */
  explain?: ExplainId
  color: string
  /** Member swatches for a multi-category budget, in place of the single square. */
  colors?: string[]
  spent: number
  budget: number
  proj: number
  /**
   * Shared bullet domain for the whole list, in multiples of each row's budget
   * (computeBudgetDomain). The budget tick sits at 1/domainMax of the track for
   * EVERY row and fills stay proportional — €850/€500 is visibly longer than
   * €1,536/€1,500, which the old clamped bar rendered identically.
   */
  domainMax: number
  done?: boolean
  first?: boolean // render the 'today' label
  elapsed?: number // 0..1; ≥1 (scoped/full-period) hides the today marker
  /**
   * 0..1 of the period the imported statements actually cover. Drawn as a second marker only
   * when it lags `elapsed` — the gap between "time gone" and "charges we have" is the whole
   * reason the projection could look comfortable, so it has to be visible, not just corrected.
   */
  covered?: number
  /** Words for what the pace divided by, e.g. '23 days of data'. */
  paceBasis?: string
  /** Drill to the transactions this bar was measured from. Absent ⇒ the label is not a link. */
  onOpen?: () => void
  /** Disclosure for the period-history panel the caller renders underneath. */
  expanded?: boolean
  onToggle?: () => void
  onEdit?: () => void
  canDelete?: boolean
  onDelete?: () => void
}

export function BudgetRow({ cat, caption, explain, color, colors, spent, budget, proj, domainMax, done = false, first = false, elapsed = 0.39, covered, paceBasis, onOpen, expanded, onToggle, onEdit, canDelete = false, onDelete }: BudgetRowProps) {
  const narrow = useNarrow()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // A €0 budget has no meaningful pace — render the row without pretending
  // "€430 / €0 is 100% + over". The bar shows no fill and no over segment.
  const noBudget = budget <= 0
  const b = noBudget ? Infinity : budget
  const dm = Math.max(1.0001, domainMax)
  const toPct = (ratio: number) => (Math.min(ratio, dm) / dm) * 100
  const overspent = !done && !noBudget && spent > b
  const overPace = !done && !noBudget && proj > b
  const hue = color || 'var(--c-other)'
  const tickX = toPct(1)
  const fillW = toPct(spent / b) // proportional, unclamped below the domain cap
  const baseW = Math.min(fillW, tickX) // within-budget portion keeps the category hue
  const todayX = elapsed * tickX
  const projX = toPct(proj / b)
  const fillColor = done ? 'var(--ink3)' : hue
  const pct = noBudget ? null : Math.round((spent / b) * 100)

  const paceNote = overPace ? `pace ${fmt(proj)}` : `→ ${fmt(proj)} proj`
  // The basis rides with the figure: a rate is meaningless without the window it was measured
  // over, and this one is the imported window, not the calendar month.
  const note = done
    ? 'billed monthly · done'
    : noBudget
      ? 'no budget set'
      : paceBasis
        ? `${paceNote} · over ${paceBasis}`
        : paceNote
  const noteColor = done ? GREEN : overPace ? BRICK : FAINT
  // Only worth drawing when the statements lag the calendar — otherwise it sits on `today`.
  const coveredX = covered != null && covered < elapsed ? covered * tickX : null

  return (
    <div style={{ padding: '13px 0', borderBottom: `1px solid var(--hair2)`, position: 'relative' }} data-pct={pct ?? undefined} data-over={overspent || undefined}>
      {/* On a phone this cannot be one row: the note is `nowrap` and the figures are
          `flex: none`, so "pace €1,570" and "€608 / €1,340 45%" ran into each other. Two
          lines — identity above, arithmetic below — and nothing has to shrink. */}
      <div style={narrow ? { marginBottom: 9 } : { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          {colors && colors.length > 1 ? (
            // Stacked swatches: a budget over several categories has no single colour to claim.
            <span style={{ display: 'inline-flex', flex: 'none', borderRadius: 2, overflow: 'hidden' }}>
              {colors.slice(0, 3).map((c, i) => (
                <span key={i} style={{ width: 9 / Math.min(3, colors.length) + 2, height: 9, background: c }} />
              ))}
            </span>
          ) : (
            <span style={{ width: 9, height: 9, borderRadius: 2, flex: 'none', background: hue }} />
          )}
          {onOpen ? (
            // The label is the drill. A whole-row click would fight the disclosure and the
            // delete button; the name is the thing a reader points at to mean "show me these".
            <button
              data-testid="budget-open"
              onClick={onOpen}
              aria-label={`Open ${cat} →`}
              style={{ fontSize: 14, fontWeight: 500, color: INK, display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
            >
              {cat}
            </button>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 500, color: INK, display: 'inline-flex', alignItems: 'center' }}>{cat}</span>
          )}
          {explain && <Explain id={explain} size="sm" />}
          {caption && <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '1px 5px' }}>{caption}</span>}
          {!narrow && <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: noteColor }}>{note}</span>}
          {narrow && <span style={{ flex: 1 }} />}
          {narrow && (
            <span style={{ flex: 'none' }}>
          {(onToggle || onEdit || canDelete) && (
            <button
              data-testid="budget-menu"
              onClick={() => { setMenu((m) => !m); setConfirm(false) }}
              title="Budget options"
              aria-label="Budget options"
              aria-expanded={menu}
              style={{ color: FAINT, fontSize: 17, lineHeight: 0.3, padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ⋯
            </button>
          )}
            </span>
          )}
        </div>
        {narrow ? (
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 4 }}>
            <span style={{ fontSize: 12, color: noteColor, minWidth: 0 }}>{note}</span>
          <div style={{ fontFamily: MONO, fontSize: 13 }}>
            <span>{fmt(spent)}</span> <span style={{ color: FAINT }}>/ <span>{fmt(budget)}</span></span>
            {pct !== null && <span style={{ color: overspent ? BRICK : FAINT, fontSize: 11, marginLeft: 8 }}>{pct}%</span>}
          </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 'none' }}>
          <div style={{ fontFamily: MONO, fontSize: 13 }}>
            <span>{fmt(spent)}</span> <span style={{ color: FAINT }}>/ <span>{fmt(budget)}</span></span>
            {pct !== null && <span style={{ color: overspent ? BRICK : FAINT, fontSize: 11, marginLeft: 8 }}>{pct}%</span>}
          </div>
          {(onToggle || onEdit || canDelete) && (
            <button
              data-testid="budget-menu"
              onClick={() => { setMenu((m) => !m); setConfirm(false) }}
              title="Budget options"
              aria-label="Budget options"
              aria-expanded={menu}
              style={{ color: FAINT, fontSize: 17, lineHeight: 0.3, padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              ⋯
            </button>
          )}
          </div>
        )}
      </div>
      {menu && (
        <div style={{ position: 'absolute', right: 0, top: 34, zIndex: 30, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, background: SURFACE2, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 158, boxShadow: '0 10px 28px rgba(10,9,7,.16)', ...phoneMenu(narrow) }}>
          {onEdit && <MenuBtn onClick={() => { setMenu(false); onEdit() }}>Edit budget…</MenuBtn>}
          {onToggle && (
            <MenuBtn onClick={() => { setMenu(false); onToggle() }}>
              <span data-testid="budget-expand">{expanded ? 'Hide history' : 'Show history'}</span>
            </MenuBtn>
          )}
          {canDelete && <MenuBtn danger onClick={() => { setMenu(false); setConfirm(true) }}>Remove…</MenuBtn>}
        </div>
      )}
      {confirm && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', marginBottom: 11, background: NEGBG, borderRadius: 6 }}>
          <span style={{ fontSize: 12.5, color: MUT, flex: 1 }}>Remove the budget for “{cat}”? The transactions it measured are untouched.</span>
          <button data-testid="budget-delete" onClick={() => { setConfirm(false); onDelete?.() }} style={{ fontSize: 12, color: '#fff', background: 'var(--neg)', padding: '6px 12px', borderRadius: 5, fontWeight: 600, border: 'none', cursor: 'pointer' }}>Remove</button>
          <button data-testid="budget-delete-cancel" onClick={() => setConfirm(false)} style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
      <div style={{ position: 'relative', height: 10, background: CHIP, borderRadius: 5 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${baseW.toFixed(2)}%`, background: fillColor, borderRadius: fillW > tickX ? '5px 0 0 5px' : 5 }} />
        {fillW > tickX && (
          <div style={{ position: 'absolute', left: `${tickX.toFixed(2)}%`, top: 0, bottom: 0, width: `${(fillW - tickX).toFixed(2)}%`, background: 'var(--neg)', borderRadius: '0 3px 3px 0' }} title={`${fmt(spent - budget)} over budget`} />
        )}
        {!done && elapsed < 1 && <div style={{ position: 'absolute', left: `${todayX.toFixed(2)}%`, top: -4, bottom: -4, width: 1, background: 'var(--ink3)' }} title={`today · ${Math.round(elapsed * 100)}% elapsed`} />}
        {first && !done && elapsed < 1 && (
          <div style={{ position: 'absolute', bottom: '100%', marginBottom: 3, left: `${todayX.toFixed(2)}%`, transform: 'translateX(-50%)', fontSize: 9, color: FAINT, whiteSpace: 'nowrap', fontFamily: MONO }}>today</div>
        )}
        {coveredX !== null && (
          <div
            style={{ position: 'absolute', left: `${coveredX.toFixed(2)}%`, top: -4, bottom: -4, width: 0, borderLeft: '1px dotted var(--ink3)' }}
            title={`charges imported through ${Math.round(covered! * 100)}% of the period — the gap to "today" is not yet in this bar`}
          />
        )}
        {first && coveredX !== null && (
          <div style={{ position: 'absolute', bottom: '100%', marginBottom: 3, left: `${coveredX.toFixed(2)}%`, transform: 'translateX(-50%)', fontSize: 9, color: FAINT, whiteSpace: 'nowrap', fontFamily: MONO }}>data</div>
        )}
        {!noBudget && <div style={{ position: 'absolute', left: `${tickX.toFixed(2)}%`, top: -3, bottom: -3, width: 1.5, background: 'var(--ink2)' }} title="budget" />}
        {!done && !noBudget && proj > spent && (
          <div style={{ position: 'absolute', left: `${projX.toFixed(2)}%`, top: -4, bottom: -4, width: 0, borderLeft: `2px dashed ${overPace ? 'var(--neg)' : hue}` }} title={`projected ${fmt(proj)}`} />
        )}
        {done && <div style={{ position: 'absolute', left: `${fillW.toFixed(2)}%`, top: '50%', transform: 'translate(5px,-50%)', fontSize: 10, color: 'var(--pos)', lineHeight: 1 }}>✓</div>}
      </div>
    </div>
  )
}
