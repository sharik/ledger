import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { Vault } from '../src/model/types'
import { applyOp } from '../src/model/mutations'
import { deriveKey, makeHeader, newSalt, type KdfParams } from '../src/persist/crypto'
import { KV } from '../src/persist/idb'
import { createVault, Session, unlockPeek, unlockVault } from '../src/persist/session'
import { buildVault } from './helpers/build'

const TEST_KDF: KdfParams = { m: 64, t: 1, p: 1 }

const addTxnOp = (merchant: string) =>
  ({
    kind: 'addTransaction' as const,
    txn: { date: '2026-07-08', merchant, categoryId: 'cat-dining', amount: -10 },
  })

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for broadcast')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Two Sessions sharing one L1 — the two-tabs harness. Manual save mode so the
 *  test controls exactly when each "tab" writes. */
async function twoTabs(vault: Vault) {
  const kv = await KV.open('tabs-' + Math.random().toString(36).slice(2))
  const salt = newSalt()
  const key = await deriveKey('pw', salt, TEST_KDF)
  const header = makeHeader(vault.vaultId, salt, TEST_KDF)
  const A = new Session(kv, key, salt, header, () => 'manual', TEST_KDF)
  const B = new Session(kv, key, salt, header, () => 'manual', TEST_KDF)
  A.noteL1(vault)
  B.noteL1(vault)
  A.startBroadcast(() => A.local.getLocalRevision())
  B.startBroadcast(() => B.local.getLocalRevision())
  return { A, B, key }
}

describe('sibling-tab update with local unsaved edits', () => {
  it('a dirty tab merges the sibling vault instead of dropping its edits', async () => {
    const base = buildVault()
    const { A, B, key } = await twoTabs(base)

    // Tab A holds an unsaved edit; tab B saves a different one and broadcasts.
    A.autosave.markDirty(applyOp(base, addTxnOp('From-A')).vault)
    let adoptedByA: Vault | null = null
    A.events.onSiblingUpdate = (v) => {
      adoptedByA = v
    }
    B.autosave.markDirty(applyOp(base, addTxnOp('From-B')).vault)
    await B.autosave.flush('explicit')

    await until(() => adoptedByA !== null)
    const merchants = (v: Vault) => v.transactions.map((t) => t.merchant).sort()
    // Neither side was clobbered…
    expect(merchants(adoptedByA!)).toEqual(['From-A', 'From-B'])
    // …and A's merged result is queued for saving, not silently forgotten.
    expect(A.autosave.dirty).toBe(true)

    // A's next save writes the union, so B's edit is not overwritten by a stale pending.
    await A.autosave.flush('explicit')
    const l1 = await unlockPeek(new Uint8Array((await A.local.getBlob())!), key)
    expect(merchants(l1!)).toEqual(['From-A', 'From-B'])
  })

  it('a clean tab still adopts the sibling vault wholesale', async () => {
    const base = buildVault()
    const { A, B } = await twoTabs(base)

    let adoptedByA: Vault | null = null
    A.events.onSiblingUpdate = (v) => {
      adoptedByA = v
    }
    B.autosave.markDirty(applyOp(base, addTxnOp('From-B')).vault)
    await B.autosave.flush('explicit')

    await until(() => adoptedByA !== null)
    expect(adoptedByA!.transactions.map((t) => t.merchant)).toEqual(['From-B'])
    expect(A.autosave.dirty).toBe(false)
  })
})

describe('changePassword', () => {
  it('re-keys: the new password unlocks, the old one does not', async () => {
    const kv = await KV.open('cp-' + Math.random().toString(36).slice(2))
    const vault = buildVault()
    const session = await createVault(kv, 'old-password', vault, () => 'manual', TEST_KDF)
    await session.changePassword('new-password', vault)

    expect((await unlockVault(kv, 'new-password', () => 'manual', TEST_KDF)).kind).toBe('ok')
    expect((await unlockVault(kv, 'old-password', () => 'manual', TEST_KDF)).kind).toBe('wrongPassword')
  })

  it('a failed re-key flush changes NOTHING — old password valid, salt cache untouched', async () => {
    const kv = await KV.open('cp-' + Math.random().toString(36).slice(2))
    const vault = buildVault()
    const session = await createVault(kv, 'old-password', vault, () => 'manual', TEST_KDF)
    const saltBefore = new Uint8Array((await session.local.getSaltCache())!)

    // The L1 write fails (quota, eviction) exactly once, mid-re-key.
    const realSave = session.local.saveVaultBlob.bind(session.local)
    session.local.saveVaultBlob = () => Promise.reject(new Error('quota'))
    await expect(session.changePassword('new-password', vault)).rejects.toThrow('quota')
    session.local.saveVaultBlob = realSave

    // Salt cache still pairs with the stored blob — no REKEY_NEEDED trap…
    expect(new Uint8Array((await session.local.getSaltCache())!)).toEqual(saltBefore)
    // …and the vault still opens with the password the user believes is current.
    expect((await unlockVault(kv, 'old-password', () => 'manual', TEST_KDF)).kind).toBe('ok')
    // The rolled-back session still saves under the OLD key (blob stays consistent).
    session.autosave.markDirty(vault)
    await session.autosave.flush('explicit')
    expect((await unlockVault(kv, 'old-password', () => 'manual', TEST_KDF)).kind).toBe('ok')
  })
})
