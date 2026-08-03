import type { DateStr } from '../../model/types'
import type { InstitutionAdapter, NormalizedRow, ParsedRow, ParsedStatement, Peek, SourceFile } from '../types'
import { extractPdf, reconstructLines, type PdfPage, type TextItem, type VisualLine } from '../pdf'
import { creditorIdOf, repairText } from '../identity'

const MONTHS_FR: Record<string, number> = {
  janvier: 1, fevrier: 2, 'février': 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, 'août': 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, 'décembre': 12,
}

// Column bands (A4 pt, measured on the real files ✓, §6.2).
const band = (x: number): 'date' | 'label' | 'valeur' | 'amount' | 'margin' => {
  if (x >= 24 && x < 60) return 'date'
  if (x >= 60 && x < 300) return 'label'
  if (x >= 300 && x < 346) return 'valeur'
  if (x >= 346) return 'amount'
  return 'margin'
}

const despace = (s: string) => s.replace(/[\s  ]/g, '')

/** fr-FR amount → signed minor units (§6.4). `neg` applies the débit sign. */
function lexAmountMinor(text: string, neg: boolean): number | null {
  const m = text.match(/(\d[\d   ]*),(\d{2})/)
  if (!m) return null
  const whole = m[1]!.replace(/[\s  ]/g, '')
  const minor = Number(whole) * 100 + Number(m[2])
  if (Number.isNaN(minor)) return null
  return neg ? -minor : minor
}

function amountBandItems(line: VisualLine): { text: string; rightEdge: number } | null {
  const items = line.items.filter((it) => band(it.x) === 'amount' && it.str.trim())
  if (items.length === 0) return null
  const sorted = [...items].sort((a, b) => a.x - b.x)
  return {
    text: sorted.map((it) => it.str).join(''),
    rightEdge: Math.max(...items.map((it) => it.x + it.w)),
  }
}

function labelText(line: VisualLine): string {
  const items = line.items.filter((it) => band(it.x) === 'label' && it.str.trim())
  if (items.length === 0) return ''
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let text = ''
  let prev: number | null = null
  for (const it of sorted) {
    if (prev !== null && it.x - prev > 0.25 * it.fontSize && !text.endsWith(' ')) text += ' '
    text += it.str
    prev = it.x + it.w
  }
  return text.replace(/\s+/g, ' ').trim()
}

function dateBandHit(line: VisualLine): string | null {
  const it = line.items.find((i) => band(i.x) === 'date' && /^\d{2}\.\d{2}$/.test(i.str.trim()))
  return it ? it.str.trim() : null
}

function valeurHit(line: VisualLine): string | null {
  const it = line.items.find((i) => band(i.x) === 'valeur' && /^\d{2}\.\d{2}$/.test(i.str.trim()))
  return it ? it.str.trim() : null
}

// The holder's address block sits above the table: a postcode+town line, then a bare town line
// (the statement repeats the town alone). Matched by shape, not by a list of towns.
const ADDRESS_LINE = String.raw`^\d{5}\s+[A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]{2,}$|^[A-ZÀ-Ÿ][A-ZÀ-Ÿ' -]{3,}\s+CEDEX\b`

const BOILERPLATE = new RegExp(
  String.raw`RELEVE DE COMPTE|^du \d{1,2} [a-zà-ÿ]{3,}|OU MME|OU MR| OU |^RIB|^IBAN|^BIC|Monnaie du compte|Nature des op|^Date |TOTAL DES|BNP PARIBAS SA|Commissions sur services|Montant de votre|^Rappel|mabanque|garantie des|Tél\.|Service Client|^P\. \d|${ADDRESS_LINE}|^\d{6,}$|surtaxé`,
  'i',
)

function isBoilerplate(text: string): boolean {
  return BOILERPLATE.test(text) || despace(text).length < 2
}

