import { INK, MUT } from './theme'
import { MonoLabel } from './kit'

/** Phase A stub for a not-yet-built screen. Real screens land in Phase C/D. */
export function Placeholder({ title, phase, note }: { title: string; phase: string; note: string }) {
  return (
    <div data-screen="placeholder" data-placeholder={title} style={{ paddingTop: 8 }}>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: INK }}>{title}</div>
      <div style={{ marginTop: 14 }}>
        <MonoLabel>{phase}</MonoLabel>
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: MUT, maxWidth: 460, lineHeight: 1.5 }}>{note}</div>
    </div>
  )
}
