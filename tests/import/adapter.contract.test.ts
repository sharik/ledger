import { describe, it, expect } from 'vitest'
import { adapterById } from '../../src/import/registry'
import { hashRows } from '../../src/import/identity'
import { have, loadFile, REAL } from '../helpers/importing'

// Shared conformance suite run over EVERY adapter (IMPORT §3.3). `docs/examples` is gitignored
// and files land in it over time, so each case is gated on its own input rather than on the pair
// `haveReal()` happens to check.
const CASES = [
  { id: 'revolut', variant: 'xlsx', file: () => REAL.f1, key: 'revolut:current:eur' },
  // Placeholder, like PUMB and Monobank below: BNP's real fingerprint is the account's RIB.
  { id: 'bnp', variant: 'pdf', file: () => REAL.b2026, key: 'bnp:account' },
  { id: 'privat', variant: 'xlsx', file: () => REAL.privatXlsx, key: 'privat:4149-5583:uah' },
  // A placeholder key, unlike the rows above: PUMB's fingerprint is the account's IBAN, which is
  // personal data and has no business in a committed file. What the suite proves — that two
  // parses of one file hash identically — holds for any stable key.
  { id: 'pumb', variant: 'pdf', file: () => REAL.pumb, key: 'pumb:account' },
  // Monobank states no account key at all, so the pipeline hashes its rows under the `local:`
  // fallback it derives from institution + currency. Same argument as PUMB's placeholder above.
  { id: 'monobank', variant: 'csv', file: () => REAL.mono, key: 'local:monobank:uah' },
] as const

const d = CASES.some((c) => have(c.file())) ? describe : describe.skip

d('adapter conformance (§3.3)', () => {
  for (const c of CASES.filter((x) => have(x.file()))) {
    it(`${c.id}: rows are source-ordered and two parses hash identically`, async () => {
      const ad = adapterById(c.id)!
      const n1 = ad.normalize(await ad.parse(loadFile(c.file()), c.variant))
      const n2 = ad.normalize(await ad.parse(loadFile(c.file()), c.variant))
      expect(n1.map((r) => r.sourceLine)).toEqual(n1.map((_, i) => i))
      const h1 = await hashRows(n1, c.key)
      const h2 = await hashRows(n2, c.key)
      expect(h1).toEqual(h2)
    })

    it(`${c.id}: declared balances enable reconciliation and skip accounting sums to rowsTotal`, async () => {
      const ad = adapterById(c.id)!
      const stmt = await ad.parse(loadFile(c.file()), c.variant)
      expect(stmt.openingBalance).toBeDefined()
      expect(stmt.closingBalance).toBeDefined()
      const total = stmt.rows.length + stmt.skipped.pending + stmt.skipped.reverted
      expect(total).toBeGreaterThanOrEqual(stmt.rows.length)
    })
  }
})
