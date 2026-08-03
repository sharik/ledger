import { createContext, useContext } from 'react'

/** Actions that touch persistence / sync / crypto — provided by App once those layers exist. */
export interface PersistActions {
  remoteLabel: string // 'None' | 'ledger.vault — connected' | 'Google Drive · ledger.vault — connected'
  canLocalFile: boolean
  /** Does this build carry Google OAuth credentials? If not, Drive isn't offered. */
  canGoogleDrive: boolean
  /** Which remote is attached — the header and Settings word themselves differently per provider. */
  remoteKind: 'none' | 'localFile' | 'gdrive' | 'httpTest'
  /** Is L1 storage persistent (eviction-proof)? null = unknown / API unsupported. */
  storagePersisted: boolean | null
  connectFile: (mode: 'create' | 'open') => Promise<void>
  connectGoogleDrive: () => Promise<void>
  disconnectRemote: () => Promise<void>
  /** Re-grant access after a reload: an FSA permission prompt, or a fresh Google consent. */
  reconnectRemote: () => Promise<void>
  changePassword: (next: string) => Promise<void>
  lock: () => Promise<void>
  eraseAll: () => Promise<void>
  loadDemo: () => void
  saveNow: () => void
}

export const PersistContext = createContext<PersistActions | null>(null)

export function usePersist(): PersistActions {
  const p = useContext(PersistContext)
  if (!p) throw new Error('PersistContext missing')
  return p
}
