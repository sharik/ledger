import fs from 'node:fs'
import { extractPdf } from '../../src/import/pdf'
async function main() {
  const b = new Uint8Array(fs.readFileSync('docs/examples/pumb/statement_17513756414081390631600654988633.pdf'))
  const pages = await extractPdf(b)
  const items = pages.flatMap((p) => p.items).filter((i) => /EUROPCAR|MAXICOFFEE|ANGLET/i.test(i.str))
  console.log(items.map((i) => JSON.stringify(i.str)).join('\n'))
}
main()
