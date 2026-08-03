import type { Vault } from '../model/types'
import { nowDate } from '../model/clock'
import { decryptClassify, decryptRaw, stableStringify } from '../persist/crypto'
import type { LocalStore } from '../persist/localStore'
import { threeWayMerge } from './merge'
import { RemoteAdapter, RemoteAuthError, RemoteTransientError, RevisionConflictError } from './adapter'
import type { VaultHeader } from '../persist/crypto'

export type EngineState =
  | 'IDLE_CLEAN'
  | 'SYNCING'
  | 'RETRY'
  | 'OFFLINE_PENDING'
  | 'ERROR_BACKOFF'
  | 'REAUTH_NEEDED'
  | 'READONLY_SCHEMA'
  | 'REKEY_NEEDED'
  | 'CORRUPT_REMOTE'

export interface EngineStatus {
  state: EngineState
  lastSyncedAt: string | null // 'hh:mm'
}

export interface EngineDeps {
  adapter: RemoteAdapter
  local: LocalStore
  crypto: {
    key: () => CryptoKey
    salt: () => Uint8Array
    encrypt: (vault: Vault) => Promise<Uint8Array>
  }
  getVault: () => Vault
  /** Apply a merged model to L0 (display) — the engine persists L1 itself. */
  applyVault: (vault: Vault) => void
  /** Pre-push flush so vault.blob is fresh (SYNC §2.1 immediate-flush). */
  flushSaves: () => Promise<void>
  onStatus: (status: EngineStatus) => void
  /** Remote was re-keyed elsewhere — ask for the new password (SYNC §5.4). */
  onRekeyNeeded: (header: VaultHeader) => void
  /** Remote blob damaged — never overwritten blind (SYNC §6.2). */
  onCorrupt: () => void
  isOnline?: () => boolean
  backoff?: { baseMs?: number; capMs?: number; maxRetries?: number; jitter?: () => number }
  setTimeoutFn?: typeof setTimeout
}

/**
 * The auto-sync loop (SYNC §3). Single-flight: one operation at a time; any
 * trigger during a run sets syncRequested and the runner loops until clean.
 */
export class SyncEngine {
  private running = false
  private syncRequested = false
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastSyncedAt: string | null = null
  private halted: EngineState | null = null // REKEY/CORRUPT/READONLY park states
  private readonly baseMs: number
  private readonly capMs: number
  private readonly maxRetries: number

  constructor(private deps: EngineDeps) {
    this.baseMs = deps.backoff?.baseMs ?? 1000
    this.capMs = deps.backoff?.capMs ?? 60000
    this.maxRetries = deps.backoff?.maxRetries ?? 8
  }

  private status(state: EngineState): void {
    this.deps.onStatus({ state, lastSyncedAt: this.lastSyncedAt })
  }

  /** Clear a parked failure state (after re-key adoption or corruption recovery). */
  resume(): void {
    this.halted = null
    this.retryCount = 0
    this.requestSync()
  }

  /** Any trigger lands here: unlock, focus, online, poll, post-save. */
  requestSync(): void {
    this.syncRequested = true
    if (this.running) return
    void this.runLoop()
  }

  /** Awaitable variant (unlock pull, tests). Retries may still be pending after it resolves. */
  async syncNow(): Promise<void> {
    this.syncRequested = true
    if (this.running) {
      // wait for the current runner (it will consume the flag)
      while (this.running) await new Promise((r) => setTimeout(r, 5))
      return
    }
    await this.runLoop()
  }

  /** True while a sync runs or a retry is scheduled — test quiescence probe. */
  get busy(): boolean {
    return this.running || this.retryTimer !== null
  }

