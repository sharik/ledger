// <Explain> — the "?" beside a figure or a chart title.
//
// It exists because ~66 `title=` attributes carried the load-bearing meaning in this app.
// A native title is invisible on touch, unreachable by keyboard, and cannot hold structure.
// This gives the same information a hover hint, a focus hint, a tap target, and four
// sections in a fixed order: what it is → how it was calculated → what it excludes → where
// to go next. That order is the product decision: answer "what am I looking at" before
// "should I trust it".
//
// Almost nothing here is new machinery. The hover hint is the chart tooltip fed a button
// rect instead of a pointer position — that single substitution is what makes it reachable
// by keyboard. Escape-close and focus-restore are lifted from ChartCard; the flip-above
// test is `noRoomBelow` from styles.ts; the viewport clamp mirrors ChartTip.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FAINT, HAIR, INK, MONO, MUT, SURFACE } from '../theme'
import { kicker, noRoomBelow, phoneMenu } from '../styles'
import { useNarrow } from '../responsive'
import { useStoreState } from '../store'
import { useView } from '../view'
import { ChartTip, useChartTip } from '../charts/Tooltip'
import { useAssistantOptional } from '../assistant/ctx'
import { curSym } from '../theme'
import { EXPLAIN, howText, type ExplainId, type Explanation } from './content'

/** Only one panel open at a time, across portals — cheaper than a context provider. */
const OPEN_EVENT = 'ledger:explain'

const PANEL_W = 320

export function Explain({ id, size = 'md' }: { id: ExplainId; size?: 'sm' | 'md' }) {
  const narrow = useNarrow()
  // `as const satisfies` narrows each entry to its literal shape, so absent optionals drop
  // out of the union — widen back to the interface for rendering.
  const e: Explanation = EXPLAIN[id]
  const { vault } = useStoreState()
  const view = useView()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const { tip, showAt, hide } = useChartTip()
  const panelId = useId()

  const place = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const above = noRoomBelow(btn)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8))
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above })
  }, [])

  // Hover AND focus both show the hint. `title=` can never do the focus half.
  const showHint = () => {
    const r = btnRef.current?.getBoundingClientRect()
    // Below the "?", the way the panel opens. Above it sits the previous block's content — on the
    // Plan screen that was the goals empty state, whose "Add a goal" button the hint covered.
    if (r) showAt(r.left + r.width / 2, r.bottom, e.hint, noRoomBelow(btnRef.current!) ? 'above' : 'below')
  }

  const toggle = () => {
    hide()
    if (open) return setOpen(false)
    place()
    setOpen(true)
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }))
  }

  useEffect(() => {
    if (!open) return
    const onOther = (ev: Event) => {
      if ((ev as CustomEvent<string>).detail !== id) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus() // focus returns to the opener, as in ChartCard
      }
    }
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node
      if (!panelRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    // The app scrolls in [data-main-scroll], not the window — track both.
    window.addEventListener(OPEN_EVENT, onOther)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', place)
    document.querySelector('[data-main-scroll]')?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', place)
      document.querySelector('[data-main-scroll]')?.removeEventListener('scroll', place)
    }
  }, [open, id, place])

  const assistant = useAssistantOptional()
  const askable = !!assistant && !!vault.settings.assist?.chat

  const ctx = {
    sym: curSym(),
    srTarget: vault.params.srTarget,
    efTarget: vault.params.efTarget || 6,
  }

  const px = size === 'sm' ? 12 : 13

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={`explain-${id}`}
        aria-label={`What is ${e.title}?`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        onPointerEnter={showHint}
        onPointerLeave={hide}
        onFocus={showHint}
        onBlur={hide}
        style={{
          width: px + 4,
          height: px + 4,
          borderRadius: '50%',
          border: `1px solid ${HAIR}`,
          background: 'none',
          color: open ? INK : FAINT,
          fontSize: px - 3.5,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 0,
          marginLeft: 5,
          flex: 'none',
          verticalAlign: 'middle',
          touchAction: 'manipulation',
        }}
      >
        ?
      </button>
      {!open && <ChartTip tip={tip} />}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            data-testid="explain-panel"
            data-explain-id={id}
            role="dialog"
            aria-modal="false"
            aria-label={e.title}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.above ? undefined : pos.top,
              bottom: pos.above ? window.innerHeight - pos.top : undefined,
              width: PANEL_W,
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: '70vh',
              overflowY: 'auto',
              zIndex: 70, // above ChartCard fullscreen (62), below ChartTip (80)
              background: SURFACE,
              border: `1px solid ${HAIR}`,
              borderRadius: 6,
              padding: '15px 17px',
              boxShadow: '0 14px 40px rgba(10,9,7,.20)',
              // These panels run to several paragraphs. Anchored to a 17px "?" on a phone there
              // is nowhere for that to go — it ran 250px past the bottom of the screen. Spread
              // last so it wins over the anchor geometry above.
              ...phoneMenu(narrow),
              ...(narrow ? { maxHeight: '80dvh', overflowY: 'auto' } : {}),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: INK }}>{e.title}</div>
              <button
                data-testid="explain-close"
                onClick={() => {
                  setOpen(false)
                  btnRef.current?.focus()
                }}
                aria-label="Close explanation"
                autoFocus
                style={{ color: FAINT, fontSize: 15, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                ✕
              </button>
            </div>

            <Section label="What this is">{e.what}</Section>
            <Section label="How it’s calculated">{howText(e, ctx)}</Section>
            {e.excludes && e.excludes.length > 0 && (
              <>
                <div style={{ ...kicker, fontSize: 9.5, marginTop: 13 }}>What it excludes</div>
                <ul style={{ margin: '5px 0 0', paddingLeft: 15, fontSize: 12, color: MUT, lineHeight: 1.55 }}>
                  {e.excludes.map((x) => (
                    <li key={x} style={{ marginBottom: 3 }}>{x}</li>
                  ))}
                </ul>
              </>
            )}

            {e.seeSkill && (
              <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 12 }}>
                The assistant reads more on this in its “{e.seeSkill}” note.
              </div>
            )}

            {(e.next?.length || askable) && (
              <>
                <div style={{ ...kicker, fontSize: 9.5, marginTop: 14 }}>Where to go next</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  {/* The division of labour: this panel gives the definition, the assistant
                      gives THIS user's figures. Only offered once the chat is switched on. */}
                  {askable && (
                    <button
                      data-testid="explain-ask"
                      onClick={() => {
                        setOpen(false)
                        assistant!.setOpen(true)
                        assistant!.send(
                          `Explain the “${e.title}” figure on my ${e.screen} screen — what it means, how Ledger works it out, and what mine is right now.`,
                        )
                      }}
                      style={{ textAlign: 'left', fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer' }}
                    >
                      Ask the assistant about mine →
                    </button>
                  )}
                  {e.next?.map((n) => (
                    <button
                      key={n.label}
                      data-testid="explain-next"
                      onClick={() => {
                        setOpen(false)
                        view.go(n.tab, n.query)
                      }}
                      style={{ textAlign: 'left', fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer' }}
                    >
                      {n.label} →
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={{ ...kicker, fontSize: 9.5, marginTop: 13 }}>{label}</div>
      <div style={{ fontSize: 12, color: MUT, lineHeight: 1.55, marginTop: 4 }}>{children}</div>
    </>
  )
}
