import type { Iso } from './clock'

export type { Iso }
export type DateStr = string // 'YYYY-MM-DD'
export type MonthKey = string // 'YYYY-MM'

/** Fixed ids for categories the migration mints or reconciles, minted deterministically
 *  (Convention #4) so two devices migrating independently produce identical records. */
export const CAT_TRANSFERS = 'cat-transfers'
export const CAT_INCOME = 'cat-income'
export const CAT_HOUSING = 'cat-housing'
export const CAT_OTHER = 'cat-other'
export const CAT_UTILITIES = 'cat-utilities'
export const CAT_TRAVEL = 'cat-travel'
export const CAT_HEALTH = 'cat-health'
export const CAT_ENTERTAINMENT = 'cat-entertainment'
export const CAT_INSURANCE = 'cat-insurance'
export const CAT_TAXES_FEES = 'cat-taxes-fees'

/** The four categories that carry special logic, keyed off a stable `role` (not their
 *  display name) so names stay free to rename/localize (Category.role). */
export type CategoryRole = 'income' | 'housing' | 'other' | 'transfers'

export interface Account {
  id: string
  updatedAt: Iso
  name: string
  institution?: string
  last4?: string
  liab: boolean
  liquid: boolean
  apr?: number
  monthlyPayment?: number
  institutionId?: string // registry id: 'revolut' | 'bnp' | 'privat' | 'pumb' | 'monobank'
  fingerprint?: string // stable source key (IMPORT §5.8/§6.1); merge-unified §4.3
  currency?: string // ISO 4217; absent ⇒ 'EUR'
  /** Account holder name(s) from a statement — a weak match signal that prompts confirmation. */
  holderNames?: string[]
  /** Confirmed identity signals that auto-bind a future file, tagged `rib:`/`last4:`/`holder:`.
   *  A RIB is seeded at creation (self-proving); a last-4/holder lands here only once the user
   *  confirms that file→account binding (§5.8). */
  matchKeys?: string[]
  /** Retired account: the analytics read path never sees it, its transactions, its snapshots
   *  or its statements (`visibleVault`). Unlike `Tracking.archived` — hidden from pickers but
   *  still resolving everywhere — this resolves NOWHERE except the Accounts screen, which
   *  still lists it dimmed so it can be unhidden. Deliberately never consulted by import:
   *  identity resolution, dedupe and transfer pairing all run on the raw vault, or a
   *  re-import would mint a ghost account (§5.8). Absent ⇒ visible. */
  hidden?: boolean
}

/** Append-only: a balance "edit" appends a new snapshot, never mutates (SYNC §4.3). */
export interface BalanceSnapshot {
  id: string
  updatedAt: Iso
  accountId: string
  date: DateStr
  amount: number
  createdAt: Iso
  /**
   * ANALYTICS §2.2 — absent ⇒ legacy, treated as manual.
   *
   * `at` says which side of its date an anchor describes: `close` is the balance *after* that
   * day's last row (a closing balance, or a month-end read off a balance chain), `open` the
   * balance *before* its first row (an implied opening). Reconciliation has to know — a window
   * ending on an `open` anchor must exclude that day's transactions, which have not happened yet
   * as far as the figure is concerned. Absent ⇒ unknown, handled as `close` (the common case).
   */
  origin?: { kind: 'anchor'; statementId: string; at?: 'open' | 'close' } | { kind: 'manual' }
}

export interface Transaction {
  id: string
  updatedAt: Iso
  date: DateStr
  merchant: string
  categoryId: string
  amount: number // + income, − expense
  note?: string
  accountId?: string // absent on legacy manual txns
  currency?: string // row currency; defaults to account's
  original?: { amount: number; currency: string } // foreign leg verbatim, e.g. {−59290,'JPY'}
  fee?: number // informational; already folded into `amount` (IMPORT §5.4)
  counterparty?: string
  transferGroupId?: string // both legs share it when paired (IMPORT §9)
  /**
   * How this row's category was last decided — the §10.1 ladder rung, or `manual` once a
   * person overrode it. Absent ⇒ unknown: entered by hand, or imported before this was
   * recorded. Purely additive, so no schema bump: an older peer merges it through the
   * generic field pass untouched and simply never reads it.
   */
  provenance?: 'rule' | 'ai' | 'transfer' | 'fallback' | 'manual' | 'history'
  /** Recurrence cadence — an axis orthogonal to category (Netflix is Entertainment AND
   *  monthly-recurring). Absent ⇒ not recurring. Additive field, no schema bump needed. */
  recurring?: 'monthly' | 'yearly'
  importMeta?: {
    hash: string
    file?: string
    statementId?: string
    source?: string
    variant?: string
    line?: number
    ref?: string
    balanceAfter?: number
    raw?: string
    /**
     * Identities this row is ALSO known to represent — the hashes of duplicates merged into it.
     * Without this, resolving a duplicate would delete the only row carrying that hash and the very
     * next re-import of the statement would add it straight back, so the audit could never converge.
     * Ring-1 dedupe reads `hash` ∪ `dupHashes` (IMPORT §8.1). Additive, so no schema bump.
     */
    dupHashes?: string[]
  }
  /** Transient UI badge — excluded from merging entirely (SYNC §4.3). */
  isNew?: boolean
}

