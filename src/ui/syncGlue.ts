import type { Session } from '../persist/session'
import type { VaultHeader } from '../persist/crypto'
import { unlockBlob } from '../persist/crypto'
import { SyncEngine, type EngineState } from '../sync/engine'
import type { RemoteAdapter } from '../sync/adapter'
import type { AppStore, SyncStateName } from './store'

const STATE_MAP: Record<EngineState, SyncStateName> = {
  IDLE_CLEAN: 'IDLE_CLEAN',
  SYNCING: 'SYNCING',
  RETRY: 'RETRY',
  OFFLINE_PENDING: 'OFFLINE_PENDING',
  ERROR_BACKOFF: 'ERROR_BACKOFF',
  REAUTH_NEEDED: 'REAUTH_NEEDED',
  READONLY_SCHEMA: 'READONLY_SCHEMA',
  REKEY_NEEDED: 'REKEY_NEEDED',
  CORRUPT_REMOTE: 'CORRUPT_REMOTE',
}

export interface EngineHandle {
  engine: SyncEngine
  adapter: RemoteAdapter
  /** Verify the new password against the remote, adopt the key, resume syncing. */
  submitRekeyPassword: (password: string) => Promise<string | null>
  teardown: () => void
}

export function attachEngine(
  store: AppStore,
  session: Session,
  adapter: RemoteAdapter,
  onRekeyNeeded: (header: VaultHeader) => void,
): EngineHandle {
  let lastEngineState: SyncStateName = 'SYNCING'
  let rekeyHeader: VaultHeader | null = null

  const engine = new SyncEngine({
    adapter,
    local: session.local,
    crypto: {
      key: () => session.cryptoKey,
      salt: () => session.cachedSalt,
      encrypt: (v) => session.encrypt(v),
    },
    getVault: () => store.vault,
    applyVault: (v) => store.replaceVault(v, { persist: false }), // engine persists L1 itself
    flushSaves: () => session.autosave.flush(),
    onStatus: (s) => {
      lastEngineState = STATE_MAP[s.state]
      store.setSyncStatus({ state: lastEngineState, lastSyncedAt: s.lastSyncedAt })
      if (s.state === 'CORRUPT_REMOTE') {
        store.setBanner({
          kind: 'corrupt',
          text: 'The cloud copy appears damaged — your local copy is intact. Cloud providers also keep file version history as a second net.',
          actions: [
            {
              label: 'Restore my copy over it',
              run: () =>
                void engine.restoreLocalOverRemote().then(() => store.setBanner(null)),
            },
          ],
        })
      } else if (s.state === 'READONLY_SCHEMA') {
        store.setBanner({
          kind: 'schema',
          text: 'This vault was updated by a newer version of Ledger — update to keep syncing. Your data stays viewable and safe.',
          actions: [],
        })
      }
    },
    onRekeyNeeded: (header) => {
      rekeyHeader = header
      onRekeyNeeded(header)
    },
    onCorrupt: () => {
      /* banner raised via status */
    },
    isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
  })

  // Saves poke the sync loop per SYNC §2.4: auto saves push only in onChange
  // mode; explicit saves always push; flush saves protect locally, never push.
  session.events.onSaved = (_rev, reason) => {
    const mode = store.vault.settings.saveMode
    if (reason === 'explicit' || (reason === 'auto' && mode === 'onChange')) engine.requestSync()
  }
  session.events.onSaveStateChange = (saving) => {
    if (saving) {
      store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SAVING_L1' })
    } else {
      store.setSyncStatus({ ...store.getSnapshot().sync, state: lastEngineState })
    }
  }
  // Fires after onSaveStateChange(false), so it wins over lastEngineState; the
  // next engine status or successful save clears it.
  session.events.onSaveError = () => {
    store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SAVE_ERROR' })
  }

  const detachTriggers = engine.attachTriggers()

  const submitRekeyPassword = async (password: string): Promise<string | null> => {
    try {
      const { bytes } = await adapter.read()
      const res = await unlockBlob(bytes, password)
      if (res.kind === 'wrongPassword') return 'That password doesn’t decrypt the shared vault.'
      if (res.kind === 'corrupt') return 'The shared vault is unreadable.'
      const header = rekeyHeader
      if (!header) return null
      await session.adoptKey(res.key, res.salt, header)
      if (res.vault.vaultId !== store.vault.vaultId) {
        // Different vault entirely (bootstrapping this device into a shared
        // remote): adopt the remote as truth instead of merging strangers.
        store.replaceVault(res.vault, { persist: false })
      }
      // Re-encrypt local state under the new key so L1 matches.
      session.autosave.markDirty(store.vault)
      await session.autosave.flush('explicit')
      store.setBanner(null)
      engine.resume()
      return null
    } catch {
      return 'Couldn’t reach the shared vault. Try again.'
    }
  }

  return {
    engine,
    adapter,
    submitRekeyPassword,
    teardown: () => {
      detachTriggers()
      session.events.onSaved = undefined
    },
  }
}
