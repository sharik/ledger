// The assistant drawer (ASSISTANT §9).
//
// Right-anchored sheet, following SyncNotes. Deliberately WITHOUT a scrim: the assistant's job is to
// drive the screen behind it — open a filtered list, open a comparison — and a modal overlay would
// hide the very thing it just did.
//
// Tool receipts are not decoration. Every figure in the prose came from one of them, so the receipt
// line is the audit trail: it says what was asked, over what period, and how many rows answered. It
// is also, in plain sight, exactly what left the device.
import { Fragment, useEffect, useRef, useState } from 'react'
import { useAssistant, type Proposal } from './ctx'
import type { Turn } from '../../assistant/wire'
import { BG, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE, SURFACE2 } from '../theme'
import { btnGhost, btnPrimary, kicker, phoneSheet } from '../styles'
import { useNarrow } from '../responsive'

/** Drawer width. `App` reserves exactly this much so the panel never covers what it just opened. */
export const ASSISTANT_WIDTH = 420

export function AssistantPanel() {
  const a = useAssistant()
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const narrow = useNarrow()

  // Esc closes, from anywhere — the panel never traps focus, so the key has to be global.
  useEffect(() => {
    if (!a.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') a.setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a.open, a])

  useEffect(() => {
    if (a.open) input.current?.focus()
  }, [a.open])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [a.turns, a.proposals, a.error, a.running])

  if (!a.open) return null

  const submit = () => {
    const text = draft.trim()
    if (!text || a.running) return
    setDraft('')
    a.send(text)
  }

  return (
    <div
      data-testid="assistant-panel"
      role="complementary"
      aria-label="Assistant"
      style={{
        position: 'fixed',
        top: 58,
        right: 0,
        bottom: 0,
        width: ASSISTANT_WIDTH,
        maxWidth: '100vw',
        background: BG,
        borderLeft: `1px solid ${HAIR}`,
        boxShadow: '-14px 0 44px rgba(10,9,7,.14)',
        zIndex: 21,
        display: 'flex',
        flexDirection: 'column',
        animation: 'sheetIn .18s ease',
        // Spread last: these must win over the drawer geometry above.
        ...phoneSheet(narrow),
      }}
    >
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${HAIR}` }}>
        <div style={{ ...kicker, flex: 1 }}>ASSISTANT</div>
        {a.turns.length > 0 && (
          <button data-testid="assistant-clear" onClick={a.clear} className="hov-ink" style={{ ...btnGhost, fontSize: 11 }}>
            Clear
          </button>
        )}
        <button data-testid="assistant-close" onClick={() => a.setOpen(false)} aria-label="Close assistant" className="hov-ink" style={{ ...btnGhost, fontSize: 11 }}>
          Close
        </button>
      </div>

      <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {a.turns.length === 0 && <Empty safe={a.access === 'safe'} />}
        {/* Cards render at the turn that raised them, in conversation order — a proposal is about
            one answer, and a pile of them at the bottom no longer says which. */}
        {a.turns.map((t, i) => (
          <Fragment key={i}>
            <TurnView turn={t} />
            {a.proposals
              .filter((p) => p.afterTurn === i)
              .map((p) => (
                <ProposalCard key={p.id} p={p} onApply={() => a.apply(p.id)} onDismiss={() => a.dismiss(p.id)} />
              ))}
          </Fragment>
        ))}
        {/* A card whose turn never landed would otherwise be invisible — a queued change the user
            can neither see nor dismiss. Show it at the end rather than drop it. */}
        {a.proposals
          .filter((p) => p.afterTurn >= a.turns.length)
          .map((p) => (
            <ProposalCard key={p.id} p={p} onApply={() => a.apply(p.id)} onDismiss={() => a.dismiss(p.id)} />
          ))}
        {a.running && (
          <div data-testid="assistant-working" style={{ fontSize: 12, color: MUT, fontStyle: 'italic' }}>
            Working…
          </div>
        )}
        {a.error && (
          <div data-testid="assistant-error" style={{ fontSize: 12, color: INK, background: 'var(--warnbg)', border: `1px solid ${HAIR}`, borderRadius: 5, padding: '8px 10px', lineHeight: 1.5 }}>
            {a.error}
          </div>
        )}
      </div>

      <div style={{ flex: 'none', borderTop: `1px solid ${HAIR}`, padding: 10, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={input}
          data-testid="assistant-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder="Ask about your money…"
          style={{
            flex: 1,
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: 12.5,
            lineHeight: 1.5,
            padding: '7px 9px',
            border: `1px solid ${HAIR}`,
            borderRadius: 5,
            background: SURFACE,
            color: INK,
          }}
        />
        {a.running ? (
          <button data-testid="assistant-stop" onClick={a.stop} className="hov-ink" style={{ ...btnGhost, height: 32 }}>
            Stop
          </button>
        ) : (
          <button data-testid="assistant-send" onClick={submit} disabled={!draft.trim()} style={{ ...btnPrimary, height: 32, opacity: draft.trim() ? 1 : 0.45 }}>
            Ask
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The opening screen, and the one place the access level has to be legible: what you can usefully ask
 * differs entirely between the two, and finding that out by being refused is a worse way to learn it.
 */
function Empty({ safe }: { safe: boolean }) {
  if (safe) {
    return (
      <div style={{ fontSize: 12, color: MUT, lineHeight: 1.6 }} data-testid="assistant-safe-empty">
        Access is <span style={{ color: GREEN }}>Safe</span>. The assistant knows what your accounts, categories, trips,
        budgets and goals are called, and how many transactions each has. It cannot see amounts, dates or individual
        rows, so it answers by explaining how a screen worked its figure out, or by opening the screen so you read the
        number here. Change it in Settings → Assistant.
        <div style={{ marginTop: 8, color: FAINT }}>
          “Show me last month’s groceries” · “Why does the dashboard say I’m on pace?” · “Which trips do I have?”
        </div>
      </div>
    )
  }
  return (
    <div style={{ fontSize: 12, color: MUT, lineHeight: 1.6 }}>
      Ask about your spending, accounts, budgets or trips. Nothing is sent until you ask something — then only what
      answering it requires.
      <div style={{ marginTop: 8, color: FAINT }}>
        “Where did my money go last month?” · “How does this year compare to last?” · “What did I spend at the
        supermarket?”
      </div>
    </div>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div data-testid="assistant-user" style={{ alignSelf: 'flex-end', maxWidth: '88%', background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 8, padding: '7px 10px', fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
        {turn.text}
      </div>
    )
  }
  if (turn.role === 'assistant') {
    if (!turn.text) return null
    return (
      <div data-testid="assistant-reply" style={{ fontSize: 12.5, lineHeight: 1.6, color: INK, whiteSpace: 'pre-wrap' }}>
        {turn.text}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {turn.results.map((r) => (
        <div
          key={r.id}
          data-testid="assistant-receipt"
         
          style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.02em', color: r.error ? INK : MUT, lineHeight: 1.5 }}
          title={r.name}
        >
          {r.error ? '⚠ ' : '· '}
          {r.receipt ?? r.name}
        </div>
      ))}
    </div>
  )
}

function ProposalCard({ p, onApply, onDismiss }: { p: Proposal; onApply: () => void; onDismiss: () => void }) {
  return (
    <div
      data-testid="assistant-proposal"
      style={{ border: `1px solid ${p.state === 'pending' ? INK : HAIR}`, borderRadius: 6, padding: '9px 11px', background: SURFACE }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>{p.summary}</div>
      {p.detail && <div style={{ fontSize: 11.5, color: MUT, marginTop: 3, lineHeight: 1.5 }}>{p.detail}</div>}
      {p.state === 'pending' ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button data-testid="proposal-apply" onClick={onApply} style={{ ...btnPrimary, height: 28 }}>
            Apply
          </button>
          <button data-testid="proposal-dismiss" onClick={onDismiss} className="hov-ink" style={{ ...btnGhost, height: 28 }}>
            Dismiss
          </button>
        </div>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', color: p.state === 'applied' ? GREEN : FAINT, marginTop: 6 }}>
          {p.state === 'applied' ? 'APPLIED — UNDO FROM THE TOAST' : 'DISMISSED'}
        </div>
      )}
    </div>
  )
}

/**
 * Header trigger. Hidden unless the user has switched the assistant on in Settings.
 *
 * `block` is the phone form: the button lives in the header's overflow sheet, where a 32px
 * pill labelled "Ask" among full-width rows would read as a different kind of thing.
 */
export function AssistantButton({ block }: { block?: boolean }) {
  const a = useAssistant()
  return (
    <button
      className={block ? undefined : 'hov-ink'}
      data-testid="assistant-toggle"
      aria-pressed={a.open}
      aria-label="Assistant"
      onClick={() => a.setOpen(!a.open)}
      style={
        block
          ? {
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              minHeight: 48,
              padding: '10px 6px',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--hair2)',
              color: 'var(--ink2)',
              fontSize: 14,
              cursor: 'pointer',
            }
          : {
              height: 32,
              padding: '0 11px',
              border: `1px solid ${a.open ? INK : HAIR}`,
              borderRadius: 3,
              background: SURFACE,
              color: a.open ? INK : MUT,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }
      }
    >
      {block ? 'Ask the assistant' : 'Ask'}
    </button>
  )
}