function addDays(date: DateStr, days: number): DateStr {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Statement header → product. `RELEVE DE COMPTE` is the compte chèques and carries no product
 * suffix; a passbook prints its own header (`RELEVE DE LIVRET A`) and is a SEPARATE account —
 * same bank/branch/holder, different account number, so it must never merge into the current
 * one (§5.8). Detection and naming read this one table, so any header we accept is also a
 * header we can name — a product we can't name stays unrecognized rather than importing as a
 * nameless second "current account". Most specific first.
 */
const HEADERS: { re: RegExp; product?: string }[] = [
  { re: /RELEVE\s+DE\s+LIVRET\s+A\b/i, product: 'Livret A' },
  { re: /RELEVE\s+DE\s+COMPTE/i },
]

function matchHeader(text: string): { product?: string } | undefined {
  return HEADERS.find((h) => h.re.test(text))
}

interface Header {
  fingerprint: string | null
  holderNames: string[]
  joint: boolean
  currency: string
  periodFrom: DateStr
  periodTo: DateStr
  productName?: string
}

function parseHeader(lines: VisualLine[]): Header {
  const joined = lines.map((l) => l.text)
  const flat = joined.join('\n')
  const flatDespaced = joined.map(despace).join('\n')

  let fingerprint: string | null = null
  for (const l of joined) {
    const m = l.match(/RIB\s*:?\s*([\d ]{20,})/)
    if (m) {
      const digits = m[1]!.replace(/\D/g, '')
      if (digits.length >= 23) {
        fingerprint = `bnp:${digits.slice(0, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 21)}-${digits.slice(21, 23)}`
        break
      }
    }
  }

  // Period: "du 13 mai 2026 au 13 juin 2026"
  let periodFrom = ''
  let periodTo = ''
  const pm = flat.match(/du\s+(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})\s+au\s+(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})/i)
  if (pm) {
    const mf = MONTHS_FR[pm[2]!.toLowerCase()] ?? 1
    const mt = MONTHS_FR[pm[5]!.toLowerCase()] ?? 1
    periodFrom = `${pm[3]}-${String(mf).padStart(2, '0')}-${pm[1]!.padStart(2, '0')}`
    periodTo = `${pm[6]}-${String(mt).padStart(2, '0')}-${pm[4]!.padStart(2, '0')}`
  }

  const joint = / OU /.test(flat)
  const holderNames: string[] = []
  // Titled holder line: "MR DURAND OU MME MARTIN" (may share a visual line with the RIB).
  const titled = flat.match(/\b(?:MR|MME|MLE|M)\s+([A-ZÀ-Ÿ]{3,})(?:\s+OU\s+(?:MR|MME|MLE|M)\s+([A-ZÀ-Ÿ]{3,}))?/)
  if (titled) {
    holderNames.push(titled[1]!)
    if (titled[2]) holderNames.push(titled[2])
  }
  if (holderNames.length === 0) {
    const bare = joined.find((l) => /[A-ZÀ-Ÿ]{4,}\s+[A-ZÀ-Ÿ]{4,}/.test(l) && !/RELEVE|COMPTE|OPERATIONS|SERVICE|GARANTIE|PARIBAS/.test(l))
    const m = bare?.match(/([A-ZÀ-Ÿ]{4,})\s+([A-ZÀ-Ÿ]{4,})/)
    if (m) holderNames.push(`${m[1]} ${m[2]}`)
  }

  const curM = flatDespaced.match(/MONNAIEDUCOMPTE:?\s*([A-Z]{3,4})/i)
  const rawCur = curM?.[1]?.toUpperCase()
  const currency = !rawCur || rawCur === 'EURO' ? 'EUR' : rawCur.slice(0, 3)
  return { fingerprint, holderNames, joint, currency, periodFrom, periodTo, productName: matchHeader(flat)?.product }
}

interface BnpRow {
  bookedDate: DateStr
  valueDate?: DateStr
  amountMinor: number
  label: string
  sourceLine: number
}

function inferYear(dd: string, mm: string, h: Header): number {
  const fromY = Number(h.periodFrom.slice(0, 4))
  const toY = Number(h.periodTo.slice(0, 4))
  const lowBound = addDays(h.periodFrom, -31)
  const cands = fromY === toY ? [fromY] : [fromY, toY]
  for (const y of cands) {
    const ds = `${y}-${mm}-${dd}`
    if (ds >= lowBound && ds <= h.periodTo) return y
  }
  return fromY
}

