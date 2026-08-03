import { describe, expect, it } from 'vitest'
import { isNewer, setFixedNow } from '../src/model/clock'
import {
  addMonths,
  avgMonthlyExpenses,
  budgetPace,
  budgetSpent,
  currentMonthKey,
  derive,
  dti,
  emergencyFundMonths,
  flowOf,
  flowOfRange,
  goalProjection,
  monthsOfYear,
  hiddenAccountIds,
  latestBalanceByAccount,
  mtdCashflowDelta,
  savingsRate,
  savingsRateOf,
  sparseData,
  trailingAvg,
  spendingByCategory,
  trackingSince,
  upcomingRecurring,
  visibleVault,
} from '../src/model/selectors'
import { CAT_TRANSFERS } from '../src/model/types'
import { acc, budget, buildVault, catId, goal, snap, txn } from './helpers/build'

// At module scope, not in `beforeAll`: several describes below call `derive()` in their body,
// which runs at collection time — before any hook. Frozen late, those captured the real clock and
// silently drifted, so `budgetPace` and `goalProjection` started failing the day the calendar left
// July 2026. The clock has to be fixed before the first `derive()`, which means here.
setFixedNow('2026-07-09T12:00:00Z')

describe('isCashflow: transfers excluded from flows', () => {
  it('a transferGroupId txn is excluded from income/expense, savings and EF', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'Pay', 'Income', 2000)
      txn(v, '2026-07-03', 'Groceries', 'Groceries', -400)
      // a paired transfer leg — must NOT count as expense
      const t = txn(v, '2026-07-04', 'To savings', 'Other', -1000)
      t.transferGroupId = 'grp-1'
    })
    const d = derive(v)
    expect(flowOf(d, '2026-07').income).toBe(2000)
    expect(flowOf(d, '2026-07').expense).toBe(400) // transfer leg excluded
  })

  it('a CAT_TRANSFERS txn is excluded even without a group id', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'Pay', 'Income', 2000)
      const t = txn(v, '2026-07-05', 'Move', 'Other', -500)
      t.categoryId = CAT_TRANSFERS
    })
    const d = derive(v)
    expect(flowOf(d, '2026-07').expense).toBe(0)
  })

  it('an ordinary txn (both unset) is included', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-05', 'Shop', 'Shopping', -60)
    })
    expect(flowOf(derive(v), '2026-07').expense).toBe(60)
  })

  it('MTD delta ignores transfer legs', () => {
    const v = buildVault((v) => {
      txn(v, '2026-06-05', 'A', 'Groceries', -100)
      txn(v, '2026-07-05', 'B', 'Groceries', -60)
      const t = txn(v, '2026-07-06', 'xfer', 'Other', -900)
      t.transferGroupId = 'g'
    })
    expect(mtdCashflowDelta(derive(v))).toBe(-60 - -100) // −900 transfer excluded
  })
})

describe('budget spend derivation', () => {
  const v = buildVault((v) => {
    txn(v, '2026-07-02', 'A', 'Groceries', -30)
    txn(v, '2026-07-05', 'B', 'Groceries', -20.5)
    txn(v, '2026-06-20', 'C', 'Groceries', -99) // other month
    txn(v, '2026-07-03', 'D', 'Dining out', -10) // other category
    txn(v, '2026-07-01', 'Pay', 'Income', 1000) // income ignored
  })
  const b = budget(v, 'Groceries', 100)
  const d = derive(v)

  it('sums only the month+category expenses', () => {
    expect(budgetSpent(d, b, '2026-07')).toBe(50.5)
    expect(budgetSpent(d, b, '2026-06')).toBe(99)
    expect(budgetSpent(d, b, '2026-05')).toBe(0)
  })

  it('pace compares spend against elapsed fraction of the month', () => {
    // day 9 of 31 → elapsed 29.03%; spent 50.5 of 100 → pace ≈ 1.74
    expect(budgetPace(d, b, '2026-07')).toBeCloseTo(50.5 / (100 * (9 / 31)), 5)
    // past month: full-month basis
    expect(budgetPace(d, b, '2026-06')).toBeCloseTo(0.99, 5)
  })
})

