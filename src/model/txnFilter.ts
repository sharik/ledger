// The Transactions-screen filter, as one pure predicate (ASSISTANT §5.5).
//
// This used to live inline in `TransactionsScreen`, which was fine while the screen was the only
// thing that applied it. The assistant broke that: `show_transactions` reports how many rows the
// user is about to see, and it computed that count from a *different* approximation of the same
// filter — so a search-text filter that matched nothing was reported as "9 rows" while the screen
// showed 0, and the assistant repeated the wrong number to the user.
//
// A receipt that disagrees with the screen is worse than no receipt, so there is now exactly one
// implementation and both callers use it.
import type { DateStr, Transaction, Vault } from './types'
import { CAT_TRANSFERS, isCashflow } from './types'
import { incomeCategoryId } from './selectors'
import { members } from './trackings'

/** The status chips on the Transactions screen. `all` is the absence of a status filter. */
export type TxnStatus = 'all' | 'review' | 'ai' | 'rule' | 'transfers' | 'recurring' | 'imported' | 'duplicates'

export const TXN_STATUSES: TxnStatus[] = ['all', 'review', 'ai', 'rule', 'transfers', 'recurring', 'imported', 'duplicates']

/**
 * Which figure in the Transactions totals bar a row belongs to — the drill behind pressing one.
 *
 * Its own axis because none of it is expressible with the filters above. `status: 'transfers'`
 * comes closest and still cannot tell a leg in from a leg out; nothing here can tell income from a
 * refund parked in an expense category, which is the entire distinction the second line draws. A
 * figure that opened an approximation of its own rows would be worse than one that opened nothing:
 * the reader would have no way to see that the list and the number had come apart.
 *
 * The buckets mirror the bar exactly — `in`/`out` split on sign alone, the rest apply the
 * Income/Refund/Transfer trichotomy (`derive()`, selectors.ts) — so the figure pressed becomes the
 * total of the list it opens.
 */
export type TxnFlow = 'in' | 'out' | 'income' | 'expenses' | 'transfer-in' | 'transfer-out'

export const TXN_FLOWS: TxnFlow[] = ['in', 'out', 'income', 'expenses', 'transfer-in', 'transfer-out']

export interface TxnFilterInput {
  /** Free text over merchant, raw descriptor and note. */
  q?: string
  cat?: string
  /**
   * Several categories at once, comma-joined — what a multi-category ("group") budget measures, so
   * its drill can land on exactly the rows its bar was measured from. A flat string rather than an
   * array because the route carries filters as a string map (`?cats=a,b`), and because `cat` stays
   * what it is: one id, the single-category case every other drill and chip uses.
   */
  cats?: string
  acct?: string
  merchant?: string
  from?: DateStr
  to?: DateStr
  status?: TxnStatus
  /** Trip/set membership — the one axis that is not a field on the row (ANALYTICS §1.3). */
  tracking?: string
  /** One bucket of the totals bar — see `TxnFlow`. */
  flow?: TxnFlow
}

/**
 * Rows the totals bar counted under `flow`.
 *
 * `in` is `amount > 0` and `out` is everything else, which is the split the bar's own loop makes —
 * so a €0 row files under `out` and contributes its zero there. Mirroring the loop is what keeps
 * "every row is in exactly one of in/out" true, and with it the promise that the two buckets add
 * back up to the set the reader was looking at.
 *
 * Sign is read off the raw amount, not the base-currency one. Conversion never changes a sign, so
 * the buckets agree with the bar; a row with no rate at all is missing from the FIGURE but present
 * in the LIST, which is the pre-existing behaviour the bar already discloses ("N excluded").
 */
function matchesFlow(t: Transaction, flow: TxnFlow, incomeCatId: string | undefined): boolean {
  const cash = isCashflow(t)
  const isIncome = cash && t.amount > 0 && t.categoryId === incomeCatId
  switch (flow) {
    case 'in':
      return t.amount > 0
    case 'out':
      return t.amount <= 0
    case 'income':
      return isIncome
    case 'expenses':
      return cash && !isIncome
    case 'transfer-in':
      return !cash && t.amount > 0
    case 'transfer-out':
      return !cash && t.amount <= 0
  }
}

/** Rows the search box would return for `needle` — the one predicate, so counts match the list. */
export const matchesQuery = (t: Transaction, needle: string): boolean =>
  `${t.merchant} ${t.importMeta?.raw ?? ''} ${t.note ?? ''}`.toLowerCase().includes(needle)

export interface FilterDeps {
  /** Ids of rows a duplicate scan flagged; only the `duplicates` status needs it. */
  dupIds?: Set<string>
  /**
   * Live account ids. An account hidden while its filter was active drops out, and the stale id is
   * then ignored rather than showing an unexplained empty list — the screen's existing behaviour.
   */
  acctIds?: Set<string>
}

/**
 * Filter `vault.transactions` exactly as the Transactions screen does. Not sorted or paged — the
 * screen and the assistant want different orders.
 */
export function filterTransactions(vault: Vault, f: TxnFilterInput, deps: FilterDeps = {}): Transaction[] {
  const needle = f.q?.trim().toLowerCase() ?? ''
  const reviewCat = vault.categories.find((c) => c.role === 'other')?.id
  // Membership is resolved ONCE, not per row: `members()` rescans the vault on every call.
  const memberIds = f.tracking ? members(f.tracking, vault) : null
  // Same discipline for the category set: split once, not per row. A value that yields no ids at
  // all (`''`, `',,'` — a hand-edited hash) filters nothing, rather than filtering everything away.
  const catIds = f.cats ? f.cats.split(',').filter(Boolean) : []
  const catSet = catIds.length > 0 ? new Set(catIds) : null
  // Resolved once, like `reviewCat` above, and only when a flow drill is actually on.
  const incomeCatId = f.flow ? incomeCategoryId(vault) : undefined

  return vault.transactions.filter((t) => {
    if (f.flow && !matchesFlow(t, f.flow, incomeCatId)) return false
    if (needle && !matchesQuery(t, needle)) return false
    if (f.cat && t.categoryId !== f.cat) return false
    if (catSet && !catSet.has(t.categoryId)) return false
    if (f.acct && (!deps.acctIds || deps.acctIds.has(f.acct)) && t.accountId !== f.acct) return false
    if (f.merchant && t.merchant !== f.merchant) return false
    // ISO dates compare as strings — the same property the screen's sort relies on.
    if (f.from && t.date < f.from) return false
    if (f.to && t.date > f.to) return false
    if (memberIds && !memberIds.has(t.id)) return false
    switch (f.status) {
      case 'review':
        return t.categoryId === reviewCat && !!t.importMeta
      case 'transfers':
        return !!t.transferGroupId || t.categoryId === CAT_TRANSFERS
      case 'recurring':
        return t.recurring != null
      case 'ai':
        return t.provenance === 'ai'
      case 'rule':
        return t.provenance === 'rule'
      case 'imported':
        return !!t.isNew
      case 'duplicates':
        return !!deps.dupIds?.has(t.id)
      default:
        return true
    }
  })
}
