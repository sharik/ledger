import { useState } from 'react'
import type { Category, Vault } from '../../model/types'
import { budgetCategoryIds } from '../../model/types'
import { now, uuidv7 } from '../../model/clock'
import { currentMonthKey } from '../../model/selectors'
import { useStore, useStoreState } from '../store'
import { ACCENT, BRICK, CAT_PALETTE as PALETTE, CHIP, FAINT, HAIR, INK, MUT, SURFACE2 } from '../theme'
import { hairBottom, mono } from '../styles'

/** Everything still pointing at a category — a non-zero count blocks deletion. */
function usageOf(vault: Vault, id: string) {
  return {
    txns: vault.transactions.filter((t) => t.categoryId === id).length,
    // Via budgetCategoryIds, not `b.categoryId`: a scope-driven budget parks that field on
    // CAT_TRANSFERS and names its real category inside the scope, so the raw check let a
    // category be deleted out from under the annual or recurring budget measuring it.
    budgets: vault.budgets.filter((b) => budgetCategoryIds(b).includes(id)).length,
    rules: vault.rules.filter((r) => r.categoryId === id).length,
  }
}

function usageLabel(u: { txns: number; budgets: number; rules: number }): string {
  return [
    u.txns ? `${u.txns} transaction${u.txns === 1 ? '' : 's'}` : null,
    u.budgets ? `${u.budgets} budget${u.budgets === 1 ? '' : 's'}` : null,
    u.rules ? `${u.rules} rule${u.rules === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ')
}

export function CategoriesCard() {
  const store = useStore()
  const { vault } = useStoreState()
  const cm = currentMonthKey()

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(PALETTE[0]!)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [swatchFor, setSwatchFor] = useState<string | null>(null)

  const taken = (n: string, exceptId?: string) =>
    vault.categories.some((c) => c.id !== exceptId && c.name.toLowerCase() === n.toLowerCase())

  // A category is a plain record: mint it and commit `restore`, whose inverse is
  // `delete` — the same shape RulesCard uses to add a rule.
  const add = () => {
    const trimmed = name.trim()
    if (!trimmed || taken(trimmed)) return
    const cat: Category = { id: uuidv7(), updatedAt: now(), name: trimmed, color }
    store.commit({ kind: 'restore', collection: 'categories', records: [cat] }, { msg: `Category “${trimmed}” added`, undoable: true })
    setName('')
    setAdding(false)
  }

  const commitRename = () => {
    if (!renaming) return
    const trimmed = renaming.value.trim()
    const prev = vault.categories.find((c) => c.id === renaming.id)
    if (trimmed && prev && trimmed !== prev.name && !taken(trimmed, renaming.id)) {
      store.commit({ kind: 'setField', collection: 'categories', id: renaming.id, field: 'name', value: trimmed }, { msg: `Renamed to “${trimmed}”`, undoable: true })
    }
    setRenaming(null)
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="categories-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Categories</div>
        <button data-testid="cat-new" onClick={() => setAdding(!adding)} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>{adding ? 'Cancel' : '+ New category'}</button>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
        Used across budgets and charts. A category in use can’t be deleted — move what points at it first.
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, padding: 10, background: CHIP, borderRadius: 6 }} data-testid="cat-form">
          <input
            data-testid="cat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="Category name"
            style={{ height: 30, border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE2, color: INK, fontSize: 12, padding: '0 8px', minWidth: 150 }}
          />
          <Swatches value={color} onPick={setColor} />
          <button data-testid="cat-add" onClick={add} disabled={!name.trim() || taken(name.trim())} style={{ fontSize: 12.5, color: 'var(--on-accent)', background: !name.trim() || taken(name.trim()) ? FAINT : ACCENT, border: 'none', borderRadius: 5, padding: '6px 13px', cursor: 'pointer' }}>Add</button>
          {taken(name.trim()) && <span style={{ fontSize: 11.5, color: BRICK }}>That name already exists.</span>}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
        {vault.categories.map((c) => {
          const count = vault.transactions.filter((t) => t.categoryId === c.id && t.date.startsWith(cm)).length
          // Transfers is structural; Other is the import pipeline's fallback by name.
          const locked = c.role === 'transfers' || c.role === 'other'
          // The breakdown-exclusion toggle applies to any category that can appear in
          // the spending breakdown — i.e. not Income (always excluded) or Transfers.
          const excludable = c.role !== 'income' && c.role !== 'transfers'
          const hidden = c.excludeFromBreakdown ?? c.role === 'housing'
          const uses = usageOf(vault, c.id)
          const inUse = uses.txns + uses.budgets + uses.rules > 0
          return (
            <div key={c.id} data-testid="cat-row" data-cat-name={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '11px 0', ...hairBottom }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, position: 'relative' }}>
                <button
                  data-testid="cat-swatch"
                  aria-label="Change colour"
                  onClick={() => setSwatchFor(swatchFor === c.id ? null : c.id)}
                  style={{ width: 9, height: 9, borderRadius: 1, background: c.color, border: 'none', padding: 0, cursor: 'pointer', flex: 'none' }}
                />
                {swatchFor === c.id && (
                  <div style={{ position: 'absolute', left: 0, top: 18, zIndex: 30, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 6, boxShadow: '0 10px 28px rgba(10,9,7,.16)' }}>
                    <Swatches
                      value={c.color}
                      onPick={(col) => {
                        store.commit({ kind: 'setField', collection: 'categories', id: c.id, field: 'color', value: col }, { msg: `“${c.name}” recoloured`, undoable: true })
                        setSwatchFor(null)
                      }}
                    />
                  </div>
                )}
                {renaming?.id === c.id ? (
                  <input
                    data-testid="cat-rename"
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null) }}
                    style={{ height: 26, border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE2, color: INK, fontSize: 12.5, padding: '0 6px', minWidth: 140 }}
                  />
                ) : (
                  <button
                    data-testid="cat-name-btn"
                    onClick={() => !locked && setRenaming({ id: c.id, value: c.name })}
                    aria-label={locked ? 'Built-in category' : 'Rename'}
                    style={{ fontSize: 12.5, fontWeight: 600, color: INK, background: 'none', border: 'none', padding: 0, cursor: locked ? 'default' : 'pointer' }}
                  >
                    {c.name}
                  </button>
                )}
              </div>
              <span style={{ ...mono(10.5), color: MUT }}>{count} this month</span>
              {excludable && (
                <button
                  data-testid="cat-breakdown-toggle"
                  aria-label={hidden ? 'Hidden from the spending breakdown — tap to show' : 'Shown in the spending breakdown — tap to hide'}
                  onClick={() => store.commit({ kind: 'setField', collection: 'categories', id: c.id, field: 'excludeFromBreakdown', value: !hidden }, { msg: hidden ? `“${c.name}” shown in breakdown` : `“${c.name}” hidden from breakdown`, undoable: true })}
                  style={{ fontSize: 11, fontWeight: 600, color: hidden ? FAINT : ACCENT, background: 'none', border: 'none', cursor: 'pointer', flex: 'none' }}
                >
                  {hidden ? 'Hidden' : 'In breakdown'}
                </button>
              )}
              {!locked && (
                <button
                  data-testid="cat-delete"
                  disabled={inUse}
                  aria-label={inUse ? `Still used by ${usageLabel(uses)}` : 'Delete category'}
                  onClick={() => store.commit({ kind: 'delete', collection: 'categories', ids: [c.id] }, { msg: `Category “${c.name}” deleted`, undoable: true })}
                  style={{ fontSize: 11.5, fontWeight: 600, color: inUse ? FAINT : BRICK, background: 'none', border: 'none', cursor: inUse ? 'default' : 'pointer' }}
                >
                  Delete
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 5 }} data-testid="cat-palette">
      {PALETTE.map((c) => (
        <button
          key={c}
          data-color={c}
          onClick={() => onPick(c)}
          aria-label={c}
          style={{ width: 15, height: 15, borderRadius: 3, background: c, border: value === c ? `2px solid ${INK}` : `1px solid ${HAIR}`, padding: 0, cursor: 'pointer' }}
        />
      ))}
    </div>
  )
}