describe('refunds net their category, never income (Income/Refund/Transfer)', () => {
  it('a positive in an ordinary category reduces that category and is not income', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-02', 'Doctor', 'Health', -120)
      txn(v, '2026-07-10', 'CPAM reimbursement', 'Health', 74.59) // refund
      txn(v, '2026-07-01', 'Pay', 'Income', 1000)
    })
    const d = derive(v)
    expect(flowOf(d, '2026-07').income).toBe(1000) // refund is NOT income
    expect(flowOf(d, '2026-07').expense).toBeCloseTo(45.41, 2) // 120 spend netted by 74.59 refund
    expect(budgetSpent(d, budget(v, 'Health', 200), '2026-07')).toBeCloseTo(45.41, 2)
  })

  it('a refund exceeding the category spend floors at €0 and stays out of income', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-02', 'Doctor', 'Health', -50)
      txn(v, '2026-07-10', 'Big refund', 'Health', 200)
    })
    const d = derive(v)
    expect(budgetSpent(d, budget(v, 'Health', 100), '2026-07')).toBe(0)
    expect(flowOf(d, '2026-07').income).toBe(0)
  })
})

describe('net-worth carry-forward', () => {
  const v = buildVault((v) => {
    const a = acc(v, { name: 'Checking', liquid: true })
    const l = acc(v, { name: 'Loan', liab: true })
    snap(v, a.id, '2026-01-15', 1000)
    snap(v, a.id, '2026-03-10', 1500)
    snap(v, l.id, '2026-01-20', 400)
  })
  const d = derive(v)

  it('carries balances across months without snapshots', () => {
    const feb = d.netWorthByMonth.find((r) => r.mk === '2026-02')!
    expect(feb.nw).toBe(600) // 1000 − 400 carried into Feb
    const mar = d.netWorthByMonth.find((r) => r.mk === '2026-03')!
    expect(mar.nw).toBe(1100) // 1500 − 400
    const jul = d.netWorthByMonth.find((r) => r.mk === '2026-07')!
    expect(jul.nw).toBe(1100) // carried to current month
  })

  it('same-date snapshots resolve by createdAt', () => {
    const v2 = buildVault((v) => {
      const a = acc(v, { name: 'X' })
      snap(v, a.id, '2026-07-01', 100, '2026-07-01T10:00:00Z')
      snap(v, a.id, '2026-07-01', 250, '2026-07-01T11:00:00Z')
    })
    expect(derive(v2).assets).toBe(250)
  })
})

describe('KPIs', () => {
  const v = buildVault((v) => {
    const chk = acc(v, { name: 'Checking', liquid: true })
    const loan = acc(v, { name: 'Loan', liab: true, monthlyPayment: 500 })
    snap(v, chk.id, '2026-07-01', 10000)
    snap(v, loan.id, '2026-07-01', 5000)
    for (let i = 1; i <= 12; i++) {
      const mk = addMonths('2026-07', -i)
      txn(v, `${mk}-01`, 'Pay', 'Income', 2000)
      txn(v, `${mk}-05`, 'Shop', 'Groceries', -1000)
    }
  })
  const d = derive(v)

  it('emergency fund = liquid / trailing-12 avg expenses', () => {
    expect(emergencyFundMonths(d)).toBe(10)
  })

  it('dti = payments / trailing avg income', () => {
    expect(dti(d)).toBe(25)
  })

  it('dti is null without debt payments', () => {
    const v2 = buildVault((v) => {
      acc(v, { name: 'Loan', liab: true })
    })
    expect(dti(derive(v2))).toBeNull()
  })

  it('savings rate for a complete month', () => {
    expect(savingsRate(d, '2026-06')).toBe(50)
  })

  it('MTD delta compares same-day windows', () => {
    const v2 = buildVault((v) => {
      txn(v, '2026-06-05', 'A', 'Groceries', -100)
      txn(v, '2026-06-20', 'B', 'Groceries', -900) // after day 9 → excluded from window
      txn(v, '2026-07-05', 'C', 'Groceries', -60)
    })
    expect(mtdCashflowDelta(derive(v2))).toBe(-60 - -100)
  })
})