export const bnpAdapter: InstitutionAdapter = {
  id: 'bnp',
  displayName: 'BNP Paribas',

  detect(file: SourceFile, peek: Peek) {
    if (file.container === 'pdf') {
      const text = peek.firstPageText ?? ''
      if (matchHeader(text) && (/BNP\s?PARIBAS/i.test(text) || /BNPAFRPP/i.test(text))) {
        return { institution: 'bnp', variant: 'pdf', confidence: 0.95, hints: { locale: 'fr' } }
      }
      return null
    }
    if (file.container === 'xlsx') {
      // mabanque "download transactions" export: a preamble line (`Compte … ****4242` /
      // `Solde au …`) plus the French column header. Revolut's detector needs
      // type/amount/currency/state/balance headers, so only one adapter ever matches (§3.2).
      const rows = peek.sheetRows ?? []
      const flat = rows.map((r) => r.join(' ')).join('\n')
      const preamble = /Compte .*\*{2,}\s*\d{3,}/i.test(flat) || /Solde\s+au\s/i.test(flat)
      const cols = rows.some((r) => {
        const norm = r.map((c) => c.trim().toLowerCase())
        return norm.some((c) => /^date\s*op[ée]ration$/.test(c)) && norm.some((c) => /libell[ée]/.test(c)) && norm.some((c) => /^montant/.test(c))
      })
      if (preamble && cols) return { institution: 'bnp', variant: 'xls', confidence: 0.95, hints: { locale: 'fr' } }
    }
    return null
  },

  async parse(file: SourceFile, variant?: string): Promise<ParsedStatement> {
    if (variant === 'xls' || file.container === 'xlsx') return parseXls(file)
    return parsePdf(file)
  },

  normalize(stmt: ParsedStatement): NormalizedRow[] {
    return (stmt.rows as unknown as BnpRow[]).map((r) => extractRow(r, stmt.accountCurrency || 'EUR'))
  },
}

