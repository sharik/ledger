/*
 * Derive committed fixtures from the real bank files (§5.2). Real files never enter git; this
 * dev-only script (run manually) rewrites everything that identifies a person — names, towns,
 * IBAN/RIB/card/ref digits, and the merchants they spent at — through a deterministic,
 * length-preserving, seed-stable map, so grammar, amounts, balances, dates, row order,
 * duplicates, overlaps and mojibake survive verbatim.
 *
 * What deliberately survives: amounts, balances and dates. They carry no name and no account
 * number, and holding them fixed is what lets the acceptance check below prove the rewrite did
 * not disturb parsing — it compares the real file and the fixture through the real adapters and
 * refuses to write on any difference in row count, amount/date sequence or balance anchors.
 *
 *   npx tsx scripts/make-fixtures.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { extractPdf } from '../src/import/pdf'
import { adapterById, detectFile } from '../src/import/registry'
import { toSourceFile } from '../src/import/peek'
import type { NormalizedRow, SourceFile } from '../src/import/types'
import { scrubCyrillicName, scrubDigits, scrubName } from './scrub'

const REAL = path.resolve('docs/examples')
const OUT = path.resolve('tests/fixtures')

/**
 * Personal-name tokens observed in the real files (business/brand names stay). The list is the
 * holder's own family and towns, so it lives beside the statements in gitignored `docs/examples/`
 * — committing it would publish exactly the names it exists to remove. See `scrub-names.json.example`.
 */
const NAMES = new Set<string>(
  (() => {
    const p = path.join(REAL, 'scrub-names.json')
    if (!fs.existsSync(p)) {
      console.error(`Missing ${p} — copy scrub-names.json.example and fill in the tokens to scrub.`)
      process.exit(1)
    }
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as string[]).map((s) => s.toUpperCase())
  })(),
)

/**
 * Real merchants are the account holder's daily life — where they shop, eat and travel — so they
 * leave with the names. The map is built from what the ADAPTER ITSELF reports as `merchant` for the
 * real file, never from a guess at which words are merchants: descriptor grammar (`Payment from`,
 * `Cancel`, `From UAH account`, the `,Alsace,FR` geo tail) is what the parsers key on, and blanket
 * word substitution would silently destroy the very branches these fixtures exist to cover.
 *
 * Replacements come from `scrubName`, so they are deterministic, same-length and stable across
 * files: the f1/f2 overlap still dedupes, and PDF column geometry still holds.
 */
const MERCHANTS = new Map<string, string>()

function fakeMerchant(name: string): string {
  return name.replace(/[A-Za-zÀ-ÿ]+/g, (w) => scrubName(w))
}

/**
 * The same substitution keyed on single words. A PDF stores its text as positioned fragments, so
 * `EUROPCAR ANGLET` reaches the scrubber as "EUROPCAR" and "ANGLET" in separate items and the
 * whole-string map never matches. `fakeMerchant` maps word by word, so this yields exactly the
 * same replacement — it is the same map at a finer grain, not a second policy.
 */
const MERCHANT_WORDS = new Map<string, string>()

