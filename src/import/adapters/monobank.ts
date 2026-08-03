import type { DateStr } from '../../model/types'
import type { InstitutionAdapter, NormalizedRow, ParsedRow, ParsedStatement, Peek, SourceFile } from '../types'
import { normDesc, repairText } from '../identity'
import { parseDelimited } from './revolut'

// Canonical column keys and their localized header spellings. The sample export is English; the
// Ukrainian spellings are the monobank app wording and are unverified against a real file — a miss
// degrades to the positional fallback below (`headerWarning`), never to a wrong binding.
//
// Unlike every other adapter these are PATTERNS, not exact strings: monobank prints the account
// currency inside three of the header cells (`Card currency amount, (UAH)`, `Commission(UAH)`,
// `Cashback amount(UAH)`), so set-membership could never bind them.
type Col =
  | 'datetime'
  | 'description'
  | 'mcc'
  | 'cardAmount'
  | 'opAmount'
  | 'opCurrency'
  | 'rate'
  | 'commission'
  | 'cashback'
  | 'balance'

const HEADERS: Record<Col, RegExp> = {
  datetime: /^(date and time|дата (і|i|та) час)/,
  description: /^(description|опис|деталі)/,
  mcc: /^mcc$/,
  cardAmount: /^(card currency amount|сума в валюті картки)/,
  opAmount: /^(operation amount|сума в валюті операції)/,
  opCurrency: /^(operation currency|валюта операції)/,
  rate: /^(exchange rate|курс)/,
  commission: /^(commission|комісі)/,
  cashback: /^(cashback|кеш?б[еє]к)/,
  balance: /^(balance|залишок)/,
}

const ORDER: Col[] = ['datetime', 'description', 'mcc', 'cardAmount', 'opAmount', 'opCurrency', 'rate', 'commission', 'cashback', 'balance']

/** The account currency is stated ONLY inside the header text — `Card currency amount, (UAH)`. */
const CUR_IN_HEADER = /\(\s*([A-Za-z]{3})\s*\)/

/**
 * MCC → a Ledger category NAME (the §10.1 bank rung), the same contract Privat's `Category`
 * column feeds. Deliberately partial: the catch-all codes (5999 misc retail, 5399 general
 * merchandise, 7299 misc services) and every transfer code are left out — an unmapped MCC falls
 * through to history / review, which is the honest outcome. 4829 in particular is NOT mapped to
 * Transfers: it covers both a move between the user's own accounts and a payment to a private
 * contractor, and filing the latter under Transfers would delete a real expense from cash-flow.
 */
const MCC_CATEGORY: Record<number, string> = {
  // Groceries
  5411: 'Groceries', 5422: 'Groceries', 5441: 'Groceries', 5451: 'Groceries', 5462: 'Groceries', 5499: 'Groceries',
  // Dining out
  5812: 'Dining out', 5813: 'Dining out', 5814: 'Dining out',
  // Transport
  4111: 'Transport', 4112: 'Transport', 4121: 'Transport', 4131: 'Transport', 4784: 'Transport', 4789: 'Transport',
  5541: 'Transport', 5542: 'Transport', 7523: 'Transport',
  // Travel
  4511: 'Travel', 4722: 'Travel', 7011: 'Travel', 7512: 'Travel', 7519: 'Travel',
  // Utilities
  4814: 'Utilities', 4899: 'Utilities', 4900: 'Utilities',
  // Health
  5122: 'Health', 5912: 'Health', 8011: 'Health', 8021: 'Health', 8031: 'Health', 8041: 'Health', 8042: 'Health',
  8043: 'Health', 8049: 'Health', 8050: 'Health', 8062: 'Health', 8071: 'Health', 8099: 'Health',
  // Entertainment
  5815: 'Entertainment', 5816: 'Entertainment', 5817: 'Entertainment', 5818: 'Entertainment', 7832: 'Entertainment',
  7841: 'Entertainment', 7911: 'Entertainment', 7922: 'Entertainment', 7929: 'Entertainment', 7933: 'Entertainment',
  7991: 'Entertainment', 7992: 'Entertainment', 7994: 'Entertainment', 7996: 'Entertainment', 7997: 'Entertainment',
  7998: 'Entertainment',
  // Shopping
  5300: 'Shopping', 5310: 'Shopping', 5311: 'Shopping', 5331: 'Shopping', 5611: 'Shopping', 5621: 'Shopping',
  5631: 'Shopping', 5641: 'Shopping', 5651: 'Shopping', 5655: 'Shopping', 5661: 'Shopping', 5691: 'Shopping',
  5712: 'Shopping', 5719: 'Shopping', 5722: 'Shopping', 5732: 'Shopping', 5733: 'Shopping', 5734: 'Shopping',
  5735: 'Shopping', 5941: 'Shopping', 5942: 'Shopping', 5943: 'Shopping', 5944: 'Shopping', 5945: 'Shopping',
  5946: 'Shopping', 5947: 'Shopping', 5948: 'Shopping', 5949: 'Shopping', 5977: 'Shopping', 5992: 'Shopping',
  5995: 'Shopping',
  // Insurance
  6300: 'Insurance',
  // Taxes & fees
  9211: 'Taxes & fees', 9222: 'Taxes & fees', 9223: 'Taxes & fees', 9311: 'Taxes & fees', 9399: 'Taxes & fees',
  9402: 'Taxes & fees',
}

