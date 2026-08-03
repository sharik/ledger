import { useState } from 'react'
import { useRawStoreState } from './store'
import { unreviewedNotes } from '../model/selectors'
import { usePersist } from './persistCtx'
import { useView } from './view'
import { TABS } from './view'
import { ACCENT, BG, GREEN, HAIR, INK, MONO, MUT, SURFACE, WARNBG } from './theme'
import { Badge } from './kit'
import { Sheet, SheetItem } from './kit/Sheet'
import { useNarrow } from './responsive'
import { AssistantButton } from './assistant/AssistantPanel'

const TAB_LABELS: Record<string, string> = {
  dash: 'Dashboard',
  compare: 'Compare',
  trends: 'Trends',
  trips: 'Trips',
  plan: 'Plan',
  accounts: 'Accounts',
  txns: 'Transactions',
  settings: 'Settings',
}

/** New design header + nav (mock lines 58–90). Replaces Masthead. */
export function Header() {
  const { vault, sync } = useRawStoreState() // settings/sync chrome, not account-anchored
  const persist = usePersist()
  const view = useView()
  const notes = unreviewedNotes(vault).length
  const baseCurrency = vault.params.baseCurrency ?? 'EUR'
  const manualMode = vault.settings.saveMode === 'manual'

  let statusLabel: string
  switch (sync.state) {
    case 'LOCAL_ONLY':
      statusLabel = 'LOCAL ONLY'
      break
    case 'SAVING_L1':
    case 'DIRTY':
      statusLabel = 'SAVING…'
      break
    case 'SAVE_ERROR':
      statusLabel = 'SAVE FAILED — CHANGES HELD IN MEMORY'
      break
    case 'SYNCING':
    case 'RETRY':
      statusLabel = 'SYNCING…'
      break
    case 'OFFLINE_PENDING':
      statusLabel = 'OFFLINE — CHANGES SAVED LOCALLY'
      break
    case 'ERROR_BACKOFF':
      statusLabel = sync.lastSyncedAt ? `NOT SYNCED SINCE ${sync.lastSyncedAt}` : 'NOT SYNCED'
      break
    case 'REAUTH_NEEDED':
      statusLabel = persist.remoteKind === 'gdrive' ? 'RECONNECT DRIVE' : 'RECONNECT FILE'
      break
    case 'REKEY_NEEDED':
      statusLabel = 'NEW PASSWORD NEEDED'
      break
    case 'CORRUPT_REMOTE':
      statusLabel = 'CLOUD COPY DAMAGED'
      break
    case 'READONLY_SCHEMA':
      statusLabel = 'READ-ONLY — UPDATE LEDGER'
      break
    default:
      statusLabel = sync.lastSyncedAt ? `SYNCED ${sync.lastSyncedAt}` : 'SAVED'
  }
  const statusClickable = sync.state === 'REAUTH_NEEDED'
  const narrow = useNarrow()

  if (narrow) {
    return (
      <PhoneHeader
        baseCurrency={baseCurrency}
        statusLabel={statusLabel}
        statusClickable={statusClickable}
        notes={notes}
        manualMode={manualMode && sync.state !== 'READONLY_SCHEMA'}
        chat={!!vault.settings.assist?.chat}
      />
    )
  }

  return (
    <div style={{ flex: 'none', borderBottom: `1px solid ${HAIR}`, background: BG }}>
      {/* Row 1 — brand + actions */}
      <div
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          padding: '6px clamp(20px,3vw,40px)',
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(10px,1.6vw,18px)',
          flexWrap: 'wrap', // narrow windows: actions wrap instead of clipping off-screen
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: INK }}>Ledger</div>
          <Badge data-testid="currency-badge" color={MUT}>
            {baseCurrency}
          </Badge>
        </div>

        <div style={{ flex: 1, minWidth: 0 }} />

        <button
          className="hov-invert"
          data-testid="import-btn"
          onClick={() => view.goTab('import')}
          style={{
            height: 32,
            padding: '0 13px',
            border: `1px solid ${INK}`,
            borderRadius: 3,
            background: view.tab === 'import' ? INK : 'transparent',
            color: view.tab === 'import' ? BG : INK,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Import
        </button>

        {manualMode && sync.state !== 'READONLY_SCHEMA' && (
          <button
            className="hov-ink"
            data-testid="save-now"
            onClick={() => persist.saveNow()}
            style={{
              height: 32,
              padding: '0 11px',
              border: `1px solid ${HAIR}`,
              borderRadius: 3,
              background: 'transparent',
              color: MUT,
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: '.08em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            SAVE NOW
          </button>
        )}

        <button
          className={statusClickable ? 'hov-ink' : undefined}
          data-testid="sync-status"
          onClick={statusClickable ? () => void persist.reconnectRemote() : undefined}
          style={{
            height: 32,
            padding: '0 6px',
            border: 'none',
            background: 'transparent',
            color: statusClickable ? INK : MUT,
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: '.08em',
            cursor: statusClickable ? 'pointer' : 'default',
            whiteSpace: 'nowrap',
            textDecoration: statusClickable ? 'underline' : 'none',
            textUnderlineOffset: 3,
          }}
        >
          {statusLabel}
        </button>

        {notes > 0 && (
          <button
            className="hov-ink"
            data-testid="notes-count"
            onClick={() => view.setNotesOpen(true)}
            style={{
              height: 32,
              padding: '0 10px',
              border: `1px solid ${HAIR}`,
              borderRadius: 3,
              background: WARNBG,
              color: INK,
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '.08em',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {notes} NOTE{notes > 1 ? 'S' : ''}
          </button>
        )}

        {vault.settings.assist?.chat && <AssistantButton />}

        <button
          className="hov-ink"
          data-testid="theme-toggle"
          aria-label="Toggle theme"
          onClick={view.toggleTheme}
          style={iconBtn}
        >
          {view.theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>

      {/* Row 2 — nav */}
      <div
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          padding: '0 clamp(20px,3vw,40px)',
          height: 40,
          display: 'flex',
          alignItems: 'stretch',
          gap: 'clamp(12px,1.8vw,24px)',
          overflowX: 'auto', // Settings/Transactions must stay reachable at any width
          // …but `overflow-x: auto` alone computes overflow-y to `auto` too, and the tabs'
          // `marginBottom: -1` overflows this 40px row by exactly 1px — enough for a permanent
          // vertical scrollbar in the nav strip.
          overflowY: 'hidden',
        }}
      >
        {TABS.map((t) => {
          const on = view.tab === t
          return (
            <button
              key={t}
              className="hov-ink"
              data-tab={t}
              aria-current={on ? 'page' : undefined}
              onClick={() => view.goTab(t)}
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                fontWeight: on ? 600 : 400,
                color: on ? INK : MUT,
                background: 'none',
                border: 'none',
                borderBottom: on ? `2px solid ${ACCENT}` : '2px solid transparent',
                borderRadius: 0,
                padding: 0,
                marginBottom: -1,
              }}
            >
              {TAB_LABELS[t]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The phone header.
 *
 * The desktop header is two rows: brand plus five action buttons that `flexWrap` onto a second
 * line at this width, then a 40px nav strip whose eight labels scroll sideways with no
 * affordance. Together they ate roughly a fifth of a 667px screen before any content.
 *
 * Here: one row. Brand, a sync dot, Import (the one action worth a permanent slot — it starts
 * the canonical two-device flow), and everything else behind `⋯`. Navigation moves to the bottom
 * bar, which is both reachable by thumb and always visible.
 */
function PhoneHeader({
  baseCurrency,
  statusLabel,
  statusClickable,
  notes,
  manualMode,
  chat,
}: {
  baseCurrency: string
  statusLabel: string
  statusClickable: boolean
  notes: number
  manualMode: boolean
  chat: boolean
}) {
  const view = useView()
  const persist = usePersist()
  const [open, setOpen] = useState(false)
  // Any status that is not a steady "saved"/"synced" is worth a colour rather than a word.
  const attention = /RECONNECT|NEW PASSWORD|DAMAGED|NOT SYNCED|READ-ONLY|OFFLINE/.test(statusLabel)

  return (
    <div style={{ flex: 'none', borderBottom: `1px solid ${HAIR}`, background: BG }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 14px',
          minHeight: 52,
          paddingTop: 'env(safe-area-inset-top)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: INK }}>Ledger</div>
        <Badge data-testid="currency-badge" color={MUT}>
          {baseCurrency}
        </Badge>
        <div style={{ flex: 1, minWidth: 0 }} />

        <button
          data-testid="import-btn"
          onClick={() => view.goTab('import')}
          style={{
            height: 34,
            padding: '0 12px',
            border: `1px solid ${INK}`,
            borderRadius: 3,
            background: view.tab === 'import' ? INK : 'transparent',
            color: view.tab === 'import' ? BG : INK,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Import
        </button>

        <button
          data-testid="header-more"
          aria-label="More actions"
          onClick={() => setOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 34,
            padding: '0 10px',
            border: `1px solid ${HAIR}`,
            borderRadius: 3,
            background: SURFACE,
            color: MUT,
            fontSize: 15,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          {/* The full sync sentence does not fit; the dot carries "fine" vs "look at this", and
              the sentence itself is the first line of the sheet. */}
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              flex: 'none',
              background: attention ? 'var(--warn)' : GREEN,
            }}
          />
          {notes > 0 && (
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, color: INK }}>{notes}</span>
          )}
          <span aria-hidden>⋯</span>
        </button>
      </div>

      {open && (
        <Sheet title="Ledger" onClose={() => setOpen(false)}>
          <button
            data-testid="sync-status"
            onClick={statusClickable ? () => { setOpen(false); void persist.reconnectRemote() } : undefined}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'none',
              padding: '4px 6px 12px',
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: '.06em',
              color: attention ? INK : MUT,
              textDecoration: statusClickable ? 'underline' : 'none',
              textUnderlineOffset: 3,
              cursor: statusClickable ? 'pointer' : 'default',
            }}
          >
            {statusLabel}
          </button>

          {manualMode && (
            <SheetItem
              testid="save-now"
              onClick={() => {
                setOpen(false)
                persist.saveNow()
              }}
            >
              Save now
            </SheetItem>
          )}
          {notes > 0 && (
            <SheetItem
              testid="notes-count"
              onClick={() => {
                setOpen(false)
                view.setNotesOpen(true)
              }}
            >
              <span style={{ flex: 1 }}>Sync notes</span>
              <span style={{ fontFamily: MONO, fontSize: 11, background: WARNBG, padding: '2px 7px', borderRadius: 3 }}>
                {notes}
              </span>
            </SheetItem>
          )}
          {chat && (
            <div onClick={() => setOpen(false)}>
              <AssistantButton block />
            </div>
          )}
          <SheetItem
            testid="theme-toggle"
            onClick={() => {
              setOpen(false)
              view.toggleTheme()
            }}
          >
            {view.theme === 'dark' ? 'Light appearance' : 'Dark appearance'}
          </SheetItem>
        </Sheet>
      )}
    </div>
  )
}

const iconBtn = {
  height: 32,
  padding: '0 11px',
  border: `1px solid ${HAIR}`,
  borderRadius: 3,
  background: SURFACE,
  color: MUT,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}
