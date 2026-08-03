import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { seedVault, emptyVault } from './model/seed'
import type { Vault } from './model/types'
import { AppStore, StoreProvider, useStoreState } from './ui/store'
import { ViewContext, normalizeTab, scrollToSection, type Tab, type Theme } from './ui/view'
import { formatHash, parseHash, stripHashQuery, txnFilterToQuery, type Route, type TxnFilter } from './ui/route'
import { PersistContext, type PersistActions } from './ui/persistCtx'
import { FxProvider } from './ui/fxCtx'
import { Header } from './ui/Header'
import { Toast } from './ui/Toast'
import { SyncNotes } from './ui/SyncNotes'
import { UnlockScreen } from './ui/UnlockScreen'
import { SettingsScreen } from './ui/SettingsScreen'
import { TransactionsScreen } from './ui/TransactionsScreen'
import { DashboardScreen } from './ui/DashboardScreen'
import { CompareScreen } from './ui/CompareScreen'
import { TrendsScreen } from './ui/TrendsScreen'
import { PlanScreen } from './ui/PlanScreen'
import { AccountsScreen } from './ui/AccountsScreen'
import { TripsScreen } from './ui/TripsScreen'
import { AssistantProvider, useAssistant } from './ui/assistant/ctx'
import { ASSISTANT_WIDTH, AssistantPanel } from './ui/assistant/AssistantPanel'
import { ImportScreen } from './import/ui/ImportScreen'
import { BG, HAIR, INK, setBaseCurrencySymbol } from './ui/theme'
import { KV } from './persist/idb'
import { bootProbe, createVault, openFromBlob, unlockVault, type Session } from './persist/session'
import type { SaveMode } from './model/types'
import type { OpenFileApi } from './ui/UnlockScreen'
import { DEFAULT_KDF, type KdfParams } from './persist/crypto'
import { RemoteAuthError, RemoteTransientError, type RemoteAdapter } from './sync/adapter'
import { LocalFileAdapter } from './sync/localFileAdapter'
import { HttpTestAdapter } from './sync/httpTestAdapter'
import { GoogleAuth, GoogleAuthCancelled, googleOAuthConfig } from './sync/googleAuth'
import { GoogleDriveAdapter } from './sync/googleDriveAdapter'
import { attachEngine, type EngineHandle } from './ui/syncGlue'
import { useNarrow, useWideEnough } from './ui/responsive'
import { MobileNav } from './ui/MobileNav'

const THEME_KEY = 'ledger.theme'

/** Dev/test hook: ?kdf=test makes the KDF instant so E2E suites stay fast. */
function kdfParams(): KdfParams {
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('kdf') === 'test') {
    return { m: 64, t: 1, p: 1 }
  }
  return DEFAULT_KDF
}

/**
 * Dev/test hook: ?drive=test:<slot> aims Drive at the devRemote plugin's double
 * instead of Google, with one isolated slot per spec. Playwright cannot drive
 * Google's consent screen, and the parts worth testing are the adapter and the
 * wiring — so only the consent step is replaced, not the OAuth code path.
 */
function driveTestSlot(): string | null {
  if (!import.meta.env.DEV) return null
  const p = new URLSearchParams(location.search).get('drive')
  return p?.startsWith('test:') ? p.slice(5) : null
}

function driveDeps(): { apiBase?: string; uploadBase?: string } {
  const slot = driveTestSlot()
  if (!slot) return {}
  return {
    apiBase: `${location.origin}/__drive/${slot}/drive/v3`,
    uploadBase: `${location.origin}/__drive/${slot}/upload/drive/v3`,
  }
}

/** Is Drive on offer at all? Real credentials, or the dev double. */
function driveConfigured(): boolean {
  return googleOAuthConfig() !== null || driveTestSlot() !== null
}

function makeDriveAuth(kv: KV): GoogleAuth | null {
  const slot = driveTestSlot()
  if (slot) {
    // Real PKCE, real state check, real token storage — against a fake endpoint.
    return new GoogleAuth(
      kv,
      { clientId: 'test-client', clientSecret: 'test-secret' },
      {
        fetch: (_url, init) => globalThis.fetch(`${location.origin}/__drive/${slot}/token`, init),
        openConsent: async (url) => `?code=test-code&state=${new URL(url).searchParams.get('state')}`,
        redirectUri: () => `${location.origin}/oauth-result/gdrive.html`,
      },
    )
  }
  const config = googleOAuthConfig()
  return config ? new GoogleAuth(kv, config) : null
}