describe('an anchored trailing average (the Dashboard points at any month)', () => {
  // Jan–Jun 2026 spend 100·n; nothing after June, so an anchor past June sees fewer months.
  const v = buildVault((v) => {
    for (let m = 1; m <= 6; m++) {
      const mk = `2026-${String(m).padStart(2, '0')}`
      txn(v, `${mk}-01`, 'Pay', 'Income', 1000)
      txn(v, `${mk}-05`, 'Shop', 'Groceries', -100 * m)
    }
  })
  const d = derive(v)

  it('defaults to the current month — every existing caller is unchanged', () => {
    // Anchor July (the frozen clock): the 3 complete months before it are Jun/May/Apr = 600/500/400.
    expect(trailingAvg(d, 3, (f) => f.expense)).toBe(500)
    expect(trailingAvg(d, 3, (f) => f.expense, currentMonthKey())).toBe(500)
  })

  it('averages the months before the anchor, not the months before today', () => {
    // Anchor April: Mar/Feb/Jan = 300/200/100.
    expect(trailingAvg(d, 3, (f) => f.expense, '2026-04')).toBe(200)
    // The anchor month itself is excluded, exactly as the current month is.
    expect(trailingAvg(d, 1, (f) => f.expense, '2026-03')).toBe(200)
  })

  it('avgMonthlyExpenses threads the anchor through', () => {
    expect(avgMonthlyExpenses(d, '2026-04')).toBe(200)
    expect(avgMonthlyExpenses(d)).toBe(avgMonthlyExpenses(d, currentMonthKey()))
  })

  it('flowOfRange sums a year exactly, and months with no data contribute nothing', () => {
    const year = flowOfRange(d, monthsOfYear(2026))
    expect(year.income).toBe(6000)
    expect(year.expense).toBe(2100) // 100+200+…+600
    expect(flowOfRange(d, monthsOfYear(2025))).toEqual({ income: 0, expense: 0 })
  })

  it('a year savings rate is Σ over Σ, not the mean of the monthly rates', () => {
    // Monthly rates run 90%…40%, whose mean is 65%. The honest figure is (6000−2100)/6000.
    expect(savingsRateOf(flowOfRange(d, monthsOfYear(2026)))).toBeCloseTo(65, 10)
    const lopsided = buildVault((v) => {
      txn(v, '2026-01-01', 'Pay', 'Income', 100)
      txn(v, '2026-01-05', 'Shop', 'Groceries', -10) // 90% kept, on €100
      txn(v, '2026-02-01', 'Pay', 'Income', 6000)
      txn(v, '2026-02-05', 'Shop', 'Groceries', -5400) // 10% kept, on €6,000
    })
    const dl = derive(lopsided)
    // Mean of the two rates would be 50%. Weighted by the money, it is far lower.
    expect(savingsRateOf(flowOfRange(dl, monthsOfYear(2026)))).toBeCloseTo(11.31, 2)
  })
})

describe('spending by category', () => {
  const v = buildVault((v) => {
    txn(v, '2026-07-02', 'Rent', 'Housing', -1650)
    txn(v, '2026-07-03', 'A', 'Groceries', -120)
    txn(v, '2026-07-04', 'B', 'Dining out', -80)
    txn(v, '2026-07-05', 'C', 'Other', -15)
  })
  budget(v, 'Groceries', 100)
  const rows = spendingByCategory(derive(v), '2026-07')

  it('excludes Housing, sorts desc, flags over-budget', () => {
    expect(rows.map((r) => r.name)).toEqual(['Groceries', 'Dining out', 'Other'])
    expect(rows[0]!.over).toBe(true)
    expect(rows[1]!.budget).toBeNull()
  })

  // #12a: the breakdown exclusion is a user preference (Category.excludeFromBreakdown),
  // defaulting to Housing when unset.
  it('a category flagged excludeFromBreakdown is hidden; Housing can be shown', () => {
    const v2 = buildVault((v) => {
      v.categories.find((c) => c.name === 'Dining out')!.excludeFromBreakdown = true
      v.categories.find((c) => c.name === 'Housing')!.excludeFromBreakdown = false
      txn(v, '2026-07-02', 'Rent', 'Housing', -1650)
      txn(v, '2026-07-03', 'A', 'Groceries', -120)
      txn(v, '2026-07-04', 'B', 'Dining out', -80)
    })
    const names = spendingByCategory(derive(v2), '2026-07').map((r) => r.name)
    expect(names).toContain('Housing') // un-flagged → now shown
    expect(names).not.toContain('Dining out') // flagged → hidden
    expect(names).toContain('Groceries')
  })
})