/**
 * A transaction counts toward income/expense cash-flow only if it is not a
 * transfer leg (IMPORT §9 / ANALYTICS §5): neither paired (`transferGroupId`)
 * nor filed under the Transfers category. Applied everywhere flows are summed.
 * (Lives here rather than selectors so the analytics layer can import it
 * without a selectors → fx → selections → selectors cycle.)
 */
export const isCashflow = (t: Transaction): boolean => !t.transferGroupId && t.categoryId !== CAT_TRANSFERS

export interface Category {
  id: string
  updatedAt: Iso
  name: string
  color: string
  /** Stable marker for the few categories with special logic (income/housing/other/transfers),
   *  so branches key off this instead of the display name. Absent ⇒ an ordinary category. */
  role?: CategoryRole
  /** Hide this category from the "where did my money go" spending breakdown — a
   *  presentation preference, not a correctness invariant (unlike role). Absent ⇒
   *  defaults to `role === 'housing'`, preserving the seeded Housing exclusion (#12a). */
  excludeFromBreakdown?: boolean
}

/** `spent` is never stored — always derived from transactions (SYNC §4.3). */
export interface Budget {
  id: string
  updatedAt: Iso
  categoryId: string
  amount: number
  fixed?: boolean
  /** A name the user gave this budget. A `group` scope needs one — several categories have no
   *  single name to borrow — and it is optional even there: absent ⇒ auto-titled from the
   *  members, the shape `SavedComparison.name` already uses. Elsewhere it overrides the label.
   *  Top-level rather than inside `scope` so field-LWW merges a rename on one device and a
   *  re-scope on another instead of one clobbering the other. */
  name?: string
  /** ANALYTICS §6.2 — absent ⇒ legacy category-month semantics. */
  scope?:
    | { kind: 'tracking'; trackingId: string }
    | { kind: 'category-year'; categoryId: string; year: number }
    /** Recurring spend of one cadence. Cross-category when `categoryId` is absent —
     *  minus `excludeCategoryIds` (e.g. Housing), with the budget's own `categoryId`
     *  parked on CAT_TRANSFERS, as tracking-scoped budgets do. When `categoryId` is
     *  set it targets that single category's recurring spend (#12c). */
    | { kind: 'recurring'; cadence: 'monthly' | 'yearly'; excludeCategoryIds?: string[]; categoryId?: string }
    /**
     * Several categories under one limit ("Fun" = Dining out + Entertainment). `year` absent ⇒
     * the viewed month; present ⇒ that calendar year — presence IS the discriminator, so a
     * "yearly budget with no year" cannot be expressed, and it mirrors `recurring.categoryId?`
     * (absent ⇒ cross-category). The budget's own `categoryId` parks on CAT_TRANSFERS, as
     * tracking and cross-category recurring scopes do.
     */
    | { kind: 'group'; categoryIds: string[]; year?: number }
}

/**
 * The real categories a budget MEASURES — never the `CAT_TRANSFERS` placeholder a
 * scope-driven budget parks its `categoryId` on. Empty for the scopes that are not about
 * a category at all (a trip, or every recurring charge across the vault).
 *
 * Excluded ids are not usage: `recurring.excludeCategoryIds` names what the budget refuses
 * to count, so a dangling exclusion is an inert no-op, not a reference.
 */
export function budgetCategoryIds(b: Budget): string[] {
  const s = b.scope
  if (!s) return [b.categoryId]
  if (s.kind === 'category-year') return [s.categoryId]
  if (s.kind === 'recurring') return s.categoryId ? [s.categoryId] : []
  if (s.kind === 'group') return s.categoryIds
  return []
}