async function parsePdf(file: SourceFile): Promise<ParsedStatement> {
    const pages = await extractPdf(file.bytes)
    const allLines: VisualLine[] = []
    for (const page of pages as PdfPage[]) allLines.push(...reconstructLines(page))

    const header = parseHeader(allLines)

    // Locate SOLDE (opening/closing) and TOTAL lines.
    let opening: number | undefined
    let closing: number | undefined
    let openingIdx = -1
    let closingIdx = allLines.length
    let printedTotals: { debitMinor: number; creditMinor: number } | undefined
    allLines.forEach((line, i) => {
      const flat = despace(line.text)
      const solde = flat.match(/SOLDE(CREDITEUR|DEBITEUR)AU(\d{2})\.(\d{2})\.(\d{4})/)
      if (solde) {
        const amt = amountBandItems(line)
        const minor = amt ? lexAmountMinor(amt.text, solde[1] === 'DEBITEUR') : null
        const val = minor === null ? undefined : minor / 100
        if (openingIdx < 0) {
          opening = val
          openingIdx = i
        } else {
          closing = val
          closingIdx = i
        }
        return
      }
      if (/TOTALDESOPERATIONS/.test(flat)) {
        const items = line.items.filter((it) => band(it.x) === 'amount' && it.str.trim()).sort((a, b) => a.x - b.x)
        // two right-aligned totals: debit (right edge ≤460), credit (>460)
        const groups: { text: string; rightEdge: number }[] = []
        let cur: TextItem[] = []
        for (let k = 0; k < items.length; k++) {
          cur.push(items[k]!)
          const next = items[k + 1]
          if (!next || next.x - (items[k]!.x + items[k]!.w) > 20) {
            groups.push({ text: cur.map((c) => c.str).join(''), rightEdge: Math.max(...cur.map((c) => c.x + c.w)) })
            cur = []
          }
        }
        let debitMinor = 0
        let creditMinor = 0
        for (const g of groups) {
          const v = lexAmountMinor(g.text, false)
          if (v === null) continue
          if (g.rightEdge <= 460) debitMinor = v
          else creditMinor = v
        }
        printedTotals = { debitMinor, creditMinor }
      }
    })

    // Walk the transaction region between opening and closing SOLDE.
    const rows: BnpRow[] = []
    const unparsed: string[] = []
    let current: { bookedDate: DateStr; valueDate?: DateStr; amountMinor: number; parts: string[]; line: number } | null = null
    const flush = () => {
      if (current) {
        rows.push({
          bookedDate: current.bookedDate,
          valueDate: current.valueDate,
          amountMinor: current.amountMinor,
          label: current.parts.join(' ').replace(/\s+/g, ' ').trim(),
          sourceLine: rows.length,
        })
        current = null
      }
    }
    for (let i = openingIdx + 1; i < closingIdx; i++) {
      const line = allLines[i]!
      const dd = dateBandHit(line)
      if (dd) {
        flush()
        const [d, m] = dd.split('.') as [string, string]
        const year = inferYear(d, m, header)
        const amt = amountBandItems(line)
        if (!amt) {
          unparsed.push(line.text)
          continue
        }
        const amountMinor = lexAmountMinor(amt.text, amt.rightEdge <= 460)
        if (amountMinor === null) {
          unparsed.push(line.text)
          continue
        }
        let valueDate: DateStr | undefined
        const vv = valeurHit(line)
        if (vv) {
          const [vd, vm] = vv.split('.') as [string, string]
          valueDate = `${inferYear(vd, vm, header)}-${vm}-${vd}`
        }
        current = { bookedDate: `${year}-${m}-${d}`, valueDate, amountMinor, parts: [labelText(line)].filter(Boolean), line: i }
      } else {
        // continuation, unless boilerplate / margin line
        if (!current) continue
        if (isBoilerplate(line.text)) continue
        const first = [...line.items].sort((a, b) => a.x - b.x).find((it) => it.str.trim())
        if (first && band(first.x) !== 'label') continue
        const lbl = labelText(line)
        if (lbl) current.parts.push(lbl)
      }
    }
    flush()

    const parsedRows: ParsedRow[] = rows as unknown as ParsedRow[]
    return {
      institution: 'bnp',
      variant: 'pdf',
      locale: 'fr',
      fingerprint: header.fingerprint,
      // Last-4 of the account number (the RIB's account segment) — a match signal both variants
      // share; the XLS export can only ever offer this much (§5.8).
      accountMask: header.fingerprint?.split('-')[2]?.slice(-4),
      productName: header.productName,
      holderNames: header.holderNames,
      accountCurrency: header.currency,
      periodFrom: header.periodFrom,
      periodTo: header.periodTo,
      openingBalance: opening,
      closingBalance: closing,
      printedTotals,
      rows: parsedRows,
      skipped: { pending: 0, reverted: 0, unparsed },
    }
}

/**
 * mabanque "download transactions" .xls (§6.8). Row 0 is a preamble (account mask, current
 * Solde + its date, currency); the column header is a few rows down. The file lists rows
 * newest-first with no opening balance or printed totals — only the one Solde, which becomes a
 * balance anchor (no reconciliation gate; the acceptance check is parse sanity). Rows are
 * reversed to chronological so the occurrence index aligns with the PDF's statement-line order.
 */
