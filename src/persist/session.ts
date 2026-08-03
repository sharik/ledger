import type { Vault, SaveMode } from '../model/types'
import { threeWayMerge } from '../sync/merge'
import { KV } from './idb'
import { LocalStore } from './localStore'
import { Autosave, type SaveReason } from './autosave'
import {
  DEFAULT_KDF,
  decryptRaw,
  deriveKey,
  encodeVault,
  encryptBlob,
  makeHeader,
  newSalt,
  unlockBlob,
  type KdfParams,
  type UnlockResult,
  type VaultHeader,
} from './crypto'

export interface SessionEvents {
  /** After an L1 save commits. The sync engine pokes off this. */
  onSaved?: (localRevision: number, reason: SaveReason) => void
  /** A sibling tab saved a newer revision — reload L0 from L1. */
  onSiblingUpdate?: (vault: Vault, localRevision: number) => void
  onSaveStateChange?: (saving: boolean) => void
  /** An L1 save failed. The dirty vault is retained in memory and will retry. */
  onSaveError?: (err: unknown) => void
}

/** Everything that needs the unlocked key: save pipeline, re-key, sibling reload. */
export class Session {
  readonly autosave: Autosave
  readonly local: LocalStore
  private header: VaultHeader
  private channel: BroadcastChannel | null = null
  /** The L1 vault this tab last wrote or adopted — the base for tab-vs-tab merges. */
  private lastL1: Vault | null = null
  events: SessionEvents = {}

  constructor(
    readonly kv: KV,
    private key: CryptoKey,
    private salt: Uint8Array,
    header: VaultHeader,
    getSaveMode: () => SaveMode,
    private kdfParams: KdfParams = DEFAULT_KDF,
  ) {
    this.local = new LocalStore(kv)
    this.header = header
    this.autosave = new Autosave({
      save: (vault, reason) => this.save(vault, reason),
      getSaveMode,
      onSaveError: (e) => this.events.onSaveError?.(e),
    })
  }

  get cachedSalt(): Uint8Array {
    return this.salt
  }

  get cryptoKey(): CryptoKey {
    return this.key
  }

  get vaultHeader(): VaultHeader {
    return this.header
  }

  /** Encrypt with the session key — used for both vault.blob and lastSyncedBase. */
  encrypt(vault: Vault): Promise<Uint8Array> {
    return encryptBlob(encodeVault(vault), this.key, this.header)
  }

  private async save(vault: Vault, reason: SaveReason): Promise<void> {
    this.events.onSaveStateChange?.(true)
    try {
      const run = async () => {
        const blob = await this.encrypt(vault)
        const rev = await this.local.saveVaultBlob(blob)
        this.channel?.postMessage({ type: 'model-updated', localRevision: rev })
        this.events.onSaved?.(rev, reason)
      }
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request('ledger-save', run)
      } else {
        await run()
      }
      this.lastL1 = vault
    } finally {
      this.events.onSaveStateChange?.(false)
    }
  }

  /** Prime the tab-merge base with the vault as unlocked from L1. */
  noteL1(vault: Vault): void {
    this.lastL1 = vault
  }

  /** Multi-tab: listen for sibling saves and hand the decrypted newer vault to the app. */
  startBroadcast(getLocalRevision: () => Promise<number>): void {
    if (typeof BroadcastChannel === 'undefined') return
    this.channel = new BroadcastChannel('ledger')
    this.channel.onmessage = async (e: MessageEvent) => {
      const msg = e.data as { type?: string; localRevision?: number }
      if (msg?.type !== 'model-updated' || typeof msg.localRevision !== 'number') return
      const mine = await getLocalRevision()
      if (msg.localRevision < mine) return
      const buf = await this.local.getBlob()
      if (!buf) return
      const res = await unlockPeek(new Uint8Array(buf), this.key)
      if (!res) return
      // A dirty tab must not adopt the sibling's blob wholesale: that drops this
      // tab's unsaved edits — and the stale pending vault would then save over
      // the sibling's change. Merge instead (base = the L1 state this tab last
      // saw) and re-queue the merged result so both sides survive.
      const pending = this.autosave.pendingVault
      let adopted = res
      if (pending) {
        adopted = threeWayMerge(this.lastL1 ?? res, pending, res).merged
        this.autosave.markDirty(adopted)
      }
      this.lastL1 = res
      this.events.onSiblingUpdate?.(adopted, msg.localRevision)
    }
  }

  /** Re-key: new salt + key, re-encrypt vault AND base, save immediately (SYNC §5.4 sender side).
   *  Ordering is load-bearing: the NEW-key vault blob must be durable before the salt
   *  cache flips — a cache pointing at a key the stored blob does not use classifies
   *  every remote read as `rekeyed` and parks the engine in REKEY_NEEDED for good.
   *  If the flush fails, the in-memory key/salt/header roll back and nothing changed. */
  async changePassword(next: string, vault: Vault): Promise<void> {
    const oldKey = this.key
    const oldSalt = this.salt
    const oldHeader = this.header
    const salt = newSalt()
    this.key = await deriveKey(next, salt, this.kdfParams)
    this.salt = salt
    this.header = makeHeader(this.header.vaultId, salt, this.kdfParams)
    try {
      this.autosave.markDirty(vault)
      await this.autosave.flush('explicit')
    } catch (e) {
      this.key = oldKey
      this.salt = oldSalt
      this.header = oldHeader
      throw e
    }
    await this.local.setSaltCache(salt)
    await this.reencryptBase(oldKey)
  }

  /** Adopt a new key after the remote was re-keyed elsewhere (SYNC §5.4 receiver side). */
  async adoptKey(key: CryptoKey, salt: Uint8Array, header: VaultHeader): Promise<void> {
    const oldKey = this.key
    this.key = key
    this.salt = salt
    this.header = makeHeader(header.vaultId, salt, { m: header.kdf.m, t: header.kdf.t, p: header.kdf.p })
    await this.local.setSaltCache(salt)
    await this.reencryptBase(oldKey)
  }

  /** lastSyncedBase must survive a key change, or the next merge loses its base. */
  private async reencryptBase(oldKey: CryptoKey): Promise<void> {
    const buf = await this.local.getLastSyncedBase()
    if (!buf) return
    const base = await decryptRaw(new Uint8Array(buf), oldKey)
    if (!base) return
    await this.local.setLastSyncedBase(await this.encrypt(base))
  }

  async lock(vault: Vault | null): Promise<void> {
    if (vault) {
      this.autosave.markDirty(vault)
      await this.autosave.flush()
    }
    this.channel?.close()
    // The key reference dies with this session object.
  }
}

