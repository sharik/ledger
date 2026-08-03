import type { DateStr } from '../../model/types'
import type { InstitutionAdapter, NormalizedRow, ParsedRow, ParsedStatement, Peek, SourceFile } from '../types'
import { extractPdf, reconstructLines, type PdfPage, type TextItem, type VisualLine } from '../pdf'
import { repairText } from '../identity'

/**
 * Column bands (A4 pt, measured on the real statement ✓). PUMB prints one transaction across
 * THREE visual lines — date above time in the first band, the amounts on the middle line, and
 * a wrapped merchant / operation name spilling onto the third — so a row is a group of lines,
 * not a line (§6.2-style geometry, PUMB flavor).
 */
type Band = 'date' | 'opAmount' | 'postDate' | 'accAmount' | 'fee' | 'card' | 'details' | 'opDesc' | 'margin'

const band = (x: number): Band => {
  if (x >= 30 && x < 90) return 'date'
  if (x >= 90 && x < 150) return 'opAmount'
  if (x >= 150 && x < 210) return 'postDate'
  if (x >= 210 && x < 265) return 'accAmount'
  if (x >= 265 && x < 325) return 'fee'
  if (x >= 325 && x < 395) return 'card'
  if (x >= 395 && x < 520) return 'details'
  if (x >= 520) return 'opDesc'
  return 'margin'
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^\d{2}:\d{2}:\d{2}$/

/** `26349.45` / `1 234,56 UAH` → minor units + the currency when the cell states one. */
function lexAmount(text: string): { minor: number; currency?: string } | null {
  const m = text.match(/(-?)(\d[\d   ]*)[.,](\d{2})(?:\s*([A-Z]{3}))?/)
  if (!m) return null
  const whole = Number(m[2]!.replace(/[\s   ]/g, ''))
  if (!Number.isFinite(whole)) return null
  const minor = whole * 100 + Number(m[3])
  return { minor: m[1] === '-' ? -minor : minor, currency: m[4] }
}

/** Items of one band on one line, left-to-right, spacing rebuilt at the 0.25 × fontSize gap. */
function bandChunk(line: VisualLine, b: Band): string {
  const items = line.items.filter((it) => band(it.x) === b && it.str.trim()).sort((a, b2) => a.x - b2.x)
  let text = ''
  let prevRight: number | null = null
  for (const it of items) {
    if (prevRight !== null && it.x - prevRight > 0.25 * it.fontSize && !text.endsWith(' ')) text += ' '
    text += it.str
    prevRight = it.x + it.w
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A band read across every line of a row group, top to bottom. Chunks are joined with a space
 * even when the source wrapped mid-word (`Aulnay-sous-` + `BFRFR`): the wrap is unrecoverable —
 * PUMB truncates the cell — and a space at least lets the trailing country blob be recognized
 * and stripped from the display name. Identity strips whitespace anyway, so the choice is
 * display-only.
 */
function bandText(group: VisualLine[], b: Band): string {
  const chunks: string[] = []
  for (const line of group) {
    const c = bandChunk(line, b)
    if (c) chunks.push(c)
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

/** The first item on a line that lexes as a bare amount, scanning right to left (totals block). */
function trailingAmount(line: VisualLine): number | null {
  const items = [...line.items].filter((it) => it.str.trim()).sort((a, b2) => b2.x - a.x)
  for (const it of items) {
    const v = lexAmount(it.str.trim())
    if (v) return v.minor
  }
  return null
}

interface Header {
  fingerprint: string | null
  accountMask?: string
  holderNames: string[]
  currency: string
  periodFrom: DateStr
  periodTo: DateStr
}

const STATEMENT_MARKER = /Інформація\s+про\s+рух\s+коштів/i
const PUMB_MARKER = /ПУМБ|pumb\.ua|Перший\s+Український\s+Міжнародний\s+банк/i

function parseHeader(lines: VisualLine[]): Header {
  const texts = lines.map((l) => l.text)
  const flat = texts.join('\n')

  // IBAN — the account's own key, printed under `За рахунком №` and identical in every export.
  const ibanRaw = flat.match(/\bUA\d{2}[\d ]{20,}/)?.[0]
  const iban = ibanRaw?.replace(/\s/g, '')
  const fingerprint = iban && iban.length >= 20 ? `pumb:${iban}` : null
  const accountMask = iban?.slice(-4)

  // `з 01.02.2025 р. по 28.02.2025 р.`
  let periodFrom = ''
  let periodTo = ''
  const pm = flat.match(/з\s*(\d{2})\.(\d{2})\.(\d{4})[^\d]{0,12}по\s*(\d{2})\.(\d{2})\.(\d{4})/)
  if (pm) {
    periodFrom = `${pm[3]}-${pm[2]}-${pm[1]}`
    periodTo = `${pm[6]}-${pm[5]}-${pm[4]}`
  }

  // The header is a two-column block: a label line, then its value on the NEXT line — the holder
  // in the left column (x < 300), the currency in the right (x ≥ 310).
  const valueAfter = (label: RegExp, pick: (it: TextItem) => boolean): TextItem[] => {
    const i = lines.findIndex((l) => label.test(l.text))
    if (i < 0 || i + 1 >= lines.length) return []
    return lines[i + 1]!.items.filter((it) => it.str.trim() && pick(it))
  }

  const holder = valueAfter(/Клієнт/, (it) => it.x < 300)
    .sort((a, b2) => a.x - b2.x)
    .map((it) => it.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const holderNames = holder ? [repairText(holder)] : []

  const currency = valueAfter(/У\s+валюті/, (it) => it.x >= 310 && /^[A-Z]{3}$/.test(it.str.trim()))[0]?.str.trim() ?? ''

  return { fingerprint, accountMask, holderNames, currency, periodFrom, periodTo }
}

interface PumbRow {
  bookedDate: DateStr
  time: string
  postedDate?: DateStr
  /** Signed, account currency — the sign comes from the operation word (see CREDIT_OPS). */
  amountMinor: number
  currency: string
  /** Magnitude as printed in the operation's own currency; sign is taken from amountMinor. */
  origAmount?: number
  origCurrency?: string
  feeMinor?: number
  cardMask: string
  details: string
  opDesc: string
  sourceLine: number
}

/**
 * PUMB prints no signed amount and no debit/credit column: direction lives ONLY in the Ukrainian
 * `Опис операції` word. Verified against the real file: `Покупка` (debit) and `Повернення коштів`
 * (credit). The rest are the Privat24/PUMB statement vocabulary and are unverified — an
 * unrecognized word is read as a debit, and if that guess is wrong the printed totals and the
 * opening/closing pair stop agreeing, so `reconcile` refuses the whole file rather than importing
 * a row backwards (§6.6). One dictionary entry is the fix.
 */
const CREDIT_OPS = /ПОВЕРНЕННЯ|ЗАРАХУВАННЯ|ПОПОВНЕННЯ|ВНЕСЕННЯ|НАРАХУВАННЯ/

function pumbKind(opDesc: string, credit: boolean): NormalizedRow['kind'] {
  const s = opDesc.toUpperCase()
  if (/ПОВЕРНЕННЯ/.test(s)) return 'refund'
  if (/КОМІС/.test(s)) return 'fee'
  if (/ПЕРЕКАЗ/.test(s)) return credit ? 'transfer-in' : 'transfer-out'
  if (/ГОТІВК/.test(s)) return 'expense' // Зняття / Видача готівки
  if (/ПОКУПКА|ОПЛАТА/.test(s)) return 'expense'
  if (credit) return 'other'
  return 'expense'
}

/**
 * The identity basis (§7.2, PUMB flavor). The operation word must be in it: the real file opens
 * with a `Повернення коштів` and a `Покупка` of the SAME 4381.86 UAH, at the same second, on the
 * same card, at the same merchant — the word is the only thing that distinguishes them. The card
 * tail keeps two cards' same-day identical charges apart, and the time keeps two same-merchant
 * same-amount purchases apart without leaning on the occurrence index alone.
 */
export function pumbNormDesc(details: string, opDesc: string, cardMask: string, time: string): string {
  return repairText(`${opDesc}|${details}|${cardMask}|${time}`)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s   ]/g, '')
}

const TOTALS: { re: RegExp; key: 'opening' | 'closing' | 'debit' | 'credit' }[] = [
  { re: /Баланс\s+рахунку\s+на\s+початок/i, key: 'opening' },
  { re: /Баланс\s+рахунку\s+на\s+кінець/i, key: 'closing' },
  { re: /Всього\s+списань/i, key: 'debit' },
  { re: /Всього\s+зарахувань/i, key: 'credit' },
]

/**
 * The whole parser, as a pure function over reconstructed lines — so the geometry, the grammar
 * and the totals block can be tested from hand-built lines without a PDF (and without shipping a
 * statement full of personal data to assert against).
 */
export function parseLines(lines: VisualLine[]): ParsedStatement {
  const header = parseHeader(lines)

  // Bound the transaction region: after the section title, before the totals block.
  const titleIdx = lines.findIndex((l) => STATEMENT_MARKER.test(l.text))
  const startIdx = titleIdx >= 0 ? titleIdx + 1 : 0
  let endIdx = lines.length
  let opening: number | undefined
  let closing: number | undefined
  let debitMinor: number | undefined
  let creditMinor: number | undefined
  lines.forEach((line, i) => {
    const hit = TOTALS.find((t) => t.re.test(line.text))
    if (!hit) return
    if (i < endIdx) endIdx = i
    const v = trailingAmount(line)
    if (v === null) return
    if (hit.key === 'opening') opening = v / 100
    else if (hit.key === 'closing') closing = v / 100
    else if (hit.key === 'debit') debitMinor = Math.abs(v)
    else creditMinor = Math.abs(v)
  })

  // Group lines into rows: a line carrying an ISO date in the date band opens one. A repeated
  // column header on page 2+ carries no such date, so it is skipped without a special case.
  const groups: VisualLine[][] = []
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i]!
    const anchor = line.items.some((it) => band(it.x) === 'date' && ISO.test(it.str.trim()))
    if (anchor) groups.push([line])
    else if (groups.length > 0) groups[groups.length - 1]!.push(line)
  }

  const rows: PumbRow[] = []
  const unparsed: string[] = []
  for (const g of groups) {
    const dates = g.flatMap((l) => l.items.filter((it) => band(it.x) === 'date' && it.str.trim()))
    const bookedDate = dates.find((it) => ISO.test(it.str.trim()))?.str.trim() as DateStr | undefined
    const time = dates.find((it) => TIME.test(it.str.trim()))?.str.trim() ?? ''
    const acc = lexAmount(bandText(g, 'accAmount'))
    const opDesc = bandText(g, 'opDesc')
    if (!bookedDate || !acc || !opDesc) {
      unparsed.push(g.map((l) => l.text).join(' ').trim())
      continue
    }
    const op = lexAmount(bandText(g, 'opAmount'))
    const fee = lexAmount(bandText(g, 'fee'))
    const postText = bandText(g, 'postDate')
    const credit = CREDIT_OPS.test(opDesc.toUpperCase())
    const currency = acc.currency ?? header.currency ?? 'UAH'
    rows.push({
      bookedDate,
      time,
      postedDate: ISO.test(postText) ? (postText as DateStr) : undefined,
      amountMinor: credit ? acc.minor : -acc.minor,
      currency,
      origAmount: op ? Math.abs(op.minor) / 100 : undefined,
      origCurrency: op?.currency,
      feeMinor: fee && fee.minor !== 0 ? Math.abs(fee.minor) : undefined,
      cardMask: bandText(g, 'card'),
      details: bandText(g, 'details'),
      opDesc,
      sourceLine: rows.length,
    })
  }

  const currency = header.currency || rows[0]?.currency || 'UAH'
  return {
    institution: 'pumb',
    variant: 'pdf',
    locale: 'uk',
    fingerprint: header.fingerprint,
    accountMask: header.accountMask,
    holderNames: header.holderNames,
    accountCurrency: currency,
    periodFrom: header.periodFrom || rows[0]?.bookedDate || '',
    periodTo: header.periodTo || rows[rows.length - 1]?.bookedDate || '',
    openingBalance: opening,
    closingBalance: closing,
    printedTotals: debitMinor !== undefined && creditMinor !== undefined ? { debitMinor, creditMinor } : undefined,
    rows: rows as unknown as ParsedRow[],
    skipped: { pending: 0, reverted: 0, unparsed },
  }
}

export const pumbAdapter: InstitutionAdapter = {
  id: 'pumb',
  displayName: 'PUMB',

  detect(file: SourceFile, peek: Peek) {
    if (file.container !== 'pdf') return null
    const text = peek.firstPageText ?? ''
    // Both markers, not just the letterhead: PUMB prints the same header on account certificates
    // and loan schedules, which carry no transaction table. A statement we cannot read must stay
    // unrecognized rather than import as an empty account (the discipline bnp.ts applies to
    // products it cannot name).
    if (PUMB_MARKER.test(text) && STATEMENT_MARKER.test(text)) {
      return { institution: 'pumb', variant: 'pdf', confidence: 0.95, hints: { locale: 'uk' } }
    }
    return null
  },

  async parse(file: SourceFile): Promise<ParsedStatement> {
    const pages = await extractPdf(file.bytes)
    const lines: VisualLine[] = []
    for (const page of pages as PdfPage[]) lines.push(...reconstructLines(page))
    return parseLines(lines)
  },

  normalize(stmt: ParsedStatement): NormalizedRow[] {
    return (stmt.rows as unknown as PumbRow[]).map((r) => extractRow(r))
  },
}

/**
 * Trailing acquirer/country blob on a card descriptor: `FRFR`, `QAQA`, `CEFRFR` — a doubled
 * ISO-2 country code, sometimes behind a 1–2 letter acquirer prefix. Noise everywhere it appears,
 * and it is the last token, so stripping it cannot eat a merchant name.
 */
const COUNTRY_TAIL = /\s+[A-Z]{0,2}([A-Z]{2})\1$/

function extractRow(r: PumbRow): NormalizedRow {
  const credit = r.amountMinor > 0
  const kind = pumbKind(r.opDesc, credit)

  let merchant = repairText(r.details).replace(COUNTRY_TAIL, '').replace(/[-\s]+$/, '').trim()
  merchant = merchant.replace(/\s+/g, ' ').slice(0, 60) || r.opDesc.slice(0, 40)

  // Only a genuinely foreign leg. One real row prints `481.02 UAH` against a posted `484.78 UAH`;
  // emitting that as a UAH→UAH `original` would feed a bogus derivation into `bankDerivedRate`.
  const original =
    r.origCurrency && r.origAmount !== undefined && r.origCurrency !== r.currency
      ? { amount: (credit ? 1 : -1) * r.origAmount, currency: r.origCurrency }
      : undefined

  return {
    bookedDate: r.bookedDate,
    amountMinor: r.amountMinor,
    currency: r.currency,
    original,
    // Informational, and assumed already folded into the account-currency amount: every fee in
    // the sample file is 0.00, so it cannot be verified. If PUMB ever charges one on top, the
    // rows stop summing to the printed totals and the file is refused, not mis-imported.
    feeMinor: r.feeMinor,
    merchant,
    normDesc: pumbNormDesc(r.details, r.opDesc, r.cardMask, r.time),
    kind,
    sourceLine: r.sourceLine,
    raw: [r.details, r.opDesc, r.cardMask].filter(Boolean).join(' · '),
  }
}