async function parseXls(file: SourceFile): Promise<ParsedStatement> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(file.bytes, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]!
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: true })

  // Header row by label dictionary (§5.9-style binding), then bind columns positionally.
  const isHeader = (row: unknown[] | undefined) => {
    const cells = (row ?? []).map((c) => String(c ?? '').trim().toLowerCase())
    return cells.some((c) => /^date\s*op[ée]ration$/.test(c)) && cells.some((c) => /libell[ée]/.test(c)) && cells.some((c) => /^montant/.test(c))
  }
  const hdrIdx = matrix.findIndex(isHeader)
  const hdr = (matrix[hdrIdx] ?? []).map((c) => String(c ?? '').trim().toLowerCase())
  const col = (re: RegExp) => hdr.findIndex((c) => re.test(c))
  const cDate = col(/^date/)
  const cLib = col(/libell[ée]/)
  const cAmt = col(/^montant/)
  const headerWarning = hdrIdx < 0 || cDate < 0 || cLib < 0 || cAmt < 0

  // Preamble (row 0): account mask (last-4), current Solde + its date, currency.
  const preamble = (matrix[0] ?? []).map((c) => String(c ?? ''))
  // The account cell prints either a masked tail (`Compte de chèques ****2101`, 2026 export) or
  // the number in full (`Compte de chèques 00001402101`, 2023 export). Both end in the same
  // digits, so key on the trailing run — matching only `****` left the older export with no mask
  // and no fingerprint at all, so it could not be offered the account its own newer export made.
  const accountMask = preamble.find((c) => /compte/i.test(c))?.match(/(\d{3,})\s*$/)?.[1]?.slice(-4)
  const soldeDate = preamble.find((c) => /solde\s+au/i.test(c))?.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  const soldeAmt = (matrix[0] ?? []).find((c): c is number => typeof c === 'number')
  const currency = (preamble.find((c) => /^[A-Z]{3}$/.test(c.trim())) ?? 'EUR').trim().toUpperCase()
  const soldeIso = soldeDate ? (`${soldeDate[3]}-${soldeDate[2]}-${soldeDate[1]}` as DateStr) : undefined

  const toIso = (s: string): DateStr | null => {
    const m = s.trim().match(/^(\d{2})-(\d{2})-(\d{4})$/)
    return m ? (`${m[3]}-${m[2]}-${m[1]}` as DateStr) : null
  }

  const start = hdrIdx >= 0 ? hdrIdx + 1 : 1
  const rows: BnpRow[] = []
  const unparsed: string[] = []
  for (const row of matrix.slice(start)) {
    if (!row || String(row[cDate] ?? '').trim() === '') continue
    const iso = toIso(String(row[cDate] ?? ''))
    const amt = row[cAmt]
    const label = String(row[cLib] ?? '')
    if (!iso || typeof amt !== 'number') {
      unparsed.push(label || String(row[cDate] ?? ''))
      continue
    }
    rows.push({ bookedDate: iso, amountMinor: Math.round(amt * 100), label, sourceLine: 0 })
  }
  rows.reverse()
  rows.forEach((r, i) => (r.sourceLine = i))

  const periodFrom = rows[0]?.bookedDate ?? soldeIso ?? ''
  const periodTo = soldeIso ?? rows[rows.length - 1]?.bookedDate ?? periodFrom

  return {
    institution: 'bnp',
    variant: 'xls',
    locale: 'fr',
    // The export carries no RIB — only the masked tail. Key an XLS-first account by its last-4
    // (`bnp:mask:4242`); the `mask:` prefix marks it as a signal, not a proven RIB (§5.8).
    fingerprint: accountMask ? `bnp:mask:${accountMask}` : null,
    accountMask,
    accountCurrency: currency,
    periodFrom,
    periodTo,
    openingBalance: undefined,
    closingBalance: typeof soldeAmt === 'number' ? soldeAmt : undefined,
    rows: rows as unknown as ParsedRow[],
    skipped: { pending: 0, reverted: 0, unparsed },
    headerWarning: headerWarning || undefined,
  }
}

const CARD_TOKEN = /CARTE\d{4}X+\d{4}/g

/**
 * Variant-independent BNP descriptor (§7.2, BNP flavor). The PDF loses spaces
 * unpredictably and abbreviates operation names (`FACTURE(S) CARTE … DU`, `PRLV SEPA`),
 * while the mabanque XLS spells them out (`PAIEMENT CB DU`, `PRELEVEMENT`). Despace, then
 * fold the two vocabularies to one so the *same* transaction hashes identically from either
 * file: card→`CBDU{date}`, direct-debit→`PRLV`, transfer-in→`VIRRECU`, transfer-out→`VIREMIS`.
 * REF/MDT/merchant tails stay — the occurrence index protects genuine same-day duplicates.
 */
