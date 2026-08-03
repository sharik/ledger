// Settings → Exchange rates (mock 1210–1219, IMPORT §4.5). Shows per-currency
// coverage along the resolution chain, lets the user add/delete manual overrides
// (FxOverride records — in the vault), and refresh the API tier into the L1 cache.
import { useMemo, useState } from 'react'
import type { FxOverride } from '../../model/types'
import { useRawVault, useStore } from '../store'
import { useFx } from '../fxCtx'
import { rateFor } from '../../import/fx'
import { todayStr } from '../../model/selectors'
import { HAIR, INK, MUT, FAINT, GREEN, AMBER, ACCENT, MONO } from '../theme'
import { hairBottom, mono } from '../styles'

const uuid = (): string => (crypto.randomUUID?.() ?? String(Date.now() + Math.random()))

export function FxCard() {
  // RAW: a hidden foreign account still renders its converted balance on the Accounts
  // screen, so its currency must stay listed and refreshable here.
  const vault = useRawVault()
  const store = useStore()
  const { tables, refresh } = useFx()
  const base = vault.params.baseCurrency ?? 'EUR'
  const today = todayStr()

  const [busy, setBusy] = useState(false)
  const [ovFrom, setOvFrom] = useState('')
  const [ovRate, setOvRate] = useState('')
  const [ovDate, setOvDate] = useState(today)

  // Currencies that actually appear in the data (accounts + foreign legs), minus base.
  const currencies = useMemo(() => {
    const set = new Set<string>()
    for (const a of vault.accounts) if (a.currency && a.currency !== base) set.add(a.currency)
    for (const t of vault.transactions) {
      if (t.currency && t.currency !== base) set.add(t.currency)
      if (t.original && t.original.currency !== base) set.add(t.original.currency)
    }
    return [...set].sort()
  }, [vault.accounts, vault.transactions, base])

  // Dates worth fetching: the first day of each month holding a foreign row, plus
  // the current month so account-only foreign holdings (no txns) can still refresh.
  const fetchDates = useMemo(() => {
    const months = new Set<string>()
    for (const t of vault.transactions) {
      const foreign = (t.currency && t.currency !== base) || (t.original && t.original.currency !== base)
      if (foreign) months.add(t.date.slice(0, 7))
    }
    if (currencies.length > 0) months.add(today.slice(0, 7))
    return [...months].sort().map((m) => `${m}-01`)
  }, [vault.transactions, base, currencies, today])

  const sourceLabel = (cur: string): { text: string; color: string } => {
    const r = rateFor(vault, cur, base, today, tables)
    if (!r) return { text: 'no rate — excluded', color: AMBER }
    switch (r.source) {
      case 'bank-derived':
        return { text: `bank-derived ✓ · ${r.rate.toPrecision(5)}`, color: GREEN }
      case 'override':
        return { text: `manual override · ${r.rate.toPrecision(5)}`, color: INK }
      case 'api-exact':
        return { text: `cached · ${r.rate.toPrecision(5)}`, color: MUT }
      case 'api-nearest':
        return { text: `≈ nearest-earlier · ${r.rate.toPrecision(5)}`, color: AMBER }
      default:
        return { text: `${r.rate.toPrecision(5)}`, color: MUT }
    }
  }

  const overridesFor = (cur: string): FxOverride[] =>
    vault.fxOverrides.filter((o) => o.from === cur && o.to === base).sort((a, b) => (a.date < b.date ? 1 : -1))

  const addOverride = () => {
    const from = ovFrom || currencies[0]
    const rate = Number(ovRate)
    if (!from || !Number.isFinite(rate) || rate <= 0) return
    const rec: FxOverride = { id: uuid(), updatedAt: new Date().toISOString(), from, to: base, date: ovDate, rate }
    store.commit({ kind: 'restore', collection: 'fxOverrides', records: [rec] }, { msg: `Override ${from}→${base} saved`, undoable: true })
    setOvRate('')
  }

  const doRefresh = async () => {
    if (busy || fetchDates.length === 0) return
    setBusy(true)
    try {
      const n = await refresh(fetchDates, base, vault.settings.fx)
      store.showToast(n > 0 ? `Fetched ${n} rate table${n === 1 ? '' : 's'}` : 'No new rates fetched')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="fx-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Exchange rates</div>
        <button
          data-testid="fx-refresh"
          onClick={() => void doRefresh()}
          disabled={busy || fetchDates.length === 0}
          className="hov-ink"
          style={{ ...mono(10), color: fetchDates.length === 0 ? FAINT : ACCENT, background: 'none', border: 'none', cursor: fetchDates.length === 0 ? 'default' : 'pointer', letterSpacing: '.06em' }}
        >
          {busy ? 'REFRESHING…' : 'REFRESH RATES'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
        Each amount converts at its transaction-date rate into {base}. Bank-derived rates win; the rest are cached locally — never synced.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        {currencies.length === 0 && (
          <div style={{ fontSize: 12, color: FAINT, padding: '10px 0' }}>Every amount is already in {base}. Nothing to convert.</div>
        )}
        {currencies.map((cur) => {
          const s = sourceLabel(cur)
          const ovs = overridesFor(cur)
          return (
            <div key={cur} style={{ padding: '10px 0', ...hairBottom }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...mono(12), fontWeight: 600 }} data-testid={`fx-pair-${cur}`}>{cur} → {base}</span>
                <span style={{ ...mono(10.5), color: s.color }} data-testid={`fx-source-${cur}`}>{s.text}</span>
              </div>
              {ovs.map((o) => (
                <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 5, paddingLeft: 4 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>override {o.date} · {o.rate}</span>
                  <button onClick={() => store.commit({ kind: 'delete', collection: 'fxOverrides', ids: [o.id] }, { msg: 'Override removed', undoable: true })} style={{ fontSize: 11, color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {currencies.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <select value={ovFrom || currencies[0]} onChange={(e) => setOvFrom(e.target.value)} data-testid="fx-ov-from" style={selStyle}>
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span style={{ fontSize: 12, color: FAINT }}>→ {base} @</span>
          <input value={ovRate} onChange={(e) => setOvRate(e.target.value)} data-testid="fx-ov-rate" placeholder="rate" style={{ ...selStyle, width: 90, fontFamily: MONO }} />
          <input type="date" value={ovDate} onChange={(e) => setOvDate(e.target.value)} data-testid="fx-ov-date" style={{ ...selStyle, fontFamily: MONO }} />
          <button data-testid="fx-ov-add" onClick={addOverride} style={{ fontSize: 12, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>+ Override</button>
        </div>
      )}
    </div>
  )
}

const selStyle = { fontSize: 12.5, padding: '6px 9px', border: `1px solid ${HAIR}`, borderRadius: 5, background: 'var(--surface)', color: INK }
