// Thin postMessage shell (IMPORT §11, Convention #11). All logic lives in the pure
// pipeline; this file only marshals bytes in and a plan/refusal out, so the parse
// (xlsx/pdf.js) runs off the main thread. Exercised by the app in Phase C; the
// Vitest suites call the pure functions directly.
import type { Vault } from '../model/types'
import { toSourceFile } from './peek'
import { buildImportPlan, type ImportChoices } from './pipeline'

interface PlanRequest {
  id: number
  cmd: 'plan'
  name: string
  bytes: ArrayBuffer
  vault: Vault
  choices?: ImportChoices
}

const ctx = self as unknown as { onmessage: ((e: { data: PlanRequest }) => void) | null; postMessage: (m: unknown) => void }

ctx.onmessage = async (e) => {
  const { id, name, bytes, vault, choices } = e.data
  try {
    const file = toSourceFile(name, new Uint8Array(bytes))
    const result = await buildImportPlan(file, vault, choices)
    ctx.postMessage({ id, ok: true, result })
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String(err) })
  }
}
