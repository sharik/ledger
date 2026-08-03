import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import type { Vault } from '../../src/model/types'
import { CAT_TRANSFERS } from '../../src/model/types'
import { findDuplicateImports, duplicateIds, resolveDuplicatesOp } from '../../src/analytics/duplicates'
import { applyOp } from '../../src/model/mutations'
import { acc, buildVault, catId, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

/** A committed imported row: what the audit actually reads is (account, file, date, amount, merchant). */
function imported(
  v: Vault,
  o: { accountId: string; file: string; date: string; amount: number; merchant: string; cat?: string; hash?: string },
) {
  const t = txn(v, o.date, o.merchant, o.cat ?? 'Other', o.amount)
  t.accountId = o.accountId
  t.importMeta = { hash: o.hash ?? `h-${o.file}-${o.date}-${o.amount}-${o.merchant}`, file: o.file }
  return t
}

// The false positives come first on purpose. This detector's whole value is that it stays quiet on
// them — every one of these was measured on a real vault and would be flagged by a naive
// same-amount/near-date scan (169 candidate pairs, of which exactly one was real).
describe('duplicate audit — the false positives must stay silent', () => {
  it('a subscription two people each pay is not a duplicate (different accounts, low match rate)', () => {
    // Measured at rate 0.021 on the real vault: two BNP accounts, two exports, €6.99 Amazon Prime
    // monthly on both. Everything else in the two files is unrelated.
    const v = buildVault((v) => {
      const his = acc(v, { name: 'BNP His', institutionId: 'bnp' })
      const hers = acc(v, { name: 'BNP Hers', institutionId: 'bnp' })
      for (let m = 1; m <= 6; m++) {
        const d = `2025-0${m}-20`
        imported(v, { accountId: his.id, file: 'his.xls', date: d, amount: -6.99, merchant: 'AMAZON PRIME FR PAYLI2' })
        imported(v, { accountId: hers.id, file: 'hers.xls', date: d, amount: -6.99, merchant: 'AMAZON PRIME FR' })
      }
      // …plus the bulk of each file, which shares nothing.
      for (let i = 0; i < 60; i++) {
        imported(v, { accountId: his.id, file: 'his.xls', date: '2025-03-05', amount: -(i + 11), merchant: `HIS ${i}` })
        imported(v, { accountId: hers.id, file: 'hers.xls', date: '2025-03-05', amount: -(i + 200), merchant: `HERS ${i}` })
      }
    })
    expect(findDuplicateImports(v)).toEqual([])
  })

  it('same-day repeats inside ONE file are kept — occurrence indexing creates them on purpose', () => {
    // SNCF ×3, tolls, Starbucks: 83 of the 169 naive candidates. One file is never compared to itself.
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Revolut EUR', institutionId: 'revolut' })
      for (let i = 0; i < 3; i++) imported(v, { accountId: a.id, file: 'revolut.csv', date: '2025-06-23', amount: -10, merchant: 'SNCF' })
      for (let i = 0; i < 2; i++) imported(v, { accountId: a.id, file: 'revolut.csv', date: '2025-06-24', amount: -1.5, merchant: 'Sanef' })
    })
    expect(findDuplicateImports(v)).toEqual([])
  })

  it('a monthly standing order is not a duplicate — the dates are a month apart', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'BNP', institutionId: 'bnp' })
      for (const d of ['2025-08-10', '2025-09-10', '2025-10-10', '2025-11-10']) {
        imported(v, { accountId: a.id, file: 'a.xls', date: d, amount: -200, merchant: 'SPIRICA' })
        imported(v, { accountId: a.id, file: 'b.xls', date: d, amount: -200, merchant: 'SPIRICA' })
      }
    })
    // Same date across two files IS a match — but that is the real duplicate case, so shift file b by
    // a month: now nothing lines up inside the ±1 day window.
    const shifted = buildVault((v) => {
      const a = acc(v, { name: 'BNP', institutionId: 'bnp' })
      for (const d of ['2025-08-10', '2025-09-10', '2025-10-10', '2025-11-10']) {
        imported(v, { accountId: a.id, file: 'a.xls', date: d, amount: -200, merchant: 'SPIRICA' })
      }
      for (const d of ['2025-08-25', '2025-09-25', '2025-10-25', '2025-11-25']) {
        imported(v, { accountId: a.id, file: 'b.xls', date: d, amount: -200, merchant: 'SPIRICA' })
      }
    })
    expect(findDuplicateImports(shifted)).toEqual([])
    // (the aligned vault above is a genuine restatement and SHOULD flag — asserted below)
    expect(findDuplicateImports(v).length).toBe(1)
  })

  it('both legs of a transfer are never a duplicate of each other', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'BNP', institutionId: 'bnp' })
      const b = acc(v, { name: 'Revolut', institutionId: 'revolut' })
      for (let i = 0; i < 5; i++) {
        const out = imported(v, { accountId: a.id, file: 'bnp.xls', date: '2025-03-02', amount: -4000, merchant: 'TO SELF' })
        const inn = imported(v, { accountId: b.id, file: 'rev.csv', date: '2025-03-02', amount: -4000, merchant: 'From BNP' })
        out.transferGroupId = `g${i}`
        inn.transferGroupId = `g${i}`
        out.categoryId = CAT_TRANSFERS
        inn.categoryId = CAT_TRANSFERS
      }
    })
    expect(findDuplicateImports(v)).toEqual([])
  })

  it('a tiny overlap cannot score 100% — minMatched guards the small denominator', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'BNP', institutionId: 'bnp' })
      imported(v, { accountId: a.id, file: 'a.pdf', date: '2023-03-02', amount: -4000, merchant: 'X' })
      imported(v, { accountId: a.id, file: 'b.csv', date: '2023-03-02', amount: -4000, merchant: 'Y' })
    })
    expect(findDuplicateImports(v)).toEqual([]) // 1 matched < DUP_MIN_MATCHED
  })
})

