import { unreviewedNotes } from '../model/selectors'
import { useRawVault, useStore } from './store'
import { useView } from './view'
import { BG, BRICK, HAIR, INK, MUT, fmt } from './theme'
import { hairBottom, italicNote, kicker, mono, phoneSheet, serif } from './styles'
import { useNarrow } from './responsive'

function fmtVal(v: unknown): string {
  if (typeof v === 'number') return fmt(v)
  if (v == null) return '—'
  return String(v)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const KIND_LINE: Record<string, string> = {
  'field-lww': 'Two values were saved — kept the newer one.',
  simultaneous: 'Two values were saved within seconds of each other.',
  'edit-delete': 'Edited on one device, deleted on another — the edit was kept.',
  'dup-snapshot': 'Two balances were saved for the same account and day — both kept, showing the later one.',
  'dup-import': 'The same import arrived from two devices — duplicates were removed.',
  'dup-budget': 'Two budgets were created for the same category — kept the newer one.',
  'txfr-ambiguous': 'A transfer had two possible matches — left as income until you pick one.',
  'stmt-gap': 'A statement period is missing — net worth uses the balance anchors; the gap’s transactions are absent.',
  'stmt-mismatch': 'Two statements’ balances disagree at their shared date — likely a statement missing between them.',
  'dup-account': 'The same account was imported on two devices — merged into one; edits were kept.',
}

export function SyncNotes() {
  const vault = useRawVault() // a conflict entry can reference a hidden account's records
  const store = useStore()
  const view = useView()
  const notes = unreviewedNotes(vault)
  const narrow = useNarrow()

  if (!view.notesOpen) return null

  return (
    <>
      <div
        onClick={() => view.setNotesOpen(false)}
        style={{ position: 'fixed', inset: 0, zIndex: 20, background: narrow ? 'rgba(10,9,7,.34)' : undefined }}
      />
      <div
        data-testid="sync-notes-panel"
        style={{
          position: 'fixed',
          top: 58,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '90vw',
          zIndex: 21,
          background: BG,
          borderLeft: `1px solid ${INK}`,
          boxShadow: '-18px 0 44px rgba(25,23,19,.12)',
          padding: '20px 22px',
          overflowY: 'auto',
          animation: 'sheetIn .18s ease',
          ...phoneSheet(narrow),
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={serif(19)}>Sync notes</div>
          <button
            className="hov-ink"
            data-testid="close-notes"
            onClick={() => view.setNotesOpen(false)}
            style={{
              width: 28,
              height: 28,
              borderRadius: 2,
              border: `1px solid ${HAIR}`,
              background: 'transparent',
              color: MUT,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>
          Where two devices disagreed, the merge kept a defensible answer. Nothing was lost — review at your leisure.
        </div>

        {notes.length === 0 && <div style={{ ...italicNote, marginTop: 22 }}>All clear — no notes to review.</div>}

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          {notes.map((n) => (
            <div key={n.id} style={{ padding: '14px 0', ...hairBottom }} data-testid={`note-${n.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{n.recordLabel}</div>
                <div style={{ ...kicker, fontSize: 9 }}>{n.field ?? n.kind}</div>
              </div>
              <div style={{ fontSize: 11.5, color: MUT, marginTop: 4 }}>{KIND_LINE[n.kind] ?? ''}</div>
              {n.field && (
                <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ ...mono(12.5), fontWeight: 600 }}>{fmtVal(n.keptValue)}</div>
                    <div style={{ ...mono(9), color: MUT, marginTop: 3 }}>
                      KEPT · {n.keptFrom === 'local' ? 'this device' : 'other device'}, {fmtTime(n.keptAt)}
                    </div>
                  </div>
                  <div>
                    <div style={{ ...mono(12.5), fontWeight: 600, color: BRICK }}>{fmtVal(n.discardedValue)}</div>
                    <div style={{ ...mono(9), color: MUT, marginTop: 3 }}>
                      {n.keptFrom === 'local' ? 'other device' : 'this device'}, {fmtTime(n.discardedAt)}
                    </div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                {n.field && (
                  <button
                    className="hov-ink"
                    data-testid="use-other"
                    onClick={() =>
                      store.commit(
                        { kind: 'useOtherValue', noteId: n.id },
                        { msg: `${n.recordLabel} — switched to ${fmtVal(n.discardedValue)}`, undoable: true },
                      )
                    }
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 2,
                      border: `1px solid ${INK}`,
                      background: 'transparent',
                      color: INK,
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Use other value
                  </button>
                )}
                <button
                  className="hov-ink"
                  data-testid="dismiss-note"
                  onClick={() => store.commit({ kind: 'markNoteReviewed', noteId: n.id })}
                  style={{
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 2,
                    border: `1px solid ${HAIR}`,
                    background: 'transparent',
                    color: MUT,
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
