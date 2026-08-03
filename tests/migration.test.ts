import { beforeAll, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { setFixedNow } from '../src/model/clock'
import { CAT_TRANSFERS, SCHEMA_VERSION, type Vault } from '../src/model/types'
import {
  b64,
  decryptClassify,
  decryptRaw,
  deriveKey,
  encodeVault,
  encryptBlob,
  makeHeader,
  migrate,
  newSalt,
  stableStringify,
  unlockBlob,
  type KdfParams,
} from '../src/persist/crypto'
import { unlockPeek } from '../src/persist/session'

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const TEST_KDF: KdfParams = { m: 64, t: 1, p: 1 }

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

/**
 * A literal schema-1 vault — hand-written WITHOUT any of the schema-2/3 keys
 * (no statements/rules/fxOverrides, no trackings/trackingAssignments/
 * savedComparisons, no Transfers category, no baseCurrency), exactly as an older
 * stored blob would look. Cast to Vault for `migrate`.
 */
function schema1Vault(): Vault {
  const created = '2026-01-01T00:00:00.000Z'
  return {
    schema: 1,
    vaultId: 'vault-1',
    createdAt: created,
    accounts: [{ id: 'acc-1', updatedAt: created, name: 'Checking', liab: false, liquid: true }],
    snapshots: [{ id: 'snap-1', updatedAt: created, accountId: 'acc-1', date: '2026-06-30', amount: 1000, createdAt: created }],
    transactions: [{ id: 'txn-1', updatedAt: created, date: '2026-06-15', merchant: 'Cafe', categoryId: 'cat-1', amount: -12.4 }],
    categories: [{ id: 'cat-1', updatedAt: created, name: 'Dining out', color: '#845f86' }],
    budgets: [{ id: 'bud-1', updatedAt: created, categoryId: 'cat-1', amount: 300 }],
    goals: [{ id: 'goal-1', updatedAt: created, name: 'Trip', target: 1000, saved: 200, monthly: 100 }],
    params: { id: 'params', updatedAt: created, invReturn: 5, inflation: 2.5, srTarget: 20, efTarget: 6 },
    settings: { id: 'settings', updatedAt: created, saveMode: 'onChange' },
    tombstones: [],
    syncNotes: [],
  } as unknown as Vault
}

/**
 * A literal schema-2 vault — has the schema-2 additions (import collections,
 * Transfers category, baseCurrency) but NONE of the schema-3 keys, as a blob
 * written by a post-Phase-A / pre-Phase-D client would look.
 */
function schema2Vault(): Vault {
  const created = '2026-01-01T00:00:00.000Z'
  return {
    schema: 2,
    vaultId: 'vault-2',
    createdAt: created,
    accounts: [{ id: 'acc-1', updatedAt: created, name: 'Checking', liab: false, liquid: true }],
    snapshots: [{ id: 'snap-1', updatedAt: created, accountId: 'acc-1', date: '2026-06-30', amount: 1000, createdAt: created }],
    transactions: [{ id: 'txn-1', updatedAt: created, date: '2026-06-15', merchant: 'Cafe', categoryId: 'cat-1', amount: -12.4 }],
    categories: [
      { id: 'cat-1', updatedAt: created, name: 'Dining out', color: '#845f86' },
      { id: CAT_TRANSFERS, updatedAt: created, name: 'Transfers', color: 'var(--c-other)' },
    ],
    budgets: [{ id: 'bud-1', updatedAt: created, categoryId: 'cat-1', amount: 300 }],
    goals: [{ id: 'goal-1', updatedAt: created, name: 'Trip', target: 1000, saved: 200, monthly: 100 }],
    statements: [],
    rules: [],
    fxOverrides: [],
    params: { id: 'params', updatedAt: created, invReturn: 5, inflation: 2.5, srTarget: 20, efTarget: 6, baseCurrency: 'EUR' },
    settings: { id: 'settings', updatedAt: created, saveMode: 'onChange' },
    tombstones: [],
    syncNotes: [],
  } as unknown as Vault
}

const LEAN_14 = ['Housing', 'Utilities', 'Groceries', 'Dining out', 'Transport', 'Travel', 'Shopping', 'Health', 'Entertainment', 'Insurance', 'Taxes & fees', 'Income', 'Other', 'Transfers']

describe('migration chained 1 → 4 (§4.4 cases 1–3)', () => {
  it('is forward-only and lossless for user data', () => {
    const v1 = schema1Vault()
    const before = structuredClone(v1)
    const v = migrate(v1)

    expect(v.schema).toBe(SCHEMA_VERSION)
    // schema-2 collections born empty
    expect(v.statements).toEqual([])
    expect(v.rules).toEqual([])
    expect(v.fxOverrides).toEqual([])
    expect(v.params.baseCurrency).toBe('EUR')
    // schema-3 collections born empty
    expect(v.trackings).toEqual([])
    expect(v.trackingAssignments).toEqual([])
    expect(v.savedComparisons).toEqual([])

    // Transfers category minted with the fixed id, updatedAt === createdAt, role stamped
    const transfers = v.categories.find((c) => c.id === CAT_TRANSFERS)
    expect(transfers).toBeDefined()
    expect(transfers!.updatedAt).toBe(v.createdAt)
    expect(transfers!.role).toBe('transfers')

    // every pre-existing user record survives unchanged (3→4 only touches remapped categories)
    expect(v.accounts).toEqual(before.accounts)
    expect(v.snapshots).toEqual(before.snapshots)
    expect(v.transactions).toEqual(before.transactions) // cat-1 'Dining out' adopted by name, id kept
    expect(v.budgets).toEqual(before.budgets)
    expect(v.goals).toEqual(before.goals)
    // the original 'Dining out' survived (adopted by name); the full Lean-14 set is present
    expect(v.categories.find((c) => c.name === 'Dining out')?.id).toBe('cat-1')
    for (const name of LEAN_14) expect(v.categories.some((c) => c.name === name)).toBe(true)
  })

  it('is a no-op on an already-current vault (§4.4 case 2)', () => {
    const v = migrate(schema1Vault())
    const again = migrate(structuredClone(v))
    expect(stableStringify(again)).toBe(stableStringify(v))
  })

  it('is deterministic across devices (§4.4 case 3)', () => {
    const a = migrate(structuredClone(schema1Vault()))
    const b = migrate(structuredClone(schema1Vault()))
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('never double-adds the Transfers category', () => {
    const v = migrate(schema1Vault())
    const twice = migrate({ ...v, schema: 1 } as unknown as Vault) // force re-run of the 1→2 step
    expect(twice.categories.filter((c) => c.id === CAT_TRANSFERS)).toHaveLength(1)
  })
})

describe('migration 2 → 4 (§4.4 cases 1–3)', () => {
  it('is forward-only and lossless for user data', () => {
    const v2 = schema2Vault()
    const before = structuredClone(v2)
    const v3 = migrate(v2)

    expect(v3.schema).toBe(SCHEMA_VERSION)
    expect(v3.trackings).toEqual([])
    expect(v3.trackingAssignments).toEqual([])
    expect(v3.savedComparisons).toEqual([])

    // every schema-2 user record survives unchanged
    expect(v3.accounts).toEqual(before.accounts)
    expect(v3.snapshots).toEqual(before.snapshots)
    expect(v3.transactions).toEqual(before.transactions)
    expect(v3.budgets).toEqual(before.budgets)
    expect(v3.goals).toEqual(before.goals)
    expect(v3.statements).toEqual(before.statements)
    expect(v3.rules).toEqual(before.rules)
    expect(v3.fxOverrides).toEqual(before.fxOverrides)
    expect(v3.params).toEqual(before.params)
    // categories grew to the Lean-14 set; the pre-existing 'Dining out' was adopted by name
    expect(v3.categories.find((c) => c.name === 'Dining out')?.id).toBe('cat-1')
    for (const name of LEAN_14) expect(v3.categories.some((c) => c.name === name)).toBe(true)
  })

  it('is deterministic across devices', () => {
    const a = migrate(structuredClone(schema2Vault()))
    const b = migrate(structuredClone(schema2Vault()))
    expect(stableStringify(a)).toBe(stableStringify(b))
  })
})

/**
 * Neither of the last two steps converts a record. 5 → 6 was the first migration that only
 * stamps a version: `Budget.scope` gained a `group` kind and `Budget.name`, both additive, and
 * the bump exists to push a schema-5 peer onto the read-only path before its `budgetKey` can
 * mis-key an unknown scope kind and tombstone a live budget. 6 → 7 adds one empty collection.
 */
describe('migration 5 → 7', () => {
  const schema5Vault = (): Vault => ({ ...migrate(schema1Vault()), schema: 5 })

  it('changes the version and adds an empty collection, and nothing else', () => {
    const before = schema5Vault()
    const after = migrate(structuredClone(before))
    expect(after.schema).toBe(SCHEMA_VERSION)
    expect(stableStringify({ ...after, schema: 5 })).toBe(stableStringify({ ...before, pinnedWidgets: [] }))
  })

  it('is idempotent and deterministic', () => {
    const once = migrate(schema5Vault())
    expect(stableStringify(migrate(structuredClone(once)))).toBe(stableStringify(once))
    expect(stableStringify(migrate(schema5Vault()))).toBe(stableStringify(migrate(schema5Vault())))
  })
})

/**
 * 6 → 7 adds `pinnedWidgets`: a chart pinned from any screen, which a `SavedComparison` could
 * not carry because it requires `selections`. Additive like 2 → 3 and 4 → 5.
 */
describe('migration 6 → 7', () => {
  /** A stored schema-6 payload has no `pinnedWidgets` key at all, which is the case that matters. */
  const schema6Vault = (): Vault => {
    const { pinnedWidgets: _drop, ...rest } = migrate(schema1Vault())
    return { ...rest, schema: 6 } as Vault
  }

  it('mints the collection and leaves every existing record alone', () => {
    const before = schema6Vault()
    const after = migrate(structuredClone(before))
    expect(after.schema).toBe(SCHEMA_VERSION)
    expect(after.pinnedWidgets).toEqual([])
    expect(stableStringify({ ...after, schema: 6, pinnedWidgets: undefined })).toBe(
      stableStringify({ ...before, pinnedWidgets: undefined }),
    )
  })

  it('is idempotent and deterministic', () => {
    const once = migrate(schema6Vault())
    expect(stableStringify(migrate(structuredClone(once)))).toBe(stableStringify(once))
    expect(stableStringify(migrate(schema6Vault()))).toBe(stableStringify(migrate(schema6Vault())))
  })
})

/**
 * A schema-3 vault exercising every 3→4 case: a Taxes + Bank fees pair to merge, a
 * Subscriptions category/budget/rule to retire, and the privileged categories to role-stamp.
 */
function schema3Vault(): Vault {
  const created = '2026-01-01T00:00:00.000Z'
  return {
    schema: 3,
    vaultId: 'vault-3',
    createdAt: created,
    accounts: [{ id: 'acc-1', updatedAt: created, name: 'Checking', liab: false, liquid: true }],
    snapshots: [],
    transactions: [
      { id: 'tx-tax', updatedAt: created, date: '2026-06-01', merchant: 'DGFIP', categoryId: 'cat-taxes', amount: -200 },
      { id: 'tx-bf', updatedAt: created, date: '2026-06-02', merchant: 'Commission', categoryId: 'cat-bf', amount: -12 },
      { id: 'tx-sub', updatedAt: created, date: '2026-06-08', merchant: 'Netflix', categoryId: 'cat-subs', amount: -13.49 },
    ],
    categories: [
      { id: 'cat-1', updatedAt: created, name: 'Dining out', color: '#845f86' },
      { id: 'cat-income', updatedAt: created, name: 'Income', color: 'var(--pos)' },
      { id: 'cat-house', updatedAt: created, name: 'Housing', color: 'var(--c-house)' },
      { id: 'cat-oth', updatedAt: created, name: 'Other', color: 'var(--c-other)' },
      { id: 'cat-taxes', updatedAt: created, name: 'Taxes', color: 'var(--c-other)' },
      { id: 'cat-bf', updatedAt: created, name: 'Bank fees', color: 'var(--c-other)' },
      { id: 'cat-subs', updatedAt: created, name: 'Subscriptions', color: 'var(--c-util)' },
      { id: CAT_TRANSFERS, updatedAt: created, name: 'Transfers', color: 'var(--c-other)' },
    ],
    budgets: [{ id: 'bud-sub', updatedAt: created, categoryId: 'cat-subs', amount: 70, fixed: true }],
    goals: [],
    statements: [],
    rules: [
      { id: 'rule-sub', updatedAt: created, categoryId: 'cat-subs', priority: 50, source: 'learned', enabled: true, match: { field: 'merchant', op: 'prefix', value: 'NETFLIX' } },
      { id: 'rule-tax', updatedAt: created, categoryId: 'cat-taxes', priority: 50, source: 'learned', enabled: true, match: { field: 'counterparty', op: 'prefix', value: 'DGFIP' } },
    ],
    fxOverrides: [],
    trackings: [],
    trackingAssignments: [],
    savedComparisons: [],
    params: { id: 'params', updatedAt: created, invReturn: 5, inflation: 2.5, srTarget: 20, efTarget: 6, baseCurrency: 'EUR' },
    settings: { id: 'settings', updatedAt: created, saveMode: 'onChange' },
    tombstones: [],
    syncNotes: [],
  } as unknown as Vault
}

describe('migration 3 → 4 (Lean-14 taxonomy + recurring axis)', () => {
  it('reconciles to the 14 canonical categories and stamps roles', () => {
    const v = migrate(schema3Vault())
    expect(v.schema).toBe(SCHEMA_VERSION)
    for (const name of LEAN_14) expect(v.categories.some((c) => c.name === name)).toBe(true)
    // pre-existing privileged categories are adopted by name (ids kept) and role-stamped
    const role = (r: string) => v.categories.find((c) => c.role === r)
    expect(role('income')?.id).toBe('cat-income')
    expect(role('housing')?.id).toBe('cat-house')
    expect(role('other')?.id).toBe('cat-oth')
    expect(role('transfers')?.id).toBe(CAT_TRANSFERS)
  })

  it('merges Taxes + Bank fees → Taxes & fees, reassigning their rows', () => {
    const v = migrate(schema3Vault())
    expect(v.categories.some((c) => c.name === 'Taxes')).toBe(false)
    expect(v.categories.some((c) => c.name === 'Bank fees')).toBe(false)
    const tf = v.categories.find((c) => c.name === 'Taxes & fees')!
    expect(v.transactions.find((t) => t.id === 'tx-tax')!.categoryId).toBe(tf.id)
    expect(v.transactions.find((t) => t.id === 'tx-bf')!.categoryId).toBe(tf.id)
    // the Taxes rule is repointed (not dropped)
    expect(v.rules.find((r) => r.id === 'rule-tax')!.categoryId).toBe(tf.id)
    // old category ids are tombstoned
    for (const id of ['cat-taxes', 'cat-bf']) expect(v.tombstones.some((ts) => ts.id === id && ts.collection === 'categories')).toBe(true)
  })

  it('retires Subscriptions: rows → Other + recurring, budget converted, rule dropped', () => {
    const v = migrate(schema3Vault())
    expect(v.categories.some((c) => c.name === 'Subscriptions')).toBe(false)
    const otherId = v.categories.find((c) => c.role === 'other')!.id
    const sub = v.transactions.find((t) => t.id === 'tx-sub')!
    expect(sub.categoryId).toBe(otherId)
    expect(sub.recurring).toBe('monthly')
    // budget converted to a cross-category Recurring · monthly budget, Housing excluded
    const bud = v.budgets.find((b) => b.id === 'bud-sub')!
    expect(bud.scope).toEqual({ kind: 'recurring', cadence: 'monthly', excludeCategoryIds: ['cat-house'] })
    expect(bud.categoryId).toBe(CAT_TRANSFERS)
    expect(bud.amount).toBe(70)
    // the subscription rule is dropped + tombstoned
    expect(v.rules.some((r) => r.id === 'rule-sub')).toBe(false)
    expect(v.tombstones.some((ts) => ts.id === 'rule-sub' && ts.collection === 'rules')).toBe(true)
  })

  it('is deterministic across devices', () => {
    const a = migrate(schema3Vault())
    const b = migrate(schema3Vault())
    expect(stableStringify(a)).toBe(stableStringify(b))
  })
})

describe('decrypt-path & round-trip migration (§4.4 cases 4, 7)', () => {
  it('migrates through every decrypt path', async () => {
    const v1 = schema1Vault()
    const salt = newSalt()
    const key = await deriveKey('pw', salt, TEST_KDF)
    const header = makeHeader(v1.vaultId, salt, TEST_KDF, 1) // schema-1 header
    const blob = await encryptBlob(encodeVault(v1), key, header)

    // (a) local unlock
    const unlocked = await unlockBlob(blob, 'pw', TEST_KDF)
    expect(unlocked.kind).toBe('ok')
    if (unlocked.kind === 'ok') expect(unlocked.vault.schema).toBe(SCHEMA_VERSION)

    // (b) remote classify
    const classified = await decryptClassify(blob, key, salt)
    expect(classified.kind).toBe('ok')
    if (classified.kind === 'ok') {
      expect(classified.vault.schema).toBe(SCHEMA_VERSION)
      expect(classified.vault.statements).toEqual([])
      expect(classified.vault.trackings).toEqual([])
    }

    // (c) merge/re-key base
    const raw = await decryptRaw(blob, key)
    expect(raw?.schema).toBe(SCHEMA_VERSION)
    expect(raw?.rules).toEqual([])
    expect(raw?.savedComparisons).toEqual([])

    // (d) sibling-tab peek
    const peeked = await unlockPeek(blob, key)
    expect(peeked?.schema).toBe(SCHEMA_VERSION)
    expect(peeked?.categories.some((c) => c.id === CAT_TRANSFERS)).toBe(true)
    expect(peeked?.trackingAssignments).toEqual([])
  })

  it('round-trips a migrated vault through encrypt/decrypt', async () => {
    const v = migrate(schema1Vault())
    const salt = newSalt()
    const key = await deriveKey('pw', salt, TEST_KDF)
    const header = makeHeader(v.vaultId, salt, TEST_KDF) // current schema
    const blob = await encryptBlob(encodeVault(v), key, header)
    const back = await decryptRaw(blob, key)
    expect(stableStringify(back)).toBe(stableStringify(v))
  })

  it('header salt mismatch still classifies as rekeyed before schema handling', async () => {
    const v1 = schema1Vault()
    const salt = newSalt()
    const key = await deriveKey('pw', salt, TEST_KDF)
    const blob = await encryptBlob(encodeVault(v1), key, makeHeader(v1.vaultId, salt, TEST_KDF, 1))
    const other = newSalt()
    const res = await decryptClassify(blob, key, other)
    expect(res.kind).toBe('rekeyed')
    expect(b64(salt)).not.toBe(b64(other))
  })
})

describe('merge across a schema bump (§4.4 case 6)', () => {
  it('a base that had to be migrated produces no spurious conflicts', async () => {
    // The lastSyncedBase was written pre-upgrade (schema 1). decryptRaw migrates it,
    // so threeWayMerge sees a base whose new collections are [] (not undefined).
    const { threeWayMerge } = await import('../src/sync/merge')
    const base = migrate(schema1Vault()) // as decryptRaw would return
    const local = structuredClone(base)
    const remote = structuredClone(base)
    // one untouched record present in all three; a fresh add on local only
    local.transactions.push({
      id: 'txn-2',
      updatedAt: '2026-07-01T00:00:00.000Z',
      date: '2026-07-01',
      merchant: 'New',
      categoryId: 'cat-1',
      amount: -5,
    })
    const { merged, conflicts } = threeWayMerge(base, local, remote)
    expect(conflicts).toHaveLength(0)
    expect(merged.transactions.map((t) => t.id).sort()).toEqual(['txn-1', 'txn-2'])
    expect(merged.schema).toBe(SCHEMA_VERSION)
  })
})

/** A schema-4 vault: everything schema 4 has, and no `skills` key at all. */
function schema4Vault(): Vault {
  const v = migrate(schema3Vault())
  const { skills: _dropped, ...rest } = v
  return { ...rest, schema: 4 } as unknown as Vault
}

describe('migration 4 → 5 (assistant skills)', () => {
  it('adds an empty skills collection and changes nothing else', () => {
    const before = schema4Vault()
    const after = migrate(structuredClone(before))
    expect(after.schema).toBe(SCHEMA_VERSION)
    expect(after.skills).toEqual([])
    // Purely additive: every other key is byte-identical, so a vault that never opens the
    // assistant is unchanged apart from its version number.
    const { schema: _s1, skills: _sk, ...restAfter } = after
    const { schema: _s2, ...restBefore } = before
    expect(restAfter).toEqual(restBefore)
  })

  it('is deterministic — two devices migrating independently converge', () => {
    expect(migrate(structuredClone(schema4Vault()))).toEqual(migrate(structuredClone(schema4Vault())))
  })

  it('chains from schema 1 all the way to 5', () => {
    expect(migrate(schema1Vault()).skills).toEqual([])
  })
})
