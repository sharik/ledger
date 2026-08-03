import type { Vault } from '../../model/types'
import { buildImportPlan, type ImportChoices } from '../pipeline'
import { toSourceFile } from '../peek'
import type { ImportPlan, Refusal, SourceFile } from '../types'

/**
 * Main-thread plan builder. The pure pipeline (§2) is async already; parsing
 * (xlsx / pdf.js) runs here. `worker.ts` is the off-main-thread shell for a later
 * pass — behavior is identical, so the UI and E2E drive this directly.
 */
export async function planImport(file: SourceFile, vault: Vault, choices?: ImportChoices): Promise<ImportPlan | Refusal> {
  return buildImportPlan(file, vault, choices)
}

export function fileFromBrowser(name: string, bytes: Uint8Array): SourceFile {
  return toSourceFile(name, bytes)
}
