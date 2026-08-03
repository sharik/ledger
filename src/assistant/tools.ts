// The assistant's tool catalogue and its local executors (ASSISTANT §5).
//
// This file is the entire boundary between the model and the vault. Two rules shape it:
//
//  1. NOTHING is injected. The model starts a conversation knowing only that these tools exist —
//     no categories, no accounts, no balances. It learns this vault by asking. So the data that
//     leaves the device is exactly what the question required, and a conversation the user abandons
//     after one sentence has sent one sentence.
//
//  2. Ids are plain strings, not enums. The import path constrains `categoryId` to an enum of the
//     user's own ids so an invented id is ungrammatical — but that enum IS injected context, and
//     putting every category and account name into the schema of every request is precisely what
//     rule 1 forbids. Here a bad id comes back as a structured error naming the valid ones, which
//     doubles as discovery: a wrong guess teaches the model the right answer for one round trip.
//
// Executors are pure over `ToolCtx` except the three control tools, which drive the router, and
// `propose_edit`, which commits nothing — it hands a pending proposal to the UI for approval.
import type { Account, Budget, Goal, Selection, Skill, Transaction, Vault } from '../model/types'
import { budgetCategoryIds, budgetKey, CAT_TRANSFERS, isCashflow } from '../model/types'
import type { Derived } from '../model/selectors'
import type { RateBook } from '../import/fx'
import { accountCurrencyMap, rowCurrency } from '../import/fx'
import { budgetScopeLabel, budgetScopeSpent, budgetScopeTxns, scopeTrailingAvg } from '../analytics/budgets'
import { compare } from '../analytics/compare'
import { duplicateIds, findDuplicateImports } from '../analytics/duplicates'
import { goalStatus } from '../analytics/goals'
import { tripSummary } from '../analytics/trips'
import { resolveSelection, selectionPeriod } from '../analytics/selections'
import { members } from '../model/trackings'
import { filterTransactions, TXN_STATUSES, type TxnFlow, type TxnStatus } from '../model/txnFilter'
import { monthKeyOf } from '../model/selectors'
import { redactDescriptor } from '../import/assist'
import type { Op } from '../model/mutations'
import type { TxnFilter } from '../ui/route'
import type { Tab } from '../ui/view'
import type { Access } from './config'
import type { ToolDef } from './wire'

/** Rows returned by `query_transactions` in one call. Aggregates carry the whole set's totals. */
export const ROW_CAP = 50

export interface SkillView {
  name: string
  description: string
  body: string
  builtin: boolean
}

/** A mutation the model proposed. It reaches the vault only if the user clicks Apply. */
export interface PendingEdit {
  summary: string
  detail: string
  op: Op
}

export interface ToolCtx {
  /** The RAW vault: hidden accounts are in scope on purpose (§5, "inactive accounts"). */
  vault: Vault
  derived: Derived
  rates?: RateBook
  today: string
  /**
   * How much of the vault this run may read (§5.0). Required, not optional with a default: every
   * construction site has to state it, so granting access is always a visible decision and `tsc`
   * finds the ones that forgot. `runChat` overwrites it from settings before every call, so the
   * stored preference — not the caller — is the authority.
   */
  access: Access
  /**
   * Per-call memo of tracking membership. `members()` rescans every transaction, so resolving it
   * inside a per-row loop was quadratic: on a 3k-transaction vault with six trips, one
   * `groupBy: "tracking"` was ~60M operations on the main thread. Populated lazily by `memberSet`.
   */
  memberCache?: Map<string, Set<string>>
  /** Router control. Absent in unit tests, where the control tools report as unavailable. */
  nav?: {
    goTab: (tab: Tab) => void
    goTxns: (filter: TxnFilter) => void
    goCompare: (a: Selection, b: Selection, normalize?: string, mode?: string) => void
  }
  /** Enabled skills, built-ins already shadowed by same-named user skills. */
  skills: SkillView[]
  /** Queue a proposal for the user to approve. */
  propose?: (edit: PendingEdit) => void
}

// ---------------------------------------------------------------- schema fragments

const SELECTION_SCHEMA = {
  type: 'object',
  description:
    'Which transactions to look at. Every field is optional and they combine with AND; omit a field to leave that axis unconstrained.',
  properties: {
    period: {
      type: 'object',
      description:
        'One of: {"rel":"thisMonth"|"lastMonth"|"thisYear"|"lastYear"|"sameMonthLastYear"}, {"month":"YYYY-MM"}, {"year":2026}, or {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}. Omit for all time.',
    },
    categoryIds: { type: 'array', items: { type: 'string' }, description: 'Category ids from list_categories.' },
    accountIds: { type: 'array', items: { type: 'string' }, description: 'Account ids from list_accounts.' },
    trackingIds: { type: 'array', items: { type: 'string' }, description: 'Trip/set ids from list_trackings. OR within this field.' },
    merchantQuery: { type: 'string', description: 'Case-insensitive substring match on the merchant.' },
    includeNonCashflow: {
      type: 'boolean',
      description: 'Default false. Transfers between the user’s own accounts are excluded unless this is true.',
    },
    recurring: { type: 'string', description: '"monthly" or "yearly" to keep only rows flagged with that cadence.' },
  },
}

/** `propose_plan`'s budget amount. Safe mode refuses the trailing forms, so it must not offer them. */
const AMOUNT_DESC = 'A number, or "trailing-3" / "trailing-6" for a budget.'
const AMOUNT_DESC_SAFE =
  'A number, for a budget. It has to come from the user, because safe mode cannot work an average out for you.'

// ---------------------------------------------------------------- the catalogue