/**
 * Duplicate identity for the merge's dup-budget post-pass (ANALYTICS §6.2) — and the same
 * test the add/edit dialog uses, so the UI can never mint a record the next merge would
 * silently tombstone.
 *
 * It lives here rather than in `sync/merge.ts` for the reason `isCashflow` does: two layers
 * need it and neither may import the other. Every scope kind MUST have an arm. The version
 * that did not was a data-loss bug: `recurring` fell through to `cat|${categoryId}`, so a
 * cross-category monthly and a cross-category yearly recurring budget (both parked on
 * CAT_TRANSFERS, both creatable from the Plan form) shared one key and the post-pass
 * tombstoned one of them — and a per-category recurring budget (#12c) collided with that
 * category's own plain monthly budget, the pair `budgetRollup` deliberately counts as two.
 */
export function budgetKey(b: Budget): string {
  const s = b.scope
  if (!s) return `cat|${b.categoryId}` // legacy category-month (Convention #5: one per category)
  if (s.kind === 'tracking') return `tracking|${s.trackingId}`
  if (s.kind === 'category-year') return `cat-year|${s.categoryId}|${s.year}`
  if (s.kind === 'recurring') return `recurring|${s.cadence}|${s.categoryId ?? '*'}`
  // Sorted, so the same set picked in a different order on two devices is one budget.
  return `group|${s.year ?? '*'}|${[...s.categoryIds].sort().join(',')}`
}

export interface Goal {
  id: string
  updatedAt: Iso
  name: string
  target: number
  saved: number
  monthly: number
  targetDate?: MonthKey
  /** Hidden from Plan/Dashboard lists; unarchive from Plan. */
  archived?: boolean
  /** ANALYTICS §6.1 — absent ⇒ legacy manual saved/monthly; exactly one of the two flow keys. */
  source?:
    | { kind: 'flow'; trackingId?: string; categoryId?: string }
    | { kind: 'balance'; accountId: string; direction: 'up' | 'down'; target: number } // target in euros; payoff = 0
}

/** Append-only import record (IMPORT §4), one per imported statement file. */
export interface StatementRecord {
  id: string
  updatedAt: Iso
  accountId: string
  institutionId: string
  variant: string
  fileName: string
  fileHash: string // sha256 of bytes — re-import short-circuit (IMPORT §12.3)
  periodFrom: DateStr
  periodTo: DateStr
  openingBalance?: number
  closingBalance?: number
  rowsTotal: number
  rowsImported: number
  rowsSkipped: { duplicate: number; pending: number; reverted: number; unparsed: number }
  importedAt: Iso
}

export interface Rule {
  id: string
  updatedAt: Iso
  categoryId: string
  priority: number // user 100 · learned 50 · seed 10
  source: 'seed' | 'learned' | 'user'
  enabled?: boolean // default true
  match: {
    field: 'creditorId' | 'counterparty' | 'merchant' | 'descriptor'
    op: 'equals' | 'prefix' | 'contains'
    value: string
    /**
     * Direction scope (#19). **Absent ⇒ matches either direction**, which must stay the default:
     * IMPORT §5.4 needs a `Card Refund` (a positive amount) to read as its merchant's category,
     * so a merchant rule is deliberately sign-blind. Set on `counterparty` keys, where direction
     * IS part of identity — one person both sends and receives, and money *leaving* for an
     * untracked account is not income however the money arriving from it was categorized.
     *
     * Additive optional ⇒ no schema bump and no migration (the #11f argument): field-level merge
     * carries an unknown key through untouched.
     */
    sign?: 'inflow' | 'outflow'
  }
}

export interface FxOverride {
  id: string
  updatedAt: Iso
  from: string
  to: string
  date: DateStr
  rate: number
}

// ---- schema 3: trackings & comparison analytics (ANALYTICS §2) ----

/** A named, colored, date-ranged or hand-curated set of transactions (ANALYTICS §2.1). */
export interface Tracking {
  id: string
  updatedAt: Iso
  name: string
  kind: 'trip' | 'set'
  color?: string // token from the design palette
  dateFrom?: DateStr // the implicit window; trips have one, sets may
  dateTo?: DateStr
  archived?: boolean // hidden from pickers, still resolves everywhere
}

/** The entire curation mechanism (ANALYTICS §3): one live record per (trackingId, txnId). */
export interface TrackingAssignment {
  id: string
  updatedAt: Iso
  trackingId: string
  txnId: string
  dir: 'include' | 'exclude'
}

