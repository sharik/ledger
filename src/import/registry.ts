import type { Detection, InstitutionAdapter, Peek, SourceFile } from './types'
import { revolutAdapter } from './adapters/revolut'
import { bnpAdapter } from './adapters/bnp'
import { privatAdapter } from './adapters/privat'
import { pumbAdapter } from './adapters/pumb'
import { monobankAdapter } from './adapters/monobank'
import { buildPeek } from './peek'

export const registry: InstitutionAdapter[] = [revolutAdapter, bnpAdapter, privatAdapter, pumbAdapter, monobankAdapter]

export function adapterById(id: string): InstitutionAdapter | undefined {
  return registry.find((a) => a.id === id)
}

export interface DetectResult {
  best: Detection | null
  ambiguous: boolean
  candidates: Detection[]
}

/**
 * Content-first detection dispatch (§3.2). Never guesses silently: an empty
 * result, a best confidence < 0.6, or two adapters within 0.1 all surface as
 * ambiguous so the caller asks the user which bank it is.
 */
export function detect(file: SourceFile, peek: Peek): DetectResult {
  const candidates: Detection[] = []
  for (const a of registry) {
    const d = a.detect(file, peek)
    if (d) candidates.push(d)
  }
  candidates.sort((x, y) => y.confidence - x.confidence)
  const best = candidates[0] ?? null
  const ambiguous =
    best === null ||
    best.confidence < 0.6 ||
    (candidates.length >= 2 && candidates[0]!.confidence - candidates[1]!.confidence < 0.1)
  return { best, ambiguous, candidates }
}

export async function detectFile(file: SourceFile): Promise<DetectResult> {
  const peek = await buildPeek(file)
  return detect(file, peek)
}
