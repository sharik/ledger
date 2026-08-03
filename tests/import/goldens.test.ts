import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { adapterById } from '../../src/import/registry'
import { toSourceFile } from '../../src/import/peek'
import { FIXTURE_DIR } from '../helpers/importing'

// Committed, anonymized fixtures (scrubbed from the real files, §5.2). These run
// everywhere — CI included — proving the adapters against goldens without the real
// personal data. Regenerate with `npm run fixtures:goldens`.
const FIXTURES = [
  { file: 'revolut/f1.xlsx', institution: 'revolut', variant: 'xlsx', rows: 330, open: 1571.35, close: 2738.89 },
  { file: 'revolut/f2.xlsx', institution: 'revolut', variant: 'xlsx', rows: 195, open: 703.55, close: 2372.54 },
  { file: 'privat/p1.xlsx', institution: 'privat', variant: 'xlsx', rows: 73, open: -200.87, close: 12410.01 },
  // Tab-delimited despite the extension — `parse` gets the sniffed `tsv` variant, not `csv`.
  // Only the FIRST card of this two-card export; the split itself is pinned in privat.test.ts.
  { file: 'privat/p2.csv', institution: 'privat', variant: 'tsv', rows: 11, open: 341.38, close: 2979.9 },
  // The only committed PDF fixture. Regenerating it needs the vendored Cyrillic font — pdf-lib's
  // standard fonts are WinAnsi and would turn every Ukrainian glyph into `?`.
  { file: 'pumb/p1.pdf', institution: 'pumb', variant: 'pdf', rows: 11, open: 26349.45, close: 11525.3 },
  // Written newest-first; the anchors below are the CHRONOLOGICAL ends, so this row also pins the
  // reversal the adapter performs (§18.3).
  { file: 'monobank/m1.csv', institution: 'monobank', variant: 'csv', rows: 23, open: 5254.11, close: 10133.8 },
]

const present = FIXTURES.filter((f) => fs.existsSync(path.join(FIXTURE_DIR, f.file)))
const d = present.length > 0 ? describe : describe.skip

d('golden fixtures (§5.2.1)', () => {
  for (const fx of present) {
    const p = path.join(FIXTURE_DIR, fx.file)
    const load = () => toSourceFile(path.basename(p), new Uint8Array(fs.readFileSync(p)))

    it(`${fx.file}: parses to ${fx.rows} rows and reconciles`, async () => {
      const ad = adapterById(fx.institution)!
      const stmt = await ad.parse(load(), fx.variant)
      expect(stmt.rows.length).toBe(fx.rows)
      expect(stmt.openingBalance).toBe(fx.open)
      expect(stmt.closingBalance).toBe(fx.close)
      const norm = ad.normalize(stmt)
      const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
      expect(Math.round(fx.open * 100) + sum).toBe(Math.round(fx.close * 100))
    })

    it(`${fx.file}: matches the committed goldens`, async () => {
      const parsedGolden = p.replace(/\.\w+$/, '.parsed.json')
      const normGolden = p.replace(/\.\w+$/, '.normalized.json')
      if (!fs.existsSync(parsedGolden)) return
      const ad = adapterById(fx.institution)!
      const stmt = await ad.parse(load(), fx.variant)
      const norm = ad.normalize(stmt)
      expect(JSON.parse(JSON.stringify(stmt))).toEqual(JSON.parse(fs.readFileSync(parsedGolden, 'utf8')))
      expect(JSON.parse(JSON.stringify(norm))).toEqual(JSON.parse(fs.readFileSync(normGolden, 'utf8')))
    })
  }
})
