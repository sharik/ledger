import { useState } from 'react'
import type { Rule, Vault } from '../../model/types'
import { now, uuidv7 } from '../../model/clock'
import { matchesRule } from '../../import/rules'
import { useRawVault, useStore } from '../store'
import { ACCENT, BRICK, CHIP, FAINT, HAIR, INK, MONO, MUT, SURFACE2 } from '../theme'
import { hairBottom, mono } from '../styles'

type Field = Rule['match']['field']
type Op = Rule['match']['op']
type Sign = NonNullable<Rule['match']['sign']>

const FIELDS: Field[] = ['creditorId', 'counterparty', 'merchant', 'descriptor']
const OPS: Op[] = ['equals', 'prefix', 'contains']
/** '' is the stored `undefined`: either direction, the §5.4-preserving default (#19). The row's
 *  select uses the short labels so it never crowds out the rule's own key, which is what a reader
 *  is scanning for. */
const SIGNS: { value: '' | Sign; label: string; short: string }[] = [
  { value: '', label: 'either way', short: 'either' },
  { value: 'inflow', label: 'money in', short: 'in' },
  { value: 'outflow', label: 'money out', short: 'out' },
]

const SOURCE_COLOR: Record<Rule['source'], string> = { user: ACCENT, learned: 'var(--pos)', seed: MUT }

/** Best-effort live match count over committed transactions (§10.3). */
function ruleMatchCount(vault: Vault, rule: Rule): number {
  return vault.transactions.filter((t) => matchesRule(t, rule)).length
}

export function RulesCard() {
  const store = useStore()
  const vault = useRawVault() // a rule's reach is a property of the vault, not of one chart
  const catById = new Map(vault.categories.map((c) => [c.id, c]))
  // Transfers included (§9.4): “Always → Transfers” mints exactly this rule, so the
  // editor has to be able to express — and correct — what the review screen learns.
  const cats = vault.categories
  const rules = [...vault.rules].sort((a, b) => b.priority - a.priority || (a.updatedAt < b.updatedAt ? 1 : -1))

  const [adding, setAdding] = useState(false)
  const [field, setField] = useState<Field>('merchant')
  const [op, setOp] = useState<Op>('equals')
  const [value, setValue] = useState('')
  const [sign, setSign] = useState<'' | Sign>('')
  const [categoryId, setCategoryId] = useState(cats[0]?.id ?? '')

  const addRule = () => {
    if (!value.trim() || !categoryId) return
    const rule: Rule = { id: uuidv7(), updatedAt: now(), categoryId, priority: 100, source: 'user', enabled: true, match: { field, op, value: value.trim(), ...(sign ? { sign } : {}) } }
    store.commit({ kind: 'restore', collection: 'rules', records: [rule] }, { msg: 'Rule added', undoable: true })
    setValue('')
    setAdding(false)
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="rules-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Categorization rules</div>
        <button data-testid="rule-new" onClick={() => setAdding(!adding)} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>{adding ? 'Cancel' : '+ New rule'}</button>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
        Higher priority wins; within a tier the newest rule wins. Deleting a rule never recategorizes what it already touched.
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, padding: 10, background: CHIP, borderRadius: 6 }} data-testid="rule-form">
          <select data-testid="rule-field" value={field} onChange={(e) => setField(e.target.value as Field)} style={sel}>{FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
          <select data-testid="rule-op" value={op} onChange={(e) => setOp(e.target.value as Op)} style={sel}>{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          <input data-testid="rule-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" style={{ ...sel, minWidth: 140 }} />
          <select data-testid="rule-sign" value={sign} onChange={(e) => setSign(e.target.value as '' | Sign)} style={sel} title="Which direction this rule applies to">{SIGNS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
          <select data-testid="rule-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={sel}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button data-testid="rule-add" onClick={addRule} style={{ fontSize: 12.5, color: 'var(--on-accent)', background: ACCENT, border: 'none', borderRadius: 5, padding: '6px 13px', cursor: 'pointer' }}>Add rule</button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        {rules.length === 0 && <div style={{ ...mono(11), color: FAINT, padding: '12px 0' }}>No rules yet — recategorize a row and choose “Always” to learn one.</div>}
        {rules.map((r) => {
          const cat = catById.get(r.categoryId)
          return (
            <div key={r.id} data-testid="rule-row" data-rule-value={r.match.value} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', ...hairBottom }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.06em', color: SOURCE_COLOR[r.source], border: `1px solid ${HAIR}`, borderRadius: 3, padding: '1px 4px', textTransform: 'uppercase' }}>{r.source}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: r.enabled === false ? FAINT : INK, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: r.enabled === false ? 'line-through' : 'none' }}>
                {r.match.field} {r.match.op} {r.match.value}
              </span>
              {/* #19: the direction the rule is scoped to, and a way to change it — a learned
                  counterparty rule is minted `money out`/`money in`, and correcting one by hand
                  must not mean deleting and retyping it. `match` is written whole: it is one
                  logical key, so field-LWW over its parts would be a false precision. */}
              <select
                data-testid="rule-sign-edit"
                value={r.match.sign ?? ''}
                onChange={(e) => {
                  const next = e.target.value as '' | Sign
                  const match = { ...r.match, ...(next ? { sign: next } : {}) }
                  if (!next) delete (match as { sign?: Sign }).sign
                  store.commit({ kind: 'setField', collection: 'rules', id: r.id, field: 'match', value: match }, { msg: 'Rule direction changed', undoable: true })
                }}
                style={{ ...sel, height: 24, fontSize: 11, color: r.match.sign ? INK : FAINT }}
                title="Which direction this rule applies to"
              >
                {SIGNS.map((s) => <option key={s.value} value={s.value}>{s.short}</option>)}
              </select>
              {/* Retargeting is the sanctioned remedy for a rule that learned the wrong category
                  (#19) — one gesture, not delete-and-retype. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: cat?.color ?? FAINT }} />
                <select
                  data-testid="rule-cat-edit"
                  value={r.categoryId}
                  onChange={(e) => store.commit({ kind: 'setField', collection: 'rules', id: r.id, field: 'categoryId', value: e.target.value }, { msg: 'Rule retargeted', undoable: true })}
                  style={{ ...sel, height: 24, fontSize: 12, border: 'none', background: 'none', padding: '0 2px' }}
                >
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {!cat && <option value={r.categoryId}>—</option>}
                </select>
              </span>
              <span style={{ ...mono(10), color: FAINT, width: 64, textAlign: 'right' }} data-testid="rule-count">{ruleMatchCount(vault, r)} match</span>
              <button data-testid="rule-toggle" onClick={() => store.commit({ kind: 'setField', collection: 'rules', id: r.id, field: 'enabled', value: r.enabled === false })} style={linkBtn}>{r.enabled === false ? 'Enable' : 'Disable'}</button>
              <button data-testid="rule-delete" onClick={() => store.commit({ kind: 'delete', collection: 'rules', ids: [r.id] }, { msg: 'Rule deleted', undoable: true })} style={{ ...linkBtn, color: BRICK }}>Delete</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const sel: React.CSSProperties = { height: 30, border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE2, color: INK, fontSize: 12, padding: '0 8px' }
const linkBtn: React.CSSProperties = { fontSize: 11.5, color: MUT, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }
