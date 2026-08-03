import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { Vault } from '../model/types'
import type { Op } from '../model/mutations'
import { applyOp } from '../model/mutations'
import { derive, visibleVault, type Derived } from '../model/selectors'
import { useRateBook } from './fxCtx'

export type SyncStateName =
  | 'LOCAL_ONLY'
  | 'IDLE_CLEAN'
  | 'DIRTY'
  | 'SAVING_L1'
  | 'SAVE_ERROR'
  | 'SYNCING'
  | 'RETRY'
  | 'OFFLINE_PENDING'
  | 'ERROR_BACKOFF'
  | 'REAUTH_NEEDED'
  | 'READONLY_SCHEMA'
  | 'REKEY_NEEDED'
  | 'CORRUPT_REMOTE'

export interface SyncStatus {
  state: SyncStateName
  lastSyncedAt: string | null // 'hh:mm'
  message?: string
}

export interface ToastState {
  msg: string
  undo?: Op
  key: number // re-triggers the auto-hide timer
}

export interface Banner {
  kind: 'corrupt' | 'rekey' | 'schema' | 'reconnect'
  text: string
  actions: { label: string; run: () => void }[]
}

export interface StoreState {
  vault: Vault
  toast: ToastState | null
  sync: SyncStatus
  banner: Banner | null
}

export class AppStore {
  private state: StoreState
  private listeners = new Set<() => void>()
  /** Persistence hook — wired to autosave/broadcast once the vault is unlocked. */
  onCommit: ((vault: Vault) => void) | null = null

  constructor(vault: Vault) {
    this.state = { vault, toast: null, sync: { state: 'LOCAL_ONLY', lastSyncedAt: null }, banner: null }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): StoreState => this.state

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  /** The true vault — hidden accounts included. `AppStore` never stores or emits a projected
   *  vault: the visibility projection is a read-side lens that exists only above the hook
   *  boundary, so persistence, autosave and sync are structurally unable to see it. */
  get vault(): Vault {
    return this.state.vault
  }

  /** Apply a durable mutation; optionally raise a toast (with undo = the inverse op). */
  commit(op: Op, toast?: { msg: string; undoable?: boolean }): void {
    const { vault, inverse } = applyOp(this.state.vault, op)
    if (vault === this.state.vault) return
    this.set({
      vault,
      toast: toast ? { msg: toast.msg, undo: toast.undoable ? inverse : undefined, key: Date.now() } : this.state.toast,
    })
    this.onCommit?.(vault)
  }

  /** Replace the whole model (merge apply, multi-tab reload, demo load). */
  replaceVault(vault: Vault, opts?: { persist?: boolean }): void {
    this.set({ vault })
    if (opts?.persist !== false) this.onCommit?.(vault)
  }

  undoToast(): void {
    const undo = this.state.toast?.undo
    this.set({ toast: null })
    if (undo) this.commit(undo)
  }

  showToast(msg: string): void {
    this.set({ toast: { msg, key: Date.now() } })
  }

  hideToast(): void {
    if (this.state.toast) this.set({ toast: null })
  }

  setSyncStatus(sync: SyncStatus): void {
    if (
      sync.state !== this.state.sync.state ||
      sync.lastSyncedAt !== this.state.sync.lastSyncedAt ||
      sync.message !== this.state.sync.message
    ) {
      this.set({ sync })
    }
  }

  setBanner(banner: Banner | null): void {
    this.set({ banner })
  }
}

const StoreContext = createContext<AppStore | null>(null)
export const StoreProvider = StoreContext.Provider

export function useStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('StoreProvider missing')
  return store
}

/** The store's true state, hidden accounts included. Import, export, Settings and the
 *  Accounts list read this — anything that must not lie about what the vault holds. */
export function useRawStoreState(): StoreState {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useRawVault(): Vault {
  return useRawStoreState().vault
}

/**
 * The analytics read model: the store state with `vault` projected through `visibleVault`,
 * so hidden accounts and everything anchored to them are gone. Projected is the DEFAULT on
 * purpose — a screen that forgets to opt in can only over-hide (immediately visible), never
 * leak a hidden account back into a chart (silent). Use `useRawVault` where the truth is
 * required, and say why.
 */
export function useStoreState(): StoreState {
  const raw = useRawStoreState()
  const vault = visibleVault(raw.vault)
  // `visibleVault` returns `raw.vault` itself when nothing is hidden, so the common case
  // hands back the identical StoreState and every downstream identity check is unaffected.
  return useMemo(() => (vault === raw.vault ? raw : { ...raw, vault }), [raw, vault])
}

export function useDerived(): Derived {
  const { vault } = useStoreState()
  // Full FX chain: API tables from context join the vault's own rates, so every
  // derived sum (KPIs, Trends, budgets, net worth) is converted into base. The book
  // is built over the RAW vault (see `useRateBook`) while `derive` sees the visible one.
  const rates = useRateBook()
  return derive(vault, rates)
}