export const TOOLS: ToolDef[] = [
  {
    name: 'get_overview',
    description:
      'Orientation: base currency, today’s date, the months the data covers, record counts, and how fresh the data is. Cheap — call this first when you need to know what this vault even contains.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_categories',
    description: 'Every category with its id, name and role. Call before using any category id.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_accounts',
    description:
      'Every account: id, name, institution, currency, whether it is a liability, whether it is liquid, whether it is hidden (retired), and its latest balance with the date that balance is "as of". Includes hidden accounts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_trackings',
    description:
      'Trips and sets — hand-curated groups of transactions — with their windows, member counts and total SPEND (income inside the window is not netted off). This one call is enough to rank trips by cost; do not aggregate them one at a time.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_budgets',
    description: 'Budgets with their name, scope, the categories they measure, amount and derived spend for a month.',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM. Defaults to the current month.' } },
    },
  },
  {
    name: 'list_goals',
    description: 'Goals with target, progress and whether they are archived.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'aggregate',
    description:
      'Totals for a selection, grouped. THE DEFAULT WAY TO ANSWER A "how much" QUESTION — prefer it over query_transactions, which is for questions about individual rows. Returns `expense`, `income` and `net` separately with a sorted breakdown. What something COST is `expense`; never quote `net` as a cost, because a period containing a salary nets positive however much was spent.',
    parameters: {
      type: 'object',
      required: ['selection', 'groupBy'],
      properties: {
        selection: SELECTION_SCHEMA,
        groupBy: {
          type: 'string',
          description: 'One of: category, month, merchant, account, tracking, none.',
        },
        limit: { type: 'number', description: 'Max groups to return, largest first. Default 20.' },
      },
    },
  },
  {
    name: 'query_transactions',
    description:
      `Individual transactions matching a selection, at most ${ROW_CAP} of them, plus the count and sum of the FULL match so you can tell when you are seeing a slice. Use for "what was that charge", not for totals.`,
    parameters: {
      type: 'object',
      required: ['selection'],
      properties: {
        selection: SELECTION_SCHEMA,
        sort: { type: 'string', description: 'One of: date_desc (default), date_asc, amount_desc, amount_asc.' },
        limit: { type: 'number', description: `Max rows, capped at ${ROW_CAP}.` },
      },
    },
  },
  {
    name: 'compare_selections',
    description:
      'Compare two selections: totals, the difference, and the per-category movers. Use normalize when the periods differ in length, and note that by default a completed period is truncated to match an in-progress one so the comparison is fair.',
    parameters: {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: SELECTION_SCHEMA,
        b: SELECTION_SCHEMA,
        normalize: { type: 'string', description: 'total (default), perDay, or perMonth.' },
        mode: { type: 'string', description: 'samePoint (default, truncates to the same elapsed length) or full.' },
      },
    },
  },
  {
    name: 'navigate',
    description: 'Open a screen in the app for the user.',
    parameters: {
      type: 'object',
      required: ['tab'],
      properties: {
        tab: { type: 'string', description: 'One of: dash, compare, trends, trips, plan, accounts, txns, settings.' },
      },
    },
  },
  {
    name: 'show_transactions',
    description:
      'Open the Transactions screen filtered to what you are talking about, so the user can check the number you just gave them. Do this after any claim about a specific slice of spending. Returns the exact number of rows the screen now shows.',
    parameters: {
      type: 'object',
      properties: {
        categoryId: { type: 'string' },
        accountId: { type: 'string' },
        trackingId: {
          type: 'string',
          description:
            'A trip or set from list_trackings. Use this for "show me the X trip" — membership is curated, so a date range is NOT the same thing and will show rows that are not in the trip.',
        },
        from: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        to: { type: 'string', description: 'YYYY-MM-DD inclusive.' },
        merchant: { type: 'string', description: 'Exact merchant name.' },
        search: { type: 'string', description: 'Free text over merchant, raw descriptor and note.' },
        status: {
          type: 'string',
          description: 'One of: all, review, ai, rule, transfers, recurring, imported, duplicates.',
        },
      },
    },
  },
  {
    name: 'show_comparison',
    description: 'Open the Compare screen with both sides already set to the selections you compared.',
    parameters: {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: SELECTION_SCHEMA,
        b: SELECTION_SCHEMA,
        normalize: { type: 'string', description: 'total, perDay, or perMonth.' },
        mode: { type: 'string', description: 'samePoint or full.' },
      },
    },
  },
  {
    name: 'list_skills',
    description:
      'Notes the user keeps for you — house rules, valuations, conventions this app cannot derive. Returns names and one-line descriptions only. Check this when a question depends on something the data cannot tell you.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_skill',
    description: 'The full text of one skill, by name.',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'propose_edit',
    description:
      'Propose a change for the user to approve. It does NOT take effect until they click Apply, so say what you are proposing in your reply too. Only these four kinds of change are possible.',
    parameters: {
      type: 'object',
      required: ['kind', 'txnIds'],
      properties: {
        kind: {
          type: 'string',
          description: 'One of: recategorize, set_recurring, tag_tracking, merge_merchant.',
        },
        txnIds: { type: 'array', items: { type: 'string' }, description: 'Transaction ids from query_transactions.' },
        categoryId: { type: 'string', description: 'For recategorize.' },
        recurring: { type: 'string', description: 'For set_recurring: monthly, yearly, or none.' },
        trackingId: { type: 'string', description: 'For tag_tracking.' },
        merchant: {
          type: 'string',
          description:
            'For merge_merchant: the spelling to keep. Use when one merchant is written two ways (a reference or country suffix on some rows), which makes it read as two subscriptions and two rows in the grouped view. Pass the ids of the rows spelled the OTHER way. Never merge merchants that merely share a prefix and could be different services.',
        },
        direction: {
          type: 'string',
          description:
            'For tag_tracking: "add" (default) puts the rows in the trip, "remove" takes them out. A trip contains every row in its date range, so "remove" is how a subscription, insurance premium or bank fee that merely fell inside those dates gets excluded from the trip’s total.',
        },
        reason: { type: 'string', description: 'One line the user will read on the approval card.' },
      },
    },
  },
  {
    name: 'propose_plan',
    description:
      'Propose creating, changing, archiving or removing a BUDGET or a GOAL, for the user to approve. ' +
      'It does NOT take effect until they click Apply, so say what you are proposing in your reply too. ' +
      'THE CARD CANNOT BE EDITED. It shows exactly the figures you pass here, and the only two things ' +
      'the user can do is Apply it or Dismiss it. So never fill a required amount with a placeholder ' +
      'and tell them to correct it before applying — there is nowhere to correct it, and one click ' +
      'turns your invented number into their real target. If you need a figure you do not have, ask ' +
      'for it in a reply and wait; propose nothing until they answer. ' +
      'Prefer archiving a goal over deleting it. For a budget amount you may pass the literal number, or ' +
      '"trailing-3"/"trailing-6" to use what that budget actually cost over the last 3 or 6 complete months — ' +
      'Ledger works the figure out itself, so the card shows the same number the app would suggest. ' +
      'A GOAL tracks its progress in one of four ways, and you pick which by passing ONE of these: ' +
      'accountId (progress is that account’s latest balance snapshot), categoryIds with a single id ' +
      '(progress is the sum of that category’s transactions, updated as new ones arrive), trackingId ' +
      '(the sum of a trip’s transactions), or none of them, which makes it a goal the user updates by ' +
      'hand with monthly/saved. Prefer a derived source over a hand-updated one. ' +
      'A GOAL HAS NO PERIOD: a category or trip source sums for all time and never resets, so a target ' +
      'that repeats every year ("invest 30k a year") is a yearly BUDGET on that category, not a goal. ' +
      'Goals are for a single cumulative target with a date. And a goal can follow at most ONE account, ' +
      'so a target for total net worth, or one that counts assets Ledger does not hold, has to be the ' +
      'hand-updated kind — say so plainly rather than implying it will keep itself current.',
    parameters: {
      type: 'object',
      required: ['action', 'target'],
      properties: {
        action: { type: 'string', description: 'One of: create, update, archive, remove.' },
        target: { type: 'string', description: 'One of: budget, goal.' },
        id: { type: 'string', description: 'The budget or goal id, for update / archive / remove.' },
        name: { type: 'string', description: 'Display name. Required for a goal, and for a budget over several categories.' },
        amount: { type: 'string', description: AMOUNT_DESC },
        categoryIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Budget: one id, or several for one limit covering them all. Goal: exactly one id, and progress ' +
            'becomes the running sum of that category’s transactions, so the goal fills itself in and needs ' +
            'no manual updating.',
        },
        cadence: { type: 'string', description: 'Budget: "monthly" (default) or "yearly".' },
        recurringOnly: { type: 'boolean', description: 'Budget: count only charges marked recurring.' },
        trackingId: {
          type: 'string',
          description:
            'Budget: a trip instead of categories. Goal: progress is the running sum of that trip’s transactions.',
        },
        targetAmount: { type: 'string', description: 'Goal: the amount being worked toward. Required when creating one, and it must be a figure the user gave you.' },
        accountId: { type: 'string', description: 'Goal: progress is this account’s latest balance snapshot.' },
        direction: { type: 'string', description: 'Goal, with accountId: "up" to save up, "down" to pay off.' },
        monthly: { type: 'string', description: 'Goal with no accountId, categoryIds or trackingId: the amount added each month.' },
        saved: { type: 'string', description: 'Goal with no accountId, categoryIds or trackingId: how much is set aside already. A derived goal ignores it.' },
        targetDate: { type: 'string', description: 'Goal: YYYY-MM the target should be reached by.' },
        reason: { type: 'string', description: 'One line the user will read on the approval card.' },
      },
    },
  },
]

// ---------------------------------------------------------------- access (§5.0)

/**
 * Tools withheld in safe mode. Every one of them hands back money, a date, or a transaction row.
 *
 * `propose_edit` is here for a different reason: it needs `txnIds`, which only `query_transactions`
 * produces, so in safe mode it could never be used. Advertising a tool that cannot work is worse
 * than withholding it.
 *
 * `propose_plan` is deliberately NOT here. It writes, but a write is not a read: when the model
 * proposes "set the groceries budget to 400", the 400 came from the person asking, not from the
 * vault, and nothing about their spending travelled to get it. Only two of its paths would leak a
 * vault figure back to the model, and `proposePlan` closes both in safe mode: a `trailing-3`
 * amount, which Ledger works out from real spending, and the duplicate-budget error, which names
 * the existing budget's amount. Everything else it does — archive a goal, rename one, delete a
 * budget, set an amount the user just said out loud — reads nothing.
 */
export const FULL_ONLY: readonly string[] = ['aggregate', 'query_transactions', 'compare_selections', 'propose_edit']

/**
 * The catalogue for an access level. Safe mode keeps discovery (names, flags, counts), the skills
 * pair, and the three control tools — those move no data off the device; they put the user's own
 * numbers on their own screen.
 */
export const toolsFor = (access: Access): ToolDef[] =>
  access === 'full' ? TOOLS : TOOLS.filter((t) => !FULL_ONLY.includes(t.name)).map(safeSchema)

/**
 * Descriptions have to match what the executor will actually do at this access level. `propose_plan`
 * advertises `trailing-3`/`trailing-6` for a budget amount, and safe mode refuses them (§5.0) — so a
 * model that reads the schema, calls it, and gets refused has burned a round on the tool's own advice.
 * One real conversation did that three times in a row before this existed.
 */
function safeSchema(tool: ToolDef): ToolDef {
  if (tool.name !== 'propose_plan') return tool
  const props = tool.parameters.properties as Record<string, unknown>
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...props, amount: { type: 'string', description: AMOUNT_DESC_SAFE } },
    },
  }
}