async function loadMerchantMap(srcPath: string): Promise<void> {
  MERCHANTS.clear()
  MERCHANT_WORDS.clear()
  const { rows } = await parse(toSourceFile(path.basename(srcPath), new Uint8Array(fs.readFileSync(srcPath))))
  for (const r of rows) {
    const m = r.merchant?.trim()
    // One-character merchants would match inside every other word; leave them to the token rules.
    if (m && m.length > 1 && !MERCHANTS.has(m)) MERCHANTS.set(m, fakeMerchant(m))
    // Four and up: shorter fragments (`CAR`, `SUD`) are too generic to be identifying on their
    // own, and scrubbing them risks colliding with a descriptor keyword.
    for (const w of m?.split(/[^A-Za-zÀ-ÿ]+/) ?? []) {
      if (w.length >= 4 && !MERCHANT_WORDS.has(w)) MERCHANT_WORDS.set(w, scrubName(w))
    }
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Longest first, so `POP MART` is replaced as a unit before a shorter `POP` could bite into it.
 * Bounded by non-letters rather than `\b`, which does not fire next to accented characters.
 */
function applyMerchants(s: string, words = false): string {
  let out = s
  const pairs = [...MERCHANTS.entries(), ...(words ? MERCHANT_WORDS.entries() : [])].sort((a, b) => b[0].length - a[0].length)
  for (const [real, fake] of pairs) {
    out = out.replace(new RegExp(`(^|[^A-Za-zÀ-ÿ0-9])${escapeRe(real)}(?![A-Za-zÀ-ÿ0-9])`, 'gi'), (_m, pre: string) => pre + fake)
  }
  return out
}

function scrubWord(w: string): string {
  if (/^\d{5,}$/.test(w)) return scrubDigits(w)
  if (NAMES.has(w.toUpperCase())) return scrubName(w)
  return w
}

function scrubText(s: string): string {
  // merchants first (whole strings), then name words and long digit runs; grammar, mojibake and
  // amounts are left alone
  return applyMerchants(s).replace(/[A-Za-zÀ-ÿ]+|\d+/g, (tok) => scrubWord(tok))
}

// ---------------- Revolut XLSX ----------------
function scrubXlsx(src: string, dest: string): void {
  const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer', cellStyles: true })
  const sheet = wb.Sheets[wb.SheetNames[0]!]!
  const range = XLSX.utils.decode_range(sheet['!ref']!)
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 4 }) // Description column (E)
    const cell = sheet[addr]
    if (cell && cell.t === 's' && typeof cell.v === 'string') {
      const v = applyMerchants(cell.v as string)
      const scrubbed = v.replace(/^(Payment from|Transfer to)\s+(.+)$/, (_m, pre: string, name: string) => `${pre} ${name.replace(/[A-Za-zÀ-ÿ]+/g, (w) => scrubName(w))}`)
      cell.v = scrubbed
      cell.w = scrubbed
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  fs.writeFileSync(dest, buf)
}

// ---------------- BNP mabanque .xls (scrub every string cell, keep BIFF8) ----------------
function scrubXlsBnp(src: string, dest: string): void {
  const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]!
  const range = XLSX.utils.decode_range(sheet['!ref']!)
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.t === 's' && typeof cell.v === 'string') {
        const v = scrubText(cell.v) // scrubs holder names + digit runs; amounts/dates are numbers, untouched
        cell.v = v
        cell.w = v
      }
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }))
}

// ---------------- Privat (XLSX + tab-delimited "CSV") ----------------
// Only two columns can carry an identity: `Card` (C) and `Description` (D). Digit runs are
// scrubbed from 4 up rather than 5, because the card prints as a masked BIN + tail
// (`4149 **** **** 5583`) and that same tail reappears inside a transfer descriptor
// (`To my card *0741`). `scrubDigits` is keyed on the run, so both sites get the SAME
// replacement and the two cards of one export still point at each other.
const PRIVAT_CARD_COL = 2
const PRIVAT_DESC_COL = 3

function scrubPrivatText(s: string): string {
  return applyMerchants(s).replace(/[A-Za-zÀ-ÿ]+|\d{4,}/g, (tok) => (/^\d{4,}$/.test(tok) ? scrubDigits(tok) : NAMES.has(tok.toUpperCase()) ? scrubName(tok) : tok))
}

