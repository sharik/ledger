// Settings → Duplicate imports. Ring-1 dedup only catches a re-import when the row's hash matches,
// so a statement re-imported in another variant — or an export that renames a merchant to its payment
// processor — lands twice and nothing notices. This card is the standing audit for that: it groups
// findings by the FILE PAIR that restates itself, which is what makes the verdict trustworthy (a pair
// of rows on its own carries no signal — see `analytics/duplicates`).
import { useMemo, useState } from 'react'
import { findDuplicateImports, resolveDuplicatesOp, type DupPair } from '../../analytics/duplicates'
import { useStore, useStoreState } from '../store'
import { INK, MUT, FAINT, GREEN, AMBER, ACCENT } from '../theme'
import { btnOutline, hairBottom, mono } from '../styles'

const fmtDate = (d: string): string => {
  const [y, m, day] = d.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(day)} ${months[Number(m) - 1]} ${y!.slice(2)}`
}
const eur = (n: number): string => `€${Math.abs(n).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function DuplicatesCard() {
  const { vault } = useStoreState()
  const store = useStore()
  // "Not a duplicate" for this session only. The detector is derived, so a dismissal has nowhere to
  // live without a model change — and that change is only worth making once the flag rate is proven
  // on real data. Same shape as the recurring-suggestion dismissal on the Transactions screen.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const all = useMemo(
    () => findDuplicateImports(vault),
    // Snapshots feed only the advisory drift line; statements bound the windows.
    [vault.transactions, vault.statements, vault.snapshots, vault.accounts], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const findings = all
    .map((f) => ({ ...f, pairs: f.pairs.filter((p) => !dismissed.has(`${p.keepId}|${p.dropId}`)) }))
    .filter((f) => f.pairs.length > 0)
  const totalRows = findings.reduce((s, f) => s + f.pairs.length, 0)
  const acctName = (id: string): string => vault.accounts.find((a) => a.id === id)?.name ?? 'unknown account'

  const resolve = (pairs: DupPair[]) => {
    const op = resolveDuplicatesOp(vault, pairs)
    if (!op) return
    const n = pairs.length
    store.commit(op, { msg: `${n} duplicate${n === 1 ? '' : 's'} removed`, undoable: true })
  }
  const dismiss = (pairs: DupPair[]) =>
    setDismissed((prev) => {
      const next = new Set(prev)
      for (const p of pairs) next.add(`${p.keepId}|${p.dropId}`)
      return next
    })

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="duplicates-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Duplicate imports</div>
        <span data-testid="dup-total" style={{ ...mono(10), color: totalRows > 0 ? AMBER : GREEN, letterSpacing: '.06em' }}>
          {totalRows > 0 ? `${totalRows} SUSPECT ROW${totalRows === 1 ? '' : 'S'}` : 'CLEAN'}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
        Two statements covering the same period, where the rows match but the descriptors don’t — the case import dedup
        can’t see. Rows repeating inside a single file are left alone; those are usually real.
      </div>

      {findings.length === 0 ? (
        <div style={{ fontSize: 12, color: FAINT, padding: '10px 0' }} data-testid="dup-empty">
          No overlapping statements restate each other.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
          {findings.map((f) => (
            <div key={f.id} style={{ ...hairBottom, padding: '11px 0' }} data-testid="dup-finding">
              <div style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>
                {f.matched} row{f.matched === 1 ? '' : 's'} · {eur(f.totalAmount)}
                <span style={{ fontWeight: 400, color: MUT }}> on {f.accountIds.map(acctName).join(', ')}</span>
              </div>
              <div style={{ ...mono(10.5), color: FAINT, marginTop: 3, wordBreak: 'break-all' }}>
                {f.fileA} ↔ {f.fileB}
              </div>
              <div style={{ ...mono(10.5), color: FAINT, marginTop: 2 }}>
                {fmtDate(f.window[0])} → {fmtDate(f.window[1])} · {Math.round(f.matchRate * 100)}% of the smaller file already present
                {f.driftCorroboration !== undefined && ` · balance off by ${eur(f.driftCorroboration)} over this period`}
              </div>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {f.pairs.map((p) => (
                  <div key={p.dropId} style={{ ...mono(10.5), color: MUT, display: 'flex', alignItems: 'center', gap: 8 }} data-testid="dup-pair">
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {eur(p.amount)} · {fmtDate(p.keepDate)} <span style={{ color: INK }}>{p.keepMerchant}</span>
                      <span style={{ color: FAINT }}> ↔ </span>
                      <span style={{ color: INK }}>{p.dropMerchant}</span>
                    </span>
                    <button data-testid="dup-pair-remove" onClick={() => resolve([p])} style={{ ...mono(10), color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>
                      REMOVE
                    </button>
                    <button data-testid="dup-pair-keep" onClick={() => dismiss([p])} style={{ ...mono(10), color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>
                      NOT A DUPLICATE
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                <button data-testid="dup-resolve-all" onClick={() => resolve(f.pairs)} style={btnOutline}>
                  Remove {f.pairs.length} newer {f.pairs.length === 1 ? 'row' : 'rows'}
                </button>
                <button data-testid="dup-dismiss-all" onClick={() => dismiss(f.pairs)} style={{ ...btnOutline, color: MUT }}>
                  Not duplicates
                </button>
              </div>
              <div style={{ ...mono(10), color: FAINT, marginTop: 6 }}>
                Keeps the older row of each pair and moves any note or trip tag onto it. Undoable.
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
