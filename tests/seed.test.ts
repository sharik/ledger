import { describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import { CAT_TRANSFERS, SCHEMA_VERSION } from '../src/model/types'
import { emptyVault, seedVault, SEED_FLOWS, SEED_HISTORY_MONTHS } from '../src/model/seed'
import { addMonths, currentMonthKey, derive, flowOf, isCashflow, monthKeyOf } from '../src/model/selectors'
import { members } from '../src/model/trackings'
import { goalStatus } from '../src/analytics/goals'
import { compare } from '../src/analytics/compare'

// Anchor to the mock's instant: 12 Jul 2026, 14:32. Set at module load so
// seedVault() below sees the fixed clock.
setFixedNow('2026-07-12T14:32:00Z')

describe('schema-3 seed', () => {
  const vault = seedVault()
  const d = derive(vault)
  const cm = currentMonthKey()
  const TODAY = '2026-07-12'

  it('anchors to the fixed clock and current schema', () => {
    expect(cm).toBe('2026-07')
    expect(vault.schema).toBe(SCHEMA_VERSION)
    expect(vault.params.baseCurrency).toBe('EUR')
    expect(vault.params.reconTolerance).toBe(1.0)
    expect(vault.categories.find((c) => c.id === CAT_TRANSFERS)).toBeDefined()
  })

  it('emptyVault matches a migrated vault: fixed Transfers id + createdAt stamp', () => {
    const e = emptyVault()
    const transfers = e.categories.find((c) => c.id === CAT_TRANSFERS)!
    expect(transfers.updatedAt).toBe(e.createdAt)
    expect(e.trackings).toEqual([])
    expect(e.savedComparisons).toEqual([])
  })

  it('synthesizes the four accounts with import provenance where expected', () => {
    expect(vault.accounts.map((a) => a.name)).toEqual(['BNP Joint', 'Revolut · EUR', 'Livret A', 'Mortgage'])
    const bnp = vault.accounts.find((a) => a.name === 'BNP Joint')!
    expect(bnp.fingerprint).toBeTruthy()
    expect(bnp.institutionId).toBe('bnp')
    expect(vault.accounts.find((a) => a.name === 'Mortgage')!.liab).toBe(true)
  })

  it('carries statements, trackings, goals, comparisons and unreviewed notes', () => {
    expect(vault.statements).toHaveLength(2)
    expect(vault.trackings).toHaveLength(3)
    expect(vault.savedComparisons.filter((c) => c.pinned)).toHaveLength(2)
    expect(vault.syncNotes.filter((n) => !n.reviewedAt).length).toBeGreaterThanOrEqual(2)
    expect(vault.goals.some((g) => g.source?.kind === 'balance')).toBe(true)
  })

  it('derived monthly income/expense equals the FLOWS history (baseline months)', () => {
    const tripMonths = new Set(['2024-10', '2025-04', '2026-06']) // extra trip spend on top of baseline
    SEED_FLOWS.forEach(([inc, exp], i) => {
      const mk = addMonths(cm, i - SEED_HISTORY_MONTHS)
      const f = flowOf(d, mk)
      expect(f.income, `${mk} income`).toBeCloseTo(inc, 2)
      if (!tripMonths.has(mk)) expect(f.expense, `${mk} expense`).toBeCloseTo(exp, 2)
      else expect(f.expense, `${mk} expense`).toBeGreaterThan(exp) // baseline + trip
    })
  })

  it('net worth = assets − liabilities from the latest snapshots', () => {
    // computed independently from the seed's own balances
    const bal = (name: string) => d.currentBalance.get(vault.accounts.find((a) => a.name === name)!.id)!.amount
    const assets = bal('BNP Joint') + bal('Revolut · EUR') + bal('Livret A')
    const liab = bal('Mortgage')
    expect(d.assets).toBeCloseTo(assets, 2)
    expect(d.liabilities).toBeCloseTo(liab, 2)
    expect(d.netWorth).toBeCloseTo(assets - liab, 2)
  })

  it('trip trackings auto-capture their in-window rows', () => {
    const jun = vault.trackings.find((t) => t.name.includes('Jun 2026'))!
    const mem = members(jun.id, vault)
    expect(mem.size).toBeGreaterThan(0)
    // every member falls in the window (excludes honored: mortgage payment removed)
    for (const id of mem) {
      const t = vault.transactions.find((x) => x.id === id)!
      expect(t.date >= jun.dateFrom! && t.date <= jun.dateTo!).toBe(true)
      expect(t.merchant).not.toBe('Free Mobile') // the excluded recurring bill is gone
    }
  })

  it('the balance-linked emergency-fund goal reads the Livret A snapshot, not saved', () => {
    const g = vault.goals.find((x) => x.name === 'Emergency fund')!
    const livret = vault.accounts.find((a) => a.name === 'Livret A')!
    const s = goalStatus(vault, g, TODAY)
    expect(s.kind).toBe('balance')
    expect(s.progress).toBeCloseTo(d.currentBalance.get(livret.id)!.amount, 2)
  })

  it('the pinned this-vs-last comparison resolves without error', () => {
    const [a, b] = vault.savedComparisons[0]!.selections
    const r = compare(vault, a!, b!, TODAY)
    expect(r.a.totalRaw).toBeGreaterThan(0)
    expect(Number.isFinite(r.delta)).toBe(true)
  })

  it('MTD spend is the sum of this-month expense cash-flow rows (BRIEF §17)', () => {
    const headline = vault.transactions
      .filter((t) => monthKeyOf(t.date) === cm && isCashflow(t) && t.amount < 0)
      .reduce((s, t) => s + -t.amount, 0)
    expect(headline).toBeGreaterThan(0)
    // matches the compare "this month" raw total for an all-category selection
    const r = compare(vault, { period: { rel: 'thisMonth' } }, { period: { rel: 'lastMonth' } }, TODAY, { mode: 'full' })
    expect(r.a.totalRaw).toBeCloseTo(headline, 2)
  })

  it('is deterministic', () => {
    const v2 = seedVault()
    const VOLATILE = new Set([
      'id', 'vaultId', 'categoryId', 'accountId', 'trackingId', 'txnId', 'statementId', 'recordId',
      'updatedAt', 'createdAt', 'importedAt', 'keptAt', 'discardedAt', // now()-derived timestamps
      'categoryIds', 'accountIds', 'trackingIds', // id arrays inside Selection
    ])
    const strip = (v: typeof v2) => JSON.stringify(v, (k, val) => (VOLATILE.has(k) ? undefined : val))
    expect(strip(v2)).toBe(strip(vault))
  })
})
