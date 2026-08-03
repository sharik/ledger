import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Category, Rule, Transaction } from '../model/types'
import { CAT_TRANSFERS, isCashflow } from '../model/types'
import { nowDate } from '../model/clock'
import { incomeCategoryId } from '../model/selectors'
import { filterTransactions, matchesQuery, TXN_FLOWS, type TxnFlow, type TxnStatus } from '../model/txnFilter'
import type { Op } from '../model/mutations'
import { matchesRule, mintLearnedRuleForTxn, ruleKeyLabel } from '../import/rules'
import { detectRecurring, merchantKey } from '../analytics/recurringDetect'
import { MergeMerchantDialog } from './MergeMerchantDialog'
import { duplicateIds, findDuplicateImports } from '../analytics/duplicates'
import { convertRows, convertedById } from '../analytics/rows'
import { lookupQuery } from '../import/lookup'
import { useStore, useStoreState } from './store'
import { useRateBook } from './fxCtx'
import { useView } from './view'
import { formatHash, queryToTxnFilter, txnFilterToQuery } from './route'
import { ACCENT, AMBER, BRICK, CHIP, FAINT, GREEN, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2, WARNBG, fmt, netLbl } from './theme'
import { MENU_MAX, btnGhost, noRoomBelow, phoneMenu, phoneSheet } from './styles'
import { useNarrow } from './responsive'
import { FilterChip, LookupLinks, MenuItem } from './kit'
import { TrackingChips } from './TrackingChips'
import { Explain } from './explain'
import { EmptyState, type EmptyBasis } from './kit/EmptyState'
import { ScreenIntro } from './ScreenIntro'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The list spans every year at once, newest first, with no year separators — so a bare
 * `3 Jan` is ambiguous the moment you scroll past the current year. Carry the year only
 * when it is not the current one, which keeps the common case short.
 */
