import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Vault, SaveMode } from '../src/model/types'
import { Autosave } from '../src/persist/autosave'
import { KV } from '../src/persist/idb'
import { LocalStore } from '../src/persist/localStore'
import { buildVault } from './helpers/build'

describe('autosave debounce', () => {
  let saves: { vault: Vault; reason: string }[]
  let mode: SaveMode
  let auto: Autosave

  beforeEach(() => {
    vi.useFakeTimers()
    saves = []
    mode = 'onChange'
    auto = new Autosave({
      save: async (vault, reason) => {
        saves.push({ vault, reason })
      },
      getSaveMode: () => mode,
    })
  })

  afterEach(() => vi.useRealTimers())

  it('coalesces 6 rapid commits into one save', async () => {
    const v = buildVault()
    for (let i = 0; i < 6; i++) {
      auto.markDirty({ ...v })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(saves).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(saves).toHaveLength(1)
    expect(saves[0]!.reason).toBe('auto')
  })

  it('max-wait bounds continuous editing to 5s of risk', async () => {
    const v = buildVault()
    // keep editing every 500ms forever — trailing debounce alone would never fire
    for (let i = 0; i < 11; i++) {
      auto.markDirty({ ...v })
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(saves.length).toBeGreaterThanOrEqual(1) // max-wait fired at 5s
  })

  it('flush saves immediately', async () => {
    auto.markDirty(buildVault())
    await auto.flush()
    expect(saves).toHaveLength(1)
    expect(saves[0]!.reason).toBe('flush')
  })

  it('flush with nothing pending is a no-op', async () => {
    await auto.flush()
    expect(saves).toHaveLength(0)
  })

  it('onLock mode: no auto saves, flush still writes', async () => {
    mode = 'onLock'
    auto.markDirty(buildVault())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saves).toHaveLength(0)
    await auto.flush()
    expect(saves).toHaveLength(1)
  })

  it('manual mode: explicit save works', async () => {
    mode = 'manual'
    auto.markDirty(buildVault())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(saves).toHaveLength(0)
    await auto.flush('explicit')
    expect(saves[0]!.reason).toBe('explicit')
  })
})

describe('autosave failure', () => {
  let saves: Vault[]
  let errors: unknown[]
  let failing: boolean
  let auto: Autosave

  beforeEach(() => {
    vi.useFakeTimers()
    saves = []
    errors = []
    failing = true
    auto = new Autosave({
      save: async (vault) => {
        if (failing) throw new Error('quota')
        saves.push(vault)
      },
      getSaveMode: () => 'onChange',
      onSaveError: (e) => errors.push(e),
    })
  })

  afterEach(() => vi.useRealTimers())

  it('a rejected save keeps the vault pending and does not end saving', async () => {
    const v = buildVault()
    auto.markDirty(v)
    await vi.advanceTimersByTimeAsync(1000)
    expect(errors).toHaveLength(1)
    expect(auto.dirty).toBe(true) // the dirty vault was not lost
    failing = false
    await auto.flush() // the chain is not poisoned: this save still runs
    expect(saves).toEqual([v])
    expect(auto.dirty).toBe(false)
  })

  it('a newer edit during the failed save supersedes the old vault', async () => {
    const v1 = buildVault()
    const v2 = { ...v1 }
    auto.markDirty(v1)
    const attempt = auto.flush().catch(() => {})
    auto.markDirty(v2) // arrives while the save is failing
    await attempt
    failing = false
    await auto.flush()
    expect(saves).toEqual([v2]) // v2 contains all state; v1 must not overwrite it
  })

  it('flush rejects so explicit callers can react', async () => {
    auto.markDirty(buildVault())
    await expect(auto.flush('explicit')).rejects.toThrow('quota')
  })
})

describe('L1 store atomicity', () => {
  it('saveVaultBlob writes blob + revision + pendingWrite in one transaction', async () => {
    const kv = await KV.open('test-atomic-' + Math.random())
    const store = new LocalStore(kv)
    const blob = new TextEncoder().encode('LGR1-fake')
    const rev = await store.saveVaultBlob(blob)
    expect(rev).toBe(1)
    expect(await store.getPendingWrite()).toBe(true)
    expect(new Uint8Array((await store.getBlob())!)).toEqual(blob)
    const rev2 = await store.saveVaultBlob(blob)
    expect(rev2).toBe(2)
  })

  it('commitSync clears pendingWrite and stores base + revision', async () => {
    const kv = await KV.open('test-commit-' + Math.random())
    const store = new LocalStore(kv)
    await store.saveVaultBlob(new Uint8Array([1]))
    await store.commitSync('r9', new Uint8Array([2, 3]))
    expect(await store.getPendingWrite()).toBe(false)
    expect(await store.getLastSyncedRevision()).toBe('r9')
    expect(new Uint8Array((await store.getLastSyncedBase())!)).toEqual(new Uint8Array([2, 3]))
  })
})
