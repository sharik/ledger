// Shared pdf.js text-run extraction + visual-line reconstruction (IMPORT §6.2).
// Pure geometry; consumed by the BNP adapter and by peek. pdf.js is lazy-loaded.

export interface TextItem {
  x: number
  y: number
  w: number
  fontSize: number
  str: string
}

export interface VisualLine {
  y: number
  items: TextItem[]
  text: string // space-rebuilt
}

export interface PdfPage {
  items: TextItem[]
  width: number
  height: number
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let workerConfigured = false
let sharedWorker: unknown = null
let standardFontDataUrl: string | undefined

async function loadPdfjs(): Promise<Pdfjs> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!workerConfigured) {
    workerConfigured = true
    const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node
    if (isNode && !pdfjs.GlobalWorkerOptions.workerSrc) {
      const mod = (await import(/* @vite-ignore */ 'node:module')) as { createRequire: (u: string) => { resolve: (id: string) => string } }
      const url = (await import(/* @vite-ignore */ 'node:url')) as { pathToFileURL: (p: string) => { href: string } }
      const require = mod.createRequire(import.meta.url)
      const abs = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      ;(pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = url.pathToFileURL(abs).href
      // Standard-14 font data — needed to extract text from PDFs that use Helvetica
      // et al. (the scrubbed fixtures do; the real files embed Type 3 fonts).
      const pkg = require.resolve('pdfjs-dist/package.json')
      standardFontDataUrl = url.pathToFileURL(pkg.replace(/package\.json$/, 'standard_fonts/')).href
    } else if (!isNode && !pdfjs.GlobalWorkerOptions.workerSrc) {
      // Browser: point pdf.js at its bundled worker. Vite rewrites this `?url`
      // import to the hashed asset URL. Without it, getDocument() throws
      // `No "GlobalWorkerOptions.workerSrc" specified` and every PDF import fails.
      pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default
    }
  }
  return pdfjs
}

/**
 * A single reused worker. Node's loopback (fake) worker chokes on the *second*
 * getDocument in a process, so we spawn one real worker and share it across every
 * parse — never destroyed. In the browser this is a no-op (a per-doc worker is fine).
 */
async function sharedWorkerOpt(pdfjs: Pdfjs): Promise<Record<string, unknown>> {
  const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node
  if (!isNode) return {}
  if (!sharedWorker) {
    const Ctor = pdfjs.PDFWorker as unknown as new (opts?: Record<string, unknown>) => { promise: Promise<void> }
    const w = new Ctor({ name: 'ledger-import' })
    await w.promise
    sharedWorker = w
  }
  return { worker: sharedWorker }
}

export class ScannedPdfError extends Error {}
export class EncryptedPdfError extends Error {}

export async function extractPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await loadPdfjs()
  const workerOpt = await sharedWorkerOpt(pdfjs)
  let doc
  try {
    // pdf.js may transfer the buffer to the worker → hand it a copy so the caller's
    // bytes stay intact for fileHash and re-parse.
    const opts = { data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl, ...workerOpt }
    doc = await pdfjs.getDocument(opts as Parameters<typeof pdfjs.getDocument>[0]).promise
  } catch (e) {
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'PasswordException') throw new EncryptedPdfError('encrypted')
    throw e
  }
  const pages: PdfPage[] = []
  let totalItems = 0
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const items: TextItem[] = []
    for (const it of tc.items) {
      if (!('str' in it)) continue
      const t = it.transform
      items.push({
        x: t[4],
        y: t[5],
        w: it.width,
        fontSize: Math.hypot(t[2], t[3]) || it.height || 10,
        str: it.str,
      })
    }
    totalItems += items.length
    pages.push({ items, width: viewport.width, height: viewport.height })
  }
  try {
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.()
  } catch {
    /* proxy variant without destroy — fine */
  }
  if (totalItems === 0) throw new ScannedPdfError('no text layer')
  return pages
}

/**
 * Group a page's items into visual lines (y-tolerance 2 pt), sorted top-to-bottom
 * (PDF y-axis points up), items left-to-right, with spacing rebuilt where the gap
 * between consecutive items exceeds 0.25 × fontSize (§6.2).
 */
export function reconstructLines(page: PdfPage, yTol = 2): VisualLine[] {
  const lines: { y: number; items: TextItem[] }[] = []
  for (const it of page.items) {
    if (!it.str) continue
    let line = lines.find((l) => Math.abs(l.y - it.y) <= yTol)
    if (!line) {
      line = { y: it.y, items: [] }
      lines.push(line)
    }
    line.items.push(it)
  }
  lines.sort((a, b) => b.y - a.y)
  return lines.map((l) => {
    const items = [...l.items].sort((a, b) => a.x - b.x)
    let text = ''
    let prevRight: number | null = null
    for (const it of items) {
      if (prevRight !== null && it.x - prevRight > 0.25 * it.fontSize && !text.endsWith(' ') && !it.str.startsWith(' ')) {
        text += ' '
      }
      text += it.str
      prevRight = it.x + it.w
    }
    return { y: l.y, items, text: text.replace(/\s+/g, ' ').trim() }
  })
}

export async function firstPageText(bytes: Uint8Array): Promise<string> {
  const pages = await extractPdf(bytes)
  if (pages.length === 0) return ''
  return reconstructLines(pages[0]!)
    .map((l) => l.text)
    .join('\n')
}
