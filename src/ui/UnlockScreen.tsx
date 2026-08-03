import { useState } from 'react'
import { BG, HAIR, INK, MONO, MUT, SERIF } from './theme'
import { btnPrimary, chip, inputUnderline, italicNote, kicker, mono } from './styles'
import { useNarrow } from './responsive'

export interface OpenFileApi {
  /** Open the picker; resolves to the chosen file name (null if cancelled). */
  pick: () => Promise<string | null>
  /**
   * Sign in and fetch the vault from Google Drive; resolves to its name, null if
   * cancelled, or an error string. Absent when this build has no Google client.
   */
  pickDrive?: () => Promise<{ name: string } | { error: string } | null>
  /** Unlock the picked file with its password; error text or null on success. */
  open: (password: string) => Promise<string | null>
}

interface Props {
  mode: 'setup' | 'unlock' | 'rekey'
  onCreate?: (password: string, demo: boolean) => Promise<void>
  onUnlock?: (password: string) => Promise<string | null> // error text or null
  openFile?: OpenFileApi
}

type View = 'create' | 'unlock' | 'open' | 'rekey'

export function UnlockScreen(props: Props) {
  const [view, setView] = useState<View>(props.mode === 'setup' ? 'create' : props.mode)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [demo, setDemo] = useState(true)
  const [fileName, setFileName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const switchView = (v: View) => {
    setView(v)
    setError(null)
    setPw('')
    setPw2('')
  }

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      if (view === 'create') {
        if (pw.length < 8) return setError('Use at least 8 characters.')
        if (pw !== pw2) return setError('Passwords don’t match.')
        await props.onCreate?.(pw, demo)
      } else if (view === 'open') {
        if (!fileName) return setError('Choose a vault file first.')
        if (!pw) return
        const err = await props.openFile?.open(pw)
        if (err) setError(err)
      } else {
        if (!pw) return
        const err = await props.onUnlock?.(pw)
        if (err) setError(err)
      }
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) void submit()
  }

  const narrow = useNarrow()

  const intro =
    view === 'create'
      ? 'Your data is encrypted on this device with a master password. Nothing leaves in plaintext — not even to your own cloud.'
      : view === 'open'
        ? 'Open a vault file created on another device. Its master password decrypts it and it becomes the vault on this device.'
        : view === 'rekey'
          ? 'The password was changed on another device. Enter the new master password to continue.'
          : 'Enter your master password to decrypt your vault.'

  const buttonLabel = busy ? 'DERIVING KEY…' : view === 'create' ? 'CREATE VAULT' : view === 'open' ? 'OPEN VAULT' : 'UNLOCK'

  return (
    <div style={{ height: '100svh', background: BG, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* The card is 360 wide in a content-box, so with its 30px side padding it really occupies
          420 — wider than any phone. Narrow screens switch it to border-box and cap it; on
          desktop both properties are absent, so the box is byte-for-byte what it was. */}
      <div
        style={{
          width: 360,
          maxWidth: narrow ? 'calc(100vw - 24px)' : undefined,
          boxSizing: narrow ? 'border-box' : undefined,
          border: `1px solid ${INK}`,
          borderRadius: 2,
          padding: '28px 30px 30px',
          background: BG,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <div style={{ fontFamily: SERIF, fontSize: 26, fontWeight: 600, letterSpacing: '-0.01em' }}>Ledger</div>
          <div style={{ ...mono(9.5), color: MUT, letterSpacing: '.08em' }}>PRIVATE BY DESIGN</div>
        </div>

        {props.mode === 'setup' && props.openFile && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button data-testid="tab-create" onClick={() => switchView('create')} style={chip(view === 'create')}>
              Create new
            </button>
            <button data-testid="tab-open" onClick={() => switchView('open')} style={chip(view === 'open')}>
              Open vault file
            </button>
          </div>
        )}

        <div style={{ fontSize: 12.5, color: MUT, marginTop: 12, lineHeight: 1.5 }}>{intro}</div>

        {view === 'open' && (
          <>
            <div style={{ ...kicker, marginTop: 20 }}>Vault file</div>
            <button
              className="hov-border"
              data-testid="pick-file"
              onClick={() =>
                void props.openFile?.pick().then((name) => {
                  if (name) {
                    setFileName(name)
                    setError(null)
                  }
                })
              }
              style={{
                width: '100%',
                marginTop: 8,
                border: `1.5px dashed ${fileName ? INK : '#B9B29F'}`,
                background: 'transparent',
                padding: '12px 10px',
                cursor: 'pointer',
                ...mono(11),
                color: fileName ? INK : MUT,
                letterSpacing: '.04em',
              }}
            >
              {fileName ?? 'Choose vault file…'}
            </button>
            {props.openFile?.pickDrive && (
              <button
                className="hov-invert"
                data-testid="pick-gdrive"
                onClick={() => {
                  setBusy(true)
                  void props.openFile
                    ?.pickDrive?.()
                    .then((res) => {
                      if (!res) return
                      if ('error' in res) return setError(res.error)
                      setFileName(res.name)
                      setError(null)
                    })
                    .finally(() => setBusy(false))
                }}
                disabled={busy}
                style={{
                  width: '100%',
                  marginTop: 8,
                  border: `1px solid ${INK}`,
                  background: 'transparent',
                  padding: '10px',
                  cursor: busy ? 'default' : 'pointer',
                  ...mono(10.5),
                  letterSpacing: '.06em',
                }}
              >
                FROM GOOGLE DRIVE
              </button>
            )}
          </>
        )}

        <div style={{ ...kicker, marginTop: view === 'open' ? 16 : 22 }}>
          {view === 'create' ? 'Choose a master password' : view === 'open' ? 'The file’s master password' : 'Master password'}
        </div>
        <input
          type="password"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={onEnter}
          data-testid="password"
          style={{ ...inputUnderline, width: '100%', boxSizing: 'border-box', fontSize: 14, marginTop: 6 }}
        />
        {view === 'create' && (
          <>
            <div style={{ ...kicker, marginTop: 16 }}>Repeat it</div>
            <input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={onEnter}
              data-testid="password2"
              style={{ ...inputUnderline, width: '100%', boxSizing: 'border-box', fontSize: 14, marginTop: 6 }}
            />
            <div style={{ ...kicker, marginTop: 18 }}>Start with</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button data-testid="start-demo" onClick={() => setDemo(true)} style={chip(demo)}>
                Demo data
              </button>
              <button data-testid="start-empty" onClick={() => setDemo(false)} style={chip(!demo)}>
                Empty vault
              </button>
            </div>
          </>
        )}

        {error && (
          <div data-testid="unlock-error" style={{ fontSize: 12, color: 'var(--neg)', fontWeight: 600, marginTop: 14 }}>
            {error}
          </div>
        )}

        <button
          className="hov-dark"
          disabled={busy}
          data-testid="unlock-go"
          onClick={() => void submit()}
          style={{ ...btnPrimary, width: '100%', height: 40, marginTop: 20, fontFamily: MONO, letterSpacing: '.08em', fontSize: 12 }}
        >
          {buttonLabel}
        </button>

        {view === 'unlock' && props.openFile && (
          <button
            className="hov-ink"
            data-testid="switch-open"
            onClick={() => switchView('open')}
            style={{
              border: 'none',
              background: 'none',
              padding: 0,
              marginTop: 14,
              cursor: 'pointer',
              ...mono(10),
              letterSpacing: '.06em',
              color: MUT,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            OPEN A DIFFERENT VAULT FILE…
          </button>
        )}
        {view === 'open' && props.mode === 'unlock' && (
          <button
            className="hov-ink"
            data-testid="switch-unlock"
            onClick={() => switchView('unlock')}
            style={{
              border: 'none',
              background: 'none',
              padding: 0,
              marginTop: 14,
              cursor: 'pointer',
              ...mono(10),
              letterSpacing: '.06em',
              color: MUT,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            ← UNLOCK THE VAULT ON THIS DEVICE
          </button>
        )}

        {view === 'create' && (
          <div style={{ ...italicNote, fontSize: 11.5, marginTop: 14, borderTop: `1px solid ${HAIR}`, paddingTop: 12 }}>
            There is no password recovery — the encryption is only as forgiving as you are.
          </div>
        )}
        {view === 'open' && props.mode === 'unlock' && (
          <div style={{ ...italicNote, fontSize: 11.5, marginTop: 14, borderTop: `1px solid ${HAIR}`, paddingTop: 12 }}>
            Opening a file replaces the vault currently on this device.
          </div>
        )}
      </div>
    </div>
  )
}