/**
 * Withheld tools a skill's text leans on, so Settings can say so on the skill rather than letting the
 * user discover it through an assistant that reads a note and then cannot follow it.
 */
export const safeModeGaps = (body: string): string[] => FULL_ONLY.filter((name) => body.includes(name))

const SAFE_REFUSAL =
  'the assistant is in safe mode, which withholds every amount, date and transaction. Answer from what the other tools give you — names and counts — and open the screen so the figure is read on this device. The user can switch the assistant to full access in Settings.'

// ---------------------------------------------------------------- executor

export interface ExecOutcome {
  /** JSON text handed back to the model. */
  content: string
  error?: boolean
  /** One line for the transcript, so every number in the reply has a visible provenance. */
  receipt: string
}

/**
 * Run one tool. Never throws: a bad argument comes back as `{error}` the model can read and correct,
 * because a thrown exception would end the conversation over a fixable mistake.
 */
export function execTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): ExecOutcome {
  try {
    // One membership memo per call — never shared across calls, since the vault can change between
    // them (the user may have applied a proposal).
    return run({ ...ctx, memberCache: new Map() }, name, args)
  } catch (e) {
    return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function memberSet(ctx: ToolCtx, trackingId: string): Set<string> {
  const hit = ctx.memberCache?.get(trackingId)
  if (hit) return hit
  const set = members(trackingId, ctx.vault)
  ctx.memberCache?.set(trackingId, set)
  return set
}

function run(ctx: ToolCtx, name: string, args: Record<string, unknown>): ExecOutcome {
  // Second layer, and the one that actually holds. `toolsFor` decides what the model is OFFERED;
  // this decides what it GETS. A model can name a tool it was never given — from a stale transcript,
  // a skill that mentions one, or plain invention — so filtering the catalogue alone is not a boundary.
  if (ctx.access !== 'full' && FULL_ONLY.includes(name)) return fail(`${name} is unavailable: ${SAFE_REFUSAL}`)

  switch (name) {
    case 'get_overview':
      return getOverview(ctx)
    case 'list_categories':
      return listCategories(ctx)
    case 'list_accounts':
      return listAccounts(ctx)
    case 'list_trackings':
      return listTrackings(ctx)
    case 'list_budgets':
      return listBudgets(ctx, args)
    case 'list_goals':
      return listGoals(ctx)
    case 'aggregate':
      return aggregate(ctx, args)
    case 'query_transactions':
      return queryTransactions(ctx, args)
    case 'compare_selections':
      return compareSelections(ctx, args)
    case 'navigate':
      return navigate(ctx, args)
    case 'show_transactions':
      return showTransactions(ctx, args)
    case 'show_comparison':
      return showComparison(ctx, args)
    case 'list_skills':
      return listSkills(ctx)
    case 'read_skill':
      return readSkill(ctx, args)
    case 'propose_edit':
      return proposeEdit(ctx, args)
    case 'propose_plan':
      return proposePlan(ctx, args)
    default:
      return fail(`Unknown tool "${name}".`)
  }
}

const ok = (value: unknown, receipt: string): ExecOutcome => ({ content: JSON.stringify(value), receipt })
const fail = (message: string, extra: Record<string, unknown> = {}): ExecOutcome => ({
  content: JSON.stringify({ error: message, ...extra }),
  error: true,
  receipt: message,
})

// ---------------------------------------------------------------- discovery
//
// In safe mode these six are the entire data surface, so the shape of what they withhold IS the
// feature. One rule, applied without exception: **identities, flags and counts**. No amount, no date,
// no row. `monthsCovered` is a count of months, not a span; a count of transactions is not a sum of
// them. `today` stays because it is the clock, not this person's money.

const safeMode = (ctx: ToolCtx): boolean => ctx.access !== 'full'

/** Transactions per key, one pass — the only quantity safe mode reports. */
function countBy(txns: Transaction[], key: (t: Transaction) => string): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of txns) {
    const k = key(t)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

function getOverview(ctx: ToolCtx): ExecOutcome {
  const { vault, derived } = ctx
  const months = derived.monthsTracked
  const dates = vault.transactions.map((t) => t.date)
  const span = safeMode(ctx)
    ? { access: 'safe' as const }
    : {
        firstMonth: months[0] ?? null,
        lastMonth: months[months.length - 1] ?? null,
        latestTransactionDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
      }
  return ok(
    {
      today: ctx.today,
      baseCurrency: vault.params.baseCurrency ?? 'EUR',
      monthsCovered: months.length,
      ...span,
      counts: {
        transactions: vault.transactions.length,
        accounts: vault.accounts.length,
        hiddenAccounts: vault.accounts.filter((a) => a.hidden).length,
        categories: vault.categories.length,
        trackings: vault.trackings.length,
        budgets: vault.budgets.length,
        goals: vault.goals.length,
        skills: ctx.skills.length,
      },
    },
    `Overview · ${months.length} month${months.length === 1 ? '' : 's'} of data`,
  )
}

function listCategories(ctx: ToolCtx): ExecOutcome {
  const counts = safeMode(ctx) ? countBy(ctx.vault.transactions, (t) => t.categoryId) : undefined
  const rows = ctx.vault.categories.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    excludedFromBreakdown: c.excludeFromBreakdown ?? c.role === 'housing',
    ...(counts ? { transactionCount: counts.get(c.id) ?? 0 } : {}),
  }))
  return ok(rows, `Categories · ${rows.length}`)
}

/**
 * Account numbers, RIB fingerprints, holder names and the confirmed match keys are deliberately
 * absent: none of them helps answer a money question, and all of them are exactly what you would
 * not want in a provider's logs.
 */
function listAccounts(ctx: ToolCtx): ExecOutcome {
  // Safe mode reports only WHETHER a balance is on record: the amount and the "as of" date are both
  // this person's money, and a balance without its date would be worse than none at all. A legacy
  // manual transaction has no accountId, so it counts toward no account rather than toward one.
  const counts = safeMode(ctx) ? countBy(ctx.vault.transactions, (t) => t.accountId ?? '') : undefined
  const rows = ctx.vault.accounts.map((a: Account) => {
    const bal = ctx.derived.currentBalance.get(a.id)
    return {
      id: a.id,
      name: a.name,
      institution: a.institution,
      currency: a.currency ?? ctx.vault.params.baseCurrency ?? 'EUR',
      liability: a.liab,
      liquid: a.liquid,
      hidden: !!a.hidden,
      ...(counts
        ? { hasBalance: !!bal, transactionCount: counts.get(a.id) ?? 0 }
        : { balance: bal ? { amount: round2(bal.amount), asOf: bal.date } : null }),
    }
  })
  const hidden = rows.filter((r) => r.hidden).length
  return ok(rows, `Accounts · ${rows.length}${hidden ? ` (${hidden} hidden)` : ''}`)
}

/**
 * Trips and sets WITH their totals, from `tripSummary` — the same function the Trips screen renders,
 * so the number here is the number on the card.
 *
 * The totals are here rather than left to N follow-up `aggregate` calls for two reasons. Ranking
 * six trips used to cost six rounds out of the loop's budget, and — worse — those aggregates
 * returned NET cash flow, so a trip whose window happened to contain a payday looked cheap or even
 * profitable. That produced a confidently wrong "most expensive trip" answer. `tripSummary.total`
 * is spend-only, like the rest of the app.
 */
function listTrackings(ctx: ToolCtx): ExecOutcome {
  const base = ctx.vault.params.baseCurrency ?? 'EUR'
  if (safeMode(ctx)) {
    // A trip's window is a date this person typed — where they were, and when. `tripSummary` is not
    // called at all here, so no total is computed even locally.
    const rows = ctx.vault.trackings.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      archived: !!t.archived,
      memberCount: memberSet(ctx, t.id).size,
    }))
    return ok({ access: 'safe', trackings: rows }, `Trips & sets · ${rows.length}`)
  }
  const rows = ctx.vault.trackings.map((t) => {
    const s = tripSummary(ctx.vault, t.id, base, ctx.rates)
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      dateFrom: t.dateFrom,
      dateTo: t.dateTo,
      archived: !!t.archived,
      memberCount: s.memberCount,
      /** Spend only — income inside the window is NOT netted off. */
      totalSpend: round2(s.total),
      days: s.days,
      perDay: round2(s.perDay),
      approxRows: s.approxCount || undefined,
    }
  })
  const dearest = [...rows].sort((a, b) => b.totalSpend - a.totalSpend)[0]
  return ok(
    { currency: base, note: 'totalSpend is spend only, not net of income', trackings: rows },
    `Trips & sets · ${rows.length}${dearest ? ` · most expensive ${dearest.name} ${fmtMoney(ctx, dearest.totalSpend)}` : ''}`,
  )
}

