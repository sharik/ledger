import { sha256 } from 'hash-wasm'
import type { NormalizedRow } from './types'

/**
 * Unescape OOXML `_xHHHH_` control-char escapes (Revolut xlsx string cells) to
 * the literal code point, so the byte enters the mojibake repair below.
 */
export function unescapeOOXML(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Repair UTF-8-decoded-as-Latin-1 mojibake (`CafÃ©` → `Café`). Only bytes < 256
 * are candidates; a string that isn't valid UTF-8 when re-read is left untouched,
 * which makes the operation idempotent (already-clean text round-trips to itself).
 */
export function repairMojibake(s: string): string {
  if (!s) return s
  for (const c of s) if (c.charCodeAt(0) > 0xff) return s // already has real Unicode → not mojibake
  try {
    const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return s
  }
}

/** Full descriptor repair used before display cleaning and before hashing (§5.7 / §7.2 step 1). */
export function repairText(s: string): string {
  return repairMojibake(unescapeOOXML(s))
}

/**
 * §7.2 — the descriptor identity basis. Deliberately conservative: repair, NFKC,
 * uppercase, collapse whitespace, and strip ONLY volatile decoration (the
 * `ECH/DDMMYY` due-date token, which the row date already restates). Everything
 * else (REF/…, MDT/…, merchant suffixes) stays — over-normalizing merges genuinely
 * distinct rows, and cross-file identity for ref-less rows is the occurrence index.
 */
export function normDesc(raw: string): string {
  let s = repairText(raw)
  s = s.normalize('NFKC').toUpperCase()
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/\bECH\/\d{6}\b/g, '').replace(/\s+/g, ' ').trim()
  return s
}

/**
 * SEPA creditor identifier (ICS) — exactly 13 chars: FR + 2 check + 9 (§10.2). The
 * best categorization key there is, and the only one that survives solely in the raw
 * descriptor, so both the adapter and the rule minter read it through here.
 */
export function creditorIdOf(raw: string): string | undefined {
  // Old BNP forms write `ID EMETTEUR/FR28…`; the newer xls export writes `EMETTEUR : FR28…`.
  // Accept either separator so the SEPA creditor id (the strongest rule key) survives both.
  return raw.match(/EMETTEUR\s*[/:]\s*([A-Z]{2}\d{2}[A-Z0-9]{9})/)?.[1]
}

const compositeKey = (r: NormalizedRow) =>
  `${r.bookedDate}|${r.amountMinor}|${r.currency}|${r.normDesc}`

/**
 * §7.3 occurrence index: rows sharing a composite key are numbered 0,1,2… in
 * source order. Legitimate same-second duplicates (Grab −0.17 ×2 ✓) survive as
 * distinct rows, yet still dedupe against an overlapping file because that file
 * lists the same group in the same source order.
 */
export function occurrenceIndexes(rows: NormalizedRow[]): number[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const k = compositeKey(r)
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n
  })
}

/**
 * §7.3 hash basis. `accountKey` is the account FINGERPRINT (device-independent),
 * never the UUID. Ref-based when the format supplies an end-to-end reference,
 * canonical-composite (with occurrence index) otherwise.
 */
export function hashBasis(r: NormalizedRow, accountKey: string, occurrenceIndex: number): string {
  return r.ref != null
    ? `r|${accountKey}|${r.ref}|${r.amountMinor}`
    : `c|${accountKey}|${r.bookedDate}|${r.amountMinor}|${r.currency}|${r.normDesc}|${occurrenceIndex}`
}

export async function sha256hex(s: string): Promise<string> {
  return sha256(s)
}

export async function fileHash(bytes: Uint8Array): Promise<string> {
  return sha256(bytes)
}

/** Compute the identity hash for every row (parallel array, input order). */
export async function hashRows(rows: NormalizedRow[], accountKey: string): Promise<string[]> {
  const occ = occurrenceIndexes(rows)
  return Promise.all(rows.map((r, i) => sha256hex(hashBasis(r, accountKey, occ[i]!))))
}
