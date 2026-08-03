import type { DateStr } from '../../model/types'
import type { InstitutionAdapter, NormalizedRow, ParsedRow, ParsedStatement, Peek, SourceFile } from '../types'
import { normDesc, repairText } from '../identity'
import { parseDelimited } from './revolut'

// Canonical column keys and their localized header spellings. Both sample exports are English;
// the Ukrainian spellings are the Privat24 UI wording and are unverified against a real file —
// a miss degrades to the positional fallback below (`headerWarning`), never to a wrong binding.
type Col =
  | 'date'
  | 'category'
  | 'card'
  | 'description'
  | 'amount'
  | 'currency'
  | 'origAmount'
  | 'origCurrency'
  | 'balance'
  | 'balanceCurrency'

const HEADERS: Record<Col, string[]> = {
  date: ['date', 'дата'],
  category: ['category', 'категорія'],
  card: ['card', 'картка'],
  description: ['description', 'опис операції', 'опис'],
  amount: ['amount in card currency', 'сума в валюті картки'],
  currency: ['card currency', 'валюта картки'],
  origAmount: ['amount in transaction currency', 'сума в валюті транзакції'],
  origCurrency: ['transaction currency', 'валюта транзакції'],
  balance: ['rest at the end of the period', 'залишок на кінець періоду'],
  balanceCurrency: ['rest currency', 'валюта залишку'],
}

const ORDER: Col[] = ['date', 'category', 'card', 'description', 'amount', 'currency', 'origAmount', 'origCurrency', 'balance', 'balanceCurrency']

/** The columns that make a row set unmistakably Privat — no other registered format has them. */
const REQUIRED: Col[] = ['card', 'amount', 'currency', 'origAmount', 'balance']

/**
 * Privat's own classification → a Ledger category NAME (the §10.1 bank rung). Deliberately
 * partial: `Other`, `Services`, `Foundations and organizations` and `Cash withdrawal` have no
 * honest home in the default taxonomy, and the two transfer labels are consumed by `kind`
 * instead. An unmapped label simply falls through to history / fallback.
 */
const CATEGORY: Record<string, string> = {
  'supermarkets and groceries': 'Groceries',
  'супермаркети та продукти': 'Groceries',
  'restaurants, cafes, bars': 'Dining out',
  'ресторани, кафе, бари': 'Dining out',
  transport: 'Transport',
  транспорт: 'Transport',
  'train tickets': 'Transport',
  'залізничні квитки': 'Transport',
  taxi: 'Transport',
  таксі: 'Transport',
  fuel: 'Transport',
  паливо: 'Transport',
  parking: 'Transport',
  паркування: 'Transport',
  'air tickets': 'Travel',
  авіаквитки: 'Travel',
  hotels: 'Travel',
  готелі: 'Travel',
  tourism: 'Travel',
  туризм: 'Travel',
  'car rental': 'Travel',
  'оренда авто': 'Travel',
  'digital goods': 'Entertainment',
  'цифрові товари': 'Entertainment',
  entertainment: 'Entertainment',
  розваги: 'Entertainment',
  'utility payments': 'Utilities',
  'комунальні платежі': 'Utilities',
  'mobile communication': 'Utilities',
  "мобільний зв'язок": 'Utilities',
  internet: 'Utilities',
  інтернет: 'Utilities',
  pharmacies: 'Health',
  аптеки: 'Health',
  medicine: 'Health',
  медицина: 'Health',
  'clothes and shoes': 'Shopping',
  'одяг та взуття': 'Shopping',
  beauty: 'Shopping',
  краса: 'Shopping',
  electronics: 'Shopping',
  електроніка: 'Shopping',
  insurance: 'Insurance',
  страхування: 'Insurance',
  'fees and commissions': 'Taxes & fees',
  комісії: 'Taxes & fees',
}

const TRANSFER_IN = ['transfer crediting', 'зарахування переказу']
const TRANSFER_OUT = ['transfer to my card', 'переказ на свою картку', 'переказ між своїми картками']

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/** `DD.MM.YYYY HH:MM:SS` (or an Excel serial, should a locale write the cell as a date) →
 *  'YYYY-MM-DD', verbatim date part, no TZ math. `null` ⇒ the row is unparsed. */