function listBudgets(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  const mk = typeof args.month === 'string' && /^\d{4}-\d{2}$/.test(args.month) ? args.month : ctx.derived.currentMonth
  if (safeMode(ctx)) {
    // How many charges this budget's own scope matched, through `budgetScopeTxns` — the same matcher
    // `budgetScopeSpent` sums, so the count belongs to the figure on the Plan row even though the
    // figure itself stays here. The limit the user set is money too, so it is withheld as well.
    const rows = ctx.vault.budgets.map((b) => ({
      id: b.id,
      name: b.name,
      label: budgetScopeLabel(ctx.vault, b),
      categoryIds: budgetCategoryIds(b),
      month: mk,
      transactionCount: budgetScopeTxns(ctx.vault, b, mk).size,
    }))
    return ok({ access: 'safe', budgets: rows }, `Budgets · ${mk} · ${rows.length}`)
  }
  const rows = ctx.vault.budgets.map((b) => ({
    id: b.id,
    // A multi-category budget's label is "monthly · 3 categories", which does not say WHICH
    // three, and its `categoryId` is the CAT_TRANSFERS placeholder — so both go on the row.
    name: b.name,
    label: budgetScopeLabel(ctx.vault, b),
    categoryIds: budgetCategoryIds(b),
    amount: b.amount,
    spent: round2(budgetScopeSpent(ctx.vault, b, mk, ctx.rates)),
    month: mk,
  }))
  return ok(rows, `Budgets · ${mk} · ${rows.length}`)
}

function listGoals(ctx: ToolCtx): ExecOutcome {
  if (safeMode(ctx)) {
    const rows = ctx.vault.goals.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.source?.kind ?? 'legacy',
      archived: !!g.archived,
      ...safeGoalSource(ctx, g),
    }))
    return ok({ access: 'safe', goals: rows }, `Goals · ${rows.length}`)
  }
  const rows = ctx.vault.goals.map((g) => {
    const s = goalStatus(ctx.vault, g, ctx.today, ctx.rates)
    return {
      id: g.id,
      name: g.name,
      // What drives progress, not just how much of it there is. Without this the assistant cannot
      // tell a goal that fills itself in from one the user has to keep up to date by hand, and it
      // will answer "does this update automatically?" from guesswork.
      kind: s.kind,
      ...goalSourceIds(g),
      target: s.target,
      progress: round2(s.progress),
      fraction: Math.round(s.fraction * 100) / 100,
      monthly: g.monthly,
      targetDate: g.targetDate,
      archived: !!g.archived,
      asOf: s.asOf,
    }
  })
  return ok(rows, `Goals · ${rows.length}`)
}

/**
 * The record a goal's progress is derived from, as ids. A `flow` goal sums a category's or a trip's
 * transactions and so keeps itself current; a `balance` goal reads an account's latest snapshot; a
 * legacy goal has no source and only moves when the user edits it. Which one it is decides the answer
 * to "will this update on its own", so both access levels report it.
 */
function goalSourceIds(g: Goal): Record<string, unknown> {
  const src = g.source
  if (src?.kind === 'flow') return { categoryId: src.categoryId, trackingId: src.trackingId }
  if (src?.kind === 'balance') return { accountId: src.accountId, direction: src.direction }
  return {}
}

/**
 * The same, plus how many records feed it, for safe mode. Deliberately does not call `goalStatus` —
 * every field that returns is money or a date, and a target the user is working toward is exactly the
 * kind of figure safe mode exists to keep on this device.
 */
function safeGoalSource(ctx: ToolCtx, g: Goal): Record<string, unknown> {
  const src = g.source
  const ids = goalSourceIds(g)
  if (src?.kind === 'flow') {
    // Same predicate as `flowProgress` in analytics/goals.ts — counted rather than summed.
    const mem = src.trackingId ? memberSet(ctx, src.trackingId) : null
    let n = 0
    for (const t of ctx.vault.transactions) {
      if (mem ? mem.has(t.id) : src.categoryId != null && t.categoryId === src.categoryId) n++
    }
    return { ...ids, contributionCount: n }
  }
  if (src?.kind === 'balance') {
    return { ...ids, snapshotCount: ctx.vault.snapshots.filter((s) => s.accountId === src.accountId).length }
  }
  return ids
}

// ---------------------------------------------------------------- selection plumbing

interface ParsedSelection {
  sel: Selection
  recurring?: 'monthly' | 'yearly'
}

/** Validate ids against the vault. An unknown id is an error carrying the valid ones (§5). */
function parseSelection(ctx: ToolCtx, raw: unknown): ParsedSelection | ExecOutcome {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const sel: Selection = {}

  if (r.period && typeof r.period === 'object') sel.period = r.period as Selection['period']
  const strs = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

  const cats = strs(r.categoryIds)
  if (cats?.length) {
    const known = new Set(ctx.vault.categories.map((c) => c.id))
    const bad = cats.filter((id) => !known.has(id))
    if (bad.length) {
      return fail(`Unknown category id(s): ${bad.join(', ')}.`, {
        validCategoryIds: ctx.vault.categories.map((c) => ({ id: c.id, name: c.name })),
      })
    }
    sel.categoryIds = cats
  }

  const accts = strs(r.accountIds)
  if (accts?.length) {
    const known = new Set(ctx.vault.accounts.map((a) => a.id))
    const bad = accts.filter((id) => !known.has(id))
    if (bad.length) {
      return fail(`Unknown account id(s): ${bad.join(', ')}.`, {
        validAccountIds: ctx.vault.accounts.map((a) => ({ id: a.id, name: a.name })),
      })
    }
    sel.accountIds = accts
  }

  const tracks = strs(r.trackingIds)
  if (tracks?.length) {
    const known = new Set(ctx.vault.trackings.map((t) => t.id))
    const bad = tracks.filter((id) => !known.has(id))
    if (bad.length) {
      return fail(`Unknown tracking id(s): ${bad.join(', ')}.`, {
        validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })),
      })
    }
    sel.trackingIds = tracks
  }

  if (typeof r.merchantQuery === 'string' && r.merchantQuery.trim()) sel.merchantQuery = r.merchantQuery
  if (r.includeNonCashflow === true) sel.includeNonCashflow = true
  const recurring = r.recurring === 'monthly' || r.recurring === 'yearly' ? r.recurring : undefined
  return { sel, recurring }
}

const isOutcome = (v: ParsedSelection | ExecOutcome): v is ExecOutcome => 'content' in v

/**
 * Rows for a selection, converted to base currency at each row's own date. `recurring` is applied
 * here rather than inside `Selection`: the axis lives on the transaction, but adding it to the
 * stored Selection shape would ripple into compare() and every SavedComparison on disk.
 */
function rowsOf(ctx: ToolCtx, p: ParsedSelection): { rows: { txn: Transaction; base: number }[]; excluded: number; approx: number } {
  const base = ctx.vault.params.baseCurrency ?? 'EUR'
  const accountCur = accountCurrencyMap(ctx.vault)
  const out: { txn: Transaction; base: number }[] = []
  let excluded = 0
  let approx = 0
  for (const t of resolveSelection(p.sel, ctx.vault, ctx.today)) {
    if (p.recurring && t.recurring !== p.recurring) continue
    let amount = t.amount
    const cur = rowCurrency(t, accountCur, base)
    if (cur !== base) {
      const conv = ctx.rates?.convert(t.amount, cur, t.date)
      if (!conv) {
        excluded++
        continue
      }
      amount = conv.value
      if (conv.approx) approx++
    }
    out.push({ txn: t, base: amount })
  }
  return { rows: out, excluded, approx }
}

// ---------------------------------------------------------------- analysis