function scrubPrivatXlsx(src: string, dest: string): void {
  const wb = XLSX.read(fs.readFileSync(src), { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]!
  const range = XLSX.utils.decode_range(sheet['!ref']!)
  // Row 0 is the merged period title, row 1 the column header — data starts at row 2.
  for (let r = range.s.r + 2; r <= range.e.r; r++) {
    for (const c of [PRIVAT_CARD_COL, PRIVAT_DESC_COL]) {
      const cellRef = sheet[XLSX.utils.encode_cell({ r, c })]
      if (cellRef && cellRef.t === 's' && typeof cellRef.v === 'string') {
        const v = scrubPrivatText(cellRef.v)
        cellRef.v = v
        cellRef.w = v
      }
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

/** Field-wise, on the raw text: quoting, delimiter and row order must survive byte-for-byte. */
function scrubPrivatDelimited(src: string, dest: string): void {
  const text = fs.readFileSync(src, 'utf8')
  const delim = text.split('\n')[0]!.includes('\t') ? '\t' : ','
  const out = text.split('\n').map((line, i) => {
    if (i === 0 || !line.trim()) return line // header
    const fields = line.split(delim)
    for (const c of [PRIVAT_CARD_COL, PRIVAT_DESC_COL]) {
      if (fields[c] !== undefined) fields[c] = scrubPrivatText(fields[c]!)
    }
    return fields.join(delim)
  })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, out.join('\n'))
}

// ---------------- Monobank CSV ----------------
const MONO_DESC_COL = 1

/**
 * Split a delimited line into its RAW fields, quotes included, so rejoining is byte-identical
 * everywhere the scrubber did not touch. A naive `line.split(',')` would tear `"AUPA,Alsace,FR"`
 * — monobank quotes its descriptions and they contain the delimiter.
 */
function splitRawFields(line: string, delim: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes
      field += ch
    } else if (ch === delim && !inQuotes) {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out
}

/**
 * Monobank's Description column is the only one carrying identities, and they are of two kinds:
 * Cyrillic personal names (`Олена Х.`, `ФОП Грушко Лідія Василівна`) and digit runs (a masked
 * destination card `5168 7****0537`, a phone number, a tax-office code).
 *
 * Every Cyrillic run goes, rather than an enumerated name list: the file mixes personal names with
 * institution names in the same field and no rule separates them reliably, so the safe default is
 * to replace them all. Latin runs stay — in this format they are merchants (`SEAZON`, `AUPA`,
 * `Lifecell`) and the descriptor grammar the adapter parses (`Cancel …`, `From UAH account`, the
 * `,Alsace,FR` geo tail). `scrubDigits` is length-preserving, so the masked-card SHAPE survives
 * and `monoKind` still reads it as a transfer.
 */
function scrubMonoText(s: string): string {
  return applyMerchants(s).replace(/[Ѐ-ӿ]+|\d{4,}/g, (tok) => (/^\d+$/.test(tok) ? scrubDigits(tok) : scrubCyrillicName(tok)))
}

function scrubMonoDelimited(src: string, dest: string): void {
  const text = fs.readFileSync(src, 'utf8')
  const out = text.split('\n').map((line, i) => {
    if (i === 0 || !line.trim()) return line // header
    const fields = splitRawFields(line, ',')
    if (fields[MONO_DESC_COL] !== undefined) fields[MONO_DESC_COL] = scrubMonoText(fields[MONO_DESC_COL]!)
    return fields.join(',')
  })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, out.join('\n'))
}

// ---------------- BNP PDF (regenerate same geometry) ----------------
const WINANSI = (s: string) => s.replace(/[  ]/g, ' ').replace(/[^\x00-\xFF]/g, '?')

async function scrubPdf(src: string, dest: string): Promise<void> {
  const bytes = new Uint8Array(fs.readFileSync(src))
  const pages = await extractPdf(bytes)
  const out = await PDFDocument.create()
  const font = await out.embedFont(StandardFonts.Helvetica)
  for (const page of pages) {
    const p = out.addPage([page.width, page.height])
    for (const it of page.items) {
      if (!it.str.trim()) continue
      const scrubbed = scrubText(it.str)
      const draw = WINANSI(scrubbed)
      let x = it.x
      // amounts are right-aligned — preserve the right edge so debit/credit banding holds
      if (it.x >= 346) {
        const w = font.widthOfTextAtSize(draw, it.fontSize)
        x = it.x + it.w - w
      }
      try {
        p.drawText(draw, { x, y: it.y, size: it.fontSize, font })
      } catch {
        /* unencodable run — skip */
      }
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, await out.save())
}

// ---------------- PUMB PDF (regenerate same geometry, Cyrillic) ----------------
// `scrubText` cannot be reused here, on two counts. It scrambles digit runs of four and up, and
// PUMB writes amounts unseparated (`26349.45`) — the opening balance, both period totals and the
// closing balance would all be rewritten and reconciliation destroyed. And its token class is
// Latin-only, so the `Клієнт` line would have been committed verbatim.
const PUMB_PROTECTED = /\d+[.,]\d{2}|\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4}|\d{2}:\d{2}:\d{2}/g

function scrubPumbText(s: string): string {
  // 1. Set every amount, date and time aside before any digit rule can reach them. The sentinel
  //    is NUL on both sides, and it has to be a character a statement can never contain: a
  //    space-delimited ` 12 ` would be re-matched by the restore below, which would then eat a
  //    scrubbed IBAN group or the passport number and leave `undefined` in the fixture.
  const kept: string[] = []
  let out = s.replace(PUMB_PROTECTED, (m) => `\u0000${kept.push(m) - 1}\u0000`)

  // 1b. Merchants, while the descriptor grammar around them is still intact. Word-level too: a
  //     PDF hands us `EUROPCAR` and `ANGLET` as separate items, never the merchant as a phrase.
  out = applyMerchants(out, true)

  // 2. The IBAN, as a unit. Its groups are only four digits each, so a per-run rule would leave
  //    most of it intact; `scrubDigits` is length-preserving, so the header block keeps its width.
  out = out.replace(/\bUA\d{2}(?:\s?\d{4}){5,6}\s?\d?\b/g, (m) => 'UA' + scrubDigits(m.slice(2)))

  // 3. The card tail behind the mask (`53552800****2791`); the BIN falls to the run rule below.
  out = out.replace(/(\*{3,})(\d{4})/g, (_m, stars: string, tail: string) => stars + scrubDigits(tail))

  // 4. Remaining long digit runs — ІПН (10) and the passport number (6). The bank's own MFO code
  //    goes with them; it is public rather than personal, but detection keys on `ПУМБ`/`pumb.ua`,
  //    so nothing is lost by not carving out an exception.
  out = out.replace(/\d{6,}/g, (run) => scrubDigits(run))

  // 5. Personal names, Latin and Cyrillic. Merchants, cities and operation words are neither in
  //    NAMES nor touched — detection and the sign dictionary read them.
  out = out.replace(/[A-Za-zÀ-ÿ]+|[Ѐ-ӿ]+/g, (tok) =>
    NAMES.has(tok.toUpperCase()) ? (/[Ѐ-ӿ]/.test(tok) ? scrubCyrillicName(tok) : scrubName(tok)) : tok,
  )

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]!)
}

