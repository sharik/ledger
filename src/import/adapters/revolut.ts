import type { DateStr } from '../../model/types'
import type { InstitutionAdapter, NormalizedRow, ParsedRow, ParsedStatement, Peek, SourceFile } from '../types'
import { normDesc, repairText } from '../identity'

// Canonical column keys and their localized header spellings (§5.9).
type Col = 'type' | 'product' | 'started' | 'completed' | 'description' | 'amount' | 'fee' | 'currency' | 'state' | 'balance'

const HEADERS: Record<Col, string[]> = {
  type: ['type'],
  product: ['product', 'produit'],
  started: ['started date', 'date de début', 'date de debut'],
  completed: ['completed date', 'date de fin'],
  description: ['description'],
  amount: ['amount', 'montant'],
  fee: ['fee', 'frais'],
  currency: ['currency', 'devise'],
  state: ['state', 'état', 'etat'],
  balance: ['balance', 'solde'],
}

const ORDER: Col[] = ['type', 'product', 'started', 'completed', 'description', 'amount', 'fee', 'currency', 'state', 'balance']

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

/** Excel serial (or ISO datetime string) → 'YYYY-MM-DD', verbatim date part, no TZ math (§5.5). */
export function revolutDate(v: unknown): DateStr {
  if (typeof v === 'number') {
    const d = new Date(EXCEL_EPOCH + Math.floor(v) * 86400000)
    return d.toISOString().slice(0, 10)
  }
  return String(v).trim().slice(0, 10)
}

function num(v: unknown): number {
  if (typeof v === 'number') return v
  const s = String(v).trim().replace(/\s/g, '')
  if (!s) return NaN
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  // Both marks present: the later one is the decimal separator ("1,234.56" / "1.234,56").
  if (lastComma >= 0 && lastDot >= 0) {
    return lastDot > lastComma ? Number(s.replace(/,/g, '')) : Number(s.replace(/\./g, '').replace(',', '.'))
  }
  // Several commas can only be thousands grouping; a single one is the FR decimal mark.
  if (lastComma >= 0) {
    return s.indexOf(',') !== lastComma ? Number(s.replace(/,/g, '')) : Number(s.replace(',', '.'))
  }
  return Number(s)
}

interface Bound {
  cols: Record<Col, number>
  warning: boolean
}

function bindColumns(header: unknown[]): Bound {
  const norm = header.map((h) => String(h ?? '').trim().toLowerCase())
  const cols = {} as Record<Col, number>
  let matched = 0
  for (const c of ORDER) {
    const idx = norm.findIndex((h) => HEADERS[c].includes(h))
    if (idx >= 0) {
      cols[c] = idx
      matched++
    }
  }
  // Positional fallback for any unmatched column (localized-header miss, §5.9).
  let warning = false
  if (matched < ORDER.length) {
    warning = true
    ORDER.forEach((c, i) => {
      if (cols[c] === undefined) cols[c] = i
    })
  }
  return { cols, warning }
}

// ---- RFC-4180 CSV/TSV parser (hand-rolled) ----
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch === '\r') {
      // swallow; \n handles the row break
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0]!.trim() !== ''))
}

interface RRow {
  type: string
  product: string
  started: unknown
  completed: unknown
  description: string
  amount: number
  fee: number
  currency: string
  state: string
  balance: number | undefined
}