function aggregate(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  const parsed = parseSelection(ctx, args.selection)
  if (isOutcome(parsed)) return parsed
  const groupBy = typeof args.groupBy === 'string' ? args.groupBy : 'category'
  const limit = clamp(typeof args.limit === 'number' ? args.limit : 20, 1, 200)
  const { rows, excluded, approx } = rowsOf(ctx, parsed)
  const period = selectionPeriod(parsed.sel, ctx.vault, ctx.today)

  let income = 0
  let expense = 0
  const groups = new Map<string, { income: number; expense: number; count: number }>()
  const keyOf = (t: Transaction): string => {
    switch (groupBy) {
      case 'month':
        return monthKeyOf(t.date)
      case 'merchant':
        return redactDescriptor(t.merchant)
      case 'account':
        return t.accountId ?? 'none'
      case 'tracking':
        return trackingOf(ctx, t.id)
      case 'none':
        return 'all'
      default:
        return t.categoryId
    }
  }
  for (const { txn, base } of rows) {
    if (base >= 0) income += base
    else expense += -base
    const k = keyOf(txn)
    const g = groups.get(k) ?? { income: 0, expense: 0, count: 0 }
    if (base >= 0) g.income += base
    else g.expense += -base
    g.count++
    groups.set(k, g)
  }

  const breakdown = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: labelFor(ctx, groupBy, key),
      income: round2(g.income),
      expense: round2(g.expense),
      net: round2(g.income - g.expense),
      count: g.count,
    }))
    .sort((a, b) => b.expense - a.expense || b.income - a.income)

  return ok(
    {
      currency: ctx.vault.params.baseCurrency ?? 'EUR',
      period,
      matched: rows.length,
      // `expense` is what a cost question wants. `net` is reported too, but it is NOT the cost:
      // a period containing a salary nets to a positive number no matter how much was spent.
      expense: round2(expense),
      income: round2(income),
      net: round2(income - expense),
      costIs: 'expense',
      groupBy,
      breakdown: breakdown.slice(0, limit),
      truncatedGroups: Math.max(0, breakdown.length - limit),
      ...noteOf(ctx, parsed, excluded, approx),
    },
    // Spend first, because that is what the question almost always is; income only when there is
    // any, so a receipt cannot silently present a netted figure as "what this cost".
    `${describeSelection(ctx, parsed)}${groupBy === 'none' ? '' : ` · by ${groupBy}`} · ${rows.length} row${rows.length === 1 ? '' : 's'} · spent ${fmtMoney(ctx, expense)}${income > 0 ? ` · in ${fmtMoney(ctx, income)}` : ''}`,
  )
}

function queryTransactions(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  const parsed = parseSelection(ctx, args.selection)
  if (isOutcome(parsed)) return parsed
  const limit = clamp(typeof args.limit === 'number' ? args.limit : ROW_CAP, 1, ROW_CAP)
  const sort = typeof args.sort === 'string' ? args.sort : 'date_desc'
  const { rows, excluded, approx } = rowsOf(ctx, parsed)

  const sorted = [...rows].sort((x, y) => {
    switch (sort) {
      case 'date_asc':
        return x.txn.date.localeCompare(y.txn.date)
      case 'amount_desc':
        return Math.abs(y.base) - Math.abs(x.base)
      case 'amount_asc':
        return Math.abs(x.base) - Math.abs(y.base)
      default:
        return y.txn.date.localeCompare(x.txn.date)
    }
  })

  const sum = rows.reduce((s, r) => s + r.base, 0)
  return ok(
    {
      currency: ctx.vault.params.baseCurrency ?? 'EUR',
      totalCount: rows.length,
      returned: Math.min(limit, sorted.length),
      sum: round2(sum),
      rows: sorted.slice(0, limit).map(({ txn, base }) => ({
        id: txn.id,
        date: txn.date,
        merchant: redactDescriptor(txn.merchant),
        categoryId: txn.categoryId,
        amount: round2(base),
        accountId: txn.accountId,
        recurring: txn.recurring,
        provenance: txn.provenance,
      })),
      ...noteOf(ctx, parsed, excluded, approx),
    },
    `${describeSelection(ctx, parsed)} · ${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length > limit ? `, showing ${limit}` : ''}`,
  )
}

function compareSelections(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  const a = parseSelection(ctx, args.a)
  if (isOutcome(a)) return a
  const b = parseSelection(ctx, args.b)
  if (isOutcome(b)) return b
  if (a.recurring || b.recurring) {
    return fail('compare_selections cannot filter by recurring cadence. Use aggregate on each side instead.')
  }
  const normalize = pick(args.normalize, ['total', 'perDay', 'perMonth'], 'total') as 'total' | 'perDay' | 'perMonth'
  const mode = pick(args.mode, ['samePoint', 'full'], 'samePoint') as 'samePoint' | 'full'
  const r = compare(ctx.vault, a.sel, b.sel, ctx.today, { normalize, mode, rates: ctx.rates })
  const side = (s: typeof r.a) => ({
    from: s.from,
    to: s.to,
    inProgress: s.inProgress,
    daysCounted: s.daysCounted,
    total: round2(s.total),
    excludedRows: s.excludedCount,
    approxRows: s.approxCount,
  })
  return ok(
    {
      currency: ctx.vault.params.baseCurrency ?? 'EUR',
      normalize,
      mode,
      a: side(r.a),
      b: side(r.b),
      delta: round2(r.delta),
      byCategory: r.byCategory.slice(0, 20).map((c) => ({
        categoryId: c.categoryId,
        label: ctx.derived.catById.get(c.categoryId)?.name ?? c.categoryId,
        a: round2(c.a),
        b: round2(c.b),
        delta: round2(c.delta),
      })),
      note:
        mode === 'samePoint' && (r.a.inProgress || r.b.inProgress)
          ? 'One side is still in progress, so both were truncated to the same elapsed length.'
          : undefined,
    },
    `Compare · ${describeSelection(ctx, a)} vs ${describeSelection(ctx, b)} · ${fmtMoney(ctx, r.delta)}`,
  )
}

// ---------------------------------------------------------------- control

const TABS: Tab[] = ['dash', 'compare', 'trends', 'trips', 'plan', 'accounts', 'txns', 'settings']

function navigate(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  if (!ctx.nav) return fail('Navigation is unavailable.')
  const tab = typeof args.tab === 'string' ? args.tab : ''
  if (!(TABS as string[]).includes(tab)) return fail(`Unknown screen "${tab}". Valid: ${TABS.join(', ')}.`)
  ctx.nav.goTab(tab as Tab)
  return ok({ opened: tab }, `Opened ${tab}`)
}

function showTransactions(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  if (!ctx.nav) return fail('Navigation is unavailable.')
  const s = (k: string): string | undefined => (typeof args[k] === 'string' && args[k] ? (args[k] as string) : undefined)
  const status = s('status')
  if (status && !(TXN_STATUSES as string[]).includes(status)) {
    return fail(`Unknown status "${status}".`, { validStatuses: TXN_STATUSES })
  }
  const filter: TxnFilter = {
    cat: s('categoryId'),
    acct: s('accountId'),
    tracking: s('trackingId'),
    from: s('from'),
    to: s('to'),
    merchant: s('merchant'),
    q: s('search'),
    status: status === 'all' ? undefined : status,
  }
  if (filter.cat && !ctx.vault.categories.some((c) => c.id === filter.cat)) {
    return fail(`Unknown category id "${filter.cat}".`, {
      validCategoryIds: ctx.vault.categories.map((c) => ({ id: c.id, name: c.name })),
    })
  }
  if (filter.tracking && !ctx.vault.trackings.some((t) => t.id === filter.tracking)) {
    return fail(`Unknown tracking id "${filter.tracking}".`, {
      validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })),
    })
  }
  // The EXACT count, through the screen's own predicate. This was previously an approximation that
  // ignored `search` and `status`, so a search matching nothing was reported as a full date range's
  // worth of rows — and the assistant told the user a number the screen contradicted.
  const shown = filterTransactions(ctx.vault, { ...filter, status: filter.status as TxnStatus | undefined, flow: filter.flow as TxnFlow | undefined }, {
    dupIds: filter.status === 'duplicates' ? duplicateIds(findDuplicateImports(ctx.vault)) : undefined,
  }).length
  ctx.nav.goTxns(filter)
  return ok({ opened: 'txns', filter, rowsShown: shown }, `Opened Transactions · ${shown} row${shown === 1 ? '' : 's'}`)
}

function showComparison(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  if (!ctx.nav) return fail('Navigation is unavailable.')
  const a = parseSelection(ctx, args.a)
  if (isOutcome(a)) return a
  const b = parseSelection(ctx, args.b)
  if (isOutcome(b)) return b
  const normalize = pick(args.normalize, ['total', 'perDay', 'perMonth'], 'total')
  const mode = pick(args.mode, ['samePoint', 'full'], 'samePoint')
  ctx.nav.goCompare(a.sel, b.sel, normalize, mode)
  return ok({ opened: 'compare' }, `Opened Compare · ${describeSelection(ctx, a)} vs ${describeSelection(ctx, b)}`)
}

// ---------------------------------------------------------------- skills

function listSkills(ctx: ToolCtx): ExecOutcome {
  const rows = ctx.skills.map((s) => ({ name: s.name, description: s.description }))
  return ok(rows, `Skills · ${rows.length} available`)
}