describe('goal projection', () => {
  const v = buildVault()
  const d = derive(v)

  it('linear ETA and behind flag', () => {
    const g = goal(v, { name: 'G', target: 3500, saved: 2140, monthly: 450, targetDate: '2026-10' })
    const p = goalProjection(d, g)
    expect(p.monthsToGo).toBe(4) // ceil(1360/450)
    expect(p.etaMonth).toBe('2026-11')
    expect(p.behind).toBe(true)
    expect(p.scheduleMark).toBeCloseTo((3500 - 450 * 3) / 3500, 5)
  })

  it('on schedule when eta <= targetDate', () => {
    const g = goal(v, { name: 'G2', target: 1000, saved: 900, monthly: 100, targetDate: '2026-12' })
    const p = goalProjection(d, g)
    expect(p.etaMonth).toBe('2026-08')
    expect(p.behind).toBe(false)
  })

  it('done goal', () => {
    const g = goal(v, { name: 'G3', target: 500, saved: 500, monthly: 50 })
    expect(goalProjection(d, g).monthsToGo).toBe(0)
  })
})

describe('recurring heuristic', () => {
  it('detects merchant on same day in two consecutive months, not yet logged', () => {
    const v = buildVault((v) => {
      txn(v, '2026-05-15', 'Rent Co', 'Housing', -1650)
      txn(v, '2026-06-15', 'Rent Co', 'Housing', -1650)
      txn(v, '2026-05-02', 'Gym', 'Other', -40) // day already passed (today = 9) → excluded
      txn(v, '2026-06-02', 'Gym', 'Other', -40)
      txn(v, '2026-05-20', 'OnceOff', 'Other', -10) // only one month → excluded
    })
    const items = upcomingRecurring(derive(v))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ merchant: 'Rent Co', day: 15, isIncome: false })
  })

  it('skips (merchant, day) pairs already logged this month', () => {
    const v = buildVault((v) => {
      txn(v, '2026-05-09', 'Gym', 'Other', -40)
      txn(v, '2026-06-09', 'Gym', 'Other', -40)
      txn(v, '2026-07-09', 'Gym', 'Other', -40) // already logged today
    })
    expect(upcomingRecurring(derive(v))).toHaveLength(0)
  })

  it('a different-day charge this month does not suppress the recurring one', () => {
    const v = buildVault((v) => {
      txn(v, '2026-05-15', 'Paycheck', 'Income', 2600)
      txn(v, '2026-06-15', 'Paycheck', 'Income', 2600)
      txn(v, '2026-07-01', 'Paycheck', 'Income', 2600) // the 1st-of-month one
    })
    const items = upcomingRecurring(derive(v))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ merchant: 'Paycheck', day: 15, isIncome: true })
  })
})

describe('sparse data', () => {
  it('flags < 2 tracked months', () => {
    const v = buildVault((v) => {
      txn(v, '2026-07-01', 'A', 'Other', -1)
    })
    const d = derive(v)
    expect(sparseData(d)).toBe(true)
    expect(trackingSince(d)).toBe('2026-07')
    expect(sparseData(derive(buildVault((v) => {
      txn(v, '2026-06-01', 'A', 'Other', -1)
      txn(v, '2026-07-01', 'B', 'Other', -1)
    })))).toBe(false)
  })
})

