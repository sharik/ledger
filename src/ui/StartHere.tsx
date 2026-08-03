// "Start here" — the first-run checklist on the Dashboard.
//
// Not a tour. Every step TICKS ITSELF FROM THE VAULT rather than being dismissed, so the
// card disappears by being completed, and it never lies about progress. On first run the
// vault is empty and most anchor targets a spotlight tour would need do not exist yet;
// this needs no anchors at all.
//
// It is also the missing entry point to Import, which is not in the tab strip, and the only
// place the assistant is mentioned before you go looking for it in Settings.
import type { Vault } from '../model/types'
import { ACCENT, FAINT, GREEN, HAIR, INK, MONO, MUT, SURFACE } from './theme'
import { useView } from './view'

export interface StartStep {
  id: string
  label: string
  hint: string
  done: boolean
  go?: () => void
}

/** Pure: which steps are done, given a vault. Exported for testing. */
export function startSteps(vault: Vault): { id: string; label: string; hint: string; done: boolean }[] {
  return [
    {
      id: 'import',
      label: 'Import a statement',
      hint: 'CSV, XLS or a PDF statement. It is parsed on this device — nothing is uploaded.',
      done: vault.statements.length > 0,
    },
    {
      id: 'coverage',
      label: 'Check what it covers',
      hint: 'Accounts shows the period each statement covers, and any gap between them.',
      done: vault.snapshots.length > 0,
    },
    {
      id: 'budget',
      label: 'Set one budget',
      hint: 'Pick the category you most want to watch. Spend is derived, never typed.',
      done: vault.budgets.length > 0,
    },
    {
      id: 'compare',
      label: 'Pin a comparison',
      hint: 'Build any two-sided comparison, then pin it to see it here every time.',
      done: vault.savedComparisons.some((c) => c.pinned),
    },
    {
      id: 'recurring',
      label: 'Confirm your subscriptions',
      hint: 'Ledger spots repeating charges; marking them makes the recurring total real.',
      done: vault.transactions.some((t) => t.recurring),
    },
  ]
}

export function StartHere({ vault }: { vault: Vault }) {
  const { goTab } = useView()
  const steps = startSteps(vault)
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null

  const target: Record<string, Parameters<typeof goTab>[0]> = {
    import: 'import',
    coverage: 'accounts',
    budget: 'plan',
    compare: 'compare',
    recurring: 'txns',
  }

  return (
    <section
      data-testid="start-here"
      data-done={done}
      style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 20px', marginBottom: 22 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Start here</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{done} of {steps.length} done</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {steps.map((s) => (
          <button
            key={s.id}
            data-testid={`start-step-${s.id}`}
            data-done={s.done ? '1' : undefined}
            onClick={() => goTab(target[s.id]!)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '9px 0',
              borderTop: `1px solid var(--hair2)`,
              background: 'none',
              border: 'none',
              borderTopStyle: 'solid',
              textAlign: 'left',
              width: '100%',
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `1.5px solid ${s.done ? GREEN : HAIR}`,
                background: s.done ? GREEN : 'transparent',
                color: 'var(--bg)',
                fontSize: 9,
                lineHeight: '11px',
                textAlign: 'center',
                flex: 'none',
                marginTop: 2,
              }}
            >
              {s.done ? '✓' : ''}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, color: s.done ? FAINT : INK, textDecoration: s.done ? 'line-through' : 'none' }}>
                {s.label}
              </span>
              {!s.done && <span style={{ display: 'block', fontSize: 11.5, color: FAINT, marginTop: 2, lineHeight: 1.5 }}>{s.hint}</span>}
            </span>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: FAINT, marginTop: 11, lineHeight: 1.55 }}>
        There is an assistant too — it can read this vault and answer in plain language. It is off
        until you turn it on, and nothing is sent until you ask a question.{' '}
        <button onClick={() => goTab('settings')} style={{ fontSize: 11.5, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          Settings → Assistant
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 8 }} />
    </section>
  )
}