/**
 * Decrypt the local blob with an in-memory key (sibling reload path — no KDF),
 * migrating to the current schema (§4.1). Exported for tests (§4.4 case 4d).
 */
export async function unlockPeek(blob: Uint8Array, key: CryptoKey): Promise<Vault | null> {
  const { parseBlob, migrate } = await import('./crypto')
  const parsed = parseBlob(blob)
  if (!parsed) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parsed.iv as BufferSource, additionalData: parsed.headerBytes as BufferSource },
      key,
      parsed.ct as BufferSource,
    )
    return migrate(JSON.parse(new TextDecoder().decode(plain)) as Vault)
  } catch {
    return null
  }
}

/**
 * IMPORT §11: the IMPORTED badge marks *this* session's arrivals, and is "cleared at next
 * unlock". Applied on the password-unlock paths only — a sibling tab that just imported
 * should still show its badges. Not a mutation: `updatedAt` must not move, or a transient
 * field would start winning LWW races (SYNC §4.3).
 */
function clearImportBadges(vault: Vault): Vault {
  if (!vault.transactions.some((t) => t.isNew)) return vault
  return { ...vault, transactions: vault.transactions.map(({ isNew: _drop, ...t }) => t) }
}

export interface BootState {
  kv: KV
  hasVault: boolean
}

export async function bootProbe(dbName = 'ledger'): Promise<BootState> {
  const kv = await KV.open(dbName)
  const blob = await kv.get('vault.blob')
  return { kv, hasVault: blob !== undefined }
}

/** First run: derive, encrypt the initial vault, first save. */
export async function createVault(
  kv: KV,
  password: string,
  vault: Vault,
  getSaveMode: () => SaveMode,
  kdfParams: KdfParams = DEFAULT_KDF,
): Promise<Session> {
  const salt = newSalt()
  const key = await deriveKey(password, salt, kdfParams)
  const header = makeHeader(vault.vaultId, salt, kdfParams)
  const session = new Session(kv, key, salt, header, getSaveMode, kdfParams)
  await session.local.setSaltCache(salt)
  session.autosave.markDirty(vault)
  await session.autosave.flush('explicit')
  return session
}

export type UnlockOutcome =
  | { kind: 'ok'; session: Session; vault: Vault }
  | { kind: 'readonly'; session: Session; vault: Vault } // newer schema — view only, no push
  | { kind: 'wrongPassword' }
  | { kind: 'corrupt' }

/**
 * Adopt a vault from external bytes (an opened vault file): unlock it with its
 * own password, keep its salt/key/header (so other devices see no re-key), and
 * make it this device's local vault. Replaces whatever was in L1.
 */
export async function openFromBlob(
  kv: KV,
  blob: Uint8Array,
  password: string,
  getSaveMode: () => SaveMode,
): Promise<UnlockOutcome> {
  const res = await unlockBlob(blob, password)
  if (res.kind === 'wrongPassword' || res.kind === 'corrupt') return { kind: res.kind }
  res.vault = clearImportBadges(res.vault)
  const { parseBlob } = await import('./crypto')
  const header = parseBlob(blob)!.header
  const session = new Session(kv, res.key, res.salt, header, getSaveMode, {
    m: header.kdf.m,
    t: header.kdf.t,
    p: header.kdf.p,
  })
  await session.local.setSaltCache(res.salt)
  session.autosave.markDirty(res.vault)
  await session.autosave.flush('explicit')
  if (res.kind === 'schemaNewer') return { kind: 'readonly', session, vault: res.vault }
  return { kind: 'ok', session, vault: res.vault }
}

export async function unlockVault(
  kv: KV,
  password: string,
  getSaveMode: () => SaveMode,
  kdfParams?: KdfParams,
): Promise<UnlockOutcome> {
  const buf = await kv.get('vault.blob')
  if (!buf) return { kind: 'corrupt' }
  const blob = new Uint8Array(buf as ArrayBuffer)
  const res: UnlockResult = await unlockBlob(blob, password, kdfParams)
  if (res.kind === 'wrongPassword' || res.kind === 'corrupt') return { kind: res.kind }
  res.vault = clearImportBadges(res.vault)
  const { parseBlob } = await import('./crypto')
  const header = parseBlob(blob)!.header
  const session = new Session(
    kv,
    res.key,
    res.salt,
    header,
    getSaveMode,
    kdfParams ?? { m: header.kdf.m, t: header.kdf.t, p: header.kdf.p },
  )
  await session.local.setSaltCache(res.salt)
  session.noteL1(res.vault)
  if (res.kind === 'schemaNewer') return { kind: 'readonly', session, vault: res.vault }
  return { kind: 'ok', session, vault: res.vault }
}
