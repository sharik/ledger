import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../src/model/clock'
import type { Vault } from '../src/model/types'
import { CAT_TRANSFERS } from '../src/model/types'
import { filterTransactions, matchesQuery } from '../src/model/txnFilter'
import { acc, buildVault, txn } from './helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

/**
 * The Transactions screen's predicate, extracted so the assistant's "this will show N rows" and the
 * screen's actual rows come from one implementation. These tests pin the behaviours the screen
 * relied on, so extracting it cannot have changed what the user sees.
 */
function fixture(): { vault: Vault; acctId: string } {
  let acctId = ''
  const vault = buildVault((v) => {
    const a = acc(v, { name: 'Current', liquid: true })
    acctId = a.id
    const t1 = txn(v, '2026-06-05', 'Bistro', 'Dining out', -42.5)
    t1.accountId = a.id
    t1.importMeta = { hash: 'h1', raw: 'CARD PAYMENT BISTRO PARIS' }
    t1.provenance = 'ai'
    const t2 = txn(v, '2026-06-19', 'Netflix', 'Entertainment', -13.49)
    t2.accountId = a.id
    t2.recurring = 'monthly'
    t2.provenance = 'rule'
    const t3 = txn(v, '2026-07-02', 'Move to savings', 'Other', -500)
    t3.accountId = a.id
    t3.categoryId = CAT_TRANSFERS
    const t4 = txn(v, '2026-07-03', 'Unmatched shop', 'Other', -8)
    t4.accountId = a.id
    t4.importMeta = { hash: 'h4' }
    t4.isNew = true
    t4.note = 'check this'
  })
  return { vault, acctId }
}

const names = (v: Vault, f: Parameters<typeof filterTransactions>[1]) =>
  filterTransactions(v, f).map((t) => t.merchant).sort()

describe('free-text search', () => {
  it('covers merchant, raw descriptor and note', () => {
    const { vault } = fixture()
    expect(names(vault, { q: 'bistro' })).toEqual(['Bistro'])
    expect(names(vault, { q: 'paris' })).toEqual(['Bistro']) // from the raw descriptor
    expect(names(vault, { q: 'check this' })).toEqual(['Unmatched shop']) // from the note
    expect(names(vault, { q: 'nothing here' })).toEqual([])
  })

  it('is the same predicate the detail panel counts "similar" rows with', () => {
    const { vault } = fixture()
    expect(matchesQuery(vault.transactions[0]!, 'bistro')).toBe(true)
    expect(matchesQuery(vault.transactions[1]!, 'bistro')).toBe(false)
  })
})

describe('category set (a group budget’s drill)', () => {
  const catOf = (v: Vault, name: string) => v.categories.find((c) => c.name === name)!.id

  it('keeps every row of every named category and nothing else', () => {
    const { vault } = fixture()
    const cats = `${catOf(vault, 'Dining out')},${catOf(vault, 'Entertainment')}`
    expect(names(vault, { cats })).toEqual(['Bistro', 'Netflix'])
  })

  it('an id nothing points at is inert rather than an error', () => {
    const { vault } = fixture()
    expect(names(vault, { cats: `${catOf(vault, 'Dining out')},cat-gone` })).toEqual(['Bistro'])
    expect(names(vault, { cats: 'cat-gone' })).toEqual([])
  })

  it('an empty or comma-only value filters nothing away', () => {
    const { vault } = fixture()
    expect(names(vault, { cats: '' }).length).toBe(4)
    expect(names(vault, { cats: ',,' }).length).toBe(4)
  })

  it('composes with `cat` as an intersection, not a replacement', () => {
    const { vault } = fixture()
    const cats = `${catOf(vault, 'Dining out')},${catOf(vault, 'Entertainment')}`
    expect(names(vault, { cats, cat: catOf(vault, 'Entertainment') })).toEqual(['Netflix'])
    expect(names(vault, { cats, cat: CAT_TRANSFERS })).toEqual([])
  })
})

describe('status chips', () => {
  it('review = the fallback category with import provenance', () => {
    const { vault } = fixture()
    expect(names(vault, { status: 'review' })).toEqual(['Unmatched shop'])
  })

  it('transfers, recurring, ai, rule and imported each isolate their rows', () => {
    const { vault } = fixture()
    expect(names(vault, { status: 'transfers' })).toEqual(['Move to savings'])
    expect(names(vault, { status: 'recurring' })).toEqual(['Netflix'])
    expect(names(vault, { status: 'ai' })).toEqual(['Bistro'])
    expect(names(vault, { status: 'rule' })).toEqual(['Netflix'])
    expect(names(vault, { status: 'imported' })).toEqual(['Unmatched shop'])
  })

  it('duplicates needs the caller to supply the finding, and is empty without it', () => {
    const { vault } = fixture()
    expect(filterTransactions(vault, { status: 'duplicates' })).toEqual([])
    const id = vault.transactions[0]!.id
    expect(filterTransactions(vault, { status: 'duplicates' }, { dupIds: new Set([id]) }).map((t) => t.id)).toEqual([id])
  })
})

/**
 * The totals bar's figures are pressable, and each opens the rows it counted. That only holds if
 * the buckets here are the same branches the bar sums with — otherwise a figure opens a list whose
 * own total contradicts the number that was pressed.
 */