  private async runLoop(): Promise<void> {
    this.running = true
    try {
      const run = async () => {
        while (this.syncRequested) {
          this.syncRequested = false
          await this.cycle()
        }
      }
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request('ledger-sync', run)
      } else {
        await run()
      }
    } finally {
      this.running = false
      if (this.syncRequested) void this.runLoop()
    }
  }

  private async cycle(): Promise<void> {
    if (this.halted) {
      this.status(this.halted)
      return
    }
    if (this.deps.isOnline && !this.deps.isOnline()) {
      this.status('OFFLINE_PENDING')
      return
    }
    this.status('SYNCING')
    try {
      await this.push()
      this.retryCount = 0
      this.lastSyncedAt = fmtTime()
      this.status(this.halted ?? 'IDLE_CLEAN')
    } catch (e) {
      if (e instanceof RevisionConflictError) {
        this.scheduleRetry('RETRY')
      } else if (e instanceof RemoteAuthError) {
        this.halted = 'REAUTH_NEEDED'
        this.status('REAUTH_NEEDED')
      } else if (e instanceof RemoteTransientError || e instanceof TypeError) {
        // TypeError = fetch network failure
        this.scheduleRetry('ERROR_BACKOFF')
      } else {
        this.scheduleRetry('ERROR_BACKOFF')
      }
    }
  }

  private scheduleRetry(state: EngineState): void {
    this.retryCount++
    if (this.retryCount > this.maxRetries) {
      this.status('ERROR_BACKOFF')
      this.retryCount = 0
      return
    }
    this.status(state)
    const jitter = this.deps.backoff?.jitter ?? (() => 0.7 + Math.random() * 0.6)
    const delay = Math.min(this.capMs, this.baseMs * 2 ** (this.retryCount - 1)) * jitter()
    const st = this.deps.setTimeoutFn ?? setTimeout
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = st(() => {
      this.retryTimer = null
      this.requestSync()
    }, delay)
  }

  /** SYNC §3.4, verbatim. */
  private async push(): Promise<void> {
    await this.deps.flushSaves()
    const [blobBuf, pending, lastRev] = await Promise.all([
      this.deps.local.getBlob(),
      this.deps.local.getPendingWrite(),
      this.deps.local.getLastSyncedRevision(),
    ])
    if (!blobBuf) return
    const blob = new Uint8Array(blobBuf)

    const meta = await this.deps.adapter.getMetadata()

    if (meta === null) {
      // first ever save to this location
      const { revision } = await this.deps.adapter.write(blob, {})
      await this.commit(revision, blob)
      return
    }

    if (meta.revision === lastRev) {
      if (!pending) return // nothing to do — remote didn't move, nothing local to push
      const { revision } = await this.deps.adapter.write(blob, { ifRevision: meta.revision })
      await this.commit(revision, blob)
      return
    }

    // remote moved → pull + merge (+ push if we hold anything)
    await this.pullMergePush(pending)
  }

  private async pullMergePush(hadPending: boolean): Promise<void> {
    const { bytes, revision } = await this.deps.adapter.read()
    const res = await decryptClassify(bytes, this.deps.crypto.key(), this.deps.crypto.salt())

    if (res.kind === 'rekeyed') {
      this.halted = 'REKEY_NEEDED'
      this.status('REKEY_NEEDED')
      this.deps.onRekeyNeeded(res.header)
      return
    }
    if (res.kind === 'corrupt') {
      this.halted = 'CORRUPT_REMOTE'
      this.status('CORRUPT_REMOTE')
      this.deps.onCorrupt()
      return
    }
    if (res.kind === 'schemaNewer') {
      // Old client must not write a downgraded payload (SYNC §6.3).
      this.halted = 'READONLY_SCHEMA'
      this.status('READONLY_SCHEMA')
      return
    }

    const baseBuf = await this.deps.local.getLastSyncedBase()
    const base = baseBuf ? await decryptRaw(new Uint8Array(baseBuf), this.deps.crypto.key()) : null
    if (baseBuf && base === null) {
      // A stored base that fails to decrypt is NOT "first-ever sync": merging
      // with base=null unions both sides and resurrects pruned deletions.
      // Erroring here lands in ERROR_BACKOFF — and self-heals when the cause is
      // a re-key mid-flight (reencryptBase makes the next attempt readable).
      throw new Error('lastSyncedBase failed to decrypt — refusing base-less merge')
    }
    const { merged } = threeWayMerge(base, this.deps.getVault(), res.vault)

    // user sees merged reality BEFORE any network write
    this.deps.applyVault(merged)
    const mergedBlob = await this.deps.crypto.encrypt(merged)
    await this.deps.local.saveVaultBlob(mergedBlob)

    if (!hadPending && stableStringify(merged) === stableStringify(res.vault)) {
      // pure remote update — nothing of ours to push (SYNC §5.1)
      await this.commit(revision, mergedBlob)
      return
    }

    const { revision: newRev } = await this.deps.adapter.write(mergedBlob, { ifRevision: revision })
    await this.commit(newRev, mergedBlob)
  }

  /** Record exactly the bytes the remote now holds. Never re-encrypt the live
   *  vault here: an edit landing while the write was in flight would enter the
   *  base without ever reaching the remote, and the next three-way merge would
   *  read it as a *remote* change and silently revert it. */
  private async commit(rev: string, blob: Uint8Array): Promise<void> {
    await this.deps.local.commitSync(rev, blob)
  }

  /** §6.2 recovery: keep forensics, then restore the local copy over the damaged remote. */
  async restoreLocalOverRemote(): Promise<void> {
    const blobBuf = await this.deps.local.getBlob()
    if (!blobBuf) return
    const blob = new Uint8Array(blobBuf)
    try {
      const damaged = await this.deps.adapter.read()
      await this.deps.adapter.writeAux?.('vault.corrupt.bak', damaged.bytes)
      const { revision } = await this.deps.adapter.write(blob, { ifRevision: damaged.revision })
      await this.commit(revision, blob)
    } catch (e) {
      if (!(e instanceof RevisionConflictError)) throw e
      // someone else moved it meanwhile — normal path will handle it
    }
    this.halted = null
    this.retryCount = 0
    this.lastSyncedAt = fmtTime()
    this.status('IDLE_CLEAN')
  }

  /** Wire browser triggers (SYNC §3.1). Returns teardown. */
  attachTriggers(): () => void {
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.requestSync()
    }
    const onFocus = () => this.requestSync()
    const onOnline = () => this.requestSync()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') this.requestSync()
    }, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      clearInterval(poll)
    }
  }
}

function fmtTime(): string {
  const d = nowDate()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