function readSkill(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  const name = typeof args.name === 'string' ? args.name : ''
  const hit = ctx.skills.find((s) => s.name === name)
  if (!hit) return fail(`No skill named "${name}".`, { available: ctx.skills.map((s) => s.name) })
  return ok({ name: hit.name, description: hit.description, body: hit.body }, `Read skill · ${hit.name}`)
}

// ---------------------------------------------------------------- proposals

function proposeEdit(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  if (!ctx.propose) return fail('Edits are unavailable.')
  const txnIds = Array.isArray(args.txnIds) ? args.txnIds.filter((x): x is string => typeof x === 'string') : []
  if (txnIds.length === 0) return fail('propose_edit needs at least one transaction id.')
  const known = new Set(ctx.vault.transactions.map((t) => t.id))
  const bad = txnIds.filter((id) => !known.has(id))
  if (bad.length) return fail(`Unknown transaction id(s): ${bad.slice(0, 5).join(', ')}.`)
  const n = txnIds.length
  const rows = `${n} transaction${n === 1 ? '' : 's'}`
  const reason = typeof args.reason === 'string' ? args.reason : ''

  switch (args.kind) {
    case 'recategorize': {
      const categoryId = typeof args.categoryId === 'string' ? args.categoryId : ''
      const cat = ctx.vault.categories.find((c) => c.id === categoryId)
      if (!cat) {
        return fail(`Unknown category id "${categoryId}".`, {
          validCategoryIds: ctx.vault.categories.map((c) => ({ id: c.id, name: c.name })),
        })
      }
      ctx.propose({
        summary: `Recategorize ${rows} to ${cat.name}`,
        detail: reason,
        op: { kind: 'recategorizeBatch', txnIds, categoryId },
      })
      return ok({ proposed: 'recategorize', count: n, awaitingApproval: true }, `Proposed: recategorize ${rows} → ${cat.name}`)
    }
    case 'set_recurring': {
      const value = args.recurring === 'monthly' || args.recurring === 'yearly' ? args.recurring : undefined
      if (args.recurring !== 'none' && !value) return fail('recurring must be "monthly", "yearly" or "none".')
      const label = value ?? 'not recurring'
      ctx.propose({
        summary: `Mark ${rows} as ${label}`,
        detail: reason,
        op: {
          kind: 'batch',
          ops: txnIds.map((id) => ({ kind: 'setField', collection: 'transactions', id, field: 'recurring', value })),
        },
      })
      return ok({ proposed: 'set_recurring', count: n, awaitingApproval: true }, `Proposed: mark ${rows} as ${label}`)
    }
    /**
     * Both directions. Membership is `(rows inside the window − excludes) ∪ includes`, so removing
     * is not the absence of adding — it is an explicit exclude record, and it is the *more* useful
     * half: a trip picks up every row in its date range, so the recurring bills that happened to
     * fall inside it (a subscription, an insurance premium, bank fees) are members until someone
     * says otherwise. Wiring only `include` left the assistant able to describe that problem and
     * unable to offer the fix.
     */
    case 'tag_tracking': {
      const trackingId = typeof args.trackingId === 'string' ? args.trackingId : ''
      const tr = ctx.vault.trackings.find((t) => t.id === trackingId)
      if (!tr) {
        return fail(`Unknown tracking id "${trackingId}".`, {
          validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })),
        })
      }
      if (args.direction !== undefined && args.direction !== 'add' && args.direction !== 'remove') {
        return fail('direction must be "add" or "remove".')
      }
      const removing = args.direction === 'remove'
      let targets = txnIds
      if (removing) {
        // Excluding a row that is not in the trip writes a record and changes nothing visible —
        // an Apply card that does nothing is worse than a refusal.
        const inTrip = txnIds.filter((id) => memberSet(ctx, trackingId).has(id))
        if (inTrip.length === 0) return fail(`None of those transactions are in ${tr.name}.`)
        targets = inTrip
      }
      const count = targets.length
      const label = `${count} transaction${count === 1 ? '' : 's'}`
      const summary = removing ? `Remove ${label} from ${tr.name}` : `Add ${label} to ${tr.name}`
      ctx.propose({
        summary,
        detail: reason,
        op: {
          kind: 'setAssignments',
          trackingId,
          entries: targets.map((txnId) => ({ txnId, dir: removing ? ('exclude' as const) : ('include' as const) })),
        },
      })
      return ok(
        { proposed: 'tag_tracking', direction: removing ? 'remove' : 'add', count, awaitingApproval: true },
        `Proposed: ${summary}`,
      )
    }
    /**
     * One merchant spelled two ways (`Deezerfr Y6bsn5` vs `DEEZER`) reads as two subscriptions and
     * two rows in the grouped view. Normalizing it automatically would merge genuinely distinct
     * merchants that share a prefix, so the merge is a decision the user makes — and the assistant
     * can only ever propose it, like every other edit here. `merchant` is display text: the verbatim
     * descriptor stays in `importMeta.raw`, so nothing is lost and provenance is unchanged.
     */
    case 'merge_merchant': {
      const merchant = typeof args.merchant === 'string' ? args.merchant.trim() : ''
      if (!merchant) return fail('merge_merchant needs `merchant`: the spelling to keep.')
      const targets = txnIds.filter((id) => ctx.vault.transactions.find((t) => t.id === id)?.merchant !== merchant)
      if (targets.length === 0) return fail(`Every one of those transactions already reads “${merchant}”.`)
      const count = targets.length
      const label = `${count} transaction${count === 1 ? '' : 's'}`
      ctx.propose({
        summary: `Rename ${label} to “${merchant}”`,
        detail: reason,
        op: {
          kind: 'batch',
          ops: targets.map((id) => ({ kind: 'setField', collection: 'transactions', id, field: 'merchant', value: merchant })),
        },
      })
      return ok({ proposed: 'merge_merchant', count, awaitingApproval: true }, `Proposed: rename ${label} → ${merchant}`)
    }
    default:
      return fail('kind must be "recategorize", "set_recurring", "tag_tracking" or "merge_merchant".')
  }
}

// ---------------------------------------------------------------- helpers

function trackingOf(ctx: ToolCtx, txnId: string): string {
  for (const tr of ctx.vault.trackings) if (memberSet(ctx, tr.id).has(txnId)) return tr.id
  return 'none'
}

function labelFor(ctx: ToolCtx, groupBy: string, key: string): string {
  switch (groupBy) {
    case 'category':
      return ctx.derived.catById.get(key)?.name ?? key
    case 'account':
      return ctx.vault.accounts.find((a) => a.id === key)?.name ?? key
    case 'tracking':
      return ctx.vault.trackings.find((t) => t.id === key)?.name ?? key
    default:
      return key
  }
}

/** Honest footnotes: rows dropped for want of a rate, rows converted approximately, hidden accounts. */
function noteOf(ctx: ToolCtx, p: ParsedSelection, excluded: number, approx: number): Record<string, unknown> {
  const hidden = ctx.vault.accounts.filter((a) => a.hidden).map((a) => a.id)
  const included = p.sel.accountIds ? hidden.filter((id) => p.sel.accountIds!.includes(id)) : hidden
  return {
    ...(excluded ? { excludedRows: excluded, excludedReason: 'no exchange rate available for these rows' } : {}),
    ...(approx ? { approxRows: approx, approxReason: 'converted using a nearest-earlier rate' } : {}),
    ...(included.length ? { includesHiddenAccounts: included } : {}),
    ...transferNote(ctx, p),
  }
}

/**
 * A tracking's member count includes transfer legs; a cashflow selection drops them. Without this
 * the assistant's "28 rows" quietly contradicts the "30 rows" on the trip card, and neither number
 * explains the other.
 */
function transferNote(ctx: ToolCtx, p: ParsedSelection): Record<string, unknown> {
  if (!p.sel.trackingIds?.length || p.sel.includeNonCashflow) return {}
  let dropped = 0
  for (const id of p.sel.trackingIds) {
    for (const txnId of memberSet(ctx, id)) {
      const t = ctx.vault.transactions.find((x) => x.id === txnId)
      if (t && !isCashflow(t)) dropped++
    }
  }
  return dropped
    ? { transferRowsExcluded: dropped, transferRowsReason: 'transfers between the user’s own accounts are not spending; the trip card counts them, this total does not' }
    : {}
}