/** The 3xxx blocks are per-brand codes (one airline, one hotel chain, one rental firm each), so
 *  they are ranges rather than 900 map entries. */
const MCC_RANGES: { from: number; to: number; category: string }[] = [
  { from: 3000, to: 3299, category: 'Travel' }, // airlines
  { from: 3351, to: 3441, category: 'Travel' }, // car rental
  { from: 3501, to: 3999, category: 'Travel' }, // lodging
]

function mccCategory(mcc: number): string | undefined {
  if (!mcc) return undefined
  const exact = MCC_CATEGORY[mcc]
  if (exact) return exact
  return MCC_RANGES.find((r) => mcc >= r.from && mcc <= r.to)?.category
}

/** Money-movement codes: what a transfer looks like when the format states no `Type` (§16.3's
 *  problem, solved with the only column monobank offers). */
const MCC_TRANSFER = new Set([4829, 6010, 6011, 6012, 6051, 6532, 6536, 6537, 6538, 6540])

const CANCEL = /^(cancel|повернення|відміна|скасування)\b/i
/** `From UAH account` / `To EUR account`, and the Ukrainian wording. */
const OWN_ACCOUNT = /^(from|to)\s+[A-Za-z]{3}\s+account\b|^(з|на)\s+(власн|рахунк)/i
/** A P2P transfer names the destination card, masked: `5168 7****0537`. */
const CARD_MASK = /^\d{4}\s?\d?\*{3,}\d{4}$/

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/** `DD.MM.YYYY HH:MM:SS` (or an Excel serial, should the xlsx write the cell as a date) →
 *  'YYYY-MM-DD', verbatim date part, no TZ math (§5.5). `null` ⇒ the row is unparsed. */
