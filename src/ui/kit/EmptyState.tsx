// EmptyState — for a surface that has nothing to show.
//
// The component is small; the RULE it enforces is the point. Every full-surface empty state
// must name WHICH of three reasons it is empty, and offer the action that fixes that
// reason. Transactions used to say "No transactions match." whether the vault was empty or
// six filters were active — two different problems, one message, no way out.
//
// The Dashboard already did this with its `insightBasis: 'empty' | 'thin' | 'ok'`; this
// generalises that. `data-basis` is rendered so e2e can assert the REASON, not the wording.
//
// Deliberately NOT used for the ~15 inline "this list is empty" one-liners inside a table
// the reader already understands — those get the `emptyNote` style constant instead. A
// shared component there would buy consistent padding across 15 files and nothing else.
import type { ReactNode } from 'react'
import { FAINT, HAIR2, MUT } from '../theme'

export type EmptyBasis =
  /** Nothing has been imported yet. */
  | 'no-data'
  /** There is data, but the active filters exclude all of it. */
  | 'filtered'
  /** There is data, but not enough history for this surface to say anything. */
  | 'thin-history'

export interface EmptyStateProps {
  basis: EmptyBasis
  /** One sentence stating what is empty. */
  title: string
  /** Optional second line: why, in the user's terms. */
  body?: ReactNode
  /** The action that fixes THIS reason. */
  action?: { label: string; onClick: () => void }
  testid?: string
  /** Compact rendering for a card that is already small. */
  dense?: boolean
}

export function EmptyState({ basis, title, body, action, testid, dense = false }: EmptyStateProps) {
  return (
    <div
      data-testid={testid}
      data-basis={basis}
      style={{
        padding: dense ? '16px 0' : '26px 0',
        textAlign: 'center',
        borderTop: dense ? undefined : `1px solid ${HAIR2}`,
      }}
    >
      <div style={{ fontSize: 13, color: MUT }}>{title}</div>
      {body && <div style={{ fontSize: 12, color: FAINT, marginTop: 5, lineHeight: 1.5 }}>{body}</div>}
      {action && (
        <button
          data-testid={testid ? `${testid}-action` : undefined}
          onClick={action.onClick}
          style={{ fontSize: 12.5, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 9, padding: 0 }}
        >
          {action.label} →
        </button>
      )}
    </div>
  )
}