function toRRows(matrix: unknown[][]): { rows: RRow[]; unparsed: RRow[]; warning: boolean } {
  const { cols, warning } = bindColumns(matrix[0] ?? [])
  const out: RRow[] = []
  const unparsed: RRow[] = []
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i]!
    if (r.every((c) => c === undefined || String(c).trim() === '')) continue
    const bal = num(r[cols.balance])
    const row: RRow = {
      type: String(r[cols.type] ?? '').trim(),
      product: String(r[cols.product] ?? '').trim(),
      started: r[cols.started],
      completed: r[cols.completed],
      description: String(r[cols.description] ?? ''),
      amount: num(r[cols.amount]),
      fee: num(r[cols.fee]) || 0,
      currency: String(r[cols.currency] ?? 'EUR').trim() || 'EUR',
      state: String(r[cols.state] ?? '').trim().toUpperCase(),
      balance: Number.isNaN(bal) ? undefined : bal,
    }
    // A row whose amount will not read is accounted as unparsed, never imported
    // as a NaN — the same refusal privat and monobank apply.
    if (Number.isNaN(row.amount)) unparsed.push(row)
    else out.push(row)
  }
  return { rows: out, unparsed, warning }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function readMatrix(file: SourceFile, variant: string): Promise<{ matrix: unknown[][]; locale?: string }> {
  if (variant === 'xlsx') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(file.bytes, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]!]!
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false })
    return { matrix }
  }
  const text = new TextDecoder('utf-8').decode(file.bytes)
  const delim = variant === 'tsv' ? '\t' : ','
  return { matrix: parseDelimited(text, delim) }
}

export function detectLocale(header: unknown[]): string {
  const norm = header.map((h) => String(h ?? '').trim().toLowerCase())
  if (norm.includes('produit') || norm.includes('montant') || norm.includes('devise')) return 'fr'
  return 'en'
}

export const revolutAdapter: InstitutionAdapter = {
  id: 'revolut',
  displayName: 'Revolut',

  detect(file: SourceFile, peek: Peek) {
    if (file.container === 'pdf') return null
    const cells = (peek.headerCells ?? []).map((h) => h.trim().toLowerCase())
    if (cells.length === 0) return null
    const required: Col[] = ['type', 'amount', 'currency', 'state', 'balance']
    const hits = required.filter((c) => cells.some((h) => HEADERS[c].includes(h))).length
    if (hits < required.length) return null
    let confidence = 0.95
    if (/^account-statement_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_/.test(file.name)) confidence = 0.99
    const locale = detectLocale(peek.headerCells ?? [])
    const variant = file.container === 'xlsx' ? 'xlsx' : file.container === 'tsv' ? 'tsv' : 'csv'
    return { institution: 'revolut', variant, confidence, hints: { locale } }
  },

  async parse(file: SourceFile, variant: string): Promise<ParsedStatement> {
    return (await parseGroups(file, variant))[0]!
  },

  parseAll: parseGroups,

  normalize(stmt: ParsedStatement): NormalizedRow[] {
    return (stmt.rows as unknown as (RRow & { sourceLine: number })[]).map((r) => {
      const amountMinor = Math.round(r.amount * 100) - Math.round(r.fee * 100)
      const feeMinor = Math.round(r.fee * 100)
      const merchant = cleanMerchant(r.description, r.type)
      const kind = revolutKind(r.type)
      let counterparty: string | undefined
      const desc = repairText(r.description)
      // Both prefixes are optional halves (#19): the outgoing descriptor is `To <name>`, not
      // `Transfer to …`, so the narrower strip was a no-op and left `To ` in the
      // counterparty — one person read as two identities depending on direction. Direction is not
      // lost by collapsing them: `mintKey` scopes a counterparty rule to the row's own sign.
      if (kind === 'transfer-in') counterparty = desc.replace(/^(?:payment\s+)?from\s+/i, '').trim() || undefined
      else if (kind === 'transfer-out') counterparty = desc.replace(/^(?:transfer\s+)?to\s+/i, '').trim() || undefined
      return {
        bookedDate: revolutDate(r.completed),
        amountMinor,
        currency: r.currency,
        feeMinor: feeMinor > 0 ? feeMinor : undefined,
        merchant,
        normDesc: normDesc(r.description),
        counterparty,
        kind,
        balanceAfterMinor: r.balance !== undefined ? Math.round(r.balance * 100) : undefined,
        sourceLine: r.sourceLine,
        // Verbatim descriptor, but with the encoding repaired (UTF-8-as-Latin-1 mojibake / OOXML
        // escapes) like merchant and normDesc — `r.description` raw would keep `CafÃ©`. `desc` is
        // already repairText(r.description): repair only, no NFKC/uppercase, so it stays verbatim.
        raw: desc,
      }
    })
  },
}

