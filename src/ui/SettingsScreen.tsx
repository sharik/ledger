import { useState } from 'react'
import type { Params, SaveMode } from '../model/types'
import { visibleVault } from '../model/selectors'
import { useRawStoreState, useStore } from './store'
import { usePersist } from './persistCtx'
import { exportCsv, exportJson } from './export'
import { HAIR, INK, MUT, BRICK } from './theme'
import { btnOutline, chip, hairBottom, inputUnderline, italicNote, mono, serif, stepBtn } from './styles'
import { CategoriesCard } from './settings/CategoriesCard'
import { RulesCard } from './settings/RulesCard'
import { FxCard } from './settings/FxCard'
import { AssistCard } from './settings/AssistCard'
import { DuplicatesCard } from './settings/DuplicatesCard'
import { SkillsCard } from './settings/SkillsCard'
import { HelpCard } from './settings/HelpCard'

type ParamKey = Exclude<keyof Omit<Params, 'id' | 'updatedAt'>, 'baseCurrency' | 'reconTolerance' | 'rulesOfThumb'>

// invReturn/inflation are deliberately NOT offered here: nothing consumes them
// yet, and a setting that promises chart behavior it doesn't have is a lie.
const PARAM_DEFS: { key: ParamKey; name: string; hint: string; step: number; unit: string; min: number }[] = [
  { key: 'srTarget', name: 'Target savings rate', hint: 'Sets the savings-rate status color', step: 1, unit: '%', min: 0 },
  { key: 'efTarget', name: 'Emergency fund target', hint: 'Sets the emergency-fund status color', step: 1, unit: ' mo', min: 1 },
]

const SAVE_MODES: { id: SaveMode; label: string; hint: string }[] = [
  { id: 'onChange', label: 'On change', hint: 'save & sync as you edit (default)' },
  { id: 'onLock', label: 'On lock', hint: 'save & sync when you lock or close' },
  { id: 'manual', label: 'Manual', hint: 'explicit Save; closing still protects your data' },
]