describe('hidden accounts (visibleVault)', () => {
  /** Two liquid accounts, one of which the caller may retire; each with a balance and a spend. */
  const twoAccounts = (hideB: boolean) =>
    buildVault((v) => {
      const a = acc(v, { name: 'Live', liquid: true })
      const b = acc(v, { name: 'Dead', liquid: true, hidden: hideB || undefined })
      snap(v, a.id, '2026-07-01', 1000)
      snap(v, b.id, '2026-07-01', 250)
      txn(v, '2026-07-02', 'Shop A', 'Groceries', -100).accountId = a.id
      txn(v, '2026-07-03', 'Shop B', 'Groceries', -40).accountId = b.id
    })

  it('returns the SAME object when nothing is hidden — the memo-safety guarantee', () => {
    const v = twoAccounts(false)
    expect(hiddenAccountIds(v).size).toBe(0)
    expect(visibleVault(v)).toBe(v)
  })

  it('returns a stable identity when something is hidden', () => {
    const v = twoAccounts(true)
    expect(visibleVault(v)).toBe(visibleVault(v))
    expect(visibleVault(v)).not.toBe(v)
  })

  it('strips the hidden account, its transactions and its snapshots', () => {
    const vv = visibleVault(twoAccounts(true))
    expect(vv.accounts.map((a) => a.name)).toEqual(['Live'])
    expect(vv.transactions.map((t) => t.merchant)).toEqual(['Shop A'])
    expect(vv.snapshots).toHaveLength(1)
  })

  it('never touches the source vault', () => {
    const v = twoAccounts(true)
    visibleVault(v)
    expect(v.accounts).toHaveLength(2)
    expect(v.transactions).toHaveLength(2)
    expect(v.snapshots).toHaveLength(2)
  })

  it('keeps a legacy row that belongs to no account', () => {
    const v = buildVault((v) => {
      const b = acc(v, { name: 'Dead', hidden: true })
      txn(v, '2026-07-03', 'Hidden row', 'Groceries', -40).accountId = b.id
      txn(v, '2026-07-04', 'Manual row', 'Groceries', -10) // no accountId at all
    })
    expect(visibleVault(v).transactions.map((t) => t.merchant)).toEqual(['Manual row'])
  })

  it('drops hidden spend from flows and the category breakdown', () => {
    const d = derive(visibleVault(twoAccounts(true)))
    expect(flowOf(d, '2026-07').expense).toBe(100)
    expect(d.spentByCatMonth.get(`2026-07|${catId(d.vault, 'Groceries')}`)).toBe(100)
  })

  it('drops the hidden balance from assets, liquid and net worth', () => {
    expect(derive(visibleVault(twoAccounts(false))).assets).toBe(1250)
    const d = derive(visibleVault(twoAccounts(true)))
    expect(d.assets).toBe(1000)
    expect(d.liquid).toBe(1000)
    expect(d.netWorth).toBe(1000)
  })

  it('rewrites the whole net-worth history, not just the last point', () => {
    // The regression an accounts-only filter would miss: netWorthByMonth walks snapshot-derived
    // data, so a hidden account would otherwise keep contributing to every past month.
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Live' })
      const b = acc(v, { name: 'Dead', hidden: true })
      snap(v, a.id, '2026-02-01', 1000)
      snap(v, b.id, '2026-02-01', 500)
    })
    const series = derive(visibleVault(v)).netWorthByMonth
    expect(series.length).toBeGreaterThan(3)
    expect(series.every((m) => m.nw === 1000)).toBe(true) // never 1500 in any month
  })

  it('excludes a hidden liability from liabilities and dti', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Live', liquid: true })
      const m = acc(v, { name: 'Mortgage', liab: true, monthlyPayment: 900, hidden: true })
      snap(v, a.id, '2026-07-01', 1000)
      snap(v, m.id, '2026-07-01', 80000)
      txn(v, '2026-07-01', 'Pay', 'Income', 3000).accountId = a.id
    })
    const d = derive(visibleVault(v))
    expect(d.liabilities).toBe(0)
    expect(d.netWorth).toBe(1000)
    expect(dti(d)).toBeNull() // the only account with a monthlyPayment is gone
  })

  it('lowers the emergency fund when the hidden account was liquid', () => {
    // trailingAvg skips the current (incomplete) month, so the spend has to sit before July.
    const ef = (hide: boolean) => {
      const v = buildVault((v) => {
        const a = acc(v, { name: 'Live', liquid: true })
        const b = acc(v, { name: 'Dead', liquid: true, hidden: hide || undefined })
        snap(v, a.id, '2026-06-01', 1200)
        snap(v, b.id, '2026-06-01', 600)
        txn(v, '2026-06-10', 'Shop', 'Groceries', -1200).accountId = a.id
      })
      return emergencyFundMonths(derive(visibleVault(v)))
    }
    expect(ef(false)).toBeGreaterThan(0)
    expect(ef(true)).toBeLessThan(ef(false)!)
  })

  it('reaches mtdCashflowDelta and upcomingRecurring through d.vault, with no edits to them', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Live' })
      const b = acc(v, { name: 'Dead', hidden: true })
      txn(v, '2026-07-02', 'Live spend', 'Groceries', -100).accountId = a.id
      txn(v, '2026-07-02', 'Dead spend', 'Groceries', -70).accountId = b.id
      // upcomingRecurring wants the same merchant+day in each of the two prior months,
      // on a day still ahead of the fixed clock's 9th.
      for (const m of ['2026-05', '2026-06']) {
        txn(v, `${m}-20`, 'Netflix', 'Entertainment', -15).accountId = b.id
      }
    })
    expect(mtdCashflowDelta(derive(visibleVault(v)))).toBe(-100)
    expect(upcomingRecurring(derive(visibleVault(v)))).toHaveLength(0)
    expect(upcomingRecurring(derive(v)).length).toBeGreaterThan(0) // present before hiding
  })

  it('survives every account being hidden — zeros and nulls, never NaN', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'Dead', liquid: true, hidden: true })
      snap(v, a.id, '2026-07-01', 1000)
      txn(v, '2026-07-02', 'Spend', 'Groceries', -100).accountId = a.id
    })
    const d = derive(visibleVault(v))
    expect([d.assets, d.liabilities, d.liquid, d.netWorth]).toEqual([0, 0, 0, 0])
    expect(d.netWorthByMonth).toEqual([])
    expect(emergencyFundMonths(d)).toBeNull() // no expenses to divide by → not computable, not 0
    expect(Number.isNaN(emergencyFundMonths(d))).toBe(false)
    expect(dti(d)).toBeNull()
    expect(spendingByCategory(d, '2026-07')).toEqual([])
    expect(sparseData(d)).toBe(true)
  })

  it('derive memoizes per vault identity, so two live vaults do not thrash', () => {
    const raw = twoAccounts(true)
    const vis = visibleVault(raw)
    const first = derive(raw)
    derive(vis) // a second identity in between
    expect(derive(raw)).toBe(first)
    expect(derive(vis)).toBe(derive(vis))
  })

  it('latestBalanceByAccount picks max (date, createdAt) — the shared fold', () => {
    const v = buildVault((v) => {
      const a = acc(v, { name: 'A' })
      snap(v, a.id, '2026-07-01', 100, '2026-07-01T10:00:00Z')
      snap(v, a.id, '2026-07-01', 250, '2026-07-01T11:00:00Z') // same date, later createdAt
      snap(v, a.id, '2026-06-01', 999)
    })
    const m = latestBalanceByAccount(v.snapshots)
    expect(m.get(v.accounts[0]!.id)).toEqual({ amount: 250, date: '2026-07-01' })
  })
})

describe('isNewer comparator', () => {
  it('orders clear differences', () => {
    expect(isNewer('2026-07-09T12:00:10Z', '2026-07-09T12:00:00Z')).toBe('a')
    expect(isNewer('2026-07-09T12:00:00Z', '2026-07-09T12:00:10Z')).toBe('b')
  })
  it('treats < 2s as tie', () => {
    expect(isNewer('2026-07-09T12:00:01.500Z', '2026-07-09T12:00:00Z')).toBe('tie')
    expect(isNewer('2026-07-09T12:00:00Z', '2026-07-09T12:00:00Z')).toBe('tie')
    expect(isNewer('2026-07-09T12:00:02Z', '2026-07-09T12:00:00Z')).toBe('a')
  })
})

describe('current month key', () => {
  it('respects the fixed clock', () => {
    expect(currentMonthKey()).toBe('2026-07')
  })
})