export type PeriodRef =
  | { rel: 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear' | 'sameMonthLastYear' } // evergreen (§5.2)
  | { month: MonthKey } // '2026-05'
  | { year: number }
  | { from: DateStr; to: DateStr } // absolute custom range

/** A *stored value shape* inside SavedComparison — not a collection. */
export interface Selection {
  period?: PeriodRef
  categoryIds?: string[]
  trackingIds?: string[]
  accountIds?: string[]
  merchantQuery?: string // normalized contains-match
  includeNonCashflow?: boolean // default false → isCashflow applies
}

export interface SavedComparison {
  id: string
  updatedAt: Iso
  name?: string // absent → auto-title from selections
  selections: Selection[] // 1–4; length 1 = a pinned watch
  normalize?: 'total' | 'perDay' | 'perMonth'
  pinned?: boolean
  order?: number // dashboard placement
}

/** A value a widget's parameters may hold — whatever survives a JSON round-trip through sync. */
export type WidgetParam = string | number | boolean | string[]

/**
 * A chart from anywhere in the app, pinned to the dashboard.
 *
 * Not a `SavedComparison`, which requires `selections` and means "re-run this query": a pinned
 * Trends chart has no selections at all, and pinning one would have meant handing `compare()` a
 * dummy to chew on. What it stores instead is a catalogue id plus the screen state the chart was
 * showing, which the dashboard replays against the live vault — so a pin stays evergreen the same
 * way `{ rel: 'thisMonth' }` does.
 *
 * `widget` is a plain string rather than the UI's `WidgetId` union on purpose: an id from a newer
 * peer has to survive a sync and a save, and merely render as unavailable.
 */
export interface PinnedWidget {
  id: string
  updatedAt: Iso
  widget: string
  params?: Record<string, WidgetParam>
  name?: string // absent → the catalogue's title
  order?: number // dashboard placement, as SavedComparison.order
}

// ---- schema 5: assistant skills (ASSISTANT §6) ----

/**
 * A note the assistant can read on demand — the mechanism for anything Ledger cannot derive
 * ("value the flat at 320k", "Revolut top-ups are transfers, not income"). Progressive disclosure
 * is the whole point: `list_skills` sends only `name` + `description`, and `body` leaves the device
 * solely when the model asks for that skill by name, so a long private note costs nothing on the
 * questions it does not touch.
 *
 * Built-in skills ship as static `.md` files and are NOT records here — only their off-state
 * persists, in `Settings.assist.skillsOff`. A user skill whose `name` matches a built-in shadows it,
 * which is how a built-in gets edited.
 */
export interface Skill {
  id: string
  updatedAt: Iso
  name: string // kebab-case handle `read_skill` takes; unique among live skills
  description: string // one line — the only part sent before the body is asked for
  body: string // markdown
  enabled?: boolean // absent ⇒ enabled
}

export interface Params {
  id: 'params'
  updatedAt: Iso
  invReturn: number // % / yr
  inflation: number // % / yr
  srTarget: number // %
  efTarget: number // months
  baseCurrency?: string // default 'EUR'
  reconTolerance?: number // euros, default 1.0 (Convention #3)
  rulesOfThumb?: boolean // Phase F — show reference lines on Plan (BRIEF §9); default off
}

export type SaveMode = 'onChange' | 'onLock' | 'manual'

export interface Settings {
  id: 'settings'
  updatedAt: Iso
  saveMode: SaveMode
  // §10.6. `provider` is a free-form id (preset, models.dev catalog id, or 'custom'); `wire` picks the
  // request shape and defaults to anthropic-for-'anthropic', OpenAI-compatible for everything else —
  // so vaults written before the catalog existed keep working untouched. `apiKey`/`baseUrl` are the
  // active provider's; `perProvider` retains the others', so switching provider neither sends one
  // provider's secret to another's endpoint nor throws away what you already typed.
  assist?: {
    provider: string
    wire?: 'anthropic' | 'openai'
    baseUrl?: string
    model: string
    apiKey: string
    perProvider?: Record<string, { apiKey?: string; baseUrl?: string }>
    /**
     * ASSISTANT §2 — consent for the chat assistant, deliberately SEPARATE from configuring a
     * provider. Smart categorization sends redacted descriptors and never an amount; the assistant
     * sends whatever its tool calls return. Widening the first toggle to cover the second would be
     * a bait-and-switch, so chat stays off until this is set explicitly. Absent ⇒ off.
     */
    chat?: boolean
    /**
     * ASSISTANT §4 — `${provider}::${model}` that last passed the live tool-calling probe. The
     * assistant cannot work without tool calling, so the toggle stays locked until this matches the
     * configured pair; changing either clears it and re-arms the gate.
     */
    toolsVerified?: string
    /** Names of BUILT-IN skills the user switched off. User skills carry their own `enabled`. */
    skillsOff?: string[]
    /**
     * ASSISTANT §2.1 — the assistant's OWN provider and model, independent of categorization's.
     * The two jobs want different models: categorization is a cheap high-volume classifier a local
     * runtime handles well, the assistant is a reasoning agent that has to call tools correctly.
     * Absent ⇒ inherit `provider`/`wire`/`model` above, so a vault that never touches this keeps
     * behaving exactly as before.
     *
     * There is deliberately no `chatBaseUrl`: `perProvider` already banks a base URL and key per
     * provider, so the chat provider's credentials come from there and no secret is duplicated.
     */
    chatProvider?: string
    chatWire?: 'anthropic' | 'openai'
    chatModel?: string
    /**
     * ASSISTANT §2.2 — how much of the vault the assistant may read. **Absent ⇒ 'safe'**, for every
     * vault, including one that already consented to chat: the safe default is the whole point, and
     * silently keeping full access for existing vaults would defeat it.
     *
     * 'safe' withholds every amount, every date and every transaction row — the assistant sees names,
     * flags and counts, explains how each screen derived its own figure, and opens screens so the
     * numbers are read on this device instead of travelling to a provider. 'full' is today's
     * behaviour: whatever answering the question requires.
     */
    chatAccess?: 'safe' | 'full'
  }
  fx?: { baseUrl?: string; fallbackUrl?: string }
  starterPackOffered?: boolean // §10.4 — the one-time starter-pack offer has been shown
  /** #12b — `merchantKey`s whose recurring suggestion the user dismissed. Persisted, so a
   *  declined offer stays declined across reloads instead of returning on every visit. */
  recurringDismissed?: string[]
}

export type CollectionName =
  | 'accounts'
  | 'snapshots'
  | 'transactions'
  | 'categories'
  | 'budgets'
  | 'goals'
  | 'statements'
  | 'rules'
  | 'fxOverrides'
  | 'trackings'
  | 'trackingAssignments'
  | 'savedComparisons'
  | 'pinnedWidgets'
  | 'skills'

export interface Tombstone {
  id: string // the dead record's id
  collection: CollectionName
  deletedAt: Iso
  updatedAt: Iso
}

export type ConflictKind =
  | 'field-lww'
  | 'simultaneous'
  | 'edit-delete'
  | 'dup-snapshot'
  | 'dup-import'
  | 'dup-budget'
  | 'txfr-ambiguous'
  | 'stmt-mismatch'
  | 'stmt-gap'
  /** An import restated a period an existing statement already covers (IMPORT §8.1). */
  | 'stmt-overlap'
  | 'dup-account'
  | 'tag-conflict'
  | 'dup-tracking'

export interface ConflictEntry {
  id: string
  createdAt: Iso
  collection: CollectionName | 'params' | 'settings'
  recordId: string
  recordLabel: string
  field?: string
  keptValue?: unknown
  discardedValue?: unknown
  keptFrom: 'local' | 'remote'
  keptAt: Iso
  discardedAt: Iso
  kind: ConflictKind
  reviewedAt?: Iso
}

export const SCHEMA_VERSION = 7

export interface Vault {
  schema: number
  vaultId: string
  createdAt: Iso
  accounts: Account[]
  snapshots: BalanceSnapshot[]
  transactions: Transaction[]
  categories: Category[]
  budgets: Budget[]
  goals: Goal[]
  statements: StatementRecord[]
  rules: Rule[]
  fxOverrides: FxOverride[]
  trackings: Tracking[]
  trackingAssignments: TrackingAssignment[]
  savedComparisons: SavedComparison[]
  pinnedWidgets: PinnedWidget[]
  skills: Skill[]
  params: Params
  settings: Settings
  tombstones: Tombstone[]
  syncNotes: ConflictEntry[]
}

export type AnyRecord =
  | Account
  | BalanceSnapshot
  | Transaction
  | Category
  | Budget
  | Goal
  | StatementRecord
  | Rule
  | FxOverride
  | Tracking
  | TrackingAssignment
  | SavedComparison
  | PinnedWidget
  | Skill

export const COLLECTIONS: CollectionName[] = [
  'accounts',
  'snapshots',
  'transactions',
  'categories',
  'budgets',
  'goals',
  'statements',
  'rules',
  'fxOverrides',
  'trackings',
  'trackingAssignments',
  'savedComparisons',
  'pinnedWidgets',
  'skills',
]

/** Fields stripped before merge diffing and from merged output (SYNC §4.3). */
export const TRANSIENT_FIELDS: Partial<Record<CollectionName, string[]>> = {
  transactions: ['isNew'],
}
