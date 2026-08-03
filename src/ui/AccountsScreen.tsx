import { useNarrow } from './responsive'
import { Fragment, useMemo, useState } from 'react'
import type { Account, BalanceSnapshot } from '../model/types'
import { latestBalanceByAccount, todayStr } from '../model/selectors'
import { daysBetween } from '../analytics/selections'
import { coverage, driftHints, type CoverageSpan } from '../analytics/recon'
import { goalStatus } from '../analytics/goals'
import { useRawVault, useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { ACCENT, AMBER, BRICK, FAINT, GREEN, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2, WARNBG, curSym, fmt, fmtK, netLbl } from './theme'
import { ScreenIntro } from './ScreenIntro'
import { EmergencyFundWidget, NetWorthWidget } from './widgets/AccountsWidgets'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthYr = (mk: string) => `${MONTHS[Number(mk.slice(5, 7)) - 1]} ’${mk.slice(2, 4)}`


/** Snapshots grouped by account, each list ascending by date. */
function groupSnapshots(snapshots: BalanceSnapshot[]): Map<string, BalanceSnapshot[]> {
  const m = new Map<string, BalanceSnapshot[]>()
  for (const s of snapshots) {
    const arr = m.get(s.accountId) ?? []
    arr.push(s)
    m.set(s.accountId, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return m
}


// This is the one screen that needs both vaults at once: the KPI tiles and the net-worth
// chart must exclude hidden accounts, while the Balances list must still show them so they
// can be unhidden. `vault` is RAW (the list, snapshots, coverage, drift); `vv` is the
// projection that `d` was derived from (tiles, chart, goals).
export function AccountsScreen() {
  const narrow = useNarrow()
  const vault = useRawVault()
  const { vault: vv } = useStoreState()
  const store = useStore()
  const rates = useRateBook()
  const base = vault.params.baseCurrency ?? 'EUR'
  const today = todayStr()

  const [addAcct, setAddAcct] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [updId, setUpdId] = useState<string | null>(null)
  const [updDate, setUpdDate] = useState(today)
  const [updAmt, setUpdAmt] = useState('')

  // add-account form fields
  const [naType, setNaType] = useState('Checking')
  const [naName, setNaName] = useState('')
  const [naBal, setNaBal] = useState('')
  const [naCur, setNaCur] = useState('EUR')

  // Raw: the expanded panel lists a hidden account's own snapshot history.
  const snapsByAccount = useMemo(() => groupSnapshots(vault.snapshots), [vault.snapshots])
  // Raw balances, so a hidden row still shows its "as of" figure even though `d` no longer has it.
  const rawBalance = useMemo(() => latestBalanceByAccount(vault.snapshots), [vault.snapshots])


  const openUpdate = (accountId: string) => {
    setUpdId(accountId)
    setUpdDate(today)
    setUpdAmt('')
  }
  const saveSnapshot = (accountId: string) => {
    const amount = parseFloat(updAmt)
    if (!Number.isFinite(amount)) return
    store.commit(
      { kind: 'appendSnapshots', snapshots: [{ accountId, date: updDate, amount }] },
      { msg: 'Balance added', undoable: true },
    )
    setUpdId(null)
    setUpdAmt('')
  }

  const submitAddAccount = () => {
    const name = naName.trim()
    if (!name) return
    const liab = naType === 'Liability'
    const liquid = naType === 'Checking' || naType === 'Savings'
    store.commit(
      { kind: 'addAccount', account: { name, liab, liquid, currency: naCur } },
      { msg: 'Account added', undoable: true },
    )
    // Round-trip the entered opening balance as one dated snapshot (the account's
    // id is minted inside applyOp, so read it back from the freshly-updated store).
    const bal = Number(naBal)
    if (naBal.trim() !== '' && Number.isFinite(bal)) {
      const created = store.vault.accounts[store.vault.accounts.length - 1]
      if (created && created.name === name) {
        store.commit(
          { kind: 'appendSnapshots', snapshots: [{ accountId: created.id, date: today, amount: bal }] },
          { msg: 'Opening balance added', undoable: true },
        )
      }
    }
    setAddAcct(false)
    setNaName('')
    setNaBal('')
  }

  const mortgageGoal = vv.goals.find((g) => g.source?.kind === 'balance' && g.source.direction === 'down')
  const mStatus = mortgageGoal ? goalStatus(vv, mortgageGoal, today, rates) : null

  return (
    <div data-screen="accounts" className="rise">
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Accounts</h1>
        <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>
          Stock figures, each “as of” a date. Balances are typed or read from stmt anchors — never mixed with flow.
        </div>
      </div>
      <ScreenIntro id="accounts" />

      {/* net worth — extracted to `widgets/` so the dashboard can pin the same chart */}
      <div style={{ marginBottom: 16 }}>
        <NetWorthWidget params={{ range: '1y' }} />
      </div>

      {/* balances */}
      <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px', borderBottom: `1px solid ${HAIR}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Balances</div>
          <button data-testid="add-account" onClick={() => setAddAcct(!addAcct)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>
            <svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>Account
          </button>
        </div>
        {addAcct && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '13px 20px', borderBottom: `1px solid ${HAIR2}`, background: SURFACE2 }}>
            <select value={naType} onChange={(e) => setNaType(e.target.value)} style={{ fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK }}>
              <option>Checking</option><option>Savings</option><option>Investment</option><option>Property (asset)</option><option>Liability</option>
            </select>
            <input value={naName} onChange={(e) => setNaName(e.target.value)} data-testid="account-name-input" placeholder="Account name" style={{ fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK }} />
            <input value={naBal} onChange={(e) => setNaBal(e.target.value)} placeholder="Balance today" style={{ fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, width: 130, fontFamily: MONO }} />
            <select value={naCur} onChange={(e) => setNaCur(e.target.value)} title="Currency" style={{ fontSize: 13, padding: '7px 10px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, fontFamily: MONO }}>
              <option>EUR</option><option>USD</option><option>GBP</option><option>PLN</option>
            </select>
            <span style={{ fontSize: 11.5, color: FAINT }}>stored as one dated snapshot</span>
            <div style={{ flex: 1 }} />
            <button data-testid="add-account-go" onClick={submitAddAccount} style={{ fontSize: 12.5, color: 'var(--on-accent)', background: ACCENT, padding: '7px 14px', borderRadius: 5, fontWeight: 500, border: 'none', cursor: 'pointer' }}>Add</button>
            <button onClick={() => setAddAcct(false)} style={{ fontSize: 12.5, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
          </div>
        )}
        <div style={{ display: narrow ? 'none' : 'grid', gridTemplateColumns: '1fr 120px 160px', gap: 12, padding: '11px 20px', borderBottom: `1px solid ${HAIR}`, fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.05em' }}>
          <div>ACCOUNT</div><div>AS OF</div><div style={{ textAlign: 'right' }}>BALANCE</div>
        </div>
        {vault.accounts.map((a) => (
          <Fragment key={a.id}>
            <AccountRow
              a={a}
              bal={rawBalance.get(a.id)}
              base={base}
              convert={(amount, date) => rates.convert(amount, a.currency, date)}
              today={today}
              // A retired account drifts by definition — nagging about it is the noise being escaped.
              hints={a.hidden ? [] : driftHints(vault, a.id)}
              expanded={expanded === a.id}
              onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
              onUpdate={() => openUpdate(a.id)}
              updating={updId === a.id}
              updDate={updDate}
              updAmt={updAmt}
              setUpdDate={setUpdDate}
              setUpdAmt={setUpdAmt}
              onSave={() => saveSnapshot(a.id)}
              onCancel={() => setUpdId(null)}
            />
            {expanded === a.id && (
              <AccountDetail
                a={a}
                snaps={snapsByAccount.get(a.id) ?? []}
                spans={coverage(vault, a.id, today)}
                onUpdate={() => openUpdate(a.id)}
                onClose={() => setExpanded(null)}
              />
            )}
          </Fragment>
        ))}
      </section>

      {/* debt + goal */}
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.5fr 1fr', gap: 16, alignItems: 'start' }}>
        <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{mortgageGoal?.name ?? 'Debt payoff'}</div>
            <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>balance-linked · target {curSym()}0</span>
          </div>
          {mStatus && mStatus.snapshots && mStatus.snapshots.length > 0 ? (
            <MortgageCard status={mStatus} />
          ) : (
            <div style={{ fontSize: 12.5, color: FAINT, marginTop: 10 }}>No linked liability snapshots yet.</div>
          )}
        </section>

        <EmergencyFundWidget />
      </div>
    </div>
  )
}

/**
 * Which statement periods this account actually holds, drawn to scale across its lifetime.
 * The question it answers — "which months did I forget to import?" — has no other surface:
 * the `stmt-gap` note fires once at import and is dismissible, and drift hints need a
 * balance anchor on both sides of a hole, so neither can see a period you simply skipped.
 */
function CoverageBar({ spans }: { spans: CoverageSpan[] }) {
  if (spans.length === 0) return null
  const total = spans.reduce((n, s) => n + s.days, 0)
  const gaps = spans.filter((s) => s.kind === 'gap')
  const label = (s: CoverageSpan) =>
    s.kind === 'covered'
      ? `${s.from} → ${s.to} · ${s.files!.map((f) => f.fileName).join(', ')} · ${s.files!.reduce((n, f) => n + f.rows, 0)} rows`
      : s.trailing
        ? `Nothing imported since ${s.from} · ${s.days} days`
        : `Missing ${s.from} → ${s.to} · ${s.days} days`

  return (
    <div style={{ marginBottom: 14 }} data-testid="coverage">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.05em' }}>STATEMENT COVERAGE</span>
        <span style={{ fontSize: 11.5, color: gaps.length ? AMBER : FAINT }} data-testid="coverage-summary">
          {gaps.length === 0 ? 'no gaps' : `${gaps.length} gap${gaps.length === 1 ? '' : 's'} · ${gaps.reduce((n, g) => n + g.days, 0)} days missing`}
        </span>
      </div>
      <div style={{ display: 'flex', height: 20, borderRadius: 3, overflow: 'hidden', border: `1px solid ${HAIR2}` }}>
        {spans.map((s) => (
          <div
            key={`${s.kind}-${s.from}`}
            data-testid={s.kind === 'gap' ? 'coverage-gap' : 'coverage-covered'}
            title={label(s)}
            style={{
              // Every span keeps a sliver of width so a one-week hole in three years stays clickable.
              flex: `${Math.max(s.days, total * 0.004)} 0 0`,
              background: s.kind === 'covered' ? GREEN : WARNBG,
              borderLeft: s.kind === 'gap' ? `1px dashed ${AMBER}` : undefined,
              borderRight: s.kind === 'gap' ? `1px dashed ${AMBER}` : undefined,
              opacity: s.kind === 'covered' ? 0.55 : 1,
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>{spans[0]!.from}</span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>{spans[spans.length - 1]!.to}</span>
      </div>
      {gaps.map((g) => (
        <div key={g.from} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }} data-testid="coverage-gap-row">
          <span style={{ fontFamily: MONO, fontSize: 11, color: AMBER }}>⚠</span>
          <span style={{ fontSize: 12, color: MUT }}>
            {g.trailing ? 'Nothing imported since' : 'Missing'} <b style={{ fontFamily: MONO, fontWeight: 500 }}>{g.from}</b>
            {g.trailing ? '' : <> → <b style={{ fontFamily: MONO, fontWeight: 500 }}>{g.to}</b></>}
            <span style={{ color: FAINT }}> · {g.days} days</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** Snapshot history for one account, rendered directly beneath its own row. */
function AccountDetail({
  a,
  snaps,
  spans,
  onUpdate,
  onClose,
}: {
  a: Account
  snaps: BalanceSnapshot[]
  spans: CoverageSpan[]
  onUpdate: () => void
  onClose: () => void
}) {
  const narrow = useNarrow()
  const store = useStore()
  const rows = [...snaps].sort((x, y) => (x.date < y.date ? 1 : -1))
  const hidden = !!a.hidden
  return (
    <div style={{ padding: '14px 20px', background: SURFACE2, borderBottom: `1px solid ${HAIR}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{a.name} · coverage &amp; snapshots</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            data-testid={hidden ? 'account-unhide' : 'account-hide'}
            aria-label={hidden
              ? 'Hidden from every chart, total and the transaction list — tap to bring it back'
              : 'Counted everywhere — tap to hide it from charts, totals and the transaction list'}
            // `!hidden || undefined` writes `undefined` when unhiding, so the field returns to
            // absent rather than lingering as `false` — matching what setField's inverse restores.
            onClick={() => store.commit(
              { kind: 'setField', collection: 'accounts', id: a.id, field: 'hidden', value: hidden ? undefined : true },
              { msg: hidden ? `“${a.name}” is counted again` : `“${a.name}” hidden from charts and lists`, undoable: true },
            )}
            style={{ fontSize: 12, fontWeight: 500, color: hidden ? FAINT : ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {hidden ? 'Hidden' : 'Counted'}
          </button>
          <button onClick={onUpdate} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>+ Add today's balance</button>
          <button onClick={onClose} style={{ fontSize: 12, color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>Close</button>
        </div>
      </div>
      <CoverageBar spans={spans} />
      <div style={{ display: narrow ? 'none' : 'grid', gridTemplateColumns: '1fr 160px 150px', gap: 12, fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.05em', paddingBottom: 4 }}>
        <div>DATE</div><div style={{ textAlign: 'right' }}>BALANCE</div><div style={{ textAlign: 'right' }}>SOURCE</div>
      </div>
      {rows.map((s) => (
        <div key={s.id} style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr auto' : '1fr 160px 150px', gap: 12, padding: '7px 0', borderTop: `1px solid ${HAIR2}`, alignItems: 'center' }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: MUT }}>{s.date}</div>
          <div style={{ fontFamily: MONO, fontSize: 12.5, textAlign: 'right', color: INK }}>{(a.liab && s.amount > 0 ? '−' : '') + fmt(s.amount)}</div>
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, textAlign: 'right' }}>{s.origin?.kind === 'anchor' ? 'anchor' : 'manual'}</div>
        </div>
      ))}
      {rows.length === 0 && <div style={{ fontSize: 12, color: FAINT, padding: '8px 0' }}>No snapshots yet.</div>}
    </div>
  )
}

function AccountRow({
  a,
  bal,
  base,
  convert,
  today,
  hints,
  expanded,
  onToggle,
  onUpdate,
  updating,
  updDate,
  updAmt,
  setUpdDate,
  setUpdAmt,
  onSave,
  onCancel,
}: {
  a: Account
  bal: { amount: number; date: string } | undefined
  base: string
  convert: (amount: number, date: string) => { value: number; approx: boolean } | null
  today: string
  hints: { message: string }[]
  expanded: boolean
  onToggle: () => void
  onUpdate: () => void
  updating: boolean
  updDate: string
  updAmt: string
  setUpdDate: (v: string) => void
  setUpdAmt: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const narrow = useNarrow()
  const hidden = !!a.hidden
  // A hidden account is already out of every total; STALE would just restate that it's retired.
  const stale = !hidden && bal ? daysBetween(bal.date, today) > 45 : false
  const staleDays = bal ? daysBetween(bal.date, today) : 0
  const dot = a.liab ? BRICK : a.liquid ? GREEN : ACCENT
  const foreign = !!a.currency && a.currency !== base
  const converted = foreign && bal ? convert(bal.amount, bal.date) : null
  const sub = [a.institution, a.last4 ? `····${a.last4}` : null].filter(Boolean).join(' ')
  const drift = hints[0]
  return (
    <>
      <div
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label="View snapshot history"
        style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr auto' : '1fr 120px 160px', gap: narrow ? 8 : 12, padding: narrow ? '13px 14px' : '13px 20px', borderBottom: `1px solid ${HAIR2}`, alignItems: 'center', cursor: 'pointer', background: expanded ? SURFACE2 : undefined, opacity: hidden ? 0.45 : undefined }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, flex: 'none', background: dot }} />
          <div>
            <span style={{ fontSize: 14, fontWeight: 500, color: INK }}>{a.name}</span>{' '}
            {sub && <span style={{ fontSize: 11.5, color: FAINT }}>{sub}</span>}
            {a.currency && a.currency !== 'EUR' && (
              <> <span style={{ fontFamily: MONO, fontSize: 9, color: ACCENT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '1px 5px' }}>{a.currency}</span></>
            )}
            {hidden && (
              <> <span data-testid={`account-hidden-badge-${a.name}`} style={{ fontFamily: MONO, fontSize: 9, color: FAINT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '1px 5px' }}>HIDDEN</span></>
            )}
            {stale && <> <span style={{ fontFamily: MONO, fontSize: 9, color: AMBER }}>STALE · {staleDays} DAYS</span></>}
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: stale ? AMBER : MUT }}>{bal ? bal.date : '—'}</div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: MONO, fontSize: 14, color: a.liab ? BRICK : INK }} data-testid={`balance-${a.name}`}>{bal ? (a.liab && bal.amount > 0 ? '−' : '') + fmt(bal.amount) : '—'}</div>
          {foreign && converted && (
            <div data-testid={`balance-conv-${a.name}`} style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 1 }}>
              {converted.approx ? '≈ ' : '= '}{(a.liab && converted.value > 0 ? '−' : '') + fmt(converted.value)} {base}
            </div>
          )}
          <button onClick={(e) => { e.stopPropagation(); onUpdate() }} style={{ fontSize: 11, color: ACCENT, marginTop: 1, background: 'none', border: 'none', cursor: 'pointer' }}>Update balance</button>
        </div>
      </div>
      {drift && (
        <div style={{ padding: '9px 20px 9px 37px', borderBottom: `1px solid ${HAIR2}`, display: 'flex', alignItems: 'center', gap: 8, background: WARNBG }}>
          <span style={{ fontFamily: MONO, fontSize: 12, color: AMBER }}>≈</span>
          <span style={{ fontSize: 12, color: MUT }}>{drift.message}</span>
        </div>
      )}
      {updating && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 20px 11px 37px', borderBottom: `1px solid ${HAIR2}`, background: SURFACE2 }}>
          <input type="date" value={updDate} onChange={(e) => setUpdDate(e.target.value)} style={{ fontSize: 13, padding: '6px 9px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, fontFamily: MONO }} />
          <input value={updAmt} onChange={(e) => setUpdAmt(e.target.value)} data-testid={`edit-${a.name}`} placeholder="Balance" style={{ fontSize: 13, padding: '6px 9px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, width: 130, fontFamily: MONO }} />
          <button onClick={onSave} style={{ fontSize: 12.5, color: 'var(--on-accent)', background: ACCENT, padding: '6px 13px', borderRadius: 5, fontWeight: 500, border: 'none', cursor: 'pointer' }}>Save</button>
          <button onClick={onCancel} style={{ fontSize: 12.5, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
    </>
  )
}

function MortgageCard({ status }: { status: { progress: number; snapshots?: number[]; eta: string | null; asOf?: string } }) {
  const snaps = status.snapshots ?? []
  const delta = snaps.length > 1 ? snaps[snaps.length - 1]! - snaps[0]! : 0
  const etaYear = status.eta ? status.eta.slice(0, 4) : '—'

  // chart geometry: viewBox 0 0 420 184; plot 60..360 × 30..150
  const L = 60
  const R = 360
  const T = 30
  const B = 150
  let maxV = Math.max(...snaps)
  let minV = Math.min(...snaps)
  if (maxV === minV) { maxV += Math.max(1, Math.abs(maxV) * 0.05); minV -= Math.max(1, Math.abs(minV) * 0.05) }
  const pad = (maxV - minV) * 0.2
  const top = maxV + pad
  const bot = minV - pad
  const x = (i: number) => (snaps.length <= 1 ? L : L + (i / (snaps.length - 1)) * (R - L))
  const y = (v: number) => T + ((top - v) / (top - bot)) * (B - T)
  const grid = [T, 90, B].map((gy) => ({ gy, v: top - ((gy - T) / (B - T)) * (top - bot) }))
  const line = snaps.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastI = snaps.length - 1

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginTop: 8 }}>
        <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1, color: INK }}>{fmt(status.progress)}</div>
        <div style={{ fontSize: 12, color: FAINT, paddingBottom: 2 }}>
          from {snaps.length} snapshot{snaps.length === 1 ? '' : 's'} · <span style={{ color: delta <= 0 ? GREEN : BRICK }}>{netLbl(delta)}</span> to date
        </div>
      </div>
      <svg viewBox="0 0 420 184" width="100%" style={{ display: 'block', marginTop: 10, overflow: 'visible' }}>
        {grid.map((g) => (
          <line key={g.gy} x1={L} x2={R} y1={g.gy} y2={g.gy} stroke={g.gy === B ? HAIR : HAIR2} strokeWidth="1" />
        ))}
        {grid.map((g) => (
          <text key={`t${g.gy}`} x={54} y={g.gy + 3} textAnchor="end" fontFamily="IBM Plex Mono" fontSize="9.5" fill={FAINT}>{fmtK(g.v)}</text>
        ))}
        {snaps.length > 1 && <polyline points={line} fill="none" stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />}
        <polyline points={`${x(lastI).toFixed(1)},${y(snaps[lastI]!).toFixed(1)} ${R},${B}`} fill="none" stroke={FAINT} strokeWidth="1.6" strokeDasharray="4 4" />
        {snaps.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === lastI ? 3.6 : 3} fill={INK} />
        ))}
        <text x={x(lastI)} y={y(snaps[lastI]!) - 8} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="10" fontWeight="600" fill={INK}>{fmt(snaps[lastI]!)}</text>
        <text x={R} y={B - 1} fontFamily="IBM Plex Mono" fontSize="9.5" fill={FAINT}>→ €0 ≈ {etaYear}</text>
        {status.asOf && <text x={R} y={172} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="9.5" fill={FAINT}>{monthYr(status.asOf.slice(0, 7))}</text>}
      </svg>
      <div style={{ fontSize: 11.5, color: FAINT, marginTop: 6 }}>Projection is a linear fit over recent snapshots — no amortization model, no rate assumed.</div>
    </>
  )
}
