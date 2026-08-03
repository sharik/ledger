import { repairText } from './identity'

// Operation boilerplate that never helps a search: BNP/CB card verbs and SEPA
// tags. Removed as whole words so a real merchant token beside them survives.
const BOILERPLATE =
  /\b(PAIEMENT|FACTURES?|CARTE|CB|DU|TX|VALIDATION|PRLV|PRELEVEMENT|SEPA|VIREMENT|VIR|RETRAIT|REMBOURST|COMMISSIONS?|MOTIF|BEN|ECH)\b/gi

// PUMB states the operation type in Ukrainian and it reaches `raw` (`… · Покупка · 5355…`), so
// without this every lookup would carry the bank's verb instead of the merchant.
const BOILERPLATE_UK = /(ПОКУПКА|ПОВЕРНЕННЯ|КОШТІВ|ПЕРЕКАЗ|ЗАРАХУВАННЯ|ПОПОВНЕННЯ|КОМІСІ\w*|ЗНЯТТЯ|ВИДАЧА|ГОТІВКИ)/gi

/**
 * A human-searchable query for a transaction: whatever recognisable name/location
 * is left in the raw descriptor once the noise a search engine can't use is
 * stripped — IBAN/RIB, creditor ids, refs, card-number tails, amounts, opaque
 * reference tokens and card-operation boilerplate. Built from the raw descriptor
 * (a superset of the display merchant); the merchant is used only when there is
 * no raw. Returns '' when nothing searchable remains (e.g. a card-validation
 * pre-authorisation), so the caller can hide the lookup links.
 */
export function lookupQuery(merchant: string, raw?: string): string {
  const src = (raw ?? merchant).trim()
  if (!src) return ''
  const s = repairText(src)
    .replace(/EMETTEUR\/[A-Z0-9]+/gi, '') // SEPA creditor id (creditorIdOf)
    .replace(/\b(REF|MDT|RUM|ID\s*EMETTEUR|ICS)[:/]?\s*\S+/gi, '')
    .replace(/\bECH\/\d{6}\b/gi, '') // due-date token (normDesc)
    .replace(/\bCARTE\s*\d+X+\d+\S*/gi, '') // masked card no. (bnp.ts)
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '') // IBAN / RIB
    .replace(/\b\d+[.,]\d{2}\s?[A-Z]{3}\b/g, '') // trailing amount + currency (41,98EUR)
    .replace(/\d{6,}/g, '') // long digit runs (redactDescriptor)
    // Opaque reference tokens — a run mixing letters and digits (e.g. a card-auth
    // ref KUUVD1WIOVHK). A rare embedded-digit brand (7ELEVEN) can be caught too,
    // but such names almost always carry more context; refs are the common case.
    .replace(/\b(?=[A-Za-z\d]*[A-Za-z])(?=[A-Za-z\d]*\d)[A-Za-z\d]{6,}\b/g, '')
    .replace(BOILERPLATE, ' ')
    .replace(BOILERPLATE_UK, ' ')
    .replace(/[/*()·]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 2) return '' // nothing searchable left
  return s.slice(0, 90).trim()
}
