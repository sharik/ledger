import { argon2id } from 'hash-wasm'
import type { Budget, Category, CollectionName, Tombstone, Vault } from '../model/types'
import { CAT_TRANSFERS, SCHEMA_VERSION } from '../model/types'
import { SEED_CATEGORIES } from '../model/categories'

const MAGIC = new TextEncoder().encode('LGR1')

export interface KdfParams {
  m: number // KiB
  t: number
  p: number
}

/** ~0.5–1 s on desktop. Tests inject tiny params. */
export const DEFAULT_KDF: KdfParams = { m: 65536, t: 3, p: 1 }

export interface VaultHeader {
  v: 1
  schema: number
  vaultId: string
  kdf: { algo: 'argon2id'; salt: string } & KdfParams
}

const te = new TextEncoder()
const td = new TextDecoder()

export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

export function newSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** Argon2id → non-extractable AES-GCM key. Runs ONLY at setup/unlock/re-key. */
export async function deriveKey(password: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF): Promise<CryptoKey> {
  const raw = await argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  })
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  ;(raw as Uint8Array).fill(0)
  return key
}

export function makeHeader(vaultId: string, salt: Uint8Array, params: KdfParams = DEFAULT_KDF, schema = SCHEMA_VERSION): VaultHeader {
  return { v: 1, schema, vaultId, kdf: { algo: 'argon2id', salt: b64(salt), ...params } }
}

/** Canonical JSON: object keys sorted recursively so every device serializes identical data identically. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

export function encodeVault(vault: Vault): Uint8Array {
  return te.encode(stableStringify(vault))
}

/** 'LGR1' ‖ u16 headerLen ‖ header JSON ‖ 12-byte fresh IV ‖ AES-GCM(ct+tag), header as AAD. */
export async function encryptBlob(plain: Uint8Array, key: CryptoKey, header: VaultHeader): Promise<Uint8Array> {
  const headerBytes = te.encode(JSON.stringify(header))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: headerBytes },
      key,
      plain as BufferSource,
    ),
  )
  const out = new Uint8Array(4 + 2 + headerBytes.length + 12 + ct.length)
  out.set(MAGIC, 0)
  new DataView(out.buffer).setUint16(4, headerBytes.length, false)
  out.set(headerBytes, 6)
  out.set(iv, 6 + headerBytes.length)
  out.set(ct, 6 + headerBytes.length + 12)
  return out
}

export interface ParsedBlob {
  header: VaultHeader
  headerBytes: Uint8Array
  iv: Uint8Array
  ct: Uint8Array
}

export function parseBlob(blob: Uint8Array): ParsedBlob | null {
  try {
    if (blob.length < 20) return null
    for (let i = 0; i < 4; i++) if (blob[i] !== MAGIC[i]) return null
    const headerLen = new DataView(blob.buffer, blob.byteOffset).getUint16(4, false)
    const headerBytes = blob.slice(6, 6 + headerLen)
    const header = JSON.parse(td.decode(headerBytes)) as VaultHeader
    if (header.v !== 1 || header.kdf?.algo !== 'argon2id') return null
    const iv = blob.slice(6 + headerLen, 6 + headerLen + 12)
    const ct = blob.slice(6 + headerLen + 12)
    if (ct.length < 16) return null
    return { header, headerBytes, iv, ct }
  } catch {
    return null
  }
}

/**
 * Decrypt any blob with an in-memory key (no KDF, no classification), migrating
 * to the current schema. The merge base and re-key base both flow through here;
 * without migration the first post-upgrade sync would hand `threeWayMerge` a
 * base whose new collections are `undefined` (§4.1). A newer-schema base can't
 * reach this path — `decryptClassify` parks the engine READONLY first.
 */
export async function decryptRaw(blob: Uint8Array, key: CryptoKey): Promise<Vault | null> {
  const parsed = parseBlob(blob)
  if (!parsed) return null
  const vault = await tryDecrypt(parsed, key)
  return vault ? migrate(vault) : null
}

async function tryDecrypt(parsed: ParsedBlob, key: CryptoKey): Promise<Vault | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv as BufferSource, additionalData: parsed.headerBytes as BufferSource },
      key,
      parsed.ct as BufferSource,
    )
    return JSON.parse(td.decode(plain)) as Vault
  } catch {
    return null
  }
}