export function monoDate(v: unknown): DateStr | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10) as DateStr
  }
  const s = String(v ?? '').trim()
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}` as DateStr
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return iso ? (iso[1] as DateStr) : null
}

/** `—` (em dash) is monobank's empty-cell marker in Exchange rate / Commission / Cashback; the
 *  en dash and a bare hyphen are accepted too rather than letting `Number('—')` reach an amount. */
const EMPTY = /^[—–-]?$/

function num(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim().replace(/[\s  ]/g, '')
  if (EMPTY.test(s)) return NaN
  return Number(s.replace(',', '.'))
}

const cell = (v: unknown) => String(v ?? '').trim().toLowerCase()

function bindColumns(header: unknown[]): { cols: Record<Col, number>; warning: boolean } {
  const norm = header.map(cell)
  const cols = {} as Record<Col, number>
  let matched = 0
  for (const c of ORDER) {
    const idx = norm.findIndex((h) => HEADERS[c].test(h))
    if (idx >= 0) {
      cols[c] = idx
      matched++
    }
  }
  // Positional fallback for any unmatched column (localized-header miss) — same policy as Revolut
  // and Privat, but guarded harder below: `cardAmount` and `opAmount` are shape-identical here, so
  // a positional bind on a file that is not monobank would read plausibly and be wrong.
  let warning = false
  if (matched < ORDER.length) {
    warning = true
    ORDER.forEach((c, i) => {
      if (cols[c] === undefined) cols[c] = i
    })
  }
  return { cols, warning }
}

/** The two markers no other registered format carries: a literal `MCC` column, and the account
 *  currency parenthesised in a header cell. Both are spelled the same in every monobank locale. */
function isMonoHeader(row: unknown[]): boolean {
  const norm = row.map(cell)
  if (norm.length < 9) return false
  if (!norm.some((h) => /^mcc$/.test(h))) return false
  return row.some((c) => CUR_IN_HEADER.test(String(c ?? '')))
}

/** The CSV puts the header on row 0, but the xlsx export is unverified and may open with a title
 *  block — so the header row is found, not assumed (the move Privat's xlsx forced). */
function headerIndex(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 6); i++) if (isMonoHeader(rows[i] ?? [])) return i
  return -1
}

export function detectLocale(header: unknown[]): string {
  return header.map(cell).some((h) => /[Ѐ-ӿ]/.test(h)) ? 'uk' : 'en'
}

interface MRow {
  date: DateStr | null
  description: string
  mcc: number
  cardAmount: number
  opAmount: number
  opCurrency: string
  commission: number
  balance: number | undefined
}

async function readMatrix(file: SourceFile, variant: string): Promise<unknown[][]> {
  if (variant === 'xlsx') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(file.bytes, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]!]!
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false })
  }
  const text = new TextDecoder('utf-8').decode(file.bytes)
  return parseDelimited(text, variant === 'tsv' ? '\t' : ',')
}

export const monobankAdapter: InstitutionAdapter = {
  id: 'monobank',
  displayName: 'Monobank',

  detect(file: SourceFile, peek: Peek) {
    if (file.container === 'pdf') return null
    const rows = peek.sheetRows ?? (peek.headerCells ? [peek.headerCells] : [])
    const h = headerIndex(rows)
    if (h < 0) return null
    const header = rows[h]!
    // The columns already decide; the dictionary only separates "certain" from "sure enough".
    const named = ORDER.filter((c) => header.map(cell).some((x) => HEADERS[c].test(x))).length
    const variant = file.container === 'xlsx' ? 'xlsx' : file.container === 'tsv' ? 'tsv' : 'csv'
    return { institution: 'monobank', variant, confidence: named >= 8 ? 0.98 : 0.95, hints: { locale: detectLocale(header) } }
  },

  async parse(file: SourceFile, variant: string): Promise<ParsedStatement> {
    const matrix = await readMatrix(file, variant)
    const hdr = headerIndex(matrix)
    const header = matrix[hdr < 0 ? 0 : hdr] ?? []
    const { cols, warning } = bindColumns(header)
    // A positional bind on a 10-column file that is not monobank would produce a plausible but
    // wrong statement — `cardAmount` and `opAmount` cannot be told apart by shape. Detection
    // already required the `MCC` header, so refuse rather than guess when neither holds.
    if (warning && !isMonoHeader(header) && header.length !== ORDER.length) {
      throw new Error('monobank: unrecognized column layout')
    }

    // The account currency is stated in the header and nowhere else in the file.
    const currency = (header.map((c) => String(c ?? '').match(CUR_IN_HEADER)?.[1]).find(Boolean) ?? 'UAH').toUpperCase()

    const rows: MRow[] = []
    const unparsed: string[] = []
    for (let i = (hdr < 0 ? 0 : hdr) + 1; i < matrix.length; i++) {
      const r = matrix[i]!
      if (r.every((c) => c === undefined || c === null || String(c).trim() === '')) continue
      const date = monoDate(r[cols.datetime])
      const cardAmount = num(r[cols.cardAmount])
      // A row whose date or amount will not read is accounted as unparsed, never imported as a
      // NaN — and the chain break that leaves is exactly the refusal the user should see.
      if (date === null || Number.isNaN(cardAmount)) {
        unparsed.push(String(r[cols.description] ?? r[cols.datetime] ?? ''))
        continue
      }
      const bal = num(r[cols.balance])
      rows.push({
        date,
        description: String(r[cols.description] ?? ''),
        mcc: Math.trunc(num(r[cols.mcc])) || 0,
        cardAmount,
        opAmount: num(r[cols.opAmount]),
        opCurrency: String(r[cols.opCurrency] ?? '').trim().toUpperCase(),
        commission: num(r[cols.commission]),
        balance: Number.isNaN(bal) ? undefined : bal,
      })
    }

    // The file lists NEWEST FIRST; every downstream stage (balance chain, anchors, occurrence
    // index, gap notes) reads chronologically, so reverse once here and renumber — the same move
    // Privat and the BNP mabanque export need.
    //
    // REVERSE, never sort. The real file lists `AUPA −744.44` and `Cancel AUPA +742.10` at the
    // same second (04.06.2025 02:19:25) and the chain only closes in the reversal's order; a
    // stable sort by timestamp keeps file order inside the tie and breaks it.
    rows.reverse()

    const dates = rows.map((r) => r.date!).filter(Boolean)
    const first = rows[0]
    const last = rows[rows.length - 1]

    return {
      institution: 'monobank',
      variant,
      locale: detectLocale(header),
      // The export carries no account number, IBAN or card number of its own — the account
      // currency is the only thing in the file, and it is not an identity. Rather than mint a
      // fingerprint two cards would share, offer none: the pipeline's `mustName` gate then asks
      // the user which account this is, every time, and never spawns a silent ghost (§5.8).
      fingerprint: null,
      accountCurrency: currency,
      periodFrom: dates[0] ?? '',
      periodTo: dates[dates.length - 1] ?? '',
      // The commission is INSIDE the card-currency amount (verified on the −12261/61 row), so the
      // implied opening subtracts the card amount alone — never amount − fee as Revolut does.
      openingBalance: first?.balance !== undefined ? round2(first.balance - first.cardAmount) : undefined,
      closingBalance: last?.balance,
      rows: rows.map((r, i) => ({ ...r, sourceLine: i })) as ParsedRow[],
      // No Type/State column ⇒ this format has no pending or reverted concept.
      skipped: { pending: 0, reverted: 0, unparsed },
      headerWarning: warning,
    }
  },

  normalize(stmt: ParsedStatement): NormalizedRow[] {
    const cur = stmt.accountCurrency
    return (stmt.rows as unknown as (MRow & { date: DateStr; sourceLine: number })[]).map((r) => {
      const desc = repairText(r.description)
      // The commission is already folded into the card-currency amount; subtracting it again
      // would double-charge every fee row. `feeMinor` is informational, as in BNP — which is also
      // the convention `bankDerivedRate` computes against (§4.5).
      const amountMinor = Math.round(r.cardAmount * 100) + 0 // `+ 0` normalizes a −0
      const feeMinor = Number.isNaN(r.commission) ? 0 : Math.round(r.commission * 100)
      const kind = monoKind(r, desc, amountMinor)
      const foreign = !Number.isNaN(r.opAmount) && !!r.opCurrency && r.opCurrency !== cur
      return {
        bookedDate: r.date,
        amountMinor,
        currency: cur,
        // Signed, in natural units as printed (Convention #3) — monobank prints the foreign leg
        // with its own sign, unlike Privat, so it is carried through as-is.
        original: foreign ? { amount: r.opAmount, currency: r.opCurrency } : undefined,
        feeMinor: feeMinor > 0 ? feeMinor : undefined,
        merchant: cleanMerchant(desc, r.mcc),
        normDesc: normDesc(r.description),
        counterparty: counterpartyOf(desc, kind),
        kind,
        // A transfer's MCC (4829 and friends) is money-movement, not a spending category — and a
        // reversal belongs wherever its charge went, not in a category of its own.
        bankCategory: kind === 'expense' || kind === 'refund' ? mccCategory(r.mcc) : undefined,
        balanceAfterMinor: r.balance !== undefined ? Math.round(r.balance * 100) : undefined,
        sourceLine: r.sourceLine,
        raw: desc,
      }
    })
  },
}

/**
 * Monobank states no transaction type — the sign, the MCC and a few language-independent
 * descriptor shapes are all the evidence there is. Getting this wrong is cheap: `kind` gates only
 * §9.2 transfer pairing, which still needs a real counter-leg on another tracked account.
 */
function monoKind(r: MRow, desc: string, amountMinor: number): NormalizedRow['kind'] {
  const inflow = amountMinor > 0
  // A reversed credit is a charge again, so `Cancel` alone does not mean refund.
  if (CANCEL.test(desc)) return inflow ? 'refund' : 'expense'
  if (MCC_TRANSFER.has(r.mcc) || CARD_MASK.test(desc.trim()) || OWN_ACCOUNT.test(desc)) {
    return inflow ? 'transfer-in' : 'transfer-out'
  }
  // An unexplained credit is `other`, never a guessed refund.
  return inflow ? 'other' : 'expense'
}

/**
 * Display name. Two cleanups, both from the real file: `Cancel ` is dropped so a reversal lands in
 * the merchant space of the charge it reverses (§5.11's Card Refund rule), and the card-network
 * geo tail is trimmed so `AUPA,Alsace,FR` and `AUPA` are one merchant. Identity is unaffected —
 * `normDesc` keeps the descriptor verbatim, so a reversal never collides with its charge.
 */
function cleanMerchant(desc: string, mcc: number): string {
  let s = desc.replace(/^cancel\s+/i, '')
  s = s.replace(/,\s?[^,]{2,},\s?[A-Z]{2}$/, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return s || (mcc ? `MCC ${mcc}` : 'Monobank')
}

/** Both directions collapse to the same identity (#19): `From UAH account` and `To UAH account`
 *  are one counterparty, and `mintKey` scopes a rule to the row's own sign anyway. */
function counterpartyOf(desc: string, kind: NormalizedRow['kind']): string | undefined {
  if (kind !== 'transfer-in' && kind !== 'transfer-out') return undefined
  return desc.replace(/^(from|to)\s+/i, '').replace(/^(з|на)\s+/i, '').trim() || undefined
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