describe('flow buckets (pressing a figure in the totals bar)', () => {
  function flowFixture(): Vault {
    return buildVault((v) => {
      txn(v, '2026-06-01', 'Salary', 'Income', 3000)
      txn(v, '2026-06-03', 'Bistro', 'Dining out', -42.5)
      txn(v, '2026-06-04', 'Shop refund', 'Shopping', 30) // a positive OUTSIDE Income: a refund
      txn(v, '2026-06-05', 'Payroll correction', 'Income', -120) // a negative INSIDE Income
      const out = txn(v, '2026-06-06', 'To savings', 'Other', -500)
      out.categoryId = CAT_TRANSFERS
      const back = txn(v, '2026-06-07', 'From savings', 'Other', 500)
      back.categoryId = CAT_TRANSFERS
    })
  }

  it('in and out split on sign alone, transfers and refunds included', () => {
    const v = flowFixture()
    expect(names(v, { flow: 'in' })).toEqual(['From savings', 'Salary', 'Shop refund'])
    expect(names(v, { flow: 'out' })).toEqual(['Bistro', 'Payroll correction', 'To savings'])
  })

  it('every row is in exactly one of in/out, so the two add back up to the whole set', () => {
    const v = flowFixture()
    expect(filterTransactions(v, { flow: 'in' }).length + filterTransactions(v, { flow: 'out' }).length).toBe(v.transactions.length)
  })

  it('income is money in filed as Income — a refund elsewhere is not income', () => {
    const v = flowFixture()
    expect(names(v, { flow: 'income' })).toEqual(['Salary'])
  })

  it('expenses is every other cash-flow row: the refund nets its spend, the reversal is not income', () => {
    const v = flowFixture()
    // The distinction `status` cannot draw: 'Shop refund' is +30 and still an expenses row, and
    // 'Payroll correction' is in the Income category and still not an income row — both exactly
    // as `derive()` files them.
    expect(names(v, { flow: 'expenses' })).toEqual(['Bistro', 'Payroll correction', 'Shop refund'])
  })

  it('the transfer legs drill apart, which is how an unpaired leg is found', () => {
    const v = flowFixture()
    expect(names(v, { flow: 'transfer-in' })).toEqual(['From savings'])
    expect(names(v, { flow: 'transfer-out' })).toEqual(['To savings'])
    // The bar's other reading: income + expenses + both legs is the whole set, nothing double-filed.
    const cash = ['income', 'expenses'] as const
    const legs = ['transfer-in', 'transfer-out'] as const
    const total = [...cash, ...legs].reduce((n, flow) => n + filterTransactions(v, { flow }).length, 0)
    expect(total).toBe(v.transactions.length)
  })

  it('composes with the other axes rather than replacing them', () => {
    const v = flowFixture()
    expect(names(v, { flow: 'in', from: '2026-06-04' })).toEqual(['From savings', 'Shop refund'])
    expect(names(v, { flow: 'expenses', q: 'bistro' })).toEqual(['Bistro'])
  })

  it('a vault with no Income-role category files every positive as a refund, never as income', () => {
    const v = flowFixture()
    v.categories = v.categories.map((c) => (c.role === 'income' ? { ...c, role: undefined } : c))
    expect(names(v, { flow: 'income' })).toEqual([])
    expect(names(v, { flow: 'expenses' })).toEqual(['Bistro', 'Payroll correction', 'Salary', 'Shop refund'])
  })
})

describe('axes combine with AND', () => {
  it('date bounds are inclusive and compare as ISO strings', () => {
    const { vault } = fixture()
    expect(names(vault, { from: '2026-06-19', to: '2026-07-02' })).toEqual(['Move to savings', 'Netflix'])
  })

  it('search narrows within a date range rather than being ignored', () => {
    const { vault } = fixture()
    expect(names(vault, { from: '2026-06-01', to: '2026-06-30' })).toEqual(['Bistro', 'Netflix'])
    expect(names(vault, { from: '2026-06-01', to: '2026-06-30', q: 'netflix' })).toEqual(['Netflix'])
  })

  it('a stale account filter is ignored once that account is gone from the live set', () => {
    const { vault, acctId } = fixture()
    expect(filterTransactions(vault, { acct: acctId }, { acctIds: new Set([acctId]) })).toHaveLength(4)
    // Hidden mid-filter: show everything rather than an unexplained empty list (screen behaviour).
    expect(filterTransactions(vault, { acct: acctId }, { acctIds: new Set() })).toHaveLength(4)
    expect(filterTransactions(vault, { acct: 'someone-else' }, { acctIds: new Set(['someone-else']) })).toHaveLength(0)
  })
})

describe('trip membership', () => {
  it('is curated, so it is not the same rows as the trip’s date range', () => {
    const { vault } = fixture()
    vault.trackings.push({ id: 'trk', updatedAt: 'x', name: 'Trip', kind: 'trip', dateFrom: '2026-06-01', dateTo: '2026-06-30' })
    vault.trackingAssignments.push(
      { id: 'a1', updatedAt: 'x', trackingId: 'trk', txnId: vault.transactions[1]!.id, dir: 'exclude' },
      { id: 'a2', updatedAt: 'x', trackingId: 'trk', txnId: vault.transactions[3]!.id, dir: 'include' },
    )
    // Window holds Bistro + Netflix; the trip is Bistro (Netflix excluded) + a July row pulled in.
    expect(names(vault, { from: '2026-06-01', to: '2026-06-30' })).toEqual(['Bistro', 'Netflix'])
    expect(names(vault, { tracking: 'trk' })).toEqual(['Bistro', 'Unmatched shop'])
  })

  it('an unknown tracking id matches nothing rather than everything', () => {
    const { vault } = fixture()
    expect(filterTransactions(vault, { tracking: 'nope' })).toEqual([])
  })
})
