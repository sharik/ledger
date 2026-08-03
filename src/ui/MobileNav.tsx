import { useState } from 'react'
import { useView, type Tab } from './view'
import { BG, HAIR, INK, MONO, MUT } from './theme'
import { Sheet, SheetItem } from './kit/Sheet'

/**
 * The phone navigation bar.
 *
 * Replaces the desktop nav strip, which put eight 11px labels with `padding: 0` in a 40px
 * sideways-scrolling row — a tap target roughly 11px tall, and half the destinations off-screen
 * with no scroll affordance.
 *
 * Five slots is the practical maximum at 360px, so four destinations lead and the rest live in a
 * More sheet. The four are the ones BRIEF §17 calls the phone's job — "mobile for glancing" —
 * plus Transactions, which is where every drill-down lands.
 *
 * Every button keeps its `data-tab` attribute, including the ones inside the sheet. That is not
 * incidental: the entire existing E2E suite navigates by `[data-tab="x"]`, and preserving the
 * attribute is what lets those specs run at phone width without being rewritten.
 */

const PRIMARY: { tab: Tab; label: string; glyph: string }[] = [
  { tab: 'dash', label: 'Dashboard', glyph: '▦' },
  { tab: 'txns', label: 'Transactions', glyph: '≡' },
  { tab: 'trends', label: 'Trends', glyph: '∿' },
  { tab: 'plan', label: 'Plan', glyph: '◎' },
]

const MORE: { tab: Tab; label: string; note: string }[] = [
  { tab: 'compare', label: 'Compare', note: 'Two periods, side by side' },
  { tab: 'trips', label: 'Trips', note: 'Spending while you were away' },
  { tab: 'accounts', label: 'Accounts', note: 'Balances and net worth' },
  { tab: 'import', label: 'Import', note: 'Add a bank statement' },
  { tab: 'settings', label: 'Settings', note: 'Rules, categories, sync' },
]

export const MOBILE_NAV_HEIGHT = 56

export function MobileNav() {
  const view = useView()
  const [moreOpen, setMoreOpen] = useState(false)
  const onMoreTab = MORE.some((m) => m.tab === view.tab)

  const go = (tab: Tab) => {
    setMoreOpen(false)
    view.goTab(tab)
  }

  return (
    <>
      <nav
        data-testid="mobile-nav"
        aria-label="Main"
        style={{
          flex: 'none',
          display: 'flex',
          borderTop: `1px solid ${HAIR}`,
          background: BG,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {PRIMARY.map((p) => (
          <NavBtn
            key={p.tab}
            tab={p.tab}
            label={p.label}
            glyph={p.glyph}
            on={view.tab === p.tab}
            onClick={() => go(p.tab)}
          />
        ))}
        <NavBtn
          testid="nav-more"
          label="More"
          glyph="⋯"
          on={onMoreTab || moreOpen}
          onClick={() => setMoreOpen(true)}
        />
      </nav>

      {moreOpen && (
        <Sheet title="Go to" onClose={() => setMoreOpen(false)}>
          {MORE.map((m) => (
            <SheetItem
              key={m.tab}
              testid={`nav-more-${m.tab}`}
              dataAttr={{ 'data-tab': m.tab }}
              selected={view.tab === m.tab}
              onClick={() => go(m.tab)}
            >
              <span style={{ flex: 1 }}>
                {m.label}
                <span style={{ display: 'block', fontSize: 11.5, color: MUT, fontWeight: 400 }}>{m.note}</span>
              </span>
            </SheetItem>
          ))}
        </Sheet>
      )}
    </>
  )
}

function NavBtn({
  tab,
  testid,
  label,
  glyph,
  on,
  onClick,
}: {
  tab?: Tab
  testid?: string
  label: string
  glyph: string
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      data-tab={tab}
      data-testid={testid}
      aria-current={on ? 'page' : undefined}
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 0,
        height: MOBILE_NAV_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        border: 'none',
        borderTop: on ? `2px solid ${INK}` : '2px solid transparent',
        background: 'none',
        color: on ? INK : MUT,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
        {glyph}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          fontWeight: on ? 600 : 400,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  )
}