function describeSelection(ctx: ToolCtx, p: ParsedSelection): string {
  const bits: string[] = []
  if (p.sel.categoryIds?.length) {
    bits.push(p.sel.categoryIds.map((id) => ctx.derived.catById.get(id)?.name ?? id).join(', '))
  }
  if (p.sel.merchantQuery) bits.push(`"${p.sel.merchantQuery}"`)
  if (p.sel.trackingIds?.length) {
    bits.push(p.sel.trackingIds.map((id) => ctx.vault.trackings.find((t) => t.id === id)?.name ?? id).join(', '))
  }
  if (p.recurring) bits.push(p.recurring)
  const { from, to } = selectionPeriod(p.sel, ctx.vault, ctx.today)
  bits.push(from === to ? from : `${from} → ${to}`)
  return bits.join(' · ')
}

function fmtMoney(ctx: ToolCtx, n: number): string {
  const cur = ctx.vault.params.baseCurrency ?? 'EUR'
  return `${n < 0 ? '−' : ''}${Math.abs(round2(n)).toLocaleString('en-GB', { maximumFractionDigits: 0 })} ${cur}`
}

function pick(v: unknown, allowed: string[], fallback: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : fallback
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Enabled skills with built-ins shadowed by same-named user skills (ASSISTANT §6). */
export function visibleSkills(builtins: SkillView[], userSkills: Skill[], skillsOff: string[] = []): SkillView[] {
  const off = new Set(skillsOff)
  const user = userSkills
    .filter((s) => s.enabled !== false)
    .map((s) => ({ name: s.name, description: s.description, body: s.body, builtin: false }))
  const shadowed = new Set(user.map((s) => s.name))
  return [...builtins.filter((b) => !off.has(b.name) && !shadowed.has(b.name)), ...user]
}

// ---------------------------------------------------------------- propose_plan

/**
 * Budget and goal changes the assistant can PROPOSE. Every one is queued for approval and lands
 * through the ordinary mutation path, so the ordinary undo toast reverses it.
 *
 * It is a separate tool from `propose_edit` on purpose. `propose_edit` requires a non-empty,
 * vault-validated `txnIds` for every one of its three kinds; adding a fourth kind that did not
 * would weaken that guard for all of them. Keeping them apart also keeps the delete surface
 * narrow: this tool can only ever remove from `budgets` and `goals`, so there is no route here to
 * deleting transactions, accounts, categories or statements.
 */
function proposePlan(ctx: ToolCtx, args: Record<string, unknown>): ExecOutcome {
  if (!ctx.propose) return fail('Edits are unavailable.')
  const str = (k: string) => {
    const v = argOf(args, k)
    return typeof v === 'string' ? v : undefined
  }
  const num = (k: string) => {
    const v = str(k)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const action = str('action')
  const target = str('target')
  const reason = str('reason') ?? ''
  if (action !== 'create' && action !== 'update' && action !== 'archive' && action !== 'remove') {
    return fail('action must be "create", "update", "archive" or "remove".')
  }
  if (target !== 'budget' && target !== 'goal') return fail('target must be "budget" or "goal".')

  const catName = (id: string) => ctx.vault.categories.find((c) => c.id === id)?.name ?? id
  const validCategoryIds = () => ({ validCategoryIds: ctx.vault.categories.map((c) => ({ id: c.id, name: c.name })) })

  // --- goal ---
  if (target === 'goal') {
    if (action === 'create') {
      const name = str('name')
      if (!name) return fail('A goal needs a name.')
      const tgt = num('targetAmount')
      if (tgt === undefined) return fail('A goal needs targetAmount, and it must be a number the user gave you.')
      // Reported, never stored as-is and never dropped: a goal whose date silently vanished reads as
      // "no date yet" on the card while the reply promised one.
      const targetDate = str('targetDate')
      if (targetDate !== undefined && !/^\d{4}-\d{2}$/.test(targetDate)) {
        return fail(`targetDate must be a month as YYYY-MM. "${targetDate}" is not.`)
      }
      const accountId = str('accountId')
      const trackingId = str('trackingId')
      const rawCats = argOf(args, 'categoryIds')
      const categoryIds = Array.isArray(rawCats) ? (rawCats as string[]) : []
      let source: Goal['source']
      if (accountId) {
        const acct = ctx.vault.accounts.find((a) => a.id === accountId)
        if (!acct) return fail(`Unknown account id "${accountId}".`, { validAccountIds: ctx.vault.accounts.map((a) => ({ id: a.id, name: a.name })) })
        const direction = str('direction') === 'down' ? 'down' : 'up'
        source = { kind: 'balance', accountId, direction, target: tgt }
      } else if (trackingId) {
        if (!ctx.vault.trackings.some((t) => t.id === trackingId)) {
          return fail(`Unknown tracking id "${trackingId}".`, { validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })) })
        }
        source = { kind: 'flow', trackingId }
      } else if (categoryIds[0]) {
        if (!ctx.vault.categories.some((c) => c.id === categoryIds[0])) return fail(`Unknown category id "${categoryIds[0]}".`, validCategoryIds())
        source = { kind: 'flow', categoryId: categoryIds[0] }
      }
      // The card states the date and what will drive the progress, because those are the two things
      // that decide whether this goal is the one the user meant. "updated by hand" on the card is how
      // they find out before Apply that nothing will fill it in for them.
      ctx.propose({
        summary: `Add the goal “${name}” · ${fmtMoney(ctx, tgt)}${targetDate ? ` by ${targetDate}` : ''} · ${sourcePhrase(ctx, source, catName)}`,
        detail: reason,
        op: {
          kind: 'addGoal',
          name,
          target: tgt,
          monthly: num('monthly') ?? 0,
          saved: num('saved') ?? 0,
          source,
          targetDate,
        },
      })
      return ok({ proposed: 'goal.create', awaitingApproval: true }, `Proposed: add the goal ${name}`)
    }
    const id = str('id')
    const goal = ctx.vault.goals.find((g) => g.id === id)
    if (!goal) return fail(`Unknown goal id "${id ?? ''}".`, { validGoalIds: ctx.vault.goals.map((g) => ({ id: g.id, name: g.name })) })
    if (action === 'archive') {
      ctx.propose({
        summary: `Archive the goal “${goal.name}”`,
        detail: reason,
        op: { kind: 'setField', collection: 'goals', id: goal.id, field: 'archived', value: true },
      })
      return ok({ proposed: 'goal.archive', awaitingApproval: true }, `Proposed: archive ${goal.name}`)
    }
    if (action === 'remove') {
      ctx.propose({
        summary: `Delete the goal “${goal.name}”`,
        detail: reason || 'Archiving keeps the record; deleting does not.',
        op: { kind: 'delete', collection: 'goals', ids: [goal.id] },
      })
      return ok({ proposed: 'goal.remove', awaitingApproval: true }, `Proposed: delete ${goal.name}`)
    }
    const name = str('name') ?? goal.name
    const tgt = num('targetAmount') ?? goal.target
    const monthly = num('monthly') ?? goal.monthly
    // Same discipline as create: a documented parameter is validated and carried,
    // never silently dropped — "move it out to 2030" must not Apply as a no-op.
    const targetDate = str('targetDate')
    if (targetDate !== undefined && !/^\d{4}-\d{2}$/.test(targetDate)) {
      return fail(`targetDate must be a month as YYYY-MM. "${targetDate}" is not.`)
    }
    const accountId = str('accountId')
    const trackingId = str('trackingId')
    const rawCats = argOf(args, 'categoryIds')
    const categoryIds = Array.isArray(rawCats) ? (rawCats as string[]) : []
    let source: Goal['source']
    if (accountId) {
      const acct = ctx.vault.accounts.find((a) => a.id === accountId)
      if (!acct) return fail(`Unknown account id "${accountId}".`, { validAccountIds: ctx.vault.accounts.map((a) => ({ id: a.id, name: a.name })) })
      const direction = str('direction') === 'down' ? 'down' : 'up'
      source = { kind: 'balance', accountId, direction, target: tgt }
    } else if (trackingId) {
      if (!ctx.vault.trackings.some((t) => t.id === trackingId)) {
        return fail(`Unknown tracking id "${trackingId}".`, { validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })) })
      }
      source = { kind: 'flow', trackingId }
    } else if (categoryIds[0]) {
      if (!ctx.vault.categories.some((c) => c.id === categoryIds[0])) return fail(`Unknown category id "${categoryIds[0]}".`, validCategoryIds())
      source = { kind: 'flow', categoryId: categoryIds[0] }
    }
    // `updateGoal` covers the three plain fields; `targetDate` and `source` ride the
    // setField arm, batched so the whole edit is one Apply — the GoalDialog's shape.
    const ops: Op[] = [{ kind: 'updateGoal', id: goal.id, name, target: tgt, monthly }]
    if (targetDate !== undefined) ops.push({ kind: 'setField', collection: 'goals', id: goal.id, field: 'targetDate', value: targetDate })
    if (source) ops.push({ kind: 'setField', collection: 'goals', id: goal.id, field: 'source', value: source })
    ctx.propose({
      summary: `Change the goal “${goal.name}” · ${fmtMoney(ctx, tgt)}${targetDate ? ` by ${targetDate}` : ''}${source ? ` · ${sourcePhrase(ctx, source, catName)}` : ''}`,
      detail: reason,
      op: ops.length === 1 ? ops[0]! : { kind: 'batch', ops },
    })
    return ok({ proposed: 'goal.update', awaitingApproval: true }, `Proposed: change ${goal.name}`)
  }

  // --- budget ---
  const existing = action === 'create' ? undefined : ctx.vault.budgets.find((b) => b.id === str('id'))
  if (action !== 'create' && !existing) {
    return fail(`Unknown budget id "${str('id') ?? ''}".`, {
      validBudgetIds: ctx.vault.budgets.map((b) => ({ id: b.id, label: b.name ?? budgetScopeLabel(ctx.vault, b) })),
    })
  }
  if (action === 'archive') return fail('A budget cannot be archived — remove it, or change its amount.')
  if (action === 'remove') {
    const label = budgetPhrase(existing!.name, catName(existing!.categoryId))
    ctx.propose({
      summary: `Remove the ${label}`,
      detail: reason,
      op: { kind: 'delete', collection: 'budgets', ids: [existing!.id] },
    })
    return ok({ proposed: 'budget.remove', awaitingApproval: true }, `Proposed: remove the ${label}`)
  }

  const rawCategoryIds = argOf(args, 'categoryIds')
  const categoryIds = Array.isArray(rawCategoryIds) ? (rawCategoryIds as string[]).filter((x) => typeof x === 'string') : []
  const unknown = categoryIds.filter((id) => !ctx.vault.categories.some((c) => c.id === id))
  if (unknown.length) return fail(`Unknown category id(s): ${unknown.join(', ')}.`, validCategoryIds())
  const trackingId = str('trackingId')
  if (trackingId && !ctx.vault.trackings.some((t) => t.id === trackingId)) {
    return fail(`Unknown tracking id "${trackingId}".`, { validTrackingIds: ctx.vault.trackings.map((t) => ({ id: t.id, name: t.name })) })
  }
  const yearly = str('cadence') === 'yearly'
  const recurringOnly = argOf(args, 'recurringOnly') === true
  const year = Number(ctx.derived.currentMonth.slice(0, 4))

  // Build the scope from the shape asked for, reusing the parking conventions the model already
  // uses for budgets that are not about a single category.
  let categoryId = categoryIds[0] ?? existing?.categoryId ?? CAT_TRANSFERS
  let scope: Budget['scope']
  if (trackingId) {
    scope = { kind: 'tracking', trackingId }
    categoryId = CAT_TRANSFERS
  } else if (categoryIds.length > 1) {
    scope = { kind: 'group', categoryIds, ...(yearly ? { year } : {}) }
    categoryId = CAT_TRANSFERS
  } else if (recurringOnly) {
    scope = { kind: 'recurring', cadence: yearly ? 'yearly' : 'monthly', ...(categoryIds[0] ? { categoryId: categoryIds[0] } : {}) }
    if (!categoryIds[0]) categoryId = CAT_TRANSFERS
  } else if (yearly && categoryIds[0]) {
    scope = { kind: 'category-year', categoryId: categoryIds[0], year }
  } else if (action === 'update' && categoryIds.length === 0) {
    scope = existing!.scope // amount-only change keeps the scope it had
  }

  const name = str('name') ?? existing?.name
  if (categoryIds.length > 1 && !name) return fail('A budget over several categories needs a name.')

  // The amount: a literal, or resolved by Ledger from what this exact scope actually cost. The
  // model chooses the policy; the app computes the number, so the card and the budget dialog's
  // own suggestion cannot disagree.
  const amountArg = str('amount')
  const months = amountArg === 'trailing-3' ? 3 : amountArg === 'trailing-6' ? 6 : null
  // The one path through this tool that reads real spending, so the one path safe mode closes. The
  // resolved figure would come straight back in the result below, which is a leak whatever the card
  // ends up saying.
  if (months !== null && safeMode(ctx)) {
    return fail(
      `Working out a ${months}-month average means reading what this person actually spent, which safe mode withholds. Ask them what limit they want and pass it as a number.`,
    )
  }
  let amount: number
  if (months !== null) {
    const probe: Budget = { id: 'probe', updatedAt: '', categoryId, amount: 0, name, scope }
    const avg = scopeTrailingAvg(ctx.vault, probe, months, ctx.derived.currentMonth, ctx.rates)
    if (avg === null) {
      return fail(
        `Not enough history to work out a ${months}-month average for that, so there is no figure to propose. Pass an explicit amount instead.`,
      )
    }
    amount = Math.round(avg)
  } else {
    const n = num('amount')
    if (n === undefined || n < 0) return fail('amount must be a number ≥ 0, or "trailing-3" / "trailing-6".')
    amount = n
  }

  const probe: Budget = { id: existing?.id ?? 'probe', updatedAt: '', categoryId, amount, name, scope }
  // The same uniqueness test the merge and the dialog use, so a proposal can never create a
  // record the next sync would silently tombstone.
  const key = budgetKey(probe)
  const clash = ctx.vault.budgets.find((b) => b.id !== existing?.id && budgetKey(b) === key)
  if (clash) {
    // The id is enough to redirect the model to an update. The existing amount is a vault figure, so
    // it travels only when the model is allowed to read one.
    return fail(
      `That budget already exists (id ${clash.id}). Propose an update to it instead of a second one measuring the same thing.`,
      safeMode(ctx) ? { existingBudgetId: clash.id } : { existingBudgetId: clash.id, existingAmount: clash.amount },
    )
  }

  const label = budgetPhrase(name, catName(categoryId))
  const basis = months !== null ? ` (${months}-month average)` : ''
  if (action === 'create') {
    ctx.propose({
      summary: `Add a ${label} of ${fmtMoney(ctx, amount)}${basis}`,
      detail: reason,
      op: { kind: 'addBudget', categoryId, amount, name, scope },
    })
    return ok({ proposed: 'budget.create', amount, awaitingApproval: true }, `Proposed: ${name ?? label} ${fmtMoney(ctx, amount)}`)
  }
  ctx.propose({
    summary: `Change the ${label} to ${fmtMoney(ctx, amount)}${basis}`,
    detail: reason,
    op: { kind: 'updateBudget', id: existing!.id, categoryId, amount, name, scope },
  })
  return ok({ proposed: 'budget.update', amount, awaitingApproval: true }, `Proposed: ${name ?? label} → ${fmtMoney(ctx, amount)}`)
}