export function bnpNormDesc(raw: string): string {
  let s = bnpNormDescLegacy(raw)
  // Cash withdrawal. The two variants name the operation differently and nothing else: measured on
  // the real files, `RETRAIT DISTRIBUTEUR 01/02/26 VPBANK HO CHI M … 5000000VND + COMMISSION : 7,70EUR`
  // (xls) and `RETRAIT DAB 01/02/26 VPBANKHO CHIM …` (pdf) despace to the SAME string once the verb
  // is folded — the ATM name, country and amount tail already agree. Folding the verb alone is enough,
  // and keeps the ATM location in the basis so two withdrawals on one day at different machines stay
  // distinguishable.
  s = s.replace(/^RETRAIT(?:AUDISTRIBUTEUR|DISTRIBUTEUR|DAB)(?=\d)/, 'RETRAIT')
  return s
}

/**
 * The canon as it stood before the RETRAIT fold — frozen, and not to be changed again.
 *
 * Rows committed by an earlier build carry a hash derived from THIS function. Ring-1 recomputes every
 * incoming row under both, so a statement re-imported after the fold still recognises its own rows
 * rather than adding a second copy (IMPORT §8.1). Removable only once no vault can hold pre-fold rows.
 */
export function bnpNormDescLegacy(raw: string): string {
  let s = repairText(raw).normalize('NFKC').toUpperCase().replace(/[\s  ]/g, '')
  s = s.replace(CARD_TOKEN, '') // card number — different position per variant
  s = s.replace(/ECH\/\d{6}/g, '') // due date, restated by the row date
  s = s.replace(/^\*+/, '') // PDF footnote marker on COMMISSIONS
  s = s.replace(/^(?:FACTURE\(S\)|PAIEMENTCB|REMBOURSTCB)(?=DU\d{6})/, '')
  s = s.replace(/^DU(\d{6})/, 'CBDU$1')
  s = s.replace(/^(?:PRLVSEPA|PRELEVEMENT)/, 'PRLV')
  s = s.replace(/^(?:VIRCPTEACPTERECU|VIRSEPAINSTANTRECU|VIRSEPARECU|VIREMENTINSTANTANERECU|VIREMENT)(?=\/DE)/, 'VIRRECU')
  s = s.replace(/^(?:VIREMENTSEPAEMIS|VIREMENT)(?=\/MOTIF)/, 'VIREMIS')
  return s
}

/**
 * SEPA end-to-end reference off the canonical descriptor (§7.3). `REF/xxx` (direct debit,
 * bounded so a run-on `LIB/` can't bleed in — the PDF despacing yields `LOT3763479402LIB`
 * where the XLS has `LOT3763479402`; they must match) · `/REFxxx` (instant transfer UUID).
 */
export function bnpRefOf(canon: string): string | undefined {
  const dd = canon.match(/REF\/([A-Z0-9-]+?)(?=LIB\/|MDT\/|$)/)
  if (dd && dd[1]!.length >= 4) return dd[1]
  return canon.match(/\/REF([A-Z0-9]{6,})/)?.[1]
}