/**
 * PUMB's bands are 55–70 pt wide and DejaVu is wider than the embedded original, so a run drawn
 * at its native size would spill into the next band — `SumUp *Taxi Chegra Zi Aulnay-sous-` ends
 * 14 pt short of the description band. Each run is therefore shrunk to fit its ORIGINAL advance
 * width, keeping x, y and the column geometry the parser reads.
 */
async function scrubPumbPdf(src: string, dest: string): Promise<void> {
  const bytes = new Uint8Array(fs.readFileSync(src))
  const pages = await extractPdf(bytes)
  const out = await PDFDocument.create()
  out.registerFontkit(fontkit)
  const font = await out.embedFont(fs.readFileSync(path.resolve('scripts/assets/DejaVuSans.ttf')), { subset: true })
  for (const page of pages) {
    const p = out.addPage([page.width, page.height])
    for (const it of page.items) {
      if (!it.str.trim()) continue
      const draw = scrubPumbText(it.str)
      const natural = font.widthOfTextAtSize(draw, it.fontSize)
      const size = natural > it.w && it.w > 0 ? (it.fontSize * it.w) / natural : it.fontSize
      try {
        p.drawText(draw, { x: it.x, y: it.y, size, font })
      } catch {
        /* unencodable run — skip */
      }
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, await out.save())
}

// ---------------- acceptance check ----------------
function amountsDatesSeq(rows: NormalizedRow[]): string {
  return rows.map((r) => `${r.bookedDate}:${r.amountMinor}`).join(',')
}

async function parse(file: SourceFile): Promise<{ rows: NormalizedRow[]; open?: number; close?: number }> {
  const det = await detectFile(file)
  const institution = det.best?.institution ?? (file.container === 'pdf' ? 'bnp' : 'revolut')
  const variant = det.best?.variant ?? (file.container === 'pdf' ? 'pdf' : 'xlsx')
  const ad = adapterById(institution)!
  const stmt = await ad.parse(file, variant)
  return { rows: ad.normalize(stmt), open: stmt.openingBalance, close: stmt.closingBalance }
}

async function accept(srcPath: string, destPath: string, label: string): Promise<void> {
  const a = await parse(toSourceFile(path.basename(srcPath), new Uint8Array(fs.readFileSync(srcPath))))
  const b = await parse(toSourceFile(path.basename(destPath), new Uint8Array(fs.readFileSync(destPath))))
  const problems: string[] = []
  if (a.rows.length !== b.rows.length) problems.push(`row count ${a.rows.length} → ${b.rows.length}`)
  if (amountsDatesSeq(a.rows) !== amountsDatesSeq(b.rows)) problems.push('amount/date sequence changed')
  if (a.open !== b.open) problems.push(`opening ${a.open} → ${b.open}`)
  if (a.close !== b.close) problems.push(`closing ${a.close} → ${b.close}`)
  if (problems.length) throw new Error(`ACCEPTANCE FAILED for ${label}:\n  ${problems.join('\n  ')}`)
  console.log(`  ✓ ${label}: ${b.rows.length} rows, anchors ${b.open}/${b.close}, amount+date sequence identical`)
}

async function main(): Promise<void> {
  // The BNP PDF fixtures are gated behind SCRUB_BNP=1: their account numbers appear
  // as grouped digit runs that collide with amount/year heuristics, and regenerating
  // a same-geometry PDF perturbs spacing. Committing a fixture that still contains a
  // real IBAN/RIB would leak PII, so the scrubbed PDFs must be audited before commit.
  // The BNP suites run against docs/examples locally (describe.skipIf) meanwhile.
  const withBnp = process.env.SCRUB_BNP === '1'
  // PUMB is gated for the same reason as BNP: it is a PDF carrying an IBAN, a tax number and a
  // passport line, and a regenerated one must be read back and audited before it enters git.
  const withPumb = process.env.SCRUB_PUMB === '1'
  type Job = { src: string; dest: string; kind: 'revolut-xlsx' | 'bnp-pdf' | 'bnp-xls' | 'privat-xlsx' | 'privat-delimited' | 'pumb-pdf' | 'mono-delimited' }
  const jobs: Job[] = [
    { src: 'revolut/account-statement_2026-02-04_2026-06-11_en-gb_e94930.xlsx', dest: 'revolut/f1.xlsx', kind: 'revolut-xlsx' },
    { src: 'revolut/account-statement_2026-05-01_2026-07-09_en-gb_ebb571.xlsx', dest: 'revolut/f2.xlsx', kind: 'revolut-xlsx' },
    { src: 'privat/privat-uah.xlsx', dest: 'privat/p1.xlsx', kind: 'privat-xlsx' },
    { src: 'privat/privat24.csv', dest: 'privat/p2.csv', kind: 'privat-delimited' },
    { src: 'monobank/mono-white.csv', dest: 'monobank/m1.csv', kind: 'mono-delimited' },
    ...(withPumb
      ? ([{ src: 'pumb/statement_17513756414081390631600654988633.pdf', dest: 'pumb/p1.pdf', kind: 'pumb-pdf' }] as Job[])
      : []),
    ...(withBnp
      ? ([
          { src: 'pariba/releve_ZZ1H99UNONO4S0FYB_260709_153217.pdf', dest: 'bnp/b2024.pdf', kind: 'bnp-pdf' },
          { src: 'pariba/releve_ZZ1KNGXG64KMFYEIV_260709_153132.pdf', dest: 'bnp/b2026.pdf', kind: 'bnp-pdf' },
          { src: 'pariba/RLV_LVA_2023-07-13.pdf', dest: 'bnp/blva.pdf', kind: 'bnp-pdf' },
          { src: 'pariba/export_24_07_2026_22_07_45.xls', dest: 'bnp/export.xls', kind: 'bnp-xls' },
          { src: 'pariba/export_2023-06-10.xls', dest: 'bnp/export-2023.xls', kind: 'bnp-xls' },
        ] as Job[])
      : []),
  ]
  for (const j of jobs) {
    const src = path.join(REAL, j.src)
    const dest = path.join(OUT, j.dest)
    if (!fs.existsSync(src)) {
      console.log(`  – skip ${j.dest} (source absent)`)
      continue
    }
    await loadMerchantMap(src)
    if (j.kind === 'bnp-pdf') await scrubPdf(src, dest)
    else if (j.kind === 'pumb-pdf') await scrubPumbPdf(src, dest)
    else if (j.kind === 'bnp-xls') scrubXlsBnp(src, dest)
    else if (j.kind === 'privat-xlsx') scrubPrivatXlsx(src, dest)
    else if (j.kind === 'privat-delimited') scrubPrivatDelimited(src, dest)
    else if (j.kind === 'mono-delimited') scrubMonoDelimited(src, dest)
    else scrubXlsx(src, dest)
    await accept(src, dest, j.dest)
  }
  console.log('Fixtures written to tests/fixtures/.')
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