export function privatDate(v: unknown): DateStr | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(EXCEL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10) as DateStr
  }
  const s = String(v ?? '').trim()
  const dmy = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}` as DateStr
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return iso ? (iso[1] as DateStr) : null
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v ?? '').trim()
  if (!s) return NaN
  return Number(s.replace(/\s/g, '').replace(',', '.'))
}

const cell = (v: unknown) => String(v ?? '').trim().toLowerCase()

function bindColumns(header: unknown[]): { cols: Record<Col, number>; warning: boolean } {
  const norm = header.map(cell)
  const cols = {} as Record<Col, number>
  let matched = 0
  for (const c of ORDER) {
    const idx = norm.findIndex((h) => HEADERS[c].includes(h))
    if (idx >= 0) {
      cols[c] = idx
      matched++
    }
  }
  // Positional fallback for any unmatched column (localized-header miss) — same policy as Revolut.
  let warning = false
  if (matched < ORDER.length) {
    warning = true
    ORDER.forEach((c, i) => {
      if (cols[c] === undefined) cols[c] = i
    })
  }
  return { cols, warning }
}

function boundRequired(header: unknown[]): number {
  const norm = header.map(cell)
  return REQUIRED.filter((c) => norm.some((h) => HEADERS[c].includes(h))).length
}

/**
 * The column header is not always row 0: the XLSX opens with a merged title row
 * (`Transactions from your cards for the period …`) and puts the header on row 1. Scan the
 * rows `Peek`/`parse` hands over and return the first that binds enough Privat columns.
 */
function headerIndex(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (boundRequired(rows[i] ?? []) >= 4) return i
  }
  return -1
}

export function detectLocale(header: unknown[]): string {
  return header.map(cell).some((h) => /[Ѐ-ӿ]/.test(h)) ? 'uk' : 'en'
}

/** `4149 **** **** 5583` → `4149-5583`; anything else falls back to a slug of the cell. */
export function cardKey(card: string): string {
  const s = card.trim()
  const bin = s.match(/^(\d{4})/)?.[1]
  const last4 = s.match(/(\d{4})\s*$/)?.[1]
  if (bin && last4) return `${bin}-${last4}`
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card'
}

export function cardLast4(card: string): string | undefined {
  return card.trim().match(/(\d{4})\s*$/)?.[1]
}

interface PRow {
  date: DateStr | null
  category: string
  card: string
  description: string
  amount: number
  currency: string
  origAmount: number
  origCurrency: string
  balance: number | undefined
  balanceCurrency: string
}

async function readMatrix(file: SourceFile, variant: string): Promise<unknown[][]> {
  if (variant === 'xlsx') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(file.bytes, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]!]!
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false })
  }
  const text = new TextDecoder('utf-8').decode(file.bytes)
  return parseDelimited(text, variant === 'csv' ? ',' : '\t')
}

function toPRows(matrix: unknown[][]): { rows: PRow[]; warning: boolean; locale: string } {
  const hdr = headerIndex(matrix)
  const header = matrix[hdr < 0 ? 0 : hdr] ?? []
  const { cols, warning } = bindColumns(header)
  const out: PRow[] = []
  for (let i = (hdr < 0 ? 0 : hdr) + 1; i < matrix.length; i++) {
    const r = matrix[i]!
    if (r.every((c) => c === undefined || c === null || String(c).trim() === '')) continue
    const bal = num(r[cols.balance])
    const currency = String(r[cols.currency] ?? '').trim().toUpperCase()
    out.push({
      date: privatDate(r[cols.date]),
      category: String(r[cols.category] ?? '').trim(),
      card: String(r[cols.card] ?? '').trim(),
      description: String(r[cols.description] ?? ''),
      amount: num(r[cols.amount]),
      currency: currency || 'UAH',
      origAmount: num(r[cols.origAmount]),
      origCurrency: String(r[cols.origCurrency] ?? '').trim().toUpperCase() || currency || 'UAH',
      balance: Number.isNaN(bal) ? undefined : bal,
      balanceCurrency: String(r[cols.balanceCurrency] ?? '').trim().toUpperCase(),
    })
  }
  return { rows: out, warning, locale: detectLocale(header) }
}

export const privatAdapter: InstitutionAdapter = {
  id: 'privat',
  displayName: 'PrivatBank',

  detect(file: SourceFile, peek: Peek) {
    if (file.container === 'pdf') return null
    const rows = peek.sheetRows ?? (peek.headerCells ? [peek.headerCells] : [])
    if (headerIndex(rows) < 0) return null
    // The title row and the file name are corroboration only — the columns already decide.
    const title = `${peek.fileName} ${(rows[0] ?? []).join(' ')}`
    const named = /privat|Transactions from your cards|Виписка з Ваших карток/i.test(title)
    const variant = file.container === 'xlsx' ? 'xlsx' : file.container === 'tsv' ? 'tsv' : 'csv'
    const locale = detectLocale(rows[Math.max(headerIndex(rows), 0)] ?? [])
    return { institution: 'privat', variant, confidence: named ? 0.98 : 0.95, hints: { locale } }
  },

  async parse(file: SourceFile, variant: string): Promise<ParsedStatement> {
    return (await parseGroups(file, variant))[0]!
  },

  parseAll: parseGroups,

  normalize(stmt: ParsedStatement): NormalizedRow[] {
    return (stmt.rows as unknown as (PRow & { date: DateStr; sourceLine: number })[]).map((r) => {
      const amountMinor = Math.round(r.amount * 100)
      const kind = privatKind(r.category, amountMinor)
      const desc = repairText(r.description)
      // The foreign leg is printed UNSIGNED (`-342.65 UAH` / `6.99 EUR`), so its sign comes from
      // the card-currency amount — otherwise every FX expense would derive a negative rate.
      const original =
        r.origCurrency && r.origCurrency !== r.currency && !Number.isNaN(r.origAmount)
          ? { amount: (amountMinor < 0 ? -1 : 1) * Math.abs(r.origAmount), currency: r.origCurrency }
          : undefined
      let counterparty: string | undefined
      if (kind === 'transfer-in') counterparty = desc.replace(/^(?:from|від)\s+/i, '').trim() || undefined
      else if (kind === 'transfer-out') counterparty = desc.replace(/^(?:to(?:\s+my\s+card)?|на)\s+/i, '').trim() || undefined
      return {
        bookedDate: r.date,
        amountMinor,
        currency: r.currency,
        original,
        merchant: desc.trim() || r.category || 'Privat',
        normDesc: normDesc(r.description),
        counterparty,
        kind,
        bankCategory: CATEGORY[r.category.trim().toLowerCase()],
        balanceAfterMinor: r.balance !== undefined ? Math.round(r.balance * 100) : undefined,
        sourceLine: r.sourceLine,
        raw: desc,
      }
    })
  },
}

/**
 * One statement per CARD. A Privat export interleaves every card the user asked for, and each
 * carries its own balance chain (`Rest at the end of the period`) — the §5.6 invariant holds
 * within a card, not across the file. First-appearance order, so the card the file opens with
 * is reviewed first. Always returns at least one statement.
 */
async function parseGroups(file: SourceFile, variant: string): Promise<ParsedStatement[]> {
  const matrix = await readMatrix(file, variant)
  const { rows, warning, locale } = toPRows(matrix)

  const groups = new Map<string, PRow[]>()
  for (const r of rows) {
    const key = `${cardKey(r.card)}:${r.currency.toLowerCase()}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  if (groups.size === 0) groups.set('card:uah', [])
  return [...groups.values()].map((g) => statementFor(g, variant, locale, warning))
}