const fmtDate = (d: string, currentYear: number) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}${Number(d.slice(0, 4)) === currentYear ? '' : ` ${d.slice(2, 4)}`}`

/** Chip label for the date range — `…` stands in for an open end. */
const dateLabel = (from: string, to: string, currentYear: number) =>
  !from && !to ? 'Date' : `${from ? fmtDate(from, currentYear) : '…'} → ${to ? fmtDate(to, currentYear) : '…'}`

/**
 * The category chip reports what it holds, the way the date chip does — a narrowed list is never a
 * mystery. A drilled-in set names its two members and counts the rest: the point of the label is
 * that the list is narrower than "Category" suggests.
 */
const catLabel = (cat: string | null, set: string[], names: Map<string, { name: string }>): string => {
  const nameOf = (id: string) => names.get(id)?.name ?? id
  if (cat) return nameOf(cat)
  if (set.length === 0) return 'Category'
  if (set.length <= 2) return set.map(nameOf).join(' + ')
  return `${set.length} categories`
}

const PAGE = 200

type Status = TxnStatus

const STATUS_LABEL: Record<Status, string> = {
  all: 'All',
  review: 'Needs review',
  ai: 'AI',
  rule: 'By rule',
  transfers: 'Transfers',
  recurring: 'Subscriptions',
  imported: 'Imported',
  duplicates: 'Possible duplicates',
}

/** A totals-bar drill in words, for the filter chip and the empty state's reason. */
const FLOW_LABEL: Record<TxnFlow, string> = {
  in: 'Money in',
  out: 'Money out',
  income: 'Income',
  expenses: 'Expenses',
  'transfer-in': 'Transfers in',
  'transfer-out': 'Transfers out',
}

/** The `provenance` field in words — how this row's category was last decided. */
const SET_BY: Record<NonNullable<Transaction['provenance']>, string> = {
  rule: 'a rule',
  ai: 'AI',
  manual: 'by hand',
  transfer: 'the transfer pairing',
  fallback: 'nothing — import fallback',
  history: 'your history',
}

export function TransactionsScreen() {
  const narrow = useNarrow()
  const store = useStore()
  const { vault } = useStoreState()
  const rates = useRateBook()
  const view = useView()
  const [q, setQ] = useState('')
  // The filter pass scans every transaction — debounce typing (150 ms).
  const [qLive, setQLive] = useState('')
  const [catFilter, setCatFilter] = useState<string | null>(null)
  // A multi-category set arrives only as a drill (a "group" budget's bar). The menu still picks one
  // category, so choosing from it clears the set — a filter the chips cannot express must not linger.
  const [catSet, setCatSet] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('all')
  // Set by pressing a figure in the totals bar; see `TxnFlow`. A filter like any other — it
  // composes with these rather than replacing them, and clears from the same chip row.
  const [flow, setFlow] = useState<TxnFlow | null>(null)
  const [acct, setAcct] = useState<string | null>(null)
  const [merchant, setMerchant] = useState<string | null>(null)
  const [from, setFrom] = useState('') // 'YYYY-MM-DD' inclusive, '' = open
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<{ key: 'amount' | 'date'; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' })
  const [limit, setLimit] = useState(PAGE)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [selMode, setSelMode] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [menu, setMenu] = useState<'cat' | 'status' | 'acct' | 'date' | 'bulk' | 'tag' | null>(null)
  const [rowMenu, setRowMenu] = useState<{ id: string; dropUp: boolean } | null>(null)
  const [always, setAlways] = useState<{ rule: Rule; categoryName: string; alsoFixes: string[] } | null>(null)
  // #19: a pick whose target contradicts the row's direction — kept, but never generalized.
  const [polarity, setPolarity] = useState<{ txnId: string; merchant: string; categoryName: string } | null>(null)
  const [grouped, setGrouped] = useState(false)
  /** The merchant whose spelling is being merged into another, or null. */
  const [mergeMerchant, setMergeMerchant] = useState<string | null>(null)
  // Trip/set membership — not a field on the row, so it cannot be expressed as any other chip.
  const [tracking, setTracking] = useState<string | null>(null)

  const catById = useMemo(() => new Map(vault.categories.map((c) => [c.id, { name: c.name, color: c.color }])), [vault.categories])
  const acctById = useMemo(() => new Map(vault.accounts.map((a) => [a.id, a.name])), [vault.accounts])
  // Rows a duplicate-import finding proposes dropping — the newer copy of a pair. Marked, never
  // hidden: the audit only ever suggests (see `analytics/duplicates`).
  const dupIds = useMemo(
    () => duplicateIds(findDuplicateImports(vault)),
    [vault.transactions, vault.statements, vault.snapshots, vault.accounts], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Chart drills land here as a route seed. A query-bearing seed REPLACES the
  // filter state wholesale (a drill must never silently combine with stale
  // filters); an empty query is plain navigation and leaves everything alone.
  const seed = view.seed
  const seenNonce = useRef(0)
  useEffect(() => {
    if (!seed || seed.tab !== 'txns' || seed.nonce === seenNonce.current) return
    seenNonce.current = seed.nonce
    if (Object.keys(seed.query).length === 0) return
    const f = queryToTxnFilter(seed.query)
    setQ(f.q ?? '')
    setCatFilter(f.cat ?? null)
    setCatSet(f.cats ? f.cats.split(',').filter(Boolean) : [])
    setStatus(f.status && f.status in STATUS_LABEL ? (f.status as Status) : 'all')
    setAcct(f.acct ?? null)
    setMerchant(f.merchant ?? null)
    setFrom(f.from ?? '')
    setTo(f.to ?? '')
    setTracking(f.tracking ?? null)
    setFlow(TXN_FLOWS.includes(f.flow as TxnFlow) ? (f.flow as TxnFlow) : null)
    setLimit(PAGE)
    setSel(new Set())
    setDetail(null)
  }, [seed])

  // Keep the hash truthful when filters change locally (replace — no history spam).
  const activeQuery = useMemo(
    () =>
      txnFilterToQuery({
        q: q || undefined,
        cat: catFilter ?? undefined,
        cats: catSet.length ? catSet.join(',') : undefined,
        status: status === 'all' ? undefined : status,
        acct: acct ?? undefined,
        merchant: merchant ?? undefined,
        from: from || undefined,
        to: to || undefined,
        tracking: tracking ?? undefined,
        flow: flow ?? undefined,
      }),
    [q, catFilter, catSet, status, acct, merchant, from, to, tracking, flow],
  )
  useEffect(() => {
    if (view.tab !== 'txns') return
    const h = formatHash({ tab: 'txns', query: activeQuery })
    if (location.hash !== h) history.replaceState(history.state, '', h)
  }, [activeQuery, view.tab])

  useEffect(() => {
    const t = setTimeout(() => setQLive(q), 150)
    return () => clearTimeout(t)
  }, [q])

  // One shared predicate (`model/txnFilter`), so the count the assistant reports before opening this
  // screen and the rows the screen actually shows can never disagree.
  const filtered = useMemo(
    () =>
      filterTransactions(
        vault,
        {
          q: qLive,
          cat: catFilter ?? undefined,
          cats: catSet.length ? catSet.join(',') : undefined,
          acct: acct ?? undefined,
          merchant: merchant ?? undefined,
          from,
          to,
          status,
          tracking: tracking ?? undefined,
          flow: flow ?? undefined,
        },
        { dupIds, acctIds: new Set(acctById.keys()) },
      ).sort((a, b) => {
        const av = sort.key === 'amount' ? a.amount : a.date
        const bv = sort.key === 'amount' ? b.amount : b.date
        const c = av < bv ? -1 : av > bv ? 1 : a.id < b.id ? -1 : 1
        return sort.dir === 'asc' ? c : -c
      }),
    [vault, qLive, catFilter, catSet, acct, acctById, merchant, status, from, to, tracking, flow, sort, dupIds],
  )

  const toggleSort = (key: 'amount' | 'date') =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))

  const page = filtered.slice(0, limit)

  // An empty list is two different problems. "No transactions match." said the same thing
  // whether the vault was empty or six filters were active, and offered no way out of either.
  const anyFilter = !!(catFilter || catSet.length || status !== 'all' || acct || merchant || from || to || tracking || flow || q)
  const emptyBasis: EmptyBasis = vault.transactions.length === 0 ? 'no-data' : anyFilter ? 'filtered' : 'no-data'
  const activeFilterNames = [
    catFilter && `category ${catById.get(catFilter)?.name ?? catFilter}`,
    catSet.length > 0 && `${catSet.length} categories`,
    status !== 'all' && STATUS_LABEL[status].toLowerCase(),
    acct && `account ${acctById.get(acct) ?? acct}`,
    merchant && `merchant ${merchant}`,
    (from || to) && 'a date range',
    tracking && 'a trip',
    flow && FLOW_LABEL[flow].toLowerCase(),
    q && `search “${q}”`,
  ].filter(Boolean) as string[]
  const filterSummary =
    activeFilterNames.length > 0
      ? `${activeFilterNames.length} filter${activeFilterNames.length === 1 ? '' : 's'} active: ${activeFilterNames.join(' · ')}.`
      : undefined
  const clearAllFilters = () => {
    setQ('')
    setCatFilter(null)
    setCatSet([])
    setStatus('all')
    setAcct(null)
    setMerchant(null)
    setFrom('')
    setTo('')
    setTracking(null)
    setFlow(null)
    setLimit(PAGE)
  }

  /** A figure drills to its own rows; pressing the active one gives the other buckets back. */
  const pickFlow = (f: TxnFlow) => {
    setFlow((cur) => (cur === f ? null : f))
    setLimit(PAGE)
  }

  const detailTxn = detail ? vault.transactions.find((t) => t.id === detail) : undefined

  /**
   * §10.3 on this screen: the pick is committed at once (undoable), and if it yields a
   * durable key the *Always* offer follows — the same learning loop review runs, started
   * from a committed row instead of an import row. The rows the rule would also settle are
   * counted here, so the offer can state its full consequence before it is accepted rather
   * than asking a second time afterwards.
   */
  const pickCategory = (t: Transaction, cat: Category) => {
    setRowMenu(null)
    setPolarity(null)
    store.commit({ kind: 'recategorizeBatch', txnIds: [t.id], categoryId: cat.id }, { msg: `${t.merchant} → ${cat.name}`, undoable: true })
    // #19: the same guard review applies. The row keeps what the user picked; what is refused is
    // teaching a rule from a contradiction — Income is money in, and this row is money out.
    if (cat.role === 'income' && t.amount < 0) {
      setAlways(null)
      setPolarity({ txnId: t.id, merchant: t.merchant, categoryName: cat.name })
      return
    }
    const rule = mintLearnedRuleForTxn(t, cat.id)
    const covered =
      rule &&
      vault.rules.some(
        (r) => r.enabled !== false && r.categoryId === cat.id && r.match.field === rule.match.field && r.match.value === rule.match.value,
      )
    if (!rule || covered) return setAlways(null)
    // §10.3 step 3: the rule speaks for rows already in the vault too. Paired legs belong
    // to Transfers by construction and are never swept up. `t` is excluded — it was just set.
    const alsoFixes = vault.transactions
      .filter((x) => x.id !== t.id && x.categoryId !== cat.id && !x.transferGroupId && x.categoryId !== CAT_TRANSFERS && matchesRule(x, rule))
      .map((x) => x.id)
    setAlways({ rule, categoryName: cat.name, alsoFixes })
  }

  /**
   * One gesture, one commit, one undo: minting the rule and settling the rows it already
   * covers are the same decision, so splitting them into two prompts only asked the user to
   * agree twice — and left undo able to reverse just the half that ran last.
   */
  const acceptAlways = () => {
    if (!always) return
    const { rule, categoryName, alsoFixes } = always
    const add: Op = { kind: 'restore', collection: 'rules', records: [rule] }
    const op: Op = alsoFixes.length
      ? { kind: 'batch', ops: [add, { kind: 'recategorizeBatch', txnIds: alsoFixes, categoryId: rule.categoryId }] }
      : add
    const msg = alsoFixes.length
      ? `Always → ${categoryName} · ${alsoFixes.length} transaction${alsoFixes.length === 1 ? '' : 's'} updated`
      : `Always → ${categoryName}`
    store.commit(op, { msg, undoable: true })
    setAlways(null)
  }

  const showSimilar = (merchant: string) => {
    setQ(merchant)
    setLimit(PAGE)
    setDetail(null)
  }

  // #12b: merchants whose debits recur at a steady cadence/amount but aren't all marked
  // `recurring` yet. Only ever suggested — the flag is written when the user confirms.
  const recurringCandidates = useMemo(() => {
    const marked = new Set(vault.transactions.filter((t) => t.recurring).map((t) => t.id))
    return detectRecurring(vault.transactions)
      .map((c) => ({ ...c, unmarked: c.txnIds.filter((id) => !marked.has(id)) }))
      .filter((c) => c.unmarked.length > 0)
  }, [vault.transactions])

  // A dismissal lives in the vault, keyed the same way the candidates are grouped — the display
  // merchant drifts between imports (`NETFLIX #4821`), the key does not.
  const dismissedRec = useMemo(() => new Set(vault.settings.recurringDismissed ?? []), [vault.settings.recurringDismissed])

  const dismissRecurring = (merchant: string) => {
    const key = merchantKey(merchant)
    if (dismissedRec.has(key)) return
    store.commit(
      { kind: 'setSingletonField', collection: 'settings', field: 'recurringDismissed', value: [...dismissedRec, key] },
      { msg: `${merchant} suggestion dismissed`, undoable: true },
    )
  }

  const markRecurring = (ids: string[], cadence: 'monthly' | 'yearly', merchant: string) => {
    store.commit(
      { kind: 'batch', ops: ids.map((id) => ({ kind: 'setField' as const, collection: 'transactions' as const, id, field: 'recurring', value: cadence })) },
      { msg: `${merchant} marked recurring · ${ids.length} row${ids.length === 1 ? '' : 's'}`, undoable: true },
    )
  }

  /**
   * What the active filters add up to, in two readings of the same rows.
   *
   * Over `filtered` — the whole matching set — not `page`, which stops at 200 rows. The counter
   * beside the search box already says "showing 200 of 1,847"; a total over the 200 would be a
   * different question than the one the filters asked.
   *
   * IN/OUT/NET totals THE ROWS ON SCREEN: a plain sign split, with no `isCashflow` and no
   * income-vs-refund rule. It cannot be replaced by the reading below, because the filters are the
   * user's and `status: 'transfers'` is one of them — a bar reading "€0 in · €0 out" above forty
   * visible transfer legs would be arithmetic about a set nobody asked for. This figure and the
   * rows can never disagree.
   *
   * INCOME/EXPENSES/TRANSFERS says what those rows MEAN, and answers the question the first
   * reading cannot: `inflow` counts a transfer leg and a refund as money coming in. This is
   * `derive()`'s Income/Refund/Transfer trichotomy (selectors.ts §derive) over the filtered set
   * instead of the whole vault — same branches, deliberately, so the screen and the read model
   * cannot drift into two answers wearing the same labels.
   */
  const converted = useMemo(() => convertRows(filtered, vault, rates), [filtered, vault, rates])
  const byId = useMemo(() => convertedById(converted), [converted])
  const totals = useMemo(() => {
    const incomeCatId = incomeCategoryId(vault)
    let inflow = 0
    let outflow = 0
    let transfers = 0
    let income = 0
    let expenses = 0
    let transferIn = 0
    let transferOut = 0
    for (const { t, amount } of converted.rows) {
      if (amount > 0) inflow += amount
      else outflow -= amount
      // Transfers move money between the user's own accounts: never income, never spending. Shown
      // as both legs rather than one net, because legs that fail to cancel are worth seeing.
      if (!isCashflow(t)) {
        transfers++
        if (amount > 0) transferIn += amount
        else transferOut -= amount
      } else if (amount > 0 && t.categoryId === incomeCatId) {
        income += amount
      } else {
        // Everything else is expense, and a positive here is a refund that nets its own spend
        // down. A negative in the Income category lands here too — the same `else` `derive()`
        // sends it to, so the two surfaces stay comparable.
        expenses += -amount
      }
    }
    return { inflow, outflow, net: inflow - outflow, transfers, income, expenses, transferIn, transferOut }
  }, [converted, vault])

  /** The same figures over the current selection, which is a subset of `filtered` by construction. */
  const selTotals = useMemo(() => {
    if (sel.size === 0) return null
    let inflow = 0
    let outflow = 0
    for (const id of sel) {
      const amount = byId.get(id)
      // A selected row with no rate is not in `byId`; it was already counted as excluded above.
      if (amount === undefined) continue
      if (amount > 0) inflow += amount
      else outflow -= amount
    }
    return { inflow, outflow, net: inflow - outflow }
  }, [sel, byId])

  // #11e: the grouped-by-merchant view — the recurring-merchant structure of the vault, the
  // way import review shows it for one file. Groups the *filtered* set by normalized merchant;
  // a group spanning more than one category is flagged (the issue-14 symptom, post-commit).
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; merchant: string; count: number; total: number; cats: Set<string>; lastDate: string }>()
    for (const t of filtered) {
      const key = merchantKey(t.merchant)
      const g = m.get(key) ?? { key, merchant: t.merchant, count: 0, total: 0, cats: new Set<string>(), lastDate: t.date }
      g.count++
      // Base currency, from the same conversion the bar above uses. Summing `t.amount` raw added
      // a ₴-denominated row straight into a € figure, and put a total on screen that disagreed
      // with the one directly above it. A row with no rate contributes nothing and is disclosed
      // in the bar's footnote, the same as everywhere else.
      g.total += byId.get(t.id) ?? 0
      g.cats.add(t.categoryId)
      if (t.date > g.lastDate) { g.lastDate = t.date; g.merchant = t.merchant } // show the most recent spelling
      m.set(key, g)
    }
    return [...m.values()].sort((a, b) => a.total - b.total) // biggest spend (most negative) first
  }, [filtered, byId])

  /**
   * Applying a bulk action ends the selection gesture: Select mode exists to build a
   * selection, and once it has been spent there is nothing left to select for. Leaving it
   * on made *Done* a step whose only job was to undo pressing *Select*.
   */
  const endSelection = () => {
    setSel(new Set())
    setSelMode(false)
    setMenu(null)
  }

  const bulkSetCat = (categoryId: string, verb = 'recategorized') => {
    if (sel.size === 0) return
    store.commit({ kind: 'recategorizeBatch', txnIds: [...sel], categoryId }, { msg: `${sel.size} transaction${sel.size === 1 ? '' : 's'} ${verb}`, undoable: true })
    endSelection()
  }

  const bulkTag = (trackingId: string, name: string) => {
    if (sel.size === 0) return
    store.commit(
      { kind: 'setAssignments', trackingId, entries: [...sel].map((txnId) => ({ txnId, dir: 'include' as const })) },
      { msg: `${sel.size} transaction${sel.size === 1 ? '' : 's'} tagged to ${name}`, undoable: true },
    )
    endSelection()
  }

  // Select-all spans the whole filtered set, not the loaded page — filtering to a
  // merchant then applying one category is the point of Select mode.
  const allSelected = filtered.length > 0 && sel.size === filtered.length
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(filtered.map((t) => t.id)))
  const bulkCats = vault.categories.filter((c) => c.id !== CAT_TRANSFERS)
  const tagTargets = vault.trackings.filter((tr) => !tr.archived)
  const transfersCat = vault.categories.find((c) => c.id === CAT_TRANSFERS)
  const currentYear = nowDate().getFullYear()

  return (
    <div data-screen="txns">
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Transactions</h1>
      <div style={{ fontSize: 13, color: FAINT, margin: '2px 0 16px' }}>A support surface — search, recategorize, and inspect any imported row.</div>
      <ScreenIntro id="txns" />

      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220, background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '8px 12px' }}>
          <span style={{ color: FAINT, fontSize: 13 }}>⌕</span>
          <input data-testid="txn-search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} placeholder="Search descriptors, notes…" style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: INK, flex: 1 }} />
        </div>
        <FilterChip testid="filter-cat" label={catLabel(catFilter, catSet, catById)} open={menu === 'cat'} onClick={() => setMenu(menu === 'cat' ? null : 'cat')}>
          <MenuItem label="All categories" onClick={() => { setCatFilter(null); setCatSet([]); setMenu(null) }} />
          {vault.categories.map((c) => <MenuItem key={c.id} label={c.name} onClick={() => { setCatFilter(c.id); setCatSet([]); setMenu(null); setLimit(PAGE) }} />)}
        </FilterChip>
        <FilterChip testid="filter-status" label={status === 'all' ? 'Status' : status} open={menu === 'status'} onClick={() => setMenu(menu === 'status' ? null : 'status')}>
          {(['all', 'review', 'ai', 'rule', 'transfers', 'recurring', 'imported', 'duplicates'] as Status[]).map((s) => <MenuItem key={s} label={STATUS_LABEL[s]} onClick={() => { setStatus(s); setMenu(null); setLimit(PAGE) }} />)}
        </FilterChip>
        <FilterChip testid="filter-acct" label={acct ? acctById.get(acct) ?? 'Account' : 'Account'} open={menu === 'acct'} onClick={() => setMenu(menu === 'acct' ? null : 'acct')}>
          <MenuItem label="All accounts" onClick={() => { setAcct(null); setMenu(null) }} />
          {vault.accounts.map((a) => <MenuItem key={a.id} label={a.name} onClick={() => { setAcct(a.id); setMenu(null); setLimit(PAGE) }} />)}
        </FilterChip>
        <FilterChip testid="filter-date" label={dateLabel(from, to, currentYear)} open={menu === 'date'} onClick={() => setMenu(menu === 'date' ? null : 'date')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '5px 6px 3px' }} onClick={(e) => e.stopPropagation()}>
            <label style={dateField}>
              <span style={{ color: FAINT }}>From</span>
              <input data-testid="date-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setLimit(PAGE) }} style={dateInput} />
            </label>
            <label style={dateField}>
              <span style={{ color: FAINT }}>To</span>
              <input data-testid="date-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setLimit(PAGE) }} style={dateInput} />
            </label>
            {(from || to) && (
              <button data-testid="date-clear" onClick={() => { setFrom(''); setTo(''); setLimit(PAGE) }} style={{ alignSelf: 'flex-start', fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>Clear dates</button>
            )}
          </div>
        </FilterChip>
        <span style={{ fontSize: 12, color: FAINT }} data-testid="txn-showing">{grouped ? `${groups.length} merchant${groups.length === 1 ? '' : 's'}` : `showing ${page.length} of ${filtered.length}`}</span>
        <div style={{ flex: 1 }} />
        {!selMode && <button data-testid="group-toggle" onClick={() => setGrouped(!grouped)} style={btnGhost}>{grouped ? 'Ungroup' : 'Group'}</button>}
        {!grouped && <button data-testid="select-mode" onClick={() => { setSelMode(!selMode); setSel(new Set()) }} style={btnGhost}>{selMode ? 'Done' : 'Select'}</button>}
      </div>

      {/* Active-filter chips — the drill-down's receipt. Each clears one filter. */}
      {anyFilter && (
        <div data-testid="txn-filter-chips" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.05em' }}>FILTERED BY</span>
          {catFilter && <ActiveChip label={`Category: ${catById.get(catFilter)?.name ?? catFilter}`} onClear={() => setCatFilter(null)} />}
          {catSet.length > 0 && <ActiveChip label={`Categories: ${catSet.map((id) => catById.get(id)?.name ?? id).join(' + ')}`} onClear={() => setCatSet([])} />}
          {status !== 'all' && <ActiveChip label={`Status: ${status}`} onClear={() => setStatus('all')} />}
          {acct && <ActiveChip label={`Account: ${acctById.get(acct) ?? acct}`} onClear={() => setAcct(null)} />}
          {merchant && <ActiveChip label={`Merchant: ${merchant}`} onClear={() => setMerchant(null)} />}
          {(from || to) && <ActiveChip label={rangeLabel(from, to)} onClear={() => { setFrom(''); setTo('') }} />}
          {tracking && <ActiveChip label={`Trip: ${vault.trackings.find((tr) => tr.id === tracking)?.name ?? tracking}`} onClear={() => setTracking(null)} />}
          {flow && <ActiveChip label={FLOW_LABEL[flow]} onClear={() => setFlow(null)} />}
          <button
            data-testid="txn-filters-clear"
            onClick={clearAllFilters}
            style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Above the list, not inside it — an offer must not reflow the rows it is about. */}
      {always && (
        <Strip testid="always-offer">
          <span style={{ fontSize: 12.5, color: INK }}>
            <b>Always → {always.categoryName}?</b> <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{ruleKeyLabel(always.rule)}</span>
            {always.alsoFixes.length > 0 && (
              <span style={{ color: MUT }}>
                {' · also fixes '}<b data-testid="backfill-count">{always.alsoFixes.length}</b>
                {` row${always.alsoFixes.length === 1 ? '' : 's'} already imported`}
              </span>
            )}
          </span>
          <div style={{ flex: 1 }} />
          <button data-testid="always-yes" onClick={acceptAlways} style={{ ...btnGhost, height: 28, borderColor: INK, color: INK }}>Always</button>
          <button data-testid="always-once" onClick={() => setAlways(null)} style={{ ...btnGhost, height: 28 }}>Just once</button>
        </Strip>
      )}

      {/* #19: the pick stands; the rule does not follow. The alternative (§9.4) is named, not implied. */}
      {polarity && (
        <Strip testid="polarity-warning">
          <span style={{ fontSize: 12.5, color: MUT }}>
            <b style={{ color: INK }}>{polarity.categoryName} is money in — {polarity.merchant} is money out.</b>
            {' Kept as you picked it, but no rule was learned from it.'}
          </span>
          <div style={{ flex: 1 }} />
          <button
            data-testid="polarity-transfers"
            onClick={() => {
              store.commit({ kind: 'recategorizeBatch', txnIds: [polarity.txnId], categoryId: CAT_TRANSFERS }, { msg: `${polarity.merchant} marked as a transfer`, undoable: true })
              setPolarity(null)
            }}
            style={{ ...btnGhost, height: 28, borderColor: INK, color: INK }}
          >
            ⇄ Transfer
          </button>
          <button data-testid="polarity-dismiss" onClick={() => setPolarity(null)} style={{ ...btnGhost, height: 28 }}>Keep {polarity.categoryName}</button>
        </Strip>
      )}

      {/* #12b: confirm-first subscription suggestions — nothing is marked until the user says so. */}
      {recurringCandidates
        .filter((c) => !dismissedRec.has(merchantKey(c.merchant)))
        .slice(0, 4)
        .map((c) => (
          <Strip key={c.merchant} testid="recurring-suggest">
            <span style={{ fontSize: 12.5, color: INK }}>
              <b>{c.merchant}</b> looks recurring · <span style={{ fontFamily: MONO, fontSize: 11 }}>{fmt(-c.typicalAmount)}</span> · {c.count} charges
            </span>
            <div style={{ flex: 1 }} />
            <button data-testid="recurring-mark" onClick={() => markRecurring(c.unmarked, c.cadence, c.merchant)} style={{ ...btnGhost, height: 28, borderColor: INK, color: INK }}>Mark {c.cadence}</button>
            <button data-testid="recurring-skip" onClick={() => dismissRecurring(c.merchant)} style={{ ...btnGhost, height: 28 }}>Dismiss</button>
          </Strip>
        ))}

      {/* No `overflow: hidden` — it would clip the row category popover on every row below the fold. */}
      <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6 }}>
        {/* Inside the list, not above it. The offer strips overhead appear and vanish mid-session
            (a rule offer, a polarity warning, a recurring suggestion), and a total that jumps down
            the page as an unrelated offer arrives is a total nobody can read twice. */}
        {filtered.length > 0 && (
          <div
            data-testid="txn-totals"
            style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '11px 18px', borderBottom: `1px solid ${HAIR}`, fontFamily: MONO }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: narrow ? 14 : 22, flexWrap: 'wrap', fontSize: 11.5 }}>
              <Figure flow="in" label="IN" value={fmt(totals.inflow)} valueTestid="totals-in" colour={GREEN} active={flow} onPick={pickFlow} title="Show only the rows this figure counted — every positive amount, transfers and refunds included" />
              <Figure flow="out" label="OUT" value={fmt(totals.outflow)} valueTestid="totals-out" colour={MUT} active={flow} onPick={pickFlow} title="Show only the rows this figure counted — every negative amount, transfers included" />
              {/* NET is not a bucket: its rows are the whole filtered set, which is what dropping
                  the drill gives back. So it becomes a control only when there is a drill to drop,
                  rather than sitting there as a button that does nothing. */}
              {flow ? (
                <button data-testid="flow-net" onClick={() => setFlow(null)} aria-label="Back to all matching rows" title="Back to all matching rows" style={{ ...figBtn, ...figOn }}>
                  <span style={{ color: FAINT }}>NET</span>
                  <span data-testid="totals-net" style={{ color: totals.net >= 0 ? GREEN : BRICK, fontWeight: 600 }}>{netLbl(totals.net)}</span>
                </button>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, ...figPad }}>
                  <span style={{ color: FAINT }}>NET</span>
                  <span data-testid="totals-net" style={{ color: totals.net >= 0 ? GREEN : BRICK, fontWeight: 600 }}>{netLbl(totals.net)}</span>
                </span>
              )}
              {/* Says what it counted. The list stops at 200 rows; this figure does not. */}
              <span data-testid="totals-count" style={{ color: FAINT }}>
                over {filtered.length} matching row{filtered.length === 1 ? '' : 's'}
              </span>
              {selTotals && (
                <span data-testid="totals-selected" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, paddingLeft: narrow ? 0 : 4, borderLeft: narrow ? undefined : `1px solid ${HAIR}`, marginLeft: narrow ? 0 : 2 }}>
                  <span style={{ color: FAINT, paddingLeft: narrow ? 0 : 14 }}>{sel.size} SELECTED</span>
                  <span style={{ color: selTotals.net >= 0 ? GREEN : BRICK, fontWeight: 600 }}>{netLbl(selTotals.net)}</span>
                </span>
              )}
              <div style={{ flex: 1 }} />
              {/* The same disclosures Compare and Trips carry. A figure that quietly dropped rows,
                  or quietly counted a transfer as spending, is a figure that reads as precise. */}
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', color: FAINT, fontSize: 10.5 }}>
                {converted.approx > 0 && <span title="Converted at nearest-date exchange rates">≈ {converted.approx} converted</span>}
                {converted.excluded > 0 && (
                  <span data-testid="totals-excluded" style={{ color: 'var(--warn)' }} title="Foreign-currency rows with no exchange rate are left out of these totals">
                    {converted.excluded} excluded (no FX rate)
                  </span>
                )}
                {totals.transfers > 0 && (
                  <span data-testid="totals-transfers" title="Transfer legs move money between your own accounts; they are counted here because the list shows them">
                    includes {totals.transfers} transfer leg{totals.transfers === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            </div>

            {/* The second reading: what the same rows mean. The line above answers "how much moved
                through these rows"; this one answers "how much of it was earned, spent, or just
                moved between my own accounts" — the question IN cannot answer while it counts a
                transfer leg and a refund as money coming in. */}
            <div data-testid="txn-breakdown" style={{ display: 'flex', alignItems: 'baseline', gap: narrow ? 12 : 20, flexWrap: 'wrap', fontSize: 11, color: MUT }}>
              <Figure flow="income" label="INCOME" value={fmt(totals.income)} valueTestid="totals-income" colour={GREEN} active={flow} onPick={pickFlow} title="Show only the rows this figure counted — money in, filed under Income" />
              <Figure
                flow="expenses"
                label="EXPENSES"
                value={fmt(totals.expenses)}
                valueTestid="totals-expenses"
                active={flow}
                onPick={pickFlow}
                title="Spending net of refunds — a positive amount outside the Income category reduces its own category's spend. Press to show those rows."
              />
              {/* Both legs, not their net: legs that fail to cancel are the symptom of a half-marked
                  transfer, and a single net figure is exactly where that symptom would hide. Each
                  leg drills on its own, which is how you find the half that has no partner. */}
              {totals.transfers > 0 && (
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }} title="Movements between your own accounts — neither income nor spending">
                  <span style={{ color: FAINT, ...figPad }}>TRANSFERS</span>
                  <Figure flow="transfer-in" value={fmt(totals.transferIn)} valueTestid="totals-transfer-in" suffix="in" active={flow} onPick={pickFlow} title="Show only the transfer legs paying into an account" />
                  <span style={{ color: FAINT }}>·</span>
                  <Figure flow="transfer-out" value={fmt(totals.transferOut)} valueTestid="totals-transfer-out" suffix="out" active={flow} onPick={pickFlow} title="Show only the transfer legs paying out of an account" />
                </span>
              )}
            </div>
          </div>
        )}
        {selMode && sel.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px', background: CHIP, borderBottom: `1px solid ${HAIR}`, flexWrap: 'wrap' }} data-testid="bulk-bar">
            <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }} data-testid="bulk-count">{sel.size} selected{allSelected && sel.size > 1 ? ' · all matching' : ''}</span>
            {bulkCats.slice(0, 8).map((c) => (
              <button key={c.id} data-bulk-cat={c.name} onClick={() => bulkSetCat(c.id)} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>{c.name}</button>
            ))}
            {bulkCats.length > 8 && (
              <div style={{ position: 'relative' }}>
                <button data-testid="bulk-more" onClick={() => setMenu(menu === 'bulk' ? null : 'bulk')} style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>
                  {bulkCats.length - 8} more ▾
                </button>
                {menu === 'bulk' && (
                  <div style={{ position: 'absolute', left: 0, top: 24, zIndex: 30, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, minWidth: 168, boxShadow: '0 10px 28px rgba(10,9,7,.16)', display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 320, overflowY: 'auto' , ...phoneMenu(narrow) }}>
                    {bulkCats.slice(8).map((c) => (
                      <button key={c.id} data-bulk-cat={c.name} onClick={() => bulkSetCat(c.id)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{c.name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* §9.4 forward direction: any selection can be called internal by hand. */}
            <button data-testid="bulk-transfer" onClick={() => bulkSetCat(CAT_TRANSFERS, 'marked as transfers')} aria-label="Not spending — an internal move" style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>⇄ Transfer</button>
            {tagTargets.length > 0 && (
              <div style={{ position: 'relative' }}>
                <button data-testid="bulk-tag" onClick={() => setMenu(menu === 'tag' ? null : 'tag')} style={{ fontSize: 12, color: MUT, background: 'none', border: 'none', cursor: 'pointer' }}>Tag ▾</button>
                {menu === 'tag' && (
                  <div style={{ position: 'absolute', left: 0, top: 24, zIndex: 30, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, minWidth: 168, boxShadow: '0 10px 28px rgba(10,9,7,.16)', display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 320, overflowY: 'auto' , ...phoneMenu(narrow) }}>
                    {tagTargets.map((tr) => (
                      <button key={tr.id} data-bulk-tag={tr.name} onClick={() => bulkTag(tr.id, tr.name)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{tr.name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{ flex: 1 }} />
            <button onClick={() => setSel(new Set())} style={{ fontSize: 12.5, color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
          </div>
        )}

        {grouped ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 110px', gap: 12, padding: '10px 18px', borderBottom: `1px solid ${HAIR}`, fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.05em' }}>
              <div>MERCHANT</div><div style={{ textAlign: 'right' }}>CHARGES</div><div style={{ textAlign: 'right' }}>TOTAL</div>
            </div>
            {groups.map((g) => (
              <div
                key={g.key}
                data-testid="merchant-group"
                data-merchant={g.merchant}
                style={{ display: 'grid', gridTemplateColumns: '1fr 90px 110px', gap: 12, padding: '11px 18px', borderBottom: `1px solid ${HAIR2}`, alignItems: 'center' }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <button
                    data-testid="group-open"
                    onClick={() => { showSimilar(g.merchant); setGrouped(false) }}
                    aria-label={`Show ${g.merchant}`}
                    style={{ fontSize: 13, fontWeight: 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                  >
                    {g.merchant}
                  </button>
                  {g.cats.size > 1 && <span data-testid="group-split" aria-label={`Split across ${g.cats.size} categories`} style={{ fontFamily: MONO, fontSize: 9, color: MUT, border: `1px solid ${HAIR}`, borderRadius: 3, padding: '0 3px', flex: 'none' }}>{g.cats.size} cats</span>}
                  {/* One merchant spelled two ways sits as two rows here — where it is visible, and
                      where the other spelling is one row away. Merging is the user's call: see
                      MergeMerchantDialog for why it is never done automatically. */}
                  <button
                    data-testid="group-merge"
                    onClick={() => setMergeMerchant(g.merchant)}
                    aria-label="Merge this merchant into another spelling"
                    style={{ fontSize: 11, color: FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', flex: 'none' }}
                  >
                    merge…
                  </button>
                </span>
                <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12, color: MUT }}>{g.count}</span>
                <span data-group-total={g.total.toFixed(2)} style={{ textAlign: 'right', fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: g.total > 0 ? GREEN : INK }}>{fmt(g.total)}</span>
              </div>
            ))}
            {groups.length === 0 && (
              <EmptyState
                testid="txn-empty"
                basis={emptyBasis}
                title={emptyBasis === 'no-data' ? 'No transactions yet.' : 'No merchants match.'}
                body={emptyBasis === 'filtered' ? filterSummary : undefined}
                action={emptyBasis === 'no-data' ? { label: 'Import a statement', onClick: () => view.goTab('import') } : { label: 'Clear all filters', onClick: clearAllFilters }}
              />
            )}
          </>
        ) : (
        <>
        {/* Column headings are meaningless once the row stops being columns, but the two SORT
            controls that live in them are not — so on a phone the headings go and the sorts stay,
            as labelled buttons. Both keep their test ids, so the specs still find them. */}
        {narrow ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${HAIR}` }}>
            {selMode && (
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, margin: '-11px 0 -11px -10px', flex: 'none', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  data-testid="select-all"
                  aria-label={allSelected ? 'Clear selection' : `Select all ${filtered.length} matching`}
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !allSelected }}
                  onChange={toggleAll}
                  style={{ width: 22, height: 22, margin: 0 }}
                />
              </label>
            )}
            <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.06em' }}>SORT</span>
            {(['date', 'amount'] as const).map((k) => (
              <button
                key={k}
                data-testid={`sort-${k}`}
                onClick={() => toggleSort(k)}
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  letterSpacing: '.05em',
                  padding: '6px 10px',
                  borderRadius: 12,
                  border: 'none',
                  background: sort.key === k ? CHIP : 'transparent',
                  color: sort.key === k ? INK : MUT,
                  cursor: 'pointer',
                }}
              >
                {k.toUpperCase()}
                {sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </button>
            ))}
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: selMode ? '24px 1fr 150px 150px 110px 70px' : '1fr 150px 150px 110px 70px', gap: 12, padding: '10px 18px', borderBottom: `1px solid ${HAIR}`, fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.05em' }}>
          {selMode && (
            <input
              type="checkbox"
              data-testid="select-all"
              aria-label={allSelected ? 'Clear selection' : `Select all ${filtered.length} matching`}
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = sel.size > 0 && !allSelected }}
              onChange={toggleAll}
            />
          )}
          <div>DESCRIPTOR</div><div>ACCOUNT</div><div>CATEGORY</div>
          <button data-testid="sort-amount" onClick={() => toggleSort('amount')} style={{ textAlign: 'right', fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: sort.key === 'amount' ? MUT : FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>AMOUNT{sort.key === 'amount' ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
          <button data-testid="sort-date" onClick={() => toggleSort('date')} style={{ textAlign: 'right', fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: sort.key === 'date' ? MUT : FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>DATE{sort.key === 'date' ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
        </div>
        )}

        {page.map((t) => (
          <Row
            key={t.id}
            t={t}
            catById={catById}
            acctById={acctById}
            year={currentYear}
            selMode={selMode}
            selected={sel.has(t.id)}
            onSelect={() => { const n = new Set(sel); n.has(t.id) ? n.delete(t.id) : n.add(t.id); setSel(n) }}
            onClick={() => { if (selMode) return; setRowMenu(null); setDetail(t.id) }}
            cats={bulkCats}
            transfersCat={transfersCat}
            menu={rowMenu?.id === t.id ? rowMenu : null}
            onOpenMenu={(dropUp) => setRowMenu(rowMenu?.id === t.id ? null : { id: t.id, dropUp })}
            onPick={(c) => pickCategory(t, c)}
            dup={dupIds.has(t.id)}
            narrow={narrow}
          />
        ))}

        {page.length === 0 && (
          <EmptyState
            testid="txn-empty"
            basis={emptyBasis}
            title={emptyBasis === 'no-data' ? 'No transactions yet.' : 'No rows match.'}
            body={emptyBasis === 'filtered' ? filterSummary : undefined}
            action={emptyBasis === 'no-data' ? { label: 'Import a statement', onClick: () => view.goTab('import') } : { label: 'Clear all filters', onClick: clearAllFilters }}
          />
        )}
        {filtered.length > limit && (
          <div style={{ padding: '12px 18px', borderTop: `1px solid ${HAIR2}`, textAlign: 'center' }}>
            <button data-testid="load-more" onClick={() => setLimit(limit + PAGE)} style={{ fontSize: 12.5, color: ACCENT, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer' }}>Load more · {filtered.length - limit} older</button>
          </div>
        )}
        </>
        )}
      </section>

      {detailTxn && (
        <Detail
          t={detailTxn}
          catById={catById}
          acctById={acctById}
          cats={bulkCats}
          transfersCat={transfersCat}
          // The panel sits over the list on a dimming overlay, so it has to close for the
          // *Always* offer that follows a pick to be visible at all.
          onPick={(c) => { setDetail(null); pickCategory(detailTxn, c) }}
          similar={vault.transactions.filter((x) => x.id !== detailTxn.id && matchesQuery(x, detailTxn.merchant.toLowerCase())).length}
          onSimilar={() => showSimilar(detailTxn.merchant)}
          onClose={() => setDetail(null)}
          narrow={narrow}
        />
      )}

      {mergeMerchant && <MergeMerchantDialog merchant={mergeMerchant} onClose={() => setMergeMerchant(null)} />}
    </div>
  )
}

interface RowProps {
  t: Transaction
  catById: Map<string, { name: string; color: string }>
  acctById: Map<string, string>
  year: number
  selMode: boolean
  selected: boolean
  onSelect: () => void
  onClick: () => void
  cats: Category[]
  transfersCat?: Category
  menu: { dropUp: boolean } | null
  onOpenMenu: (dropUp: boolean) => void
  onPick: (c: Category) => void
  dup: boolean
  narrow: boolean
}

function Row({ t, catById, acctById, year, selMode, selected, onSelect, onClick, cats, transfersCat, menu, onOpenMenu, onPick, dup, narrow }: RowProps) {
  const cat = catById.get(t.categoryId) ?? { name: '—', color: FAINT }
  // A *paired* leg is locked — pairing is evidence-based (§9.2), not a preference. A row
  // filed under Transfers by hand is an ordinary pick and stays changeable.
  const paired = !!t.transferGroupId
  const transfer = paired || t.categoryId === CAT_TRANSFERS

  if (narrow) {
    // The desktop row is six columns needing ~600px, so at 390 the amount and date — the two
    // things a glance is actually for — sat off the right edge behind a sideways scroll.
    // Stacked, they lead instead: merchant and amount on one line, then the supporting detail.
    return (
      <div
        data-testid="txn-row"
        data-txn-id={t.id}
        data-merchant={t.merchant}
        data-dup={dup ? '1' : undefined}
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '11px 14px',
          borderBottom: `1px solid ${HAIR2}`,
          cursor: selMode ? 'default' : 'pointer',
        }}
      >
        {selMode && (
          // The box stays 22px because a 44px checkbox looks like a mistake; the LABEL around it
          // carries the 44px target. Padding the hit area rather than the glyph is the standard
          // way to satisfy the touch floor without redrawing the control.
          <label
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, margin: '-8px 0 -8px -10px', flex: 'none', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              data-testid="txn-check"
              checked={selected}
              onChange={onSelect}
              style={{ width: 22, height: 22, margin: 0 }}
            />
          </label>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.merchant}
            </div>
            <div data-testid="txn-amount" style={{ flex: 'none', fontFamily: MONO, fontSize: 13, color: t.amount >= 0 ? GREEN : INK }}>
              {fmt(t.amount, true)}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <div data-testid="txn-date" style={{ fontFamily: MONO, fontSize: 11, color: FAINT, flex: 'none' }}>{fmtDate(t.date, year)}</div>
            <span style={{ color: FAINT, fontSize: 10, flex: 'none' }}>·</span>
            <div style={{ fontSize: 11.5, color: MUT, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.accountId ? acctById.get(t.accountId) ?? '—' : '—'}
            </div>
            {t.isNew && <span style={{ fontFamily: MONO, fontSize: 8.5, color: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: 3, padding: '0 3px' }} data-testid="imported-badge">IMPORTED</span>}
            {dup && (
              <span
                aria-label="Possible duplicate — another statement covering this period already holds this row"
                style={{ fontFamily: MONO, fontSize: 8.5, color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 3, padding: '0 3px' }}
                data-testid="dup-badge"
              >
                ⧉ DUPLICATE?
              </span>
            )}
            {/* Pushed hard right, and that is a hit-testing decision rather than a visual one:
                centred, the chip sat under the row's own centre point, so a tap meant to open the
                row opened the recategorize menu instead. The row's primary action needs the
                middle of the row to belong to it. */}
            <div style={{ position: 'relative', flex: 'none', marginLeft: 'auto' }}>
              {paired ? (
                <span aria-label="Paired leg — locked" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: MUT, background: CHIP, borderRadius: 12, padding: '4px 10px' }}>⇄ Transfer</span>
              ) : (
                <button
                  data-testid="recat-chip"
                  aria-label={`Recategorize — currently ${transfer ? 'Transfer' : cat.name}`}
                  onClick={(e) => { e.stopPropagation(); onOpenMenu(noRoomBelow(e.currentTarget)) }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, background: CHIP, border: 'none', color: transfer ? MUT : INK, borderRadius: 12, padding: '4px 10px', cursor: 'pointer' }}
                >
                  {transfer ? '⇄ Transfer' : <><span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color }} />{cat.name}</>}
                </button>
              )}
              {menu && (
                <div onClick={(e) => e.stopPropagation()}>
                  <CatMenu cats={cats} transfersCat={transfersCat} onPick={onPick} style={popoverMenu(menu.dropUp, narrow)} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="txn-row" data-txn-id={t.id} data-merchant={t.merchant} data-dup={dup ? '1' : undefined} onClick={onClick} style={{ display: 'grid', gridTemplateColumns: selMode ? '24px 1fr 150px 150px 110px 70px' : '1fr 150px 150px 110px 70px', gap: 12, padding: '11px 18px', borderBottom: `1px solid ${HAIR2}`, alignItems: 'center', cursor: selMode ? 'default' : 'pointer' }}>
      {selMode && <input type="checkbox" data-testid="txn-check" checked={selected} onChange={onSelect} onClick={(e) => e.stopPropagation()} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', gap: 8, alignItems: 'center' }}>
          {t.merchant}
          {t.isNew && <span style={{ fontFamily: MONO, fontSize: 8.5, color: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: 3, padding: '0 3px' }} data-testid="imported-badge">IMPORTED</span>}
          {dup && (
            <span
              aria-label="Possible duplicate — another statement covering this period already holds this row. See Settings → Duplicate imports."
              style={{ fontFamily: MONO, fontSize: 8.5, color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 3, padding: '0 3px' }}
              data-testid="dup-badge"
            >
              ⧉ DUPLICATE?
            </span>
          )}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.importMeta?.raw ?? t.note ?? ''}</div>
      </div>
      <div style={{ fontSize: 12, color: MUT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.accountId ? acctById.get(t.accountId) ?? '—' : '—'}</div>
      <div style={{ position: 'relative' }}>
        {paired ? (
          <span aria-label="Paired leg — locked" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: MUT, background: CHIP, borderRadius: 12, padding: '3px 9px' }}>⇄ Transfer</span>
        ) : (
          <button
            data-testid="recat-chip"
            aria-label="Recategorize"
            onClick={(e) => { e.stopPropagation(); onOpenMenu(noRoomBelow(e.currentTarget)) }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: CHIP, border: 'none', color: transfer ? MUT : INK, borderRadius: 12, padding: '3px 9px', cursor: 'pointer' }}
          >
            {transfer ? '⇄ Transfer' : <><span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color }} />{cat.name}</>}
          </button>
        )}
        {menu && (
          <div onClick={(e) => e.stopPropagation()}>
            <CatMenu cats={cats} transfersCat={transfersCat} onPick={onPick} style={popoverMenu(menu.dropUp, narrow)} />
          </div>
        )}
      </div>
      <div data-testid="txn-amount" style={{ fontFamily: MONO, fontSize: 12.5, textAlign: 'right', color: t.amount >= 0 ? GREEN : INK }}>{fmt(t.amount, true)}</div>
      <div data-testid="txn-date" style={{ fontFamily: MONO, fontSize: 11, color: FAINT, textAlign: 'right' }}>{fmtDate(t.date, year)}</div>
    </div>
  )
}

interface DetailProps {
  t: Transaction
  catById: Map<string, { name: string; color: string }>
  acctById: Map<string, string>
  cats: Category[]
  transfersCat?: Category
  onPick: (c: Category) => void
  similar: number
  onSimilar: () => void
  onClose: () => void
  narrow: boolean
}

function Detail({ t, catById, acctById, cats, transfersCat, onPick, similar, onSimilar, onClose, narrow }: DetailProps) {
  const store = useStore()
  const { vault } = useStoreState()
  const [catOpen, setCatOpen] = useState(false)
  const cat = catById.get(t.categoryId)
  const transfer = !!t.transferGroupId
  // Filed under Transfers without a paired leg — the §9.4 manual call.
  const marked = !transfer && t.categoryId === CAT_TRANSFERS
  // Where an un-marked row lands: the rule-engine default, as unlinking a pair does.
  const otherId = vault.categories.find((c) => c.role === 'other')?.id ?? vault.categories.find((c) => c.id !== CAT_TRANSFERS)?.id
  const lookup = lookupQuery(t.merchant, t.importMeta?.raw)
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
      <span style={{ color: FAINT }}>{label}</span><span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  )
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(10,9,7,.28)' }} />
      <div data-testid="txn-detail" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 71, width: 392, maxWidth: '92vw', background: SURFACE, borderLeft: `1px solid ${HAIR}`, boxShadow: '-14px 0 44px rgba(10,9,7,.2)', overflowY: 'auto', padding: '22px 24px', ...phoneSheet(narrow) }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: INK }}>{t.merchant}</div>
            <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 600, marginTop: 5, color: t.amount >= 0 ? GREEN : INK }}>{fmt(t.amount, true)}</div>
          </div>
          <button data-testid="detail-close" onClick={onClose} style={{ color: FAINT, fontSize: 20, background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ marginTop: 18 }}>
          {/*
            The title above is the *display* merchant — repaired and stripped of payment-processor
            prefixes by the adapter. This is the bank's own string, verbatim and unwrapped: the
            row's mono subline ellipses it, and a BNP SEPA block is unreadable at that width.
          */}
          {t.importMeta?.raw && (
            <div style={{ padding: '9px 0', borderTop: `1px solid ${HAIR2}` }}>
              <div style={{ color: FAINT, fontSize: 13, marginBottom: 4 }}>Descriptor</div>
              <div data-testid="detail-raw" style={{ fontFamily: MONO, fontSize: 11.5, color: MUT, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>
                {t.importMeta.raw}
              </div>
            </div>
          )}
          {row('Date', <span style={{ fontFamily: MONO }}>{t.date}</span>)}
          {row('Account', t.accountId ? acctById.get(t.accountId) ?? '—' : '—')}
          {lookup && row('Look up', <LookupLinks query={lookup} />)}
          {/* Not a popover: the panel scrolls, so the menu simply opens in flow. */}
          <div style={{ padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ color: FAINT }}>Category</span>
              {transfer ? (
                <span style={{ color: MUT, fontSize: 12 }}>⇄ Transfer · paired</span>
              ) : (
                <button data-testid="detail-recat" onClick={() => setCatOpen(!catOpen)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: CHIP, border: 'none', color: INK, borderRadius: 12, padding: '4px 10px', cursor: 'pointer' }}>
                  {cat && <span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color }} />}
                  {cat?.name ?? '—'} ▾
                </button>
              )}
            </div>
            {catOpen && !transfer && (
              <CatMenu cats={cats} transfersCat={transfersCat} onPick={(c) => { setCatOpen(false); onPick(c) }} style={{ ...menuShell, marginTop: 8 }} />
            )}
          </div>
          {/* Issue 11f: which rung placed this row. Absent on rows imported before the field
              existed, and on manual entry — nothing honest to say, so the row is omitted. */}
          {/* The "?" is a sibling, not a child: `detail-provenance` must stay text-only so it
              reads as the provenance value alone (to a test and to a screen reader). */}
          {t.provenance && row('Set by', <span style={{ display: 'inline-flex', alignItems: 'center' }}><span data-testid="detail-provenance" style={{ color: MUT, fontSize: 12 }}>{SET_BY[t.provenance]}</span><Explain id="txn.provenance" size="sm" /></span>)}
          {similar > 0 && row('Similar', <button data-testid="detail-similar" onClick={onSimilar} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{similar} more like this · view</button>)}
          {t.counterparty && row('Counterparty', t.counterparty)}
          {t.fee !== undefined && row('Fee', <span style={{ fontFamily: MONO }}>{fmt(t.fee, true)}</span>)}
          {t.original && row('Original', <span style={{ fontFamily: MONO }}>{t.original.amount} {t.original.currency}</span>)}
          {t.importMeta?.ref && row('Ref', <span style={{ fontFamily: MONO, fontSize: 11 }}>{t.importMeta.ref}</span>)}
          {t.importMeta?.balanceAfter !== undefined && row('Balance after', <span style={{ fontFamily: MONO }}>{fmt(t.importMeta.balanceAfter, true)}</span>)}
          {t.importMeta?.file && row('Statement', <span style={{ fontFamily: MONO, fontSize: 11 }}>{t.importMeta.file}</span>)}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
            <span style={{ color: FAINT }}>Transfer</span>
            {transfer ? (
              <button data-testid="unlink-transfer" onClick={() => {
                // §9.4: unlinking returns both legs to the rule-engine default (Other),
                // so they re-enter cash-flow instead of lingering in Transfers.
                const otherId = vault.categories.find((c) => c.role === 'other')?.id
                const restore = otherId ? vault.transactions.filter((x) => x.transferGroupId === t.transferGroupId).map((x) => ({ id: x.id, categoryId: otherId })) : undefined
                store.commit({ kind: 'unlinkTransferPair', transferGroupId: t.transferGroupId!, restore }, { msg: 'Transfer unlinked', undoable: true })
              }} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>Unlink pair</button>
            ) : marked ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: FAINT, fontSize: 12 }}>marked by hand</span>
                <button data-testid="unmark-transfer" onClick={() => {
                  if (!otherId) return
                  store.commit({ kind: 'recategorizeBatch', txnIds: [t.id], categoryId: otherId }, { msg: `${t.merchant} back in cash-flow`, undoable: true })
                }} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>Not a transfer</button>
              </span>
            ) : (
              // §9.4: money the user considers internal is their call, not the classifier's —
              // one commit, ordinary undo. Works for any row, paired counterpart or not.
              <button data-testid="mark-transfer" onClick={() => {
                store.commit({ kind: 'recategorizeBatch', txnIds: [t.id], categoryId: CAT_TRANSFERS }, { msg: `${t.merchant} marked as a transfer`, undoable: true })
              }} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>Mark as transfer</button>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
            <span style={{ color: FAINT }}>Recurring</span>
            {/* An axis orthogonal to category: the row keeps its category and joins the
                cross-category recurring/subscriptions view + budget. */}
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {(['monthly', 'yearly', 'off'] as const).map((opt) => {
                const active = opt === 'off' ? t.recurring == null : t.recurring === opt
                return (
                  <button
                    key={opt}
                    data-testid={`recurring-${opt}`}
                    onClick={() => store.commit(
                      { kind: 'setField', collection: 'transactions', id: t.id, field: 'recurring', value: opt === 'off' ? undefined : opt },
                      { msg: opt === 'off' ? `${t.merchant} not recurring` : `${t.merchant} · recurring ${opt}`, undoable: true },
                    )}
                    style={{ fontSize: 11.5, padding: '3px 9px', borderRadius: 12, cursor: 'pointer', border: 'none', background: active ? 'var(--accent)' : CHIP, color: active ? '#fff' : MUT }}
                  >{opt}</button>
                )
              })}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, padding: '9px 0', borderTop: `1px solid ${HAIR2}`, fontSize: 13 }}>
            <span style={{ color: FAINT, paddingTop: 3 }}>Trips</span>
            <div style={{ maxWidth: 240 }}><TrackingChips txn={t} showAll /></div>
          </div>
        </div>
        <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
          <button data-testid="delete-txn" onClick={() => { store.commit({ kind: 'delete', collection: 'transactions', ids: [t.id] }, { msg: `${t.merchant} deleted`, undoable: true }); onClose() }} style={{ ...btnGhost, color: 'var(--neg)', borderColor: WARNBG }}>Delete</button>
        </div>
      </div>
    </>
  )
}

/** '2026-07-01..2026-07-31' → 'Jul 2026'; '2026-01-01..2026-12-31' → '2026'; else the raw span. */
function rangeLabel(from: string, to: string): string {
  if (from && to) {
    if (from.slice(0, 4) === to.slice(0, 4) && from.slice(5) === '01-01' && to.slice(5) === '12-31') return from.slice(0, 4)
    if (from.slice(0, 7) === to.slice(0, 7) && from.slice(8) === '01' && Number(to.slice(8)) >= 28) {
      return `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`
    }
    return `${from} → ${to}`
  }
  return from ? `from ${from}` : `until ${to}`
}

/** Shared geometry, so a figure occupies the same space whether or not it is a control. */
const figPad: CSSProperties = { padding: '2px 6px', border: '1px solid transparent', borderRadius: 5 }

const figBtn: CSSProperties = {
  ...figPad,
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 6,
  font: 'inherit',
  background: 'none',
  color: 'inherit',
  cursor: 'pointer',
}

const figOn: CSSProperties = { background: CHIP, borderColor: HAIR }

/**
 * One figure in the totals bar, as a control.
 *
 * Pressing it narrows the list to exactly the rows it was computed from, so the number and the
 * list it opens can never be about different sets; pressing the active one gives the rest back.
 * The drill is a filter like any other — it composes with whatever is already on and clears from
 * the same chip row — which is what stops a figure from being a second, hidden way to filter.
 *
 * Active reads as a box, not a colour: colour on this bar already means direction (green in,
 * brick negative), and a second meaning layered on top of it would make both unreadable.
 *
 * `title` is the explanation, and it is a hover affordance — no phone will ever show it. So the
 * same sentence goes on `aria-label`, where a screen reader and a touch device can both reach it
 * (mobile audit R5). The visible label is the short form; neither is the only copy of the meaning.
 */
function Figure({ flow, label, value, valueTestid, suffix, colour, active, onPick, title }: {
  flow: TxnFlow
  label?: string
  value: string
  valueTestid: string
  suffix?: string
  colour?: string
  active: TxnFlow | null
  onPick: (f: TxnFlow) => void
  title: string
}) {
  const on = active === flow
  return (
    <button
      data-testid={`flow-${flow}`}
      aria-pressed={on}
      aria-label={`${FLOW_LABEL[flow]} ${value}. ${on ? 'Showing only these rows — press to show the rest again' : title}`}
      onClick={() => onPick(flow)}
      title={title}
      style={{ ...figBtn, ...(on ? figOn : null) }}
    >
      {label && <span style={{ color: FAINT }}>{label}</span>}
      <span data-testid={valueTestid} style={{ color: colour, fontWeight: 600 }}>{value}</span>
      {suffix && <span style={{ color: FAINT }}>{suffix}</span>}
    </button>
  )
}

function ActiveChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK, background: CHIP, border: `1px solid ${HAIR}`, borderRadius: 12, padding: '3px 6px 3px 10px' }}>
      {label}
      <button onClick={onClear} aria-label={`Clear ${label}`} style={{ color: MUT, fontSize: 13, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '0 3px' }}>×</button>
    </span>
  )
}

const dateField: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }

const dateInput: CSSProperties = { fontSize: 12.5, padding: '5px 7px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, fontFamily: MONO }

const menuShell: CSSProperties = {
  background: SURFACE2,
  border: `1px solid ${HAIR}`,
  borderRadius: 6,
  padding: 5,
  minWidth: 168,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
}

/** Anchored under (or over) the row chip; scrolls once the vault holds many categories. */
export const popoverMenu = (dropUp: boolean, narrow = false): CSSProperties => ({
  ...menuShell,
  position: 'absolute',
  left: 0,
  ...(dropUp ? { bottom: 26 } : { top: 26 }),
  zIndex: 40,
  maxHeight: MENU_MAX,
  overflowY: 'auto',
  boxShadow: '0 10px 28px rgba(10,9,7,.16)',
  ...phoneMenu(narrow),
})

/**
 * The recategorize menu, same contents and same `data-cat` handles as import review.
 * Rendered as a popover on a row and inline in the detail panel, which scrolls itself.
 */
export function CatMenu({ cats, transfersCat, onPick, style }: { cats: Category[]; transfersCat?: Category; onPick: (c: Category) => void; style: CSSProperties }) {
  const item: CSSProperties = { textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }
  return (
    <div data-testid="cat-menu" style={style}>
      {cats.map((c) => (
        <button key={c.id} data-cat={c.name} onClick={() => onPick(c)} style={item}>{c.name}</button>
      ))}
      {transfersCat && (
        <button data-cat={transfersCat.name} data-testid="cat-menu-transfer" onClick={() => onPick(transfersCat)} aria-label="Not spending — an internal move" style={{ ...item, borderTop: `1px solid ${HAIR2}`, marginTop: 3, paddingTop: 8 }}>
          ⇄ {transfersCat.name}
        </button>
      )}
    </div>
  )
}

function Strip({ testid, children }: { testid: string; children: React.ReactNode }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 14px', marginBottom: 12, background: CHIP, borderRadius: 6 }}>
      {children}
    </div>
  )
}