function driveLabel(fileName: string): string {
  return `Google Drive · ${fileName} — connected`
}

/** Nothing to open yet — which is a different situation from a failure. */
const NO_DRIVE_VAULT =
  'No Ledger vault in this Google Drive yet. Create a vault on this device, then connect Drive in Settings → Sync.'

function driveErrorText(e: unknown): string {
  if (e instanceof RemoteAuthError) return 'Google didn’t grant access — try connecting again.'
  if (e instanceof RemoteTransientError) return 'Couldn’t reach Google Drive. Check your connection and retry.'
  return 'Couldn’t open the vault from Google Drive.'
}

type Boot =
  | { phase: 'loading' }
  | { phase: 'setup'; kv: KV }
  | { phase: 'unlock'; kv: KV }
  | { phase: 'open'; store: AppStore; session: Session; readonly: boolean }

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' })
  const pendingFile = useRef<{
    name: string
    handle?: FileSystemFileHandle
    bytes?: Uint8Array
    gdrive?: { fileId: string; fileName: string }
  } | null>(null)
  /** Detaches the autosave DOM listeners on lock — they are what would otherwise keep
   *  the locked Session (and its CryptoKey + last plaintext vault) reachable forever. */
  const lifecycleTeardown = useRef<(() => void) | null>(null)

  useEffect(() => {
    void bootProbe().then(({ kv, hasVault }) => {
      setBoot(hasVault ? { phase: 'unlock', kv } : { phase: 'setup', kv })
    })
    // Session teardown happens via page unload; nothing to clean here.
  }, [])

  const open = (store: AppStore, session: Session, readonly: boolean) => {
    store.onCommit = (vault: Vault) => session.autosave.markDirty(vault)
    // Pre-engine (no remote attached) these only shuttle LOCAL_ONLY ↔ SAVING_L1. They must not
    // touch any other base state — e.g. a configured-but-not-reconnected file sits at REAUTH_NEEDED,
    // and a local save clobbering that back to LOCAL_ONLY loses the "reconnect file" prompt and
    // leaves Settings ("connected") disagreeing with the header ("local only").
    session.events.onSaveStateChange = (saving) => {
      if (saving && store.getSnapshot().sync.state === 'LOCAL_ONLY') {
        store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SAVING_L1' })
      }
    }
    session.events.onSaved = () => {
      const st = store.getSnapshot().sync.state
      if (st === 'SAVING_L1' || st === 'SAVE_ERROR') {
        store.setSyncStatus({ ...store.getSnapshot().sync, state: 'LOCAL_ONLY' })
      }
    }
    session.events.onSaveError = () => {
      const st = store.getSnapshot().sync.state
      if (st === 'LOCAL_ONLY' || st === 'SAVING_L1') {
        store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SAVE_ERROR' })
      }
    }
    session.events.onSiblingUpdate = (vault) => store.replaceVault(vault, { persist: false })
    session.startBroadcast(() => session.local.getLocalRevision())
    lifecycleTeardown.current?.()
    lifecycleTeardown.current = session.autosave.attachLifecycle()
    if (readonly) {
      store.setSyncStatus({ state: 'READONLY_SCHEMA', lastSyncedAt: null })
    }
    setBoot({ phase: 'open', store, session, readonly })
  }

  if (boot.phase === 'loading') {
    return <div style={{ height: '100svh', background: BG }} />
  }

  /** "Open vault file" — offered on both boot screens; the password is asked once. */
  const openFileApi = (kv: KV): OpenFileApi => ({
    pick: async () => {
      const useFsa =
        LocalFileAdapter.supported() &&
        !(import.meta.env.DEV && new URLSearchParams(location.search).has('nofsa'))
      if (useFsa) {
        try {
          const [handle] = await window.showOpenFilePicker()
          pendingFile.current = { name: handle!.name, handle }
          return handle!.name
        } catch (e) {
          if ((e as DOMException)?.name === 'AbortError') return null
          throw e
        }
      }
      // Fallback (non-Chromium): plain file input — opens the vault, but without
      // a writable handle it can't be connected as the sync remote.
      return new Promise<string | null>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.style.display = 'none'
        document.body.appendChild(input)
        input.onchange = async () => {
          const f = input.files?.[0]
          input.remove()
          if (!f) return resolve(null)
          pendingFile.current = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }
          resolve(f.name)
        }
        input.oncancel = () => {
          input.remove()
          resolve(null)
        }
        input.click()
      })
    },
    // Only offered when this build carries Google credentials — the whole point on a
    // phone, where there is no File System Access API and no other way in.
    ...(driveConfigured()
      ? {
          pickDrive: async () => {
            const auth = makeDriveAuth(kv)!
            try {
              if (!(await auth.connected())) await auth.authorize()
              const deps = driveDeps()
              // Look, don't create. This screen answers "is there a vault up there
              // to open?" — and a vault that exists but is still the empty
              // placeholder is the same answer as none at all.
              const found = await GoogleDriveAdapter.find(auth, deps)
              const adapter = found && new GoogleDriveAdapter(auth, found.fileId, found.fileName, deps)
              if (!adapter || !(await adapter.getMetadata())) return { error: NO_DRIVE_VAULT }
              const { bytes } = await adapter.read()
              pendingFile.current = { name: found.fileName, bytes, gdrive: found }
              return { name: found.fileName }
            } catch (e) {
              if (e instanceof GoogleAuthCancelled) return null
              return { error: driveErrorText(e) }
            }
          },
        }
      : {}),
    open: async (password) => {
      const pf = pendingFile.current
      if (!pf) return 'Choose a vault file first.'
      const bytes = pf.bytes ?? new Uint8Array(await (await pf.handle!.getFile()).arrayBuffer())
      let modeRef: () => SaveMode = () => 'onChange'
      const res = await openFromBlob(kv, bytes, password, () => modeRef())
      if (res.kind === 'wrongPassword') return 'That password doesn’t decrypt this file.'
      if (res.kind === 'corrupt') return 'That file isn’t a readable Ledger vault.'
      // A picked handle (or the Drive file we just pulled from) doubles as the sync
      // remote; the input-fallback has no writable target, so it opens local-only.
      await res.session.local.setRemote(
        pf.gdrive
          ? { kind: 'gdrive', ...pf.gdrive }
          : pf.handle
            ? { kind: 'localFile', handle: pf.handle }
            : { kind: 'none' },
      )
      const store = new AppStore(res.vault)
      modeRef = () => store.vault.settings.saveMode
      open(store, res.session, res.kind === 'readonly')
      return null
    },
  })

  if (boot.phase === 'setup') {
    return (
      <UnlockScreen
        mode="setup"
        openFile={openFileApi(boot.kv)}
        onCreate={async (password, demo) => {
          const vault = demo ? seedVault() : emptyVault()
          const store = new AppStore(vault)
          const session = await createVault(boot.kv, password, vault, () => store.vault.settings.saveMode, kdfParams())
          open(store, session, false)
        }}
      />
    )
  }

  if (boot.phase === 'unlock') {
    return (
      <UnlockScreen
        mode="unlock"
        openFile={openFileApi(boot.kv)}
        onUnlock={async (password) => {
          let modeRef: () => SaveMode = () => 'onChange'
          const res = await unlockVault(boot.kv, password, () => modeRef(), kdfParams())
          if (res.kind === 'wrongPassword') return 'That password doesn’t decrypt this vault.'
          if (res.kind === 'corrupt') return 'The local vault file is unreadable.'
          const store = new AppStore(res.vault)
          modeRef = () => store.vault.settings.saveMode
          open(store, res.session, res.kind === 'readonly')
          return null
        }}
      />
    )
  }

  return (
    <OpenApp
      key={boot.store.vault.vaultId}
      boot={boot}
      onLocked={() => {
        lifecycleTeardown.current?.()
        lifecycleTeardown.current = null
        stripHashQuery()
        setBoot({ phase: 'unlock', kv: boot.session.kv })
      }}
    />
  )
}

