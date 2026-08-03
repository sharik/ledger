import type {
  Budget,
  BalanceSnapshot,
  CategoryRole,
  ConflictEntry,
  DateStr,
  Goal,
  MonthKey,
  Transaction,
  Vault,
} from './types'
import { isCashflow } from './types'
import { nowDate } from './clock'
import { buildRateBook, type RateBook } from '../import/fx'

export { isCashflow }

export type { MonthKey }

// ---------- month helpers ----------

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function monthKeyOf(date: DateStr): MonthKey {
  return date.slice(0, 7)
}

// "Today" is the user's wall-clock date, not UTC — otherwise the app rolls the
// month over hours early/late (a UTC−5 user saw February at 19:00 on 31 Jan).
// Transaction dates are local YYYY-MM-DD strings from statements, so local is
// also the consistent frame to compare them against.
export function currentMonthKey(): MonthKey {
  const d = nowDate()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function todayStr(): DateStr {
  const d = nowDate()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addMonths(mk: MonthKey, n: number): MonthKey {
  const y = Number(mk.slice(0, 4))
  const m = Number(mk.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

export function monthDiff(a: MonthKey, b: MonthKey): number {
  return (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + (Number(a.slice(5, 7)) - Number(b.slice(5, 7)))
}

/** 'Jul 2026' */
export function monthLabel(mk: MonthKey): string {
  return `${MONTHS_SHORT[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`
}

/** 'JUL' */
export function monthShort(mk: MonthKey): string {
  return MONTHS_SHORT[Number(mk.slice(5, 7)) - 1]!.toUpperCase()
}

/** 'July 2026' */
export function monthFull(mk: MonthKey): string {
  return `${MONTHS_FULL[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`
}

/** 'July' */
export function monthName(mk: MonthKey): string {
  return MONTHS_FULL[Number(mk.slice(5, 7)) - 1]!
}

export function daysInMonth(mk: MonthKey): number {
  return new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)).getUTCDate()
}

export function dayOfToday(): number {
  return nowDate().getDate()
}

// ---------- derived core (memoized per vault identity) ----------

export interface MonthFlow {
  income: number
  expense: number // positive number
}

export interface Derived {
  vault: Vault
  currentMonth: MonthKey
  catById: Map<string, { name: string; color: string }>
  catIdByName: Map<string, string>
  /** Stable id lookup for the four privileged categories, keyed off `role` not name. */
  catIdByRole: Map<CategoryRole, string>
  txnsSorted: Transaction[] // date desc, then createdAt-ish (id) desc
  flowByMonth: Map<MonthKey, MonthFlow>
  /** `${monthKey}|${categoryId}` → expense total (positive). */
  spentByCatMonth: Map<string, number>
  monthsTracked: MonthKey[] // ascending, months having any txn or snapshot
  /** Latest snapshot per account, in the ACCOUNT's currency (display converts). */
  currentBalance: Map<string, { amount: number; date: DateStr }>
  assets: number
  liabilities: number
  netWorth: number
  liquid: number
  /** ascending month → { nw, assets, liab }; carry-forward month-end balances. */
  netWorthByMonth: { mk: MonthKey; nw: number; assets: number; liab: number }[]
  /** Foreign rows/balances converted via a nearest-date rate — render totals with `≈`. */
  fxApprox: number
  /** Foreign rows/balances with no resolvable rate, excluded from sums. */
  fxExcluded: number
}

// ---------- visibility projection (the analytics read model) ----------

export function hiddenAccountIds(vault: Vault): Set<string> {
  const out = new Set<string>()
  for (const a of vault.accounts) if (a.hidden) out.add(a.id)
  return out
}

const visibleMemo = new WeakMap<Vault, Vault>()

/**
 * The vault as the analytics read path must see it: every hidden account (§`Account.hidden`)
 * and everything anchored to one, removed. Returns `vault` ITSELF when nothing is hidden, so
 * the common case costs one loop over `accounts` and every downstream identity memo — this
 * module's own, and every `useMemo([vault.transactions])` in the screens — keeps hitting.
 *
 * `snapshots` must be stripped, not just `accounts`: `netWorthByMonth` walks snapshot-derived
 * data and consults `accounts` only for `liabIds`, so filtering accounts alone would leave a
 * hidden account contributing to every past month as an asset.
 *
 * `trackingAssignments` is deliberately NOT filtered — `members()` already treats an assignment
 * pointing at an absent transaction as inert, so a trip shrinks correctly and unhiding is lossless.
 *
 * NEVER hand the result to import, export, persistence or sync; those need the true vault.
 */
export function visibleVault(vault: Vault): Vault {
  const hidden = hiddenAccountIds(vault)
  if (hidden.size === 0) return vault
  const cached = visibleMemo.get(vault)
  if (cached) return cached
  const next: Vault = {
    ...vault,
    accounts: vault.accounts.filter((a) => !hidden.has(a.id)),
    snapshots: vault.snapshots.filter((s) => !hidden.has(s.accountId)),
    // A legacy manual row carries no accountId — it belongs to no account and always survives.
    transactions: vault.transactions.filter((t) => t.accountId == null || !hidden.has(t.accountId)),
    statements: vault.statements.filter((s) => !hidden.has(s.accountId)),
  }
  visibleMemo.set(vault, next)
  return next
}

/** Per account, the snapshot with max (date, createdAt) — the "as of" balance. */
export function latestBalanceByAccount(snapshots: BalanceSnapshot[]): Map<string, { amount: number; date: DateStr }> {
  const latest = new Map<string, BalanceSnapshot>()
  for (const s of snapshots) {
    const prev = latest.get(s.accountId)
    if (!prev || s.date > prev.date || (s.date === prev.date && s.createdAt > prev.createdAt)) {
      latest.set(s.accountId, s)
    }
  }
  const out = new Map<string, { amount: number; date: DateStr }>()
  for (const [accId, s] of latest) out.set(accId, { amount: s.amount, date: s.date })
  return out
}

// Keyed on (vault identity, rate book, current month) like the single slot it replaces. A WeakMap
// because two vault identities are live at once — the raw one for export, the projected one for the
// UI — and a single slot would thrash between them, recomputing on every render.
const deriveMemo = new WeakMap<Vault, { rates: RateBook; month: MonthKey; derived: Derived }>()

/** Vault-only RateBook (bank-derived + overrides, no API tables) for rate-less callers. */
const vaultBooks = new WeakMap<Vault, RateBook>()
export function vaultOnlyBook(vault: Vault): RateBook {
  let b = vaultBooks.get(vault)
  if (!b) {
    b = buildRateBook(vault)
    vaultBooks.set(vault, b)
  }
  return b
}

/**
 * The Income-role category's id, or `undefined` in a vault that has none.
 *
 * The Income/Refund/Transfer trichotomy (#13) turns on this one id: a positive amount here is
 * income, a positive amount anywhere else is a refund that nets down its category. `derive()`
 * reads it off its own `catIdByRole`; this is for callers outside the read model — `compare`
 * needs the same test and must not pay for a full `derive()` to ask one question.
 */
export function incomeCategoryId(vault: Vault): string | undefined {
  return vault.categories.find((c) => c.role === 'income')?.id
}

export function derive(vault: Vault, rates?: RateBook): Derived {
  const cm = currentMonthKey()
  const rb = rates ?? vaultOnlyBook(vault)
  const hit = deriveMemo.get(vault)
  if (hit && hit.rates === rb && hit.month === cm) return hit.derived

  const catById = new Map<string, { name: string; color: string }>()
  const catIdByName = new Map<string, string>()
  const catIdByRole = new Map<CategoryRole, string>()
  for (const c of vault.categories) {
    catById.set(c.id, { name: c.name, color: c.color })
    catIdByName.set(c.name, c.id)
    if (c.role) catIdByRole.set(c.role, c.id)
  }

  const txnsSorted = [...vault.transactions].sort(
    (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1),
  )

  // Every flow/spend sum is in BASE currency (ANALYTICS: same FX chain as
  // compare/trips — convert per row at its date; exclude honestly when no rate).
  const base = vault.params.baseCurrency ?? 'EUR'
  const accountCur = new Map<string, string>()
  for (const a of vault.accounts) accountCur.set(a.id, a.currency ?? 'EUR')
  let fxApprox = 0
  let fxExcluded = 0
  const inBase = (amount: number, cur: string, date: DateStr): number | null => {
    if (cur === base) return amount
    const conv = rb.convert(amount, cur, date)
    if (!conv) return null
    if (conv.approx) fxApprox++
    return conv.value
  }

  const flowByMonth = new Map<MonthKey, MonthFlow>()
  const spentByCatMonth = new Map<string, number>()
  const monthsSet = new Set<MonthKey>()
  // Income / Refund / Transfer: a positive amount is Income only in the Income-role
  // category; a positive anywhere else is a Refund that nets down its category's spend
  // (and the month's expense). Transfers are excluded from cash-flow entirely (isCashflow).
  const incomeCatId = catIdByRole.get('income')
  for (const t of vault.transactions) {
    const mk = monthKeyOf(t.date)
    monthsSet.add(mk)
    const cur = t.currency ?? (t.accountId ? (accountCur.get(t.accountId) ?? base) : base)
    const amt = inBase(t.amount, cur, t.date)
    if (amt === null) {
      fxExcluded++
      continue
    }
    if (!isCashflow(t)) continue
    const f = flowByMonth.get(mk) ?? { income: 0, expense: 0 }
    if (amt > 0 && t.categoryId === incomeCatId) {
      f.income += amt
    } else {
      f.expense += -amt
      const k = `${mk}|${t.categoryId}`
      spentByCatMonth.set(k, (spentByCatMonth.get(k) ?? 0) + -amt)
    }
    flowByMonth.set(mk, f)
  }
  // A category whose refunds exceed its spending in a month floors at €0 — never a
  // negative bar or pace. The all-category `flowByMonth.expense` aggregate is left as-is.
  for (const [k, v] of spentByCatMonth) if (v < 0) spentByCatMonth.set(k, 0)

  // Current balances: per account, the snapshot with max (date, createdAt).
  for (const s of vault.snapshots) monthsSet.add(monthKeyOf(s.date))
  const currentBalance = latestBalanceByAccount(vault.snapshots)

  // Balance sums in base: snapshots are in the account's currency, converted at
  // the snapshot's date (an anchor states "this balance on this day").
  let assets = 0
  let liabilities = 0
  let liquid = 0
  for (const a of vault.accounts) {
    const b = currentBalance.get(a.id)
    if (!b) continue
    const bal = inBase(b.amount, accountCur.get(a.id) ?? 'EUR', b.date)
    if (bal === null) {
      fxExcluded++
      continue
    }
    if (a.liab) liabilities += bal
    else assets += bal
    if (a.liquid) liquid += bal
  }
  const netWorth = assets - liabilities

  // Net-worth series: month-end carry-forward per account.
  const netWorthByMonth: Derived['netWorthByMonth'] = []
  if (vault.snapshots.length > 0) {
    const byAccount = new Map<string, BalanceSnapshot[]>()
    for (const s of vault.snapshots) {
      const arr = byAccount.get(s.accountId) ?? []
      arr.push(s)
      byAccount.set(s.accountId, arr)
    }
    for (const arr of byAccount.values()) {
      arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
    }
    let firstMk: MonthKey = cm
    for (const s of vault.snapshots) {
      const mk = monthKeyOf(s.date)
      if (mk < firstMk) firstMk = mk
    }
    const liabIds = new Set(vault.accounts.filter((a) => a.liab).map((a) => a.id))
    const idx = new Map<string, number>() // per-account pointer into its sorted snapshots
    for (const id of byAccount.keys()) idx.set(id, -1)
    for (let mk = firstMk; mk <= cm; mk = addMonths(mk, 1)) {
      const monthEnd = `${mk}-31` // string compare: 'YYYY-MM-DD' <= 'YYYY-MM-31' covers all real days
      let a = 0
      let l = 0
      for (const [accId, arr] of byAccount) {
        let i = idx.get(accId)!
        while (i + 1 < arr.length && arr[i + 1]!.date <= monthEnd) i++
        idx.set(accId, i)
        if (i >= 0) {
          const s = arr[i]!
          const amt = inBase(s.amount, accountCur.get(accId) ?? 'EUR', s.date)
          if (amt === null) continue // counted in fxExcluded via the latest-balance pass
          if (liabIds.has(accId)) l += amt
          else a += amt
        }
      }
      netWorthByMonth.push({ mk, nw: a - l, assets: a, liab: l })
    }
  }

  const monthsTracked = [...monthsSet].sort()

  const derived: Derived = {
    vault,
    currentMonth: cm,
    catById,
    catIdByName,
    catIdByRole,
    txnsSorted,
    flowByMonth,
    spentByCatMonth,
    monthsTracked,
    currentBalance,
    assets,
    liabilities,
    netWorth,
    liquid,
    netWorthByMonth,
    fxApprox,
    fxExcluded,
  }
  deriveMemo.set(vault, { rates: rb, month: cm, derived })
  return derived
}

// ---------- flow / KPI selectors ----------

export function flowOf(d: Derived, mk: MonthKey): MonthFlow {
  return d.flowByMonth.get(mk) ?? { income: 0, expense: 0 }
}

/**
 * The same flow, summed over several months — what a year's cash flow is.
 *
 * `flowByMonth` is a full-history map, so this is exact rather than an estimate. Months with no
 * data contribute nothing, which is why a year that is half over reports the half it has.
 */
export function flowOfRange(d: Derived, months: MonthKey[]): MonthFlow {
  let income = 0
  let expense = 0
  for (const mk of months) {
    const f = d.flowByMonth.get(mk)
    if (!f) continue
    income += f.income
    expense += f.expense
  }
  return { income, expense }
}

/** The twelve month keys of a calendar year, for `flowOfRange` and the year-mode tiles. */
export function monthsOfYear(year: number): MonthKey[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

export function cashflow(d: Derived, mk: MonthKey): number {
  const f = flowOf(d, mk)
  return f.income - f.expense
}

export function savingsRate(d: Derived, mk: MonthKey): number {
  return savingsRateOf(flowOf(d, mk))
}

/**
 * Savings rate from an already-summed flow, so a year can have one.
 *
 * Over a year this is (Σincome − Σexpense) / Σincome — NOT the mean of twelve monthly rates,
 * which would weight a €200 month the same as a €6,000 one.
 */
export function savingsRateOf(f: MonthFlow): number {
  return f.income > 0 ? ((f.income - f.expense) / f.income) * 100 : 0
}

/**
 * Mean over the `n` complete months before `anchor` (excludes the anchor month itself). Months
 * with no cash-flow data at all are skipped, not averaged in as fake €0 — a
 * young vault's average reflects only the months it actually has.
 *
 * `anchor` defaults to the current month, which is every existing caller. The Dashboard passes
 * the month it is pointed at, so "vs the last 3 complete months" beside a figure for March means
 * the three months before March, not the three before today.
 */
export function trailingAvg(d: Derived, n: number, of: (f: MonthFlow) => number, anchor: MonthKey = d.currentMonth): number {
  let sum = 0
  let count = 0
  for (let i = 1; i <= n; i++) {
    const mk = addMonths(anchor, -i)
    if (mk < (d.monthsTracked[0] ?? mk)) break
    const f = d.flowByMonth.get(mk)
    if (!f) continue
    sum += of(f)
    count++
  }
  return count > 0 ? sum / count : 0
}

export function avgMonthlyExpenses(d: Derived, anchor?: MonthKey): number {
  return trailingAvg(d, 12, (f) => f.expense, anchor)
}

export function avgMonthlySurplus(d: Derived, anchor?: MonthKey): number {
  return trailingAvg(d, 12, (f) => f.income - f.expense, anchor)
}

/** Null ⇒ no expense history to divide by (distinct from a genuine 0-month fund). */
export function emergencyFundMonths(d: Derived): number | null {
  const avg = avgMonthlyExpenses(d)
  return avg > 0 ? d.liquid / avg : null
}

/** Σ liability monthlyPayment ÷ trailing-avg monthly income, in %. Null when no debt payments. */
export function dti(d: Derived): number | null {
  const payments = d.vault.accounts
    .filter((a) => a.liab && a.monthlyPayment)
    .reduce((t, a) => t + (a.monthlyPayment ?? 0), 0)
  if (payments === 0) return null
  const inc = trailingAvg(d, 12, (f) => f.income)
  return inc > 0 ? (payments / inc) * 100 : null
}

/**
 * Current-month cash-flow delta vs the prior month cut at the same day (pro-rated,
 * per the brief: never compare a half month against a full month).
 */
export function mtdCashflowDelta(d: Derived): number {
  const day = String(dayOfToday()).padStart(2, '0')
  const cm = d.currentMonth
  const pm = addMonths(cm, -1)
  const upTo = (mk: MonthKey) =>
    d.vault.transactions
      .filter((t) => isCashflow(t) && monthKeyOf(t.date) === mk && t.date.slice(8, 10) <= day)
      .reduce((t, x) => t + x.amount, 0)
  return upTo(cm) - upTo(pm)
}

// ---------- budgets ----------

export function budgetSpent(d: Derived, b: Budget, mk: MonthKey): number {
  return round2(d.spentByCatMonth.get(`${mk}|${b.categoryId}`) ?? 0)
}

/** spent ÷ (budget × elapsed fraction); >1 means running ahead of the month's pace. */
export function budgetPace(d: Derived, b: Budget, mk: MonthKey): number {
  const spent = budgetSpent(d, b, mk)
  const elapsed = mk === d.currentMonth ? dayOfToday() / daysInMonth(mk) : 1
  const denom = b.amount * elapsed
  return denom > 0 ? spent / denom : 0
}

export function budgetHistory(d: Derived, b: Budget, months: number, endMk: MonthKey): { mk: MonthKey; spent: number }[] {
  const out: { mk: MonthKey; spent: number }[] = []
  for (let i = months - 1; i >= 0; i--) {
    const mk = addMonths(endMk, -i)
    out.push({ mk, spent: budgetSpent(d, b, mk) })
  }
  return out
}

export interface SpendRow {
  categoryId: string
  name: string
  spent: number
  budget: number | null
  over: boolean
}

/** Spending by category for a month, Housing excluded (per mock), sorted desc. */
export function spendingByCategory(d: Derived, mk: MonthKey): SpendRow[] {
  const budgetByCat = new Map(d.vault.budgets.map((b) => [b.categoryId, b.amount]))
  const rows: SpendRow[] = []
  for (const c of d.vault.categories) {
    // Income never appears in the spending breakdown (correctness). The breakdown
    // exclusion is a user preference (#12a), defaulting to Housing when unset.
    if (c.role === 'income') continue
    if (c.excludeFromBreakdown ?? c.role === 'housing') continue
    const spent = round2(d.spentByCatMonth.get(`${mk}|${c.id}`) ?? 0)
    const budget = budgetByCat.get(c.id) ?? null
    if (spent === 0 && budget === null) continue
    rows.push({ categoryId: c.id, name: c.name, spent, budget, over: budget !== null && spent > budget })
  }
  return rows.sort((a, b) => b.spent - a.spent)
}

// ---------- goals ----------

export interface GoalProjection {
  monthsToGo: number // 0 = done
  etaMonth: MonthKey | null // null when monthly = 0 and not done
  behind: boolean // has targetDate and eta after it
  /** On-schedule progress tick: saved needed *now* to still make targetDate at the current rate (0..1), or null. */
  scheduleMark: number | null
}

export function goalProjection(d: Derived, g: Goal): GoalProjection {
  const remaining = Math.max(0, g.target - g.saved)
  if (remaining === 0) {
    return { monthsToGo: 0, etaMonth: d.currentMonth, behind: false, scheduleMark: scheduleMark(d, g) }
  }
  if (g.monthly <= 0) return { monthsToGo: Infinity, etaMonth: null, behind: g.targetDate != null, scheduleMark: scheduleMark(d, g) }
  const monthsToGo = Math.ceil(remaining / g.monthly)
  const etaMonth = addMonths(d.currentMonth, monthsToGo)
  const behind = g.targetDate != null && etaMonth > g.targetDate
  return { monthsToGo, etaMonth, behind, scheduleMark: scheduleMark(d, g) }
}

function scheduleMark(d: Derived, g: Goal): number | null {
  if (!g.targetDate) return null
  const monthsLeft = Math.max(0, monthDiff(g.targetDate, d.currentMonth))
  const needNow = g.target - g.monthly * monthsLeft
  return Math.min(1, Math.max(0, needNow / g.target))
}

/** Backward-synthesized history (mock behavior): saved − monthly·k, floored at 0. */
export function goalHistory(g: Goal, points = 7): number[] {
  const out: number[] = []
  for (let k = points - 1; k >= 0; k--) out.push(Math.max(0, g.saved - g.monthly * k))
  return out
}

// ---------- attention / recap ----------

export interface RecurringItem {
  merchant: string
  day: number
  amount: number
  accountName?: string
  isIncome: boolean
}

/**
 * Read-only recurring detection: same merchant with a transaction on the same
 * day-of-month in each of the two previous months, that same (merchant, day)
 * not yet logged this month, day-of-month >= today. Keyed by merchant+day so
 * a mid-month paycheck still shows after the 1st-of-month one arrived.
 */
export function upcomingRecurring(d: Derived): RecurringItem[] {
  const cm = d.currentMonth
  const m1 = addMonths(cm, -1)
  const m2 = addMonths(cm, -2)
  const today = dayOfToday()
  const key = (t: Transaction) => `${t.merchant}|${t.date.slice(8, 10)}`
  const in1 = new Map<string, Transaction>()
  const in2 = new Set<string>()
  const thisMonth = new Set<string>()
  for (const t of d.vault.transactions) {
    if (!isCashflow(t)) continue // transfers are not spending signals
    const mk = monthKeyOf(t.date)
    if (mk === m1) in1.set(key(t), t)
    else if (mk === m2) in2.add(key(t))
    else if (mk === cm) thisMonth.add(key(t))
  }
  const out: RecurringItem[] = []
  for (const [k, t] of in1) {
    if (!in2.has(k)) continue
    const day = Number(t.date.slice(8, 10))
    if (day < today) continue
    if (thisMonth.has(k)) continue
    out.push({ merchant: t.merchant, day, amount: t.amount, isIncome: t.amount > 0 })
  }
  return out.sort((a, b) => a.day - b.day)
}

export interface RecapRow {
  label: string
  value: string
  tone: 'green' | 'brick' | 'muted' | 'amber'
}

// ---------- sync notes / sparse ----------

export function unreviewedNotes(vault: Vault): ConflictEntry[] {
  const amountKinds = new Set(['field-lww', 'simultaneous', 'dup-snapshot', 'dup-budget'])
  return vault.syncNotes
    .filter((n) => !n.reviewedAt)
    .sort((a, b) => {
      const aa = amountKinds.has(a.kind) && typeof a.keptValue === 'number' ? 0 : 1
      const bb = amountKinds.has(b.kind) && typeof b.keptValue === 'number' ? 0 : 1
      if (aa !== bb) return aa - bb
      return a.createdAt < b.createdAt ? 1 : -1
    })
}

/** < 2 months of history: hide trend deltas, show "tracking since". */
export function sparseData(d: Derived): boolean {
  return d.monthsTracked.length < 2
}

export function trackingSince(d: Derived): MonthKey | null {
  return d.monthsTracked[0] ?? null
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