/**
 * 3 → 4: the Lean-14 Plaid-informed taxonomy + the recurring axis. Deterministic
 * (Convention #4): every minted/changed record derives its timestamp from `v.createdAt`
 * and its id from a fixed constant, so two devices migrating the same vault independently
 * converge without a sync conflict. Every removal leaves a tombstone so a resurfaced older
 * copy stays removed.
 *  - reconcile the 14 canonical categories by name (adopt existing, mint the rest, stamp roles);
 *  - merge `Taxes` + `Bank fees` → `Taxes & fees` (reassign their txns/rules/budgets);
 *  - retire `Subscriptions`: its txns move to `Other` (needs-review) flagged `recurring:'monthly'`,
 *    its budget converts to a cross-category Recurring · monthly budget, its rules drop.
 */
function migrateV3toV4(v: Vault): Vault {
  const ts = v.createdAt
  const tombstones: Tombstone[] = [...v.tombstones]
  const drop = (id: string, collection: CollectionName) =>
    tombstones.push({ id, collection, deletedAt: ts, updatedAt: ts })

  // Reconcile the 14 canonical categories: adopt an existing name, mint the absent, stamp roles.
  const categories: Category[] = v.categories.map((c) => ({ ...c }))
  const idByName = (name: string) =>
    categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id
  for (const seed of SEED_CATEGORIES) {
    const existing = categories.find((c) => c.name.toLowerCase() === seed.name.toLowerCase())
    if (existing) {
      if (seed.role && !existing.role) { existing.role = seed.role; existing.updatedAt = ts }
    } else {
      categories.push({ id: seed.id, updatedAt: ts, name: seed.name, color: seed.color, role: seed.role })
    }
  }

  // Category id remaps: Taxes/Bank fees → Taxes & fees; Subscriptions → Other.
  const remap = new Map<string, string>()
  const taxesFeesId = idByName('Taxes & fees')!
  for (const oldName of ['Taxes', 'Bank fees']) {
    const old = categories.find((c) => c.name.toLowerCase() === oldName.toLowerCase())
    if (old && old.id !== taxesFeesId) remap.set(old.id, taxesFeesId)
  }
  const subsId = categories.find((c) => c.name.toLowerCase() === 'subscriptions')?.id
  const otherId = idByName('Other')!
  const housingId = idByName('Housing')!
  if (subsId) remap.set(subsId, otherId)

  const removedCatIds = new Set(remap.keys())
  const finalCategories = categories.filter((c) => !removedCatIds.has(c.id))
  for (const id of removedCatIds) drop(id, 'categories')

  // Transactions: reassign remapped categories; retired-subscription rows are flagged recurring.
  const transactions = v.transactions.map((tx) => {
    const to = remap.get(tx.categoryId)
    if (!to) return tx
    const next = { ...tx, categoryId: to, updatedAt: ts }
    if (tx.categoryId === subsId && !next.recurring) next.recurring = 'monthly'
    return next
  })

  // Budgets: convert the Subscriptions budget to a Recurring · monthly budget; reassign the rest.
  const budgets = v.budgets.map((b): Budget => {
    if (subsId && b.categoryId === subsId && !b.scope) {
      return {
        ...b, updatedAt: ts, categoryId: CAT_TRANSFERS,
        scope: { kind: 'recurring', cadence: 'monthly', excludeCategoryIds: [housingId] },
      }
    }
    let next = b
    const to = remap.get(b.categoryId)
    if (to) next = { ...next, categoryId: to, updatedAt: ts }
    if (next.scope?.kind === 'category-year') {
      const sto = remap.get(next.scope.categoryId)
      if (sto) next = { ...next, updatedAt: ts, scope: { ...next.scope, categoryId: sto } }
    }
    return next
  })

  // Rules: repoint Taxes/Bank fees rules to the merged category; drop the now-meaningless subs rules.
  const rules: Vault['rules'] = []
  for (const r of v.rules) {
    const to = remap.get(r.categoryId)
    if (!to) { rules.push(r); continue }
    if (r.categoryId === subsId) { drop(r.id, 'rules'); continue }
    rules.push({ ...r, categoryId: to, updatedAt: ts })
  }

  return { ...v, schema: 4, categories: finalCategories, transactions, budgets, rules, tombstones }
}