export function SettingsScreen() {
  // RAW: an export is an archive, not a chart — it must carry hidden accounts too.
  // The counts below deliberately report the visible vault instead.
  const { vault, sync } = useRawStoreState()
  const store = useStore()
  const persist = usePersist()
  const [confirmErase, setConfirmErase] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [changingPw, setChangingPw] = useState(false)

  const P = vault.params
  // Counts describe what the app is showing you, so they follow the projection — while
  // `vault` above stays raw so an export still carries every hidden account.
  const counted = visibleVault(vault)
  const hiddenCount = vault.accounts.length - counted.accounts.length

  return (
    <div data-screen="settings">
      <div style={serif(32)}>Settings</div>
      {/* Interim vault summary — a stable, vault-derived value for E2E foundation checks. */}
      <div style={{ ...mono(10.5), color: MUT, marginTop: 6 }}>
        <span data-testid="account-count">{counted.accounts.length}</span> accounts{' '}
        {hiddenCount > 0 && <span data-testid="hidden-count">({hiddenCount} hidden)</span>} ·{' '}
        <span data-testid="txn-count">{counted.transactions.length}</span> transactions
      </div>

      <div
        style={{
          borderTop: `2px solid ${INK}`,
          marginTop: 20,
          paddingTop: 26,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(min(340px,100%),1fr))',
          gap: '34px 44px',
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 34 }}>
          <RulesCard />
          <FxCard />
          <AssistCard />
          {vault.settings.assist?.chat && <SkillsCard />}

          <HelpCard />
          <DuplicatesCard />

          {/* Parameters */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Parameters</div>
            <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
              Assumptions behind projections and status colors. Changes apply everywhere, instantly.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
              {PARAM_DEFS.map((def) => (
                <div
                  key={def.key}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', ...hairBottom }}
                >
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{def.name}</div>
                    <div style={{ fontSize: 10.5, color: MUT, marginTop: 3 }}>{def.hint}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="hov-ink"
                      data-testid={`param-${def.key}-dec`}
                      onClick={() =>
                        store.commit({
                          kind: 'setParam',
                          key: def.key,
                          value: Math.max(def.min, Math.round((P[def.key] - def.step) * 100) / 100),
                        })
                      }
                      style={stepBtn}
                    >
                      −
                    </button>
                    <div style={{ ...mono(11.5), fontWeight: 600, minWidth: 56, textAlign: 'center' }} data-testid={`param-${def.key}`}>
                      {P[def.key]}
                      {def.unit}
                    </div>
                    <button
                      className="hov-ink"
                      data-testid={`param-${def.key}-inc`}
                      onClick={() =>
                        store.commit({ kind: 'setParam', key: def.key, value: Math.round((P[def.key] + def.step) * 100) / 100 })
                      }
                      style={stepBtn}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', ...hairBottom }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Rules-of-thumb lines</div>
                  <div style={{ fontSize: 10.5, color: MUT, marginTop: 3 }}>Reference lines on Plan (housing, savings, emergency fund)</div>
                </div>
                <button
                  data-testid="toggle-thumbs"
                  onClick={() => store.commit({ kind: 'setSingletonField', collection: 'params', field: 'rulesOfThumb', value: !P.rulesOfThumb })}
                  style={{ fontSize: 11.5, color: P.rulesOfThumb ? 'var(--accent)' : MUT, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '3px 12px', background: 'none', cursor: 'pointer' }}
                >
                  {P.rulesOfThumb ? 'On' : 'Off'}
                </button>
              </div>
            </div>
          </div>

          {/* Saving */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Saving</div>
            <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
              When changes are written to the encrypted vault. Closing the tab always protects unsaved work locally.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {SAVE_MODES.map((m) => (
                <button
                  key={m.id}
                  data-testid={`savemode-${m.id}`}
                  onClick={() => store.commit({ kind: 'setSaveMode', saveMode: m.id })}
                  style={chip(vault.settings.saveMode === m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ ...italicNote, marginTop: 10 }}>
              {SAVE_MODES.find((m) => m.id === vault.settings.saveMode)?.hint}
            </div>
          </div>

          {/* Your data */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Your data</div>
            <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>Everything you&rsquo;ve tracked is yours — export it any time.</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                className="hov-invert"
                data-testid="export-csv"
                onClick={() => store.showToast(`Exported ${exportCsv(vault)}`)}
                style={btnOutline}
              >
                Export CSV
              </button>
              <button
                className="hov-invert"
                data-testid="export-json"
                onClick={() => store.showToast(`Exported ${exportJson(vault)} — API keys excluded`)}
                style={btnOutline}
              >
                Export JSON
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 34 }}>
          {/* Categories */}
          <CategoriesCard />

          {/* Sync */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Sync</div>
            <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
              Your vault is encrypted before it leaves this device. Point it at a file in a synced folder, or at Google Drive, to
              share across devices.
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', ...hairBottom }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Vault file</span>
              <span style={{ ...mono(10.5), color: MUT }} data-testid="remote-label">
                {persist.remoteLabel}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {persist.remoteLabel === 'None' ? (
                <>
                  {persist.canLocalFile && (
                    <>
                      <button className="hov-invert" data-testid="connect-create" onClick={() => void persist.connectFile('create')} style={btnOutline}>
                        Create vault file
                      </button>
                      <button className="hov-invert" data-testid="connect-open" onClick={() => void persist.connectFile('open')} style={btnOutline}>
                        Open existing
                      </button>
                    </>
                  )}
                  {persist.canGoogleDrive && (
                    <button className="hov-invert" data-testid="connect-gdrive" onClick={() => void persist.connectGoogleDrive()} style={btnOutline}>
                      Connect Google Drive
                    </button>
                  )}
                  {!persist.canLocalFile && !persist.canGoogleDrive && (
                    <div style={{ ...italicNote }}>Local-file sync needs a Chromium-based browser (File System Access API).</div>
                  )}
                </>
              ) : (
                <>
                  {sync.state === 'REAUTH_NEEDED' && (
                    <button className="hov-invert" data-testid="reconnect" onClick={() => void persist.reconnectRemote()} style={btnOutline}>
                      Reconnect
                    </button>
                  )}
                  {/* Switching providers has to be reachable without disconnecting first —
                      otherwise anyone already on a vault file can't move to Drive at all. */}
                  {persist.canGoogleDrive && persist.remoteKind !== 'gdrive' && (
                    <button className="hov-invert" data-testid="connect-gdrive" onClick={() => void persist.connectGoogleDrive()} style={btnOutline}>
                      Switch to Google Drive
                    </button>
                  )}
                  <button className="hov-invert" data-testid="disconnect" onClick={() => void persist.disconnectRemote()} style={btnOutline}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {persist.remoteLabel !== 'None' && (
              <div style={{ ...mono(10.5), color: sync.state === 'REAUTH_NEEDED' ? BRICK : MUT, marginTop: 10 }} data-testid="sync-detail">
                {sync.state === 'REAUTH_NEEDED'
                  ? persist.remoteKind === 'gdrive'
                    ? 'Google access has lapsed — Reconnect to resume syncing.'
                    : 'File access needs re-granting — Reconnect to resume syncing.'
                  : sync.state === 'SYNCING' || sync.state === 'RETRY' || sync.state === 'SAVING_L1'
                    ? 'Syncing…'
                    : sync.lastSyncedAt
                      ? `Synced · last synced ${sync.lastSyncedAt}`
                      : 'Connected · not synced yet'}
              </div>
            )}
            {persist.storagePersisted === false && (
              <div style={{ ...italicNote, marginTop: 12 }} data-testid="storage-durability">
                This browser keeps your vault on a best-effort basis — it can be evicted under storage pressure or
                removed with browsing data.
                {persist.remoteLabel === 'None' && ' Connect a vault file so this device isn’t the only copy.'}
              </div>
            )}
          </div>

          {/* Security */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Security</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="hov-invert" data-testid="lock-now" onClick={() => void persist.lock()} style={btnOutline}>
                Lock now
              </button>
              {!changingPw && (
                <button className="hov-invert" data-testid="change-password" onClick={() => setChangingPw(true)} style={btnOutline}>
                  Change password
                </button>
              )}
            </div>
            {changingPw && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
                <input
                  type="password"
                  placeholder="New password (min 8 chars)"
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                  data-testid="newpw-1"
                  style={{ ...inputUnderline, width: '100%', boxSizing: 'border-box' }}
                />
                <input
                  type="password"
                  placeholder="Repeat new password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  data-testid="newpw-2"
                  style={{ ...inputUnderline, width: '100%', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setChangingPw(false)} style={{ ...btnOutline, color: MUT, border: `1px solid ${HAIR}` }}>
                    Cancel
                  </button>
                  <button
                    data-testid="newpw-go"
                    onClick={() => {
                      if (pw1.length < 8 || pw1 !== pw2) {
                        store.showToast(pw1.length < 8 ? 'Password must be at least 8 characters' : 'Passwords don’t match')
                        return
                      }
                      void persist
                        .changePassword(pw1)
                        .then(() => {
                          setChangingPw(false)
                          setPw1('')
                          setPw2('')
                        })
                        .catch(() => store.showToast('Couldn’t save the re-keyed vault — password unchanged'))
                    }}
                    style={btnOutline}
                  >
                    Re-key vault
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', color: BRICK }}>Danger zone</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="hov-invert" data-testid="load-demo" onClick={() => persist.loadDemo()} style={btnOutline}>
                Load demo data
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder='Type "erase" to confirm'
                value={confirmErase}
                onChange={(e) => setConfirmErase(e.target.value)}
                data-testid="erase-confirm"
                style={{ ...inputUnderline, width: 170 }}
              />
              <button
                data-testid="erase-go"
                onClick={() => {
                  if (confirmErase.trim().toLowerCase() === 'erase') void persist.eraseAll()
                }}
                style={{ ...btnOutline, color: BRICK, borderColor: BRICK }}
              >
                Erase &amp; start fresh
              </button>
            </div>
            <div style={{ ...italicNote, marginTop: 10 }}>
              Erasing deletes the local vault on this device. A connected vault file is left untouched.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
