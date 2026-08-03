// Help — the glossary, and the switch that brings the screen intros back.
//
// The glossary comes free from the explanation registry: the same records the "?" panels
// render and the assistant's `screens` skill is generated from. That is the third consumer
// of one definition, and it is why the registry is central rather than inline at each call
// site — inline copy could never produce this page.
import { useState } from 'react'
import { FAINT, INK, MONO, MUT } from '../theme'
import { italicNote } from '../styles'
import { EXPLAIN, EXPLAIN_IDS, howText, type Explanation } from '../explain'
import { useStoreState } from '../store'
import { curSym } from '../theme'
import { HELP_RESET_EVENT, loadHelp, resetIntros, saveHelp } from '../uiPrefs'

export function HelpCard() {
  const { vault } = useStoreState()
  const [openId, setOpenId] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  const ctx = { sym: curSym(), srTarget: vault.params.srTarget, efTarget: vault.params.efTarget || 6 }

  // Group by screen so the glossary reads as a tour of the app, not an alphabet.
  const byScreen = new Map<string, { id: string; e: Explanation }[]>()
  for (const id of EXPLAIN_IDS) {
    const e = EXPLAIN[id] as Explanation
    byScreen.set(e.screen, [...(byScreen.get(e.screen) ?? []), { id, e }])
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="help-card">
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Help</div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4, lineHeight: 1.5 }}>
        Every figure in Ledger carries a “?” explaining what it is, how it was worked out and what it
        leaves out. They are collected here.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <button
          data-testid="help-reset"
          onClick={() => {
            saveHelp(resetIntros(loadHelp()))
            // Screen panes never unmount, so tell the mounted intros to re-read.
            window.dispatchEvent(new Event(HELP_RESET_EVENT))
            setRestored(true)
          }}
          style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Show screen intros again
        </button>
        {restored && (
          <span data-testid="help-reset-done" style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
            restored — reopen a screen to see them
          </span>
        )}
      </div>

      <div style={{ marginTop: 14 }} data-testid="glossary">
        {[...byScreen].map(([screen, items]) => (
          <div key={screen} style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.08em', textTransform: 'uppercase' }}>{screen}</div>
            {items.map(({ id, e }) => (
              <div key={id} style={{ borderBottom: `1px solid var(--hair2)` }}>
                <button
                  data-testid={`glossary-${id}`}
                  aria-expanded={openId === id}
                  onClick={() => setOpenId(openId === id ? null : id)}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '8px 0' }}
                >
                  <span style={{ fontSize: 12.5, color: INK }}>{e.title}</span>
                  <span style={{ color: FAINT, fontSize: 11, flex: 'none' }}>{openId === id ? '−' : '+'}</span>
                </button>
                {openId === id && (
                  <div style={{ paddingBottom: 10, fontSize: 12, color: MUT, lineHeight: 1.55 }}>
                    <div>{e.what}</div>
                    <div style={{ marginTop: 6 }}>{howText(e, ctx)}</div>
                    {e.excludes && (
                      <ul style={{ margin: '6px 0 0', paddingLeft: 15 }}>
                        {e.excludes.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ ...italicNote, marginTop: 10 }}>
        The assistant reads these same notes, so its answers and these panels describe one thing.
      </div>
    </div>
  )
}