function OpenApp({ boot, onLocked }: { boot: Extract<Boot, { phase: 'open' }>; onLocked: () => void }) {
  const { store, session, readonly } = boot
  const [handle, setHandle] = useState<EngineHandle | null>(null)
  const [remoteLabel, setRemoteLabel] = useState('None')
  const [rekeyOpen, setRekeyOpen] = useState(false)
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null)
  const [remoteKind, setRemoteKind] = useState<PersistActions['remoteKind']>('none')
  const fileAdapterRef = useRef<LocalFileAdapter | null>(null)
  const driveAuthRef = useRef<GoogleAuth | null>(null)

  // SYNC §1/§7 durability: until a vault file is connected L1 is the only copy, and
  // best-effort storage can be evicted. Ask once per open — Chromium usually grants
  // silently on engagement; a `false` is surfaced in Settings → Sync as a nudge.
  useEffect(() => {
    void (async () => {
      const s = navigator.storage
      if (!s?.persist) return
      setStoragePersisted((await s.persisted?.()) || (await s.persist()))
    })()
  }, [])

  const attach = (adapter: RemoteAdapter, label: string, kind: PersistActions['remoteKind']) => {
    handle?.teardown()
    const h = attachEngine(store, session, adapter, () => setRekeyOpen(true))
    setHandle(h)
    setRemoteLabel(label)
    setRemoteKind(kind)
    // A remote is attached and a sync is about to run — leave LOCAL_ONLY immediately so the header
    // never contradicts the connected label while the engine's first status is still in flight.
    store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SYNCING' })
    h.engine.requestSync()
    return h
  }

  // Boot: reconnect a previously configured remote.
  useEffect(() => {
    void (async () => {
      const remote = await session.local.getRemote()
      if (remote.kind === 'httpTest' && import.meta.env.DEV) {
        attach(new HttpTestAdapter(remote.name), `test remote · ${remote.name}`, 'httpTest')
      } else if (remote.kind === 'localFile' && LocalFileAdapter.supported()) {
        const adapter = new LocalFileAdapter(remote.handle)
        fileAdapterRef.current = adapter
        if ((await adapter.permission()) === 'granted') {
          attach(adapter, `${adapter.name} — connected`, 'localFile')
        } else {
          // Configured, but the browser hasn't re-granted file access this session. Say so —
          // "connected" would be a lie, and the header's "reconnect file" is the way back.
          setRemoteLabel(`${adapter.name} — reconnect needed`)
          setRemoteKind('localFile')
          store.setSyncStatus({ state: 'REAUTH_NEEDED', lastSyncedAt: null })
        }
      } else if (remote.kind === 'gdrive' && driveConfigured()) {
        const auth = makeDriveAuth(session.kv)!
        driveAuthRef.current = auth
        if (await auth.connected()) {
          attach(
            new GoogleDriveAdapter(auth, remote.fileId, remote.fileName, driveDeps()),
            driveLabel(remote.fileName),
            'gdrive',
          )
        } else {
          // Same shape as the file case: the grant is gone (revoked, or never
          // survived), so say "reconnect needed" rather than claim a connection.
          setRemoteLabel('Google Drive — reconnect needed')
          setRemoteKind('gdrive')
          store.setSyncStatus({ state: 'REAUTH_NEEDED', lastSyncedAt: null })
        }
      }
      // dev/test hook: ?remote=test:<name> auto-connects the devRemote backend
      if (import.meta.env.DEV) {
        const p = new URLSearchParams(location.search).get('remote')
        if (p?.startsWith('test:')) {
          const name = p.slice(5)
          await session.local.setRemote({ kind: 'httpTest', name })
          attach(new HttpTestAdapter(name), `test remote · ${name}`, 'httpTest')
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persist: PersistActions = useMemo(
    () => ({
      remoteLabel,
      canLocalFile: LocalFileAdapter.supported(),
      canGoogleDrive: driveConfigured(),
      remoteKind,
      storagePersisted,
      connectFile: async (mode: 'create' | 'open') => {
        try {
          const fsHandle =
            mode === 'create'
              ? await window.showSaveFilePicker({ suggestedName: 'ledger.vault' })
              : (await window.showOpenFilePicker())[0]!
          await session.local.setRemote({ kind: 'localFile', handle: fsHandle })
          const adapter = new LocalFileAdapter(fsHandle)
          fileAdapterRef.current = adapter
          attach(adapter, `${adapter.name} — connected`, 'localFile')
          store.showToast(`Vault file connected — ${adapter.name}`)
        } catch (e) {
          if ((e as DOMException)?.name !== 'AbortError') throw e
        }
      },
      connectGoogleDrive: async () => {
        const auth = makeDriveAuth(session.kv)
        if (!auth) return
        driveAuthRef.current = auth
        try {
          if (!(await auth.connected())) await auth.authorize()
          const deps = driveDeps()
          const { fileId, fileName } = await GoogleDriveAdapter.connect(auth, deps)
          await session.local.setRemote({ kind: 'gdrive', fileId, fileName })
          fileAdapterRef.current = null // switching away from a vault file
          attach(new GoogleDriveAdapter(auth, fileId, fileName, deps), driveLabel(fileName), 'gdrive')
          store.showToast(`Google Drive connected — ${fileName}`)
        } catch (e) {
          if (e instanceof GoogleAuthCancelled) return
          store.showToast(driveErrorText(e))
        }
      },
      disconnectRemote: async () => {
        handle?.teardown()
        setHandle(null)
        fileAdapterRef.current = null
        // Hand the Google grant back rather than leaving a live token behind for a
        // remote the user just told us to forget. The file in Drive stays put.
        // Only when Drive is what's being disconnected — dropping a vault file must
        // not revoke a Google grant the user never mentioned.
        if (remoteKind === 'gdrive') {
          await driveAuthRef.current?.revoke()
          driveAuthRef.current = null
        }
        await session.local.setRemote({ kind: 'none' })
        setRemoteLabel('None')
        setRemoteKind('none')
        // restore local-only save status behavior
        session.events.onSaveStateChange = (saving) => {
          if (saving) store.setSyncStatus({ ...store.getSnapshot().sync, state: 'SAVING_L1' })
          else store.setSyncStatus({ ...store.getSnapshot().sync, state: 'LOCAL_ONLY' })
        }
        store.setSyncStatus({ state: 'LOCAL_ONLY', lastSyncedAt: null })
        store.setBanner(null)
      },
      reconnectRemote: async () => {
        if (remoteKind === 'gdrive') {
          const remote = await session.local.getRemote()
          const auth = driveAuthRef.current
          if (!auth || remote.kind !== 'gdrive') return
          try {
            await auth.authorize()
            attach(
              new GoogleDriveAdapter(auth, remote.fileId, remote.fileName, driveDeps()),
              driveLabel(remote.fileName),
              'gdrive',
            )
          } catch (e) {
            if (e instanceof GoogleAuthCancelled) return
            store.showToast(driveErrorText(e))
          }
          return
        }
        const adapter = fileAdapterRef.current
        if (!adapter) return
        if ((await adapter.requestPermission()) === 'granted') {
          attach(adapter, `${adapter.name} — connected`, 'localFile')
        }
      },
      changePassword: async (next: string) => {
        await session.changePassword(next, store.vault)
        store.showToast('Vault re-keyed — other devices will ask for the new password')
      },
      lock: async () => {
        handle?.teardown()
        try {
          await session.lock(session.autosave.dirty ? store.vault : null)
        } catch {
          // The final flush failed — locking now would discard the unsaved vault.
          store.showToast('Couldn’t save — vault stays unlocked')
          return
        }
        onLocked()
      },
      eraseAll: async () => {
        handle?.teardown()
        await session.lock(null)
        session.kv.close()
        await KV.destroy()
        location.reload()
      },
      loadDemo: () => store.replaceVault(seedVault()),
      saveNow: () => void session.autosave.flush('explicit').catch(() => {}), // surfaced via onSaveError
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, session, onLocked, remoteLabel, remoteKind, handle, storagePersisted],
  )

  return (
    <StoreProvider value={store}>
      <PersistContext.Provider value={persist}>
        <FxProvider base={store.vault.params.baseCurrency ?? 'EUR'}>
          <Shell readonly={readonly} />
        </FxProvider>
        {rekeyOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'color-mix(in srgb, var(--bg) 96%, transparent)' }}>
            <UnlockScreen
              mode="rekey"
              onUnlock={async (pw) => {
                const err = (await handle?.submitRekeyPassword(pw)) ?? null
                if (!err) setRekeyOpen(false)
                return err
              }}
            />
          </div>
        )}
      </PersistContext.Provider>
    </StoreProvider>
  )
}

function initialTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
}

/**
 * The app frame. Separate from `Shell` only so it can read the assistant's open state:
 * `AssistantProvider` sits inside Shell (it needs ViewContext), so Shell's own body cannot.
 *
 * When the assistant is open on a wide window the frame reserves room for the drawer instead of
 * sitting under it — the assistant's whole job is to open the screen that proves its answer, which
 * a panel covering that screen's right-hand column defeats. The reservation is on the FRAME, not on
 * the content column, so the header and the page below it stay aligned with each other; padding one
 * and not the other left the brand and the page title on different vertical lines. Below the
 * breakpoint the drawer is full-width anyway and there is nothing to reserve.
 */
function ShellFrame({ children }: { children: React.ReactNode }) {
  const { open } = useAssistant()
  const wide = useWideEnough()
  return (
    <div
      data-testid="app-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        // `svh`, not `vh` or `dvh`. `vh` is the LARGE viewport on mobile, so the bottom of the
        // shell sits under the browser's toolbar until the user scrolls. `dvh` tracks the
        // toolbar as it collapses, which reflows the whole shell and jumps the inner scroller
        // mid-gesture. `svh` is the one that stays still. No fallback is needed: the app already
        // ships `color-mix()` (below), which is newer than `svh` in every engine.
        height: '100svh',
        background: BG,
        overflow: 'hidden',
        // Padding, never margin: `marginRight` on a `margin: 0 auto` box cancels its right auto and
        // dumps every pixel of slack on the left — and React clears the longhand even when the value
        // is undefined, so it did that with the panel closed too.
        paddingRight: open && wide ? ASSISTANT_WIDTH : 0,
        transition: 'padding-right .18s ease',
      }}
    >
      {children}
    </div>
  )
}

