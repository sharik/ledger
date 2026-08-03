// Merge one merchant's spellings into one (#merchant-split).
//
// A statement can spell the same merchant two ways — `Deezerfr Y6bsn5` on one run of charges and
// `DEEZER` on the next — and the app then reads it as two subscriptions and two rows in the grouped
// view. `merchantKey` deliberately does NOT try to normalize that away: catching the reference and
// country suffixes means matching a lowercase alphanumeric token, which would also merge genuinely
// distinct merchants that share a prefix. The detector's whole design is to be conservative and only
// suggest, so the merge is a decision the user makes here, once, and it is an ordinary undoable
// commit — a batch of `setField merchant`, no new op, no new collection, no schema change.
//
// `merchant` is display text. `importMeta.raw` keeps the verbatim descriptor, so nothing the
// statement said is lost and provenance is untouched.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, useStoreState } from './store'
import { ACCENT, CHIP, FAINT, HAIR, INK, MONO, MUT, SURFACE, SURFACE2, fmt } from './theme'

/** Longest shared prefix, case-insensitively — how "probably the same merchant" is ranked. */
function sharedPrefix(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i
}

export function MergeMerchantDialog({ merchant, onClose }: { merchant: string; onClose: () => void }) {
  const store = useStore()
  const { vault } = useStoreState()
  const [target, setTarget] = useState<string | null>(null)
  const [q, setQ] = useState('')

  // Every distinct spelling in the vault, with what it covers, most-alike first. The list is the
  // whole point: the two spellings of one merchant sit next to each other in it.
  const others = (() => {
    const m = new Map<string, { merchant: string; count: number; total: number }>()
    for (const t of vault.transactions) {
      if (t.merchant === merchant) continue
      const g = m.get(t.merchant) ?? { merchant: t.merchant, count: 0, total: 0 }
      g.count++
      g.total += t.amount
      m.set(t.merchant, g)
    }
    const needle = q.trim().toLowerCase()
    return [...m.values()]
      .filter((g) => !needle || g.merchant.toLowerCase().includes(needle))
      .sort((a, b) => sharedPrefix(merchant, b.merchant) - sharedPrefix(merchant, a.merchant) || b.count - a.count)
      .slice(0, 40)
  })()

  const moving = vault.transactions.filter((t) => t.merchant === merchant)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = () => {
    if (!target) return
    store.commit(
      { kind: 'batch', ops: moving.map((t) => ({ kind: 'setField' as const, collection: 'transactions' as const, id: t.id, field: 'merchant', value: target })) },
      { msg: `${moving.length} row${moving.length === 1 ? '' : 's'} renamed to ${target}`, undoable: true },
    )
    onClose()
  }

  return createPortal(
    <div
      data-testid="merge-merchant"
      role="dialog"
      aria-modal="true"
      aria-label="Merge merchant"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 66, background: 'rgba(10,9,7,.34)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(520px, 100%)', background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 8, padding: '20px 22px', boxShadow: '0 18px 48px rgba(10,9,7,.24)' }}
      >
      <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Merge merchant</div>
      <div style={{ fontSize: 12.5, color: MUT, marginTop: 4, lineHeight: 1.5 }}>
        Rename every row of <b style={{ color: INK }}>{merchant}</b> ({moving.length} charge{moving.length === 1 ? '' : 's'}) to another
        spelling, so they read as one merchant everywhere. The statement’s own descriptor is kept.
      </div>

      <input
        data-testid="merge-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search merchants…"
        style={{ marginTop: 12, width: '100%', height: 32, border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE2, color: INK, fontSize: 13, padding: '0 10px' }}
      />

      <div style={{ marginTop: 10, maxHeight: 300, overflowY: 'auto', border: `1px solid ${HAIR}`, borderRadius: 5 }}>
        {others.length === 0 && <div style={{ ...mono, color: FAINT, padding: 14 }}>No other merchants to merge into.</div>}
        {others.map((g) => (
          <button
            key={g.merchant}
            data-testid="merge-option"
            data-merchant={g.merchant}
            onClick={() => setTarget(g.merchant)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              width: '100%',
              textAlign: 'left',
              padding: '9px 12px',
              background: target === g.merchant ? CHIP : 'none',
              border: 'none',
              borderBottom: `1px solid var(--hair2)`,
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 13, color: INK, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.merchant}</span>
            <span style={{ ...mono, color: FAINT }}>{g.count}×</span>
            <span style={{ ...mono, color: MUT }}>{fmt(g.total)}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <span style={{ fontSize: 12.5, color: MUT, flex: 1 }}>
          {target ? <>Rename {moving.length} row{moving.length === 1 ? '' : 's'} of “{merchant}” to “<b style={{ color: INK }}>{target}</b>”.</> : 'Pick the spelling to keep.'}
        </span>
        <button data-testid="merge-cancel" onClick={onClose} style={{ fontSize: 12.5, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
        <button
          data-testid="merge-apply"
          onClick={apply}
          disabled={!target}
          style={{ fontSize: 12.5, color: target ? 'var(--on-accent)' : FAINT, background: target ? ACCENT : SURFACE, border: target ? 'none' : `1px solid ${HAIR}`, borderRadius: 5, padding: '7px 14px', cursor: target ? 'pointer' : 'default', fontWeight: 600 }}
        >
          Merge
        </button>
      </div>
      </div>
    </div>,
    document.body,
  )
}

const mono: React.CSSProperties = { fontFamily: MONO, fontSize: 11 }