/**
 * One statement per product+currency (§5.8). A multi-currency (or multi-product)
 * export interleaves independent ledgers in one file: each has its own balance
 * chain — §5.6's invariant holds *within* an account, not across the file — its
 * own anchors and its own fingerprint. Always returns at least one statement.
 */
async function parseGroups(file: SourceFile, variant: string): Promise<ParsedStatement[]> {
  const { matrix } = await readMatrix(file, variant)
  const locale = detectLocale(matrix[0] ?? [])
  const { rows, unparsed, warning } = toRRows(matrix)

  // First-appearance order: the account the file opens with is reviewed first.
  const keyOf = (r: RRow) => `${slug(r.product || 'Current')}:${r.currency.toLowerCase()}`
  const groups = new Map<string, { rows: RRow[]; unparsed: string[] }>()
  const groupFor = (key: string) => {
    let g = groups.get(key)
    if (!g) {
      g = { rows: [], unparsed: [] }
      groups.set(key, g)
    }
    return g
  }
  for (const r of rows) groupFor(keyOf(r)).rows.push(r)
  for (const r of unparsed) groupFor(keyOf(r)).unparsed.push(r.description || r.type)
  if (groups.size === 0) groups.set('current:eur', { rows: [], unparsed: [] })
  return [...groups.values()].map((g) => statementFor(g.rows, variant, locale, warning, g.unparsed))
}

function statementFor(rows: RRow[], variant: string, locale: string, warning: boolean, unparsed: string[]): ParsedStatement {
  let pending = 0
  let reverted = 0
  const completed: RRow[] = []
  for (const r of rows) {
    if (r.state === 'COMPLETED') completed.push(r)
    else if (r.state === 'PENDING') pending++
    else if (r.state === 'REVERTED') reverted++
    else completed.push(r) // unknown state → import, flagged downstream by kind 'other'
  }

  // fingerprint from the product + currency this group is keyed by (§5.8)
  const product = rows[0]?.product || 'Current'
  const currency = rows[0]?.currency || 'EUR'
  const fingerprint = `revolut:${slug(product)}:${currency.toLowerCase()}`

  const dates = completed.map((r) => revolutDate(r.completed)).filter(Boolean).sort()
  const periodFrom = dates[0] ?? ''
  const periodTo = dates[dates.length - 1] ?? ''

  // Balance-chain anchors (§5.6): opening implied from the first row, closing = last balance.
  let openingBalance: number | undefined
  let closingBalance: number | undefined
  if (completed.length > 0) {
    const first = completed[0]!
    const last = completed[completed.length - 1]!
    if (first.balance !== undefined) openingBalance = round2(first.balance - (first.amount - first.fee))
    if (last.balance !== undefined) closingBalance = last.balance
  }

  const parsedRows: ParsedRow[] = completed.map((r, i) => ({ ...r, sourceLine: i }))
  return {
    institution: 'revolut',
    variant,
    locale,
    fingerprint,
    productName: product,
    accountCurrency: currency,
    periodFrom,
    periodTo,
    openingBalance,
    closingBalance,
    rows: parsedRows,
    skipped: { pending, reverted, unparsed },
    headerWarning: warning,
  }
}

function revolutKind(type: string): NormalizedRow['kind'] {
  switch (type.toLowerCase()) {
    case 'card payment':
      return 'expense'
    case 'card refund':
      return 'refund'
    case 'topup':
      return 'transfer-in'
    case 'transfer':
      return 'transfer-out'
    default:
      return 'other'
  }
}

function cleanMerchant(description: string, type: string): string {
  let s = repairText(description).trim()
  s = s.replace(/^(SQ|SUMUP|IZ)\s?\*\s*/i, '') // payment-processor prefixes
  if (/^payment from\s+/i.test(s)) s = s.replace(/^payment from\s+/i, '')
  else if (/^transfer to\s+/i.test(s)) s = s.replace(/^transfer to\s+/i, '')
  return s || type
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
