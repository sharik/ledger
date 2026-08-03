// ScreenIntro — a dismissible "how to read this screen" strip.
//
// Every screen already carries a one-line sub-headline stating its contract, and those are
// good: always visible, never in the way. This sits under them and answers the three things
// a first-time reader actually needs — what this screen answers, how to read its main chart,
// and where its numbers come from — then gets out of the way for good.
//
// Dismissal is per-device (see uiPrefs), and Settings can bring them all back.
import { useEffect, useState } from 'react'
import { FAINT, HAIR, MUT, SURFACE } from './theme'
import { HELP_RESET_EVENT, dismiss, isDismissed, loadHelp, saveHelp } from './uiPrefs'

export interface IntroCopy {
  /** Three bullets: what it answers · how to read it · where the numbers come from. */
  points: string[]
}

export const SCREEN_INTRO: Record<string, IntroCopy> = {
  dash: {
    points: [
      'The 10-second glance: what you have spent this month, whether that is unusual, and whether you are on plan.',
      'Every figure counts expenses only and drops transfers between your own accounts. The dashed line is a projection, never an actual.',
      'The caption top-right says how current the data is. It is the date your statements cover — not today.',
    ],
  },
  compare: {
    points: [
      'Any two selections, side by side — periods, categories and trips are interchangeable.',
      'Same-point counts both sides through the same elapsed day; Full period runs each its whole length. The toggle changes every number here.',
      'Movers are sorted by the size of the change, not the size of the spend.',
    ],
  },
  trends: {
    points: [
      'Where the money goes over time — by year, by month, then down to the merchant.',
      'The legend is a filter: switching a category off restates every total on the chart, the axis, and the projection.',
      'The current month is hatched because it is still partial.',
    ],
  },
  trips: {
    points: [
      'A trip is a tag with a date window. Rows inside it join automatically; you can include or exclude any row by hand.',
      'On the timeline, block height is spend per day on a scale shared across all trips — equal heights mean an equal daily rate, not an equal total.',
      'Trip totals count expenses only: income, refunds and transfers are left out.',
    ],
  },
  plan: {
    points: [
      'Budgets and goals for this month. Spend is derived from your transactions every time you look, so an import can never leave a budget stale.',
      'All budget bars share one scale — compare each bar to its own tick, not to the bar above it.',
      'The dashed marker is where this lands at the current pace, measured over the days your statements cover rather than the days of the month.',
      'Budgets may overlap: a charge inside two of them is counted once in the total. Click a name for its transactions, or the arrow for how it has gone over time.',
    ],
  },
  accounts: {
    points: [
      'Balances, and what they add up to. These are dated snapshots — Ledger has no bank connection, so nothing here is live.',
      'Net worth adds each account’s own most recent snapshot, and those dates are not the same across accounts.',
      'A hatched band on the chart means an account has no snapshot for those months. The line is never interpolated across it.',
    ],
  },
  txns: {
    points: [
      'A support surface — search, recategorize and inspect any imported row. Not somewhere you need to visit daily.',
      'Every chart in the app drills to here, and the chips at the top are the receipt of what was filtered.',
      'Each row records how its category was decided, so a wrong one can be fixed and taught in a single step.',
    ],
  },
}

export function ScreenIntro({ id }: { id: keyof typeof SCREEN_INTRO }) {
  const [prefs, setPrefs] = useState(loadHelp)
  useEffect(() => {
    const onReset = () => setPrefs(loadHelp())
    window.addEventListener(HELP_RESET_EVENT, onReset)
    return () => window.removeEventListener(HELP_RESET_EVENT, onReset)
  }, [])
  const copy = SCREEN_INTRO[id]
  if (!copy || isDismissed(prefs, id)) return null

  return (
    <div
      data-testid={`screen-intro-${id}`}
      data-screen-intro={id}
      style={{
        background: SURFACE,
        border: `1px solid ${HAIR}`,
        borderRadius: 6,
        padding: '11px 14px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <ul style={{ flex: 1, margin: 0, paddingLeft: 16, fontSize: 12, color: MUT, lineHeight: 1.6 }}>
        {copy.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <button
        data-testid={`screen-intro-dismiss-${id}`}
        aria-label="Dismiss this introduction"
        onClick={() => {
          const next = dismiss(prefs, id)
          setPrefs(next)
          saveHelp(next)
        }}
        style={{ color: FAINT, fontSize: 14, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', flex: 'none', padding: 2 }}
      >
        ✕
      </button>
    </div>
  )
}