/** The scrolling content column. */
function MainArea({ children }: { children: React.ReactNode }) {
  const narrow = useNarrow()
  return (
    <div data-main-scroll="1" style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'auto' }}>
      <div
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          // The bottom pad clears the iOS home indicator. `env()` resolves to 0 wherever there
          // is no inset, so the desktop value is unchanged.
          padding: narrow ? '16px 12px calc(24px + env(safe-area-inset-bottom))' : '26px clamp(16px,3vw,40px) calc(64px + env(safe-area-inset-bottom))',
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function Shell({ readonly }: { readonly?: boolean }) {
  const [tab, setTab] = useState<Tab>(() => parseHash(location.hash).tab)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [notesOpen, setNotesOpen] = useState(false)
  const [seed, setSeed] = useState<{ tab: Tab; query: Record<string, string>; nonce: number } | null>(null)
  const { banner, vault } = useStoreState()
  const narrow = useNarrow()

  // Money formatting follows the vault's base currency (theme.ts module symbol).
  useEffect(() => {
    setBaseCurrencySymbol(vault.params.baseCurrency ?? 'EUR')
  }, [vault.params.baseCurrency])
  const scrollPending = useRef<string | null>(null)
  const seedNonce = useRef(0)
  const suppressHash = useRef(0)
  const scrollTops = useRef(new Map<Tab, number>())

  /** Make `route` the visible state: switch tab (remembering scroll) and deliver its query as a seed. */
  const applyRoute = useCallback((route: Route) => {
    setTab((prev) => {
      if (prev !== route.tab) {
        const sc = document.querySelector('[data-main-scroll]')
        if (sc) scrollTops.current.set(prev, sc.scrollTop)
      }
      return route.tab
    })
    setSeed({ tab: route.tab, query: route.query, nonce: ++seedNonce.current })
  }, [])

  /** Write the route to the hash (push by default; replace for in-place filter edits) and apply it. */
  const navigate = useCallback(
    (route: Route, opts?: { replace?: boolean }) => {
      const h = formatHash(route)
      if (location.hash !== h) {
        if (opts?.replace) {
          history.replaceState(history.state, '', h)
        } else {
          suppressHash.current++ // the assignment below fires hashchange; applyRoute runs here, not there
          location.hash = h
        }
      }
      applyRoute(route)
    },
    [applyRoute],
  )

  // Back/forward and hand-edited hashes: parse and apply (unless it's our own echo).
  useEffect(() => {
    const onHash = () => {
      if (suppressHash.current > 0) {
        suppressHash.current--
        return
      }
      applyRoute(parseHash(location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [applyRoute])

  // Normalize an empty hash to '#/dash' once, so the first Back has a stable entry.
  useEffect(() => {
    if (!location.hash) history.replaceState(history.state, '', formatHash({ tab, query: {} }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore the tab's scroll position after the display:none flip has laid out.
  useEffect(() => {
    const sc = document.querySelector('[data-main-scroll]')
    if (!sc) return
    const y = scrollTops.current.get(tab) ?? 0
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        sc.scrollTop = y
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [tab])

  // Reflect the theme onto <html> so the token blocks (light default / [data-theme="dark"]) apply.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    return () => document.documentElement.removeAttribute('data-theme')
  }, [theme])

  const view = useMemo(
    () => ({
      tab,
      goTab: (t: Tab | 'overview' | 'cashflow' | 'budgets' | 'goals', section?: string) => {
        navigate({ tab: normalizeTab(t), query: {} })
        if (section) {
          scrollPending.current = section
          setTimeout(() => {
            if (scrollPending.current) scrollToSection(scrollPending.current)
            scrollPending.current = null
          }, 60)
        }
      },
      goTxns: (filter: TxnFilter) => navigate({ tab: 'txns', query: txnFilterToQuery(filter) }),
      go: (t: Tab, query?: Record<string, string>) => navigate({ tab: t, query: query ?? {} }),
      theme,
      toggleTheme: () => {
        setTheme((t) => {
          const next = t === 'dark' ? 'light' : 'dark'
          localStorage.setItem(THEME_KEY, next)
          return next
        })
      },
      seed,
      notesOpen,
      setNotesOpen,
    }),
    [tab, theme, notesOpen, seed, navigate],
  )

  // Phase-D analytics screens; Trips ships in Phase E.
  const panes: [Tab, React.ReactNode][] = [
    ['dash', <DashboardScreen key="dash" />],
    ['compare', <CompareScreen key="compare" />],
    ['trends', <TrendsScreen key="trends" />],
    ['trips', <TripsScreen key="trips" />],
    ['plan', <PlanScreen key="plan" />],
    ['accounts', <AccountsScreen key="accounts" />],
    ['txns', <TransactionsScreen key="txns" />],
    ['import', <ImportScreen key="import" />],
    ['settings', <SettingsScreen key="settings" />],
  ]

  return (
    <ViewContext.Provider value={view}>
      {/* Inside ViewContext because the assistant drives the router. Its transcript is component
          state, so locking — which unmounts OpenApp entirely — discards it without an explicit
          clear, the same way it discards the drill query via `stripHashQuery`. */}
      <AssistantProvider>
        <ShellFrame>
          <Header />
          {readonly && (
            <BannerBar text="This vault was updated by a newer version of Ledger — update to keep syncing. Viewing only." />
          )}
          {banner && <BannerBar text={banner.text} actions={banner.actions} />}
          <MainArea>
            {panes.map(([id, node]) => (
              // `data-pane` lets a test address a pane by name. Panes stay mounted (Convention #7),
              // so `data-active` is the only way to tell the visible one from the eight hidden ones.
              <div key={id} data-pane={id} data-active={tab === id ? '1' : undefined} style={{ display: tab === id ? 'block' : 'none' }}>
                {node}
              </div>
            ))}
          </MainArea>
          {/* The bottom bar is a sibling of the scroller, not an overlay: as a flex item it
              shortens the content column instead of covering its last row — which is also why
              Import's own sticky action bar cannot collide with it, since that bar sticks to the
              bottom of the SCROLLER and the scroller already ends above this.
              Import is NOT excluded. It was, to avoid two stacked bars, and that left the screen
              with no way out at all: the phone header has no nav, so reaching Import meant being
              stuck there. */}
          {narrow && <MobileNav />}
          <SyncNotes />
          <AssistantPanel />
          <Toast />
        </ShellFrame>
      </AssistantProvider>
    </ViewContext.Provider>
  )
}

function BannerBar({ text, actions }: { text: string; actions?: { label: string; run: () => void }[] }) {
  return (
    <div
      data-testid="banner"
      style={{
        flex: 'none',
        borderBottom: `1px solid ${HAIR}`,
        background: 'var(--warnbg)',
        padding: '8px clamp(20px,3vw,40px)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontSize: 12.5,
        color: INK,
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      {actions?.map((a) => (
        <button
          key={a.label}
          onClick={a.run}
          className="hov-ink"
          style={{
            height: 26,
            padding: '0 10px',
            borderRadius: 2,
            border: `1px solid ${INK}`,
            background: 'transparent',
            color: INK,
            fontSize: 11.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