/** Forward migrations for older-schema payloads (keyed by the schema they upgrade FROM). */
const migrations: Record<number, (v: Vault) => Vault> = {
  // 1 → 2: import records (IMPORT §4). Additive + lossless. The Transfers
  // category is minted deterministically (fixed id + updatedAt from createdAt,
  // Convention #4) so two devices migrating independently produce identical output.
  1: (v) => ({
    ...v,
    schema: 2,
    statements: [],
    rules: [],
    fxOverrides: [],
    params: { ...v.params, baseCurrency: v.params.baseCurrency ?? 'EUR' },
    categories: v.categories.some((c) => c.id === CAT_TRANSFERS)
      ? v.categories
      : [
          ...v.categories,
          { id: CAT_TRANSFERS, updatedAt: v.createdAt, name: 'Transfers', color: 'var(--c-other)' },
        ],
  }),
  // 2 → 3: analytics records (ANALYTICS §2). Purely additive: three empty
  // collections, optional fields elsewhere, existing records untouched.
  2: (v) => ({
    ...v,
    schema: 3,
    trackings: [],
    trackingAssignments: [],
    savedComparisons: [],
  }),
  3: migrateV3toV4,
  // 4 → 5: assistant skills (ASSISTANT §7). One empty collection; every existing record is
  // untouched, so a vault that never opens the assistant is byte-identical apart from the version.
  4: (v) => ({ ...v, schema: 5, skills: [] }),
  // 5 → 6: `Budget.scope` gains `{ kind: 'group' }` (several categories under one limit) and
  // `Budget.name`. The RECORDS need no change — the version IS the payload, and this is the
  // first migration that only stamps a number.
  //
  // It exists because a schema-5 peer decrypts such a vault fine (`schema === 5`, so no
  // `schemaNewer`), merges it, and its `budgetKey` has no arm for the unknown kind: the group
  // falls through to `cat|cat-transfers`, collides with a cross-category recurring budget, and
  // `postPassBudgets` answers a collision with a tombstone that syncs back. Losing a live
  // budget is worse than sending an un-updated device down the §6.3 read-only path, so the
  // bump buys that guard. A reload clears it — there is no service worker to bust.
  5: (v) => ({ ...v, schema: 6 }),
  // 6 → 7: charts pinned from any screen (`pinnedWidgets`). Additive like 2 → 3 and 4 → 5 —
  // one empty collection, every existing record untouched, and a vault that never pins a chart
  // differs only in the version.
  6: (v) => ({ ...v, schema: 7, pinnedWidgets: [] }),
}

export function migrate(vault: Vault): Vault {
  let v = vault
  while (v.schema < SCHEMA_VERSION) {
    const step = migrations[v.schema]
    if (!step) break
    v = step(v)
  }
  return v
}

export type DecryptResult =
  | { kind: 'ok'; vault: Vault }
  | { kind: 'rekeyed'; header: VaultHeader } // salt differs from ours → password changed elsewhere (§5.4)
  | { kind: 'corrupt' } // salt matches but AEAD fails, or unparseable (§6.2)
  | { kind: 'schemaNewer'; vault: Vault } // decrypts, but written by a newer app (§6.3)

/** Classify a REMOTE blob against our session key + cached salt. */
export async function decryptClassify(blob: Uint8Array, key: CryptoKey, cachedSalt: Uint8Array): Promise<DecryptResult> {
  const parsed = parseBlob(blob)
  if (!parsed) return { kind: 'corrupt' }
  if (parsed.header.kdf.salt !== b64(cachedSalt)) return { kind: 'rekeyed', header: parsed.header }
  const vault = await tryDecrypt(parsed, key)
  if (!vault) return { kind: 'corrupt' }
  if (vault.schema > SCHEMA_VERSION) return { kind: 'schemaNewer', vault }
  return { kind: 'ok', vault: migrate(vault) }
}

export type UnlockResult =
  | { kind: 'ok'; vault: Vault; key: CryptoKey; salt: Uint8Array }
  | { kind: 'wrongPassword' }
  | { kind: 'corrupt' }
  | { kind: 'schemaNewer'; vault: Vault; key: CryptoKey; salt: Uint8Array }

/** Unlock a LOCAL blob with a password: derive from the blob's own header salt. */
export async function unlockBlob(blob: Uint8Array, password: string, params?: KdfParams): Promise<UnlockResult> {
  const parsed = parseBlob(blob)
  if (!parsed) return { kind: 'corrupt' }
  const salt = unb64(parsed.header.kdf.salt)
  const kdf: KdfParams = params ?? { m: parsed.header.kdf.m, t: parsed.header.kdf.t, p: parsed.header.kdf.p }
  const key = await deriveKey(password, salt, kdf)
  const vault = await tryDecrypt(parsed, key)
  if (!vault) return { kind: 'wrongPassword' }
  if (vault.schema > SCHEMA_VERSION) return { kind: 'schemaNewer', vault, key, salt }
  return { kind: 'ok', vault: migrate(vault), key, salt }
}
