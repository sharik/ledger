/*
 * Regenerate golden JSON for every committed fixture (§5.2.1): a `.parsed.json`
 * (ParsedStatement) and `.normalized.json` (NormalizedRow[]) beside each file.
 * Dev-only, run manually — the goldens test never regenerates silently.
 *
 *   npm run fixtures:goldens
 */
import fs from 'node:fs'
import path from 'node:path'
import { adapterById } from '../src/import/registry'
import { toSourceFile } from '../src/import/peek'

const FIX = path.resolve('tests/fixtures')

const targets = [
  { file: 'revolut/f1.xlsx', institution: 'revolut', variant: 'xlsx' },
  { file: 'revolut/f2.xlsx', institution: 'revolut', variant: 'xlsx' },
  { file: 'bnp/b2024.pdf', institution: 'bnp', variant: 'pdf' },
  { file: 'bnp/b2026.pdf', institution: 'bnp', variant: 'pdf' },
  { file: 'bnp/export.xls', institution: 'bnp', variant: 'xls' },
  { file: 'privat/p1.xlsx', institution: 'privat', variant: 'xlsx' },
  // A Privat "csv" is tab-delimited — `sniffContainer` types the real file `tsv` and detection
  // passes that on as the variant, so the golden must be generated the same way.
  { file: 'privat/p2.csv', institution: 'privat', variant: 'tsv' },
  { file: 'pumb/p1.pdf', institution: 'pumb', variant: 'pdf' },
  { file: 'monobank/m1.csv', institution: 'monobank', variant: 'csv' },
]

async function main(): Promise<void> {
  for (const t of targets) {
    const p = path.join(FIX, t.file)
    if (!fs.existsSync(p)) continue
    const ad = adapterById(t.institution)!
    const stmt = await ad.parse(toSourceFile(path.basename(p), new Uint8Array(fs.readFileSync(p))), t.variant)
    const norm = ad.normalize(stmt)
    fs.writeFileSync(p.replace(/\.\w+$/, '.parsed.json'), JSON.stringify(stmt, null, 2) + '\n')
    fs.writeFileSync(p.replace(/\.\w+$/, '.normalized.json'), JSON.stringify(norm, null, 2) + '\n')
    console.log(`  ✓ goldens for ${t.file} (${norm.length} rows)`)
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