describe('duplicate audit — the real duplicate import', () => {
  // The measured case: revolut.csv (118 rows in the window) vs revolut-personal.csv (7 rows), all 7
  // matched. The merchant names disagree because the two exports name the same row differently —
  // the merchant vs its payment processor — so no descriptor comparison could ever find these.
  const built = () =>
    buildVault((v) => {
      const a = acc(v, { name: 'Revolut EUR', institutionId: 'revolut' })
      const drifted: [string, number, string, string][] = [
        ['2025-06-02', -50, 'Milwaukee Café', 'Milwaukee Cafe'],
        ['2025-06-08', -22, 'La Table Tournant', 'SumUp'],
        ['2025-06-09', -9, 'Laika Mtgerchg', 'SumUp'],
        ['2025-06-10', -11, 'Café Loky', 'Square'],
        ['2025-06-17', -40.73, 'Imagerie Médicale', 'Imagerie Medica'],
        ['2025-06-22', -49.61, 'Hyper Pacyl4', 'Shopping Payment'],
        ['2025-06-24', -8.6, 'Actal', 'Actal33596mcdo'],
      ]
      for (const [date, amount, big, small] of drifted) {
        imported(v, { accountId: a.id, file: 'revolut.csv', date, amount, merchant: big })
        imported(v, { accountId: a.id, file: 'revolut-personal.csv', date, amount, merchant: small })
      }
      // the rest of the larger file — unmatched, and the reason `max` would read only 6%
      for (let i = 0; i < 111; i++) {
        imported(v, { accountId: a.id, file: 'revolut.csv', date: '2025-06-15', amount: -(1000 + i), merchant: `Other ${i}` })
      }
    })

  it('finds exactly one finding, at a 100% match rate over the smaller file', () => {
    const found = findDuplicateImports(built())
    expect(found.length).toBe(1)
    const f = found[0]!
    expect(f.matched).toBe(7)
    // files are compared in name order, so `revolut-personal.csv` (7 rows) is side A here
    expect(f.inWindow).toEqual([7, 118])
    expect(f.matchRate).toBe(1) // matched / min — dividing by max would give 0.059 and miss it
    expect(f.window).toEqual(['2025-06-02', '2025-06-24'])
    expect(f.totalAmount).toBe(190.94)
  })

  it('keeps the older row of each pair — the same survivor a sync merge would pick', () => {
    const v = built()
    const f = findDuplicateImports(v)[0]!
    for (const p of f.pairs) {
      expect(p.keepId < p.dropId).toBe(true) // uuidv7 sorts oldest-first
    }
    expect(duplicateIds([f]).size).toBe(7)
  })

  it('flags a merchant pair with zero descriptor signal — but only inside the container', () => {
    // `La Table Tournant` vs `SumUp` is only knowable as a duplicate because its file was fully
    // matched. Alone in a vault, the identical pair must stay silent: it is indistinguishable from
    // a second €22 lunch.
    const inside = findDuplicateImports(built())[0]!
    expect(inside.pairs.some((p) => p.dropMerchant === 'SumUp' || p.keepMerchant === 'SumUp')).toBe(true)

    const alone = buildVault((v) => {
      const a = acc(v, { name: 'Revolut EUR', institutionId: 'revolut' })
      imported(v, { accountId: a.id, file: 'revolut.csv', date: '2025-06-08', amount: -22, merchant: 'La Table Tournant' })
      imported(v, { accountId: a.id, file: 'revolut-personal.csv', date: '2025-06-08', amount: -22, merchant: 'SumUp' })
    })
    expect(findDuplicateImports(alone)).toEqual([])
  })

  it('matches 1:1 — one row cannot absorb several from the other file', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'A', institutionId: 'bnp' })
      // file a has 3 identical rows, file b has 5 of the same shape: only 3 can pair.
      for (let i = 0; i < 3; i++) imported(v, { accountId: a.id, file: 'a.xls', date: '2025-05-05', amount: -7, merchant: 'X' })
      for (let i = 0; i < 5; i++) imported(v, { accountId: a.id, file: 'b.xls', date: '2025-05-05', amount: -7, merchant: 'X' })
    })
    const f = findDuplicateImports(v)[0]!
    expect(f.matched).toBe(3)
    expect(new Set(f.pairs.map((p) => p.dropId)).size).toBe(3) // no id claimed twice
    expect(new Set(f.pairs.map((p) => p.keepId)).size).toBe(3)
  })

  it('tolerates a one-day booked-vs-value date shift, but not two', () => {
    const mk = (shiftDays: number) =>
      buildVault((v) => {
        const a = acc(v, { name: 'A', institutionId: 'bnp' })
        const bDates = shiftDays === 1 ? ['2025-05-06', '2025-05-11', '2025-05-16'] : ['2025-05-07', '2025-05-12', '2025-05-17']
        for (const d of ['2025-05-05', '2025-05-10', '2025-05-15']) {
          imported(v, { accountId: a.id, file: 'a.xls', date: d, amount: -Number(d.slice(-2)), merchant: 'X' })
        }
        bDates.forEach((d, i) => {
          imported(v, { accountId: a.id, file: 'b.xls', date: d, amount: -[5, 10, 15][i]!, merchant: 'X' })
        })
      })
    expect(findDuplicateImports(mk(1)).length).toBe(1)
    expect(findDuplicateImports(mk(2))).toEqual([])
  })

  // Ranking guard: the real vault's worst false positive (two accounts sharing an Amazon Prime
  // subscription) scored 0.021 against this case's 0.875 — the margin the thresholds rely on.
  it('outranks the near-miss noise a real vault carries', () => {
    const v = built()
    const a = v.accounts[0]!
    // a second, unrelated file pair that coincidentally shares three amounts
    for (let i = 0; i < 40; i++) {
      imported(v, { accountId: a.id, file: 'noise-a.csv', date: '2025-06-11', amount: -(500 + i), merchant: `NA ${i}` })
      imported(v, { accountId: a.id, file: 'noise-b.csv', date: '2025-06-11', amount: -(700 + i), merchant: `NB ${i}` })
    }
    for (const amt of [-501, -502, -503]) {
      imported(v, { accountId: a.id, file: 'noise-b.csv', date: '2025-06-11', amount: amt, merchant: 'coincidence' })
    }
    const found = findDuplicateImports(v)
    expect(found.length).toBe(1) // the noise pair scores 3/40 = 0.075, well under the floor
    expect(found[0]!.fileA).toBe('revolut-personal.csv')
  })

  it('is stable and ignores manual rows, which carry no file', () => {
    const v = built()
    txn(v, '2025-06-02', 'Milwaukee Café', 'Other', -50) // hand-typed, no importMeta
    const a = findDuplicateImports(v)
    const b = findDuplicateImports(v)
    expect(a[0]!.matched).toBe(7) // unchanged by the manual row
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('resolving a duplicate', () => {
  const pairVault = () =>
    buildVault((v) => {
      const a = acc(v, { name: 'Revolut EUR', institutionId: 'revolut' })
      for (const [d, amt] of [
        ['2025-06-02', -50],
        ['2025-06-08', -22],
        ['2025-06-09', -9],
      ] as [string, number][]) {
        imported(v, { accountId: a.id, file: 'a.csv', date: d, amount: amt, merchant: 'Real Name' })
        imported(v, { accountId: a.id, file: 'b.csv', date: d, amount: amt, merchant: 'SumUp' })
      }
    })

  it('deletes only the newer rows and undoes exactly', () => {
    const v = pairVault()
    const f = findDuplicateImports(v)[0]!
    const before = v.transactions.length
    const op = resolveDuplicatesOp(v, f.pairs)!
    const { vault: after, inverse } = applyOp(v, op)

    expect(after.transactions.length).toBe(before - 3)
    for (const p of f.pairs) {
      expect(after.transactions.some((t) => t.id === p.keepId)).toBe(true)
      expect(after.transactions.some((t) => t.id === p.dropId)).toBe(false)
    }
    expect(findDuplicateImports(after)).toEqual([]) // the finding is gone, not merely hidden

    const undone = applyOp(after, inverse!).vault
    expect(undone.transactions.length).toBe(before)
    expect(undone.tombstones).toHaveLength(0) // restore clears them
  })

  it('the survivor absorbs the victim’s identity, so a re-import cannot resurrect it', () => {
    const v = pairVault()
    const f = findDuplicateImports(v)[0]!
    const dropHashes = f.pairs.map((p) => v.transactions.find((t) => t.id === p.dropId)!.importMeta!.hash)
    const after = applyOp(v, resolveDuplicatesOp(v, f.pairs)!).vault
    for (const p of f.pairs) {
      const keep = after.transactions.find((t) => t.id === p.keepId)!
      expect(keep.importMeta!.dupHashes).toBeTruthy()
    }
    // every deleted identity is now answered for by some surviving row
    const answered = new Set(after.transactions.flatMap((t) => [t.importMeta?.hash, ...(t.importMeta?.dupHashes ?? [])]))
    for (const h of dropHashes) expect(answered.has(h)).toBe(true)
  })

  it('carries the victim’s curation onto the survivor rather than losing it', () => {
    const v = pairVault()
    const f = findDuplicateImports(v)[0]!
    const p = f.pairs[0]!
    const drop = v.transactions.find((t) => t.id === p.dropId)!
    drop.note = 'split with Anna'
    drop.recurring = 'monthly'
    drop.provenance = 'manual'
    drop.categoryId = catId(v, 'Travel')
    v.trackingAssignments.push({ id: 'ta1', updatedAt: drop.updatedAt, trackingId: 'trip-1', txnId: drop.id, dir: 'include' })

    const after = applyOp(v, resolveDuplicatesOp(v, [p])!).vault
    const keep = after.transactions.find((t) => t.id === p.keepId)!
    expect(keep.note).toBe('split with Anna')
    expect(keep.recurring).toBe('monthly')
    expect(keep.categoryId).toBe(catId(v, 'Travel')) // a hand pick outranks the survivor's rung
    expect(keep.provenance).toBe('manual')
    // the trip keeps the row it was tagging
    expect(after.trackingAssignments.some((a) => a.trackingId === 'trip-1' && a.txnId === keep.id && a.dir === 'include')).toBe(true)
  })

  it('is a no-op when the pairs no longer exist', () => {
    const v = pairVault()
    expect(resolveDuplicatesOp(v, [{ keepId: 'nope', dropId: 'gone', amount: -1, keepDate: '2025-01-01', dropDate: '2025-01-01', keepMerchant: 'x', dropMerchant: 'y', dayGap: 0 }])).toBeNull()
  })
})
