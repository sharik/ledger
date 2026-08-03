import 'fake-indexeddb/auto'
import type { Vault } from '../../src/model/types'
import { applyOp, type Op } from '../../src/model/mutations'
import { KV } from '../../src/persist/idb'
import { LocalStore } from '../../src/persist/localStore'
import {
  decryptRaw,
  deriveKey,
  encodeVault,
  encryptBlob,
  makeHeader,
  newSalt,
  stableStringify,
  type KdfParams,
  type VaultHeader,
} from '../../src/persist/crypto'
import { SyncEngine, type EngineStatus } from '../../src/sync/engine'
import type { RemoteAdapter } from '../../src/sync/adapter'

export const TEST_KDF: KdfParams = { m: 64, t: 1, p: 1 }

export interface DeviceKeys {
  key: CryptoKey
  salt: Uint8Array
}

export async function makeKeys(password = 'pw'): Promise<DeviceKeys> {
  const salt = newSalt()
  const key = await deriveKey(password, salt, TEST_KDF)
  return { key, salt }
}

export class FakeDevice {
  vault!: Vault
  local!: LocalStore
  engine!: SyncEngine
  keys!: DeviceKeys
  statuses: EngineStatus[] = []
  rekeyHeaders: VaultHeader[] = []
  corruptSignals = 0
  online = true
  private dirty = false

  static async create(name: string, adapter: RemoteAdapter, keys: DeviceKeys, initial: Vault): Promise<FakeDevice> {
    const d = new FakeDevice()
    d.keys = keys
    d.vault = initial
    const kv = await KV.open(`dev-${name}-${Math.random().toString(36).slice(2)}`)
    d.local = new LocalStore(kv)
    d.engine = new SyncEngine({
      adapter,
      local: d.local,
      crypto: {
        key: () => d.keys.key,
        salt: () => d.keys.salt,
        encrypt: (v) => d.encrypt(v),
      },
      getVault: () => d.vault,
      applyVault: (v) => {
        d.vault = v
      },
      flushSaves: () => d.save(),
      onStatus: (s) => d.statuses.push(s),
      onRekeyNeeded: (h) => d.rekeyHeaders.push(h),
      onCorrupt: () => {
        d.corruptSignals++
      },
      isOnline: () => d.online,
      backoff: { baseMs: 1, capMs: 5, maxRetries: 8, jitter: () => 1 },
    })
    return d
  }

  encrypt(v: Vault): Promise<Uint8Array> {
    return encryptBlob(encodeVault(v), this.keys.key, makeHeader(v.vaultId, this.keys.salt, TEST_KDF))
  }

  commit(op: Op): void {
    const { vault } = applyOp(this.vault, op)
    this.vault = vault
    this.dirty = true
  }

  markDirty(): void {
    this.dirty = true
  }

  /** Mirror Session.adoptKey (SYNC §5.4): swap keys AND re-encrypt the stored
   *  base, or the engine rightly refuses the next merge as base-less. */
  async adoptKeys(next: DeviceKeys): Promise<void> {
    const buf = await this.local.getLastSyncedBase()
    const base = buf ? await decryptRaw(new Uint8Array(buf), this.keys.key) : null
    this.keys = next
    if (base) await this.local.setLastSyncedBase(await this.encrypt(base))
  }

  /** The autosave flush stand-in (unit-tested separately). */
  async save(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await this.local.saveVaultBlob(await this.encrypt(this.vault))
  }

  async sync(): Promise<void> {
    await this.engine.syncNow()
  }

  /** Sync and wait for retries to drain. */
  async syncSettled(timeoutMs = 2000): Promise<void> {
    await this.engine.syncNow()
    const t0 = Date.now()
    while (this.engine.busy) {
      if (Date.now() - t0 > timeoutMs) throw new Error('engine did not settle')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  lastState(): string {
    return this.statuses[this.statuses.length - 1]?.state ?? 'NONE'
  }

  merchants(): string[] {
    return this.vault.transactions.map((t) => t.merchant).sort()
  }
}

/** Two devices sharing one remote, both already synced at the same base. */
export async function makePair(adapter: RemoteAdapter, initial: Vault) {
  const keys = await makeKeys()
  const A = await FakeDevice.create('A', adapter, keys, structuredClone(initial))
  const B = await FakeDevice.create('B', adapter, keys, structuredClone(initial))
  // A creates the remote; B round-trips once; A pulls back — both now share a synced base.
  A.markDirty()
  await A.sync()
  B.markDirty()
  await B.sync()
  await A.sync()
  return { A, B, keys }
}

/** Canonical, timestamp-free serialization — the "devices render identical state" probe. */
export function stripIds(v: Vault): string {
  const noTimes = JSON.parse(
    JSON.stringify(v, (k, val) => (k === 'updatedAt' || k === 'createdAt' || k === 'deletedAt' ? undefined : val)),
  )
  return stableStringify(noTimes)
}