function statementFor(rows: PRow[], variant: string, locale: string, warning: boolean): ParsedStatement {
  const unparsed: string[] = []
  const good: PRow[] = []
  for (const r of rows) {
    if (r.date === null || Number.isNaN(r.amount)) unparsed.push(r.description || r.card)
    else good.push(r)
  }
  // The file lists newest first; every downstream stage (balance chain, anchors, occurrence
  // index, gap notes) reads chronologically, so reverse once here and renumber — the same move
  // the BNP mabanque export needs.
  good.reverse()

  const card = rows[0]?.card ?? ''
  const currency = rows[0]?.currency || 'UAH'
  const last4 = cardLast4(card)
  // The masked card number is printed in every export and is stable, so it is a proven key
  // rather than a mere signal — no `mask:` prefix (§5.8).
  const fingerprint = `privat:${cardKey(card)}:${currency.toLowerCase()}`

  const dates = good.map((r) => r.date!).filter(Boolean)
  const periodFrom = dates[0] ?? ''
  const periodTo = dates[dates.length - 1] ?? ''

  let openingBalance: number | undefined
  let closingBalance: number | undefined
  if (good.length > 0) {
    const first = good[0]!
    const last = good[good.length - 1]!
    if (first.balance !== undefined) openingBalance = round2(first.balance - first.amount)
    if (last.balance !== undefined) closingBalance = last.balance
  }

  const parsedRows: ParsedRow[] = good.map((r, i) => ({ ...r, sourceLine: i }))
  return {
    institution: 'privat',
    variant,
    locale,
    fingerprint,
    accountMask: last4,
    productName: last4 ? `····${last4}` : undefined,
    accountCurrency: currency,
    periodFrom,
    periodTo,
    openingBalance,
    closingBalance,
    rows: parsedRows,
    skipped: { pending: 0, reverted: 0, unparsed },
    headerWarning: warning,
  }
}

/** The Category column is Privat's answer to Revolut's `Type`: it is what names a transfer. */
function privatKind(category: string, amountMinor: number): NormalizedRow['kind'] {
  const c = category.trim().toLowerCase()
  if (TRANSFER_IN.includes(c)) return 'transfer-in'
  if (TRANSFER_OUT.includes(c)) return 'transfer-out'
  return amountMinor < 0 ? 'expense' : 'refund'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