function extractRow(r: BnpRow, accountCurrency: string): NormalizedRow {
  const label = r.label
  const canon = bnpNormDesc(label)
  const legacyCanon = bnpNormDescLegacy(label)
  let kind: NormalizedRow['kind'] = 'other'
  let merchant = label
  let counterparty: string | undefined
  let original: { amount: number; currency: string } | undefined
  let feeMinor: number | undefined

  const creditorId = creditorIdOf(label)
  const ref = bnpRefOf(canon)

  // `/DE …` and `/BEN …` capture up to the next slash-tag, tolerant of missing spaces.
  const afterTag = (tag: string) => {
    const m = label.match(new RegExp(`/${tag}\\s*([A-Za-zÀ-ÿ][^/]*?)(?:\\s*/|$)`, 'i'))
    return m?.[1]?.replace(/\s+/g, ' ').trim() || undefined
  }

  // Card forms: PDF `FACTURE(S) CARTE … DU {DDMMYY} {MERCHANT}` / bare `DU …`; XLS `PAIEMENT CB DU …`.
  const card = label.match(/FACTURE\(S\)\s*CARTE\s*(\S+)\s*DU\s*(\d{6})\s*(.+)/i)
  const paiementCb = label.match(/^PAIEMENT\s*CB\s*DU\s*(\d{6})\s*(.+)/i)
  const rembourst = label.match(/^REMBOURST\s*CB\s*DU\s*(\d{6})\s*(.+)/i)
  const bareCard = label.match(/^DU\s*(\d{6})\s*(.+)/i)
  const fx = despace(label).match(/([A-Z]{3})(\d+),(\d{2})([A-Z]{3})\+COMMISSION:?(\d+),(\d{2})/i)

  // Newer BNP xls dialect (e.g. 2026 `export_*.xls`): the merchant/creditor/counterparty
  // precedes a *slashed* `DU DD/MM[/YY]` date, with verbose keywords. The 2023-era export writes
  // the same forms without the year (`DU 23/04`), so it is optional — requiring it left every
  // card and prélèvement row of that vintage with the raw label as its merchant. These still
  // anchor on the SLASHED date, so they never collide with the old forms above (which anchor on
  // an unslashed `DU {6 digits}` and abbreviations like REMBOURST / VIR SEPA RECU).
  const cbNew = label.match(/^(PAIEMENT|REMBOURSEMENT)\s+CB\s+(.+?)\s+DU\s+\d{2}\/\d{2}(?:\/\d{2})?/i)
  // 2026 writes `VIREMENT [INSTANTANE] EMIS VERS {beneficiary}`; 2023 drops `EMIS`. `VERS` must
  // still follow the verb directly, so `VIREMENT INTERNE … VIREMENT VERS …` stays internal.
  const virEmisNew = label.match(/^VIREMENT(?:\s+INSTANTANE)?(?:\s+EMIS)?\s+VERS\s+(.+?)(?:\s*-\s*MOTIF|\s{2,}MOTIF|$)/i)
  const virRecuNew = label.match(/^VIREMENT(?:\s+INSTANTANE)?(?:\s+RECU)?\s+DE\s+(.+?)(?:\s{2,}MOTIF|\s+MOTIF|\s*-\s*REF|$)/i)

  // Transfer-out before transfer-in: an emitted wire (PDF `VIREMENT SEPA EMIS`, XLS
  // `VIREMENT /MOTIF …/BEN`) carries `/BEN` and no `/DE`; the received forms carry `/DE` (§6.5).
  const hasDe = /\/DE\b/i.test(label) || /\/DE[A-ZÀ-Ÿ]/i.test(label)
  if ((/VIREMENT\s?SEPA\s?EMIS/i.test(label) || /VIREMENT/i.test(label)) && /\/BEN/i.test(label) && !hasDe) {
    kind = 'transfer-out'
    counterparty = afterTag('BEN') // never the motif (§6.5)
    merchant = counterparty ?? 'Virement émis'
  } else if (/VIR\s?(SEPA(\s?INSTANT)?|CPTE\s?A\s?CPTE)\s?RECU/i.test(label) || (/VIREMENT/i.test(label) && hasDe)) {
    kind = 'transfer-in'
    counterparty = afterTag('DE')
    merchant = counterparty ?? 'Virement reçu'
  } else if (virEmisNew) {
    // Newer xls: `VIREMENT [INSTANTANE] EMIS VERS {beneficiary} - MOTIF …`
    kind = 'transfer-out'
    counterparty = virEmisNew[1]!.replace(/\s+/g, ' ').trim()
    merchant = counterparty || 'Virement émis'
  } else if (virRecuNew) {
    // Newer xls: `VIREMENT DE {sender} MOTIF…` / `VIREMENT INSTANTANE RECU DE {sender} MOTIF…`
    kind = 'transfer-in'
    counterparty = virRecuNew[1]!.replace(/\s+/g, ' ').trim()
    merchant = counterparty || 'Virement reçu'
  } else if (/^VIREMENT\s+INTERNE/i.test(label)) {
    // Newer xls: a move between the holder's own accounts — direction from the amount sign.
    kind = r.amountMinor < 0 ? 'transfer-out' : 'transfer-in'
    merchant = 'Virement interne'
  } else if (/PRLV\s?SEPA|PRELEVEMENT/i.test(label)) {
    kind = 'expense'
    // Stop at the old `ECH/` / `ID EMETTEUR` tokens OR the slashed `DU DD/MM[/YY]`. The 2023
    // export writes a bare `- EMETTEUR :` (no `ID`) and no year, so the date is what stops it.
    const cp = label.match(/(?:PRLV\s?SEPA|PRELEVEMENT)\s+(.+?)\s+(?:ECH\/|ID\s*EMETTEUR|DU\s+\d{2}\/\d{2}(?:\/\d{2})?)/i)
    counterparty = cp?.[1]?.replace(/\s+/g, ' ').trim()
    merchant = counterparty ?? label
  } else if (/COMMISSIONS/i.test(label) || /^FRAIS\b/i.test(label)) {
    kind = 'fee'
    counterparty = 'BNP Paribas'
    merchant = 'Frais bancaires'
  } else if (rembourst) {
    kind = 'refund'
    merchant = rembourst[2]!.trim()
  } else if (cbNew) {
    // Newer xls card/refund: `PAIEMENT|REMBOURSEMENT CB {merchant} [(COUNTRY)|A {place}] DU DD/MM/YY …`.
    // The capture excludes everything from `DU` onward; strip a trailing `(COUNTRY)` / `A (COUNTRY)`.
    kind = /^REMBOURSEMENT/i.test(cbNew[1]!) ? 'refund' : 'expense'
    const m = cbNew[2]!.replace(/\s+A?\s*\([A-Za-zÀ-ÿ' .\-]+\)\s*$/, '').trim()
    merchant = m || cbNew[2]!.trim()
  } else if (card) {
    kind = 'expense'
    merchant = card[3]!.trim()
  } else if (paiementCb) {
    kind = 'expense'
    merchant = paiementCb[2]!.trim()
  } else if (bareCard) {
    kind = 'expense'
    merchant = bareCard[2]!.trim()
  } else if (/^RETRAIT/i.test(label)) {
    kind = 'expense'
    merchant = 'Retrait'
  } else if (/^(?:VERSEMENT|VRST)\s*(?:D')?ESPECES/i.test(label)) {
    // Cash paid in (xls `VERSEMENT ESPECES DU 15/04 A 16H06`, pdf `VRST ESPECES AUTOMATE` —
    // which despaces to `VRSTESPECES`, hence `\s*`). Stays `other`: the cash's origin is
    // untracked, so it is neither a categorizable expense nor a transfer from a known account.
    merchant = 'Versement espèces'
  }

  if (fx) {
    const neg = r.amountMinor < 0 ? -1 : 1
    // Decimals matter: truncating `USD123,45` to 123 skewed the bank-derived rate
    // by 0.4% — at the top, non-approximate rung of the FX chain.
    original = { amount: neg * Number(`${fx[2]}.${fx[3]}`), currency: fx[4]!.toUpperCase() }
    feeMinor = Number(fx[5]) * 100 + Number(fx[6])
  }

  // Strip the trailing `CARTE 4974X…7214 [pays montant]` tail (XLS card rows) and the PDF
  // foreign-currency continuation (`… JPN 59290,00JPY+COMMISSION : 11,38`) from the display name.
  merchant = merchant.replace(/\s*CARTE\s*4974X.*$/i, '').trim()
  merchant = merchant.replace(/\s*[A-Z]{3}\s*\d[\d  ]*,\d{2}[A-Z]{3}\+COMMISSION.*$/i, '').trim()
  merchant = repairText(merchant).replace(/\s+/g, ' ').trim().slice(0, 60) || label.slice(0, 40)

  return {
    bookedDate: r.bookedDate,
    amountMinor: r.amountMinor,
    currency: accountCurrency,
    original,
    feeMinor,
    merchant,
    normDesc: canon,
    // Only when the RETRAIT fold actually moved it — otherwise the extra hash is wasted work.
    legacyNormDesc: legacyCanon === canon ? undefined : legacyCanon,
    counterparty,
    kind,
    creditorId,
    ref,
    sourceLine: r.sourceLine,
    raw: label,
  }
}