/**
 * A budget as a noun phrase that survives "Add a …" and "Remove the …".
 *
 * A named budget used to be dropped in bare, which produced "Add a Investments (yearly) of 30,000
 * EUR" on a card the user reads before approving real data. Quoting the name and keeping the word
 * "budget" fixes the article and matches how the goal cards already read.
 */
function budgetPhrase(name: string | undefined, categoryName: string): string {
  return name ? `budget “${name}”` : `${categoryName} budget`
}

/** What will move this goal's progress, in the words the approval card shows. */
function sourcePhrase(ctx: ToolCtx, source: Goal['source'], catName: (id: string) => string): string {
  if (source?.kind === 'balance') {
    return `from the ${ctx.vault.accounts.find((a) => a.id === source.accountId)?.name ?? 'account'} balance`
  }
  if (source?.kind === 'flow') {
    if (source.categoryId) return `from the ${catName(source.categoryId)} category`
    const trip = ctx.vault.trackings.find((t) => t.id === source.trackingId)
    return `from ${trip ? trip.name : 'a trip'}`
  }
  return 'updated by hand'
}

/**
 * One argument, however the model spelled the key. `target_date` is read as `targetDate`, and so on.
 *
 * This exists because a silent drop is the worst failure this tool can have. `propose_plan`'s
 * parameters were camelCase except for one snake_case outlier, `target_amount` — and a model that has
 * just used that successfully writes `target_date` by analogy. The old lookup returned undefined, the
 * goal was created with no date, nothing errored, and the assistant's reply said "by 2036-07" while
 * the card said "no date yet". Every other unknown input in this file comes back as an error the model
 * can act on; this one vanished. Matching on the key with underscores stripped closes the whole class,
 * not just the one spelling.
 */
function argOf(args: Record<string, unknown>, key: string): unknown {
  if (args[key] !== undefined) return args[key]
  const want = key.toLowerCase()
  for (const k of Object.keys(args)) {
    if (k.replace(/_/g, '').toLowerCase() === want) return args[k]
  }
  return undefined
}
