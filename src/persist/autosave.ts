import type { Vault, SaveMode } from '../model/types'

export type SaveReason = 'auto' | 'flush' | 'explicit'

export interface AutosaveOptions {
  save: (vault: Vault, reason: SaveReason) => Promise<void>
  getSaveMode: () => SaveMode
  /** A save rejected. The vault is back in `pending`; the next save still runs. */
  onSaveError?: (err: unknown) => void
  debounceMs?: number
  maxWaitMs?: number
}

/**
 * SYNC §2.1: trailing debounce 1 s, max-wait 5 s, immediate flush on
 * tab-death events. Save modes gate only the AUTO behavior — flush events
 * always write L1 regardless of mode (data safety is not configurable).
 */
export class Autosave {
  private pending: Vault | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private readonly debounceMs: number
  private readonly maxWaitMs: number

  constructor(private opts: AutosaveOptions) {
    this.debounceMs = opts.debounceMs ?? 1000
    this.maxWaitMs = opts.maxWaitMs ?? 5000
  }

  get dirty(): boolean {
    return this.pending !== null
  }

  /** The unsaved vault, if any — the sibling-tab merge needs it as "local". */
  get pendingVault(): Vault | null {
    return this.pending
  }

  /** Called on every commit. */
  markDirty(vault: Vault): void {
    this.pending = vault
    if (this.opts.getSaveMode() !== 'onChange') return // onLock/manual: only flush events save
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.runSwallowed('auto'), this.debounceMs)
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.runSwallowed('auto'), this.maxWaitMs)
    }
  }

  /** Immediate save of anything pending. reason='explicit' for user-invoked saves. */
  flush(reason: SaveReason = 'flush'): Promise<void> {
    return this.run(reason)
  }

  /** Fire-and-forget run: the failure already reached onSaveError, so don't also
   *  raise an unhandled rejection from a timer or lifecycle event. */
  private runSwallowed(reason: SaveReason): void {
    this.run(reason).catch(() => {})
  }

  private run(reason: SaveReason): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    this.debounceTimer = null
    this.maxWaitTimer = null
    const vault = this.pending
    if (!vault) return this.saving
    this.pending = null
    // Serialize saves so a slow save never interleaves with the next.
    const attempt = this.saving.then(() => this.opts.save(vault, reason))
    // A rejected save must not end saving for the session: put the vault back in
    // `pending` (unless a newer edit already superseded it) and keep the stored
    // chain resolved, or every later run() would short-circuit on the rejection.
    this.saving = attempt.catch((e) => {
      if (this.pending === null) this.pending = vault
      this.opts.onSaveError?.(e)
    })
    return attempt
  }

  /** Wire the tab-death flush events. Returns a teardown. */
  attachLifecycle(): () => void {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') this.runSwallowed('flush')
    }
    const onPagehide = () => this.runSwallowed('flush')
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPagehide)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPagehide)
    }
  }
}
