import type { Container, Peek, SourceFile } from './types'
import { firstPageText } from './pdf'
import { parseDelimited } from './adapters/revolut'

function indexOfAscii(bytes: Uint8Array, needle: string, limit = bytes.length): number {
  const n = needle.length
  for (let i = 0; i + n <= limit; i++) {
    let ok = true
    for (let j = 0; j < n; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

/** Count a delimiter's occurrences outside double-quotes. */
function countOutsideQuotes(line: string, delim: string): number {
  let n = 0
  let inQ = false
  for (const ch of line) {
    if (ch === '"') inQ = !inQ
    else if (!inQ && ch === delim) n++
  }
  return n
}

/** Content-based container sniff — magic bytes first, delimiter mode for text (§3.2). */
export function sniffContainer(bytes: Uint8Array): Container {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'xlsx' // PK.. — OOXML zip ([Content_Types].xml expected)
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'xlsx' // OLE/CDFV2 magic — legacy BIFF8 .xls (BNP mabanque export); SheetJS reads it like OOXML
  }
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'pdf' // %PDF
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 8192))
  const lines = text.split('\n').slice(0, 20).filter((l) => l.trim())
  let tab = 0
  let comma = 0
  let semi = 0
  for (const l of lines) {
    tab += countOutsideQuotes(l, '\t')
    comma += countOutsideQuotes(l, ',')
    semi += countOutsideQuotes(l, ';')
  }
  if (tab >= comma && tab >= semi && tab > 0) return 'tsv'
  return 'csv'
}

export function isXlsxZip(bytes: Uint8Array): boolean {
  return indexOfAscii(bytes, '[Content_Types].xml', Math.min(bytes.length, 1 << 20)) >= 0
}

/** Build the cheap Peek a detector needs. Reads only headers / first page. */
export async function buildPeek(file: SourceFile): Promise<Peek> {
  if (file.container === 'xlsx') {
    const XLSX = await import('xlsx')
    // Read a few rows: Revolut's header is row 0, but the BNP mabanque .xls carries a preamble
    // on row 0 and its column header on row 2 — the detector needs both (§3.2).
    const wb = XLSX.read(file.bytes, { type: 'array', sheetRows: 6 })
    const sheet = wb.Sheets[wb.SheetNames[0]!]
    const matrix = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: true }) : []
    const sheetRows = matrix.map((r) => (r ?? []).map((c) => String(c ?? '')))
    return { container: 'xlsx', headerCells: sheetRows[0] ?? [], sheetRows, fileName: file.name }
  }
  if (file.container === 'pdf') {
    const text = await firstPageText(file.bytes)
    return { container: 'pdf', firstPageText: text, fileName: file.name }
  }
  const text = new TextDecoder('utf-8').decode(file.bytes)
  const delim = file.container === 'tsv' ? '\t' : ','
  const rows = parseDelimited(text, delim)
  const textLines = text.split('\n').slice(0, 20)
  return { container: file.container, headerCells: rows[0] ?? [], textLines, fileName: file.name }
}

/** Make a SourceFile from raw bytes, sniffing the container. */
export function toSourceFile(name: string, bytes: Uint8Array): SourceFile {
  return { name, bytes, container: sniffContainer(bytes) }
}
