// The explanation registry — what every figure on screen means, how it was derived, and
// what it leaves out. Source text lives in specs/UX-Comprehension-Audit.md §4.
//
// TWO CONSUMERS, ONE DEFINITION:
//   1. The <Explain> panel renders these as structured sections.
//   2. `screensSkill()` renders the same records as a built-in assistant skill, so when a
//      user asks "why does the dashboard say I'm on pace for €6,140" the model explains the
//      screen's own formula instead of computing a rival number from `aggregate`.
// That is the whole reason this file is data and not JSX: two renderings, one source, no
// possibility of drift. A test asserts every id reaches the generated skill body.
//
// NO JSX, NO REACT IMPORT — vitest runs `environment: 'node'` over `tests/**/*.test.ts`
// only, so a plain-data module is unit-testable with no new dependency.
//
// Where a concept already lives in a built-in skill (`ledger-model`, `comparisons`,
// `balances`), cite it with `seeSkill` rather than restating it. Restating is how the
// product's own definitions fork.
/** Tabs an explanation may send the reader to. Mirrors `TABS` in ../view. */
export type ExplainTab = 'dash' | 'compare' | 'trends' | 'trips' | 'plan' | 'accounts' | 'txns' | 'settings' | 'import'

export interface ExplainCtx {
  /** Base-currency symbol, for prose that names a unit. */
  sym: string
  /** The user's savings-rate target, from params. */
  srTarget: number
  /** The user's emergency-fund target in months, from params. */
  efTarget: number
}

export interface ExplainLink {
  label: string
  tab: ExplainTab
  query?: Record<string, string>
}

export interface Explanation {
  /** Panel heading. */
  title: string
  /** The hover/focus one-liner. Kept ≤ 90 chars so it reads as a hint, not a paragraph. */
  hint: string
  /** "What this is" — one sentence. */
  what: string
  /** "How it's calculated" — the actual rule. A function when a real figure belongs in it. */
  how: string | ((c: ExplainCtx) => string)
  /** "What it excludes" — the trust section. */
  excludes?: string[]
  /** "Where to go next". */
  next?: ExplainLink[]
  /** An existing built-in skill that already carries this concept in prose. */
  seeSkill?: 'ledger-model' | 'comparisons' | 'balances'
  /** QUESTIONARY question ids this answers — traceability back to demand. */
  q?: number[]
  /** Which screen this surface belongs to; groups the generated skill. */
  screen: 'Dashboard' | 'Compare' | 'Trends' | 'Trips' | 'Plan' | 'Accounts' | 'Transactions' | 'Assistant'
}

export const EXPLAIN = {
  // ---------------------------------------------------------------- Dashboard
  'dash.spend': {
    screen: 'Dashboard',
    title: 'Spend · this month',
    hint: 'Expenses only, this month through the latest imported day. Transfers excluded.',
    what: 'Every euro that left your accounts this month, counting expenses only.',
    how: () =>
      'The sum of negative amounts dated in this month. "vs same point last month" counts the ' +
      'prior month only through the same day of the month, so a full month is never compared ' +
      'against a partial one. "On pace" divides spend so far by days elapsed and multiplies by ' +
      'the days in the month — it assumes the rest of the month looks like the start, and needs ' +
      'at least 3 days of data before it appears.',
    excludes: [
      // No currency-shaped example here: a reader cannot tell an illustration from their
      // own figure, which is the exact confusion this panel fights.
      'Transfers between your own accounts — both legs are dropped, so moving money into savings is not spending',
      'Refunds, which net against their category',
      'Accounts you have hidden',
      'Foreign-currency rows with no exchange rate for their date',
    ],
    next: [
      { label: 'See these transactions', tab: 'txns' },
      { label: 'Compare with another month', tab: 'compare' },
    ],
    seeSkill: 'ledger-model',
    q: [1, 2, 5, 62],
  },

  'dash.cashflow': {
    screen: 'Dashboard',
    title: 'Cash flow · this month',
    hint: 'Money in minus money out, from transactions — never from a change in balance.',
    what: 'What came in this month, what went out, and the difference.',
    how: 'Income minus expenses over transactions dated in this month. Both sides are flow figures: a balance that went up is not income, because a transfer in would inflate it.',
    excludes: [
      'Transfers between your own accounts, on both sides',
      'Anything not yet imported — the figure moves when the next statement lands',
      'No month-end projection: pay arrives in lumps, so extrapolating it from a few days would be a guess, not a forecast',
    ],
    next: [{ label: 'See this month’s transactions', tab: 'txns' }],
    seeSkill: 'ledger-model',
    q: [7, 34, 35],
  },

  'dash.savings-rate': {
    screen: 'Dashboard',
    title: 'Savings rate',
    hint: 'Income kept, from transactions only — never from a change in balance.',
    what: 'The share of this month’s income you did not spend.',
    how: (c) =>
      `(income − expenses) ÷ income, both from transactions in the month. Always flow-derived: ` +
      `a rising balance is not a savings rate, because a transfer in would inflate it. Your ` +
      `target is ${c.srTarget}%, which you set in Settings.`,
    excludes: [
      'The target line is a number you chose, not a recommendation',
      'The bar stops at the target; the percentage keeps going, so a rate above target shows a full bar',
      'A month with no income has no savings rate at all',
    ],
    next: [
      { label: 'Change the target', tab: 'settings' },
      { label: 'See this month’s income', tab: 'txns' },
    ],
    seeSkill: 'ledger-model',
    q: [40, 42, 283],
  },

  'dash.plan': {
    screen: 'Dashboard',
    title: 'Plan · this month',
    hint: 'Budgets running over pace, and goals with no date they would reach their target.',
    what: 'A two-line read on the plan you set: budgets first, then goals.',
    how:
      'A budget is "over pace" when its spend so far, extrapolated at the current daily rate to ' +
      'the end of the month, would land above its amount — not when it has already been passed. ' +
      'That rate divides by the days your imported statements cover, not by the days of the month ' +
      'that have passed, so a gap in your imports cannot make a budget look comfortable. ' +
      'A goal is "behind" when its contributions or balance trajectory produce no date that ' +
      'reaches the target at all.',
    excludes: [
      'Budgets and goals you have not set up — an empty plan says so, rather than reporting that it is being met',
      'Archived goals',
      'Annual, per-trip and recurring-scoped budgets are counted here as if monthly; the Plan screen holds them out of its roll-up instead',
    ],
    next: [{ label: 'Open Plan', tab: 'plan' }],
    q: [115, 116, 118, 190],
  },

  'dash.hero-chart': {
    screen: 'Dashboard',
    title: 'Cumulative spend',
    hint: 'This period against the last, day by day. The dashed tail is a projection.',
    what: 'How this month’s spending accumulated, drawn against the same run last month.',
    how: 'Each line adds up that period’s expenses day by day from day 1. The reference line runs the prior period’s whole length; the dashed segment continues this period at its current pace to month end.',
    excludes: [
      'The dashed segment is a projection, never an actual — it assumes the rest of the period looks like the part you have',
      'Transfers and refunds, as everywhere else',
    ],
    next: [{ label: 'Build a custom comparison', tab: 'compare' }],
    q: [131, 136, 137],
  },

  'dash.movers': {
    screen: 'Dashboard',
    title: 'What changed',
    hint: 'Sorted by the size of the change, not the size of spend.',
    what: 'The categories that moved most against the same point last month.',
    how: 'Each category’s spend this month minus its spend over the same elapsed days last month, sorted by the absolute difference.',
    excludes: ['A large category that did not change does not appear here, however large it is'],
    seeSkill: 'comparisons',
    q: [8, 63, 285],
  },

  'dash.pinned': {
    screen: 'Dashboard',
    title: 'Pinned comparison',
    hint: 'A saved comparison, re-run against today’s data every time you open the dashboard.',
    what: 'A comparison you pinned in Compare, kept live on the dashboard.',
    how: 'The pin stores the *question* — which periods and filters — not the answer. Both sides are recomputed from the current vault on every visit, so a pin of “this month vs last” keeps meaning this month as the months roll over. The lines accumulate each period’s spend day by day from day 1.',
    excludes: [
      'A one-sided pin is a watch: it tracks one selection with nothing to compare against, and shows no delta',
      'Transfers and refunds, as everywhere else',
    ],
    next: [{ label: 'Open it in Compare', tab: 'compare' }],
    seeSkill: 'comparisons',
  },

  // ------------------------------------------------------------------ Compare
  'compare.mode': {
    screen: 'Compare',
    title: 'Same-point vs full period',
    hint: 'Same-point truncates the finished side to the elapsed length of the in-progress one.',
    what: 'How the two sides are lined up before anything is added.',
    how: 'Same-point counts both sides through the same elapsed day — on the 8th, eight days against the first eight days. Full period runs each side its whole length. This changes every figure on the screen, including the difference and the movers.',
    excludes: [
      'Comparing an in-progress month against a finished one on Full period is the most common way to get a confidently wrong answer — a 70% "drop" that is really 22 days that have not happened yet',
    ],
    seeSkill: 'comparisons',
    q: [59, 61, 62, 68],
  },

  'compare.normalize': {
    screen: 'Compare',
    title: 'Total / per day / per month',
    hint: 'Pick on length, not habit. Two calendar months compare on total; two trips never do.',
    what: 'What each side is divided by before comparison.',
    how: 'Total is the raw sum. Per day divides by days counted — the only fair basis when the periods differ in length. Per month divides by 30.44 days.',
    excludes: ['Normalizing does not change which rows are counted, only the divisor'],
    seeSkill: 'comparisons',
    q: [68],
  },

  'compare.categories': {
    screen: 'Compare',
    title: 'By category',
    hint: 'The top six categories. Both sides share one scale.',
    what: 'Where each side’s money went, side by side.',
    how: 'The six largest categories across both sides, drawn on one shared scale so bar lengths are comparable between A and B.',
    excludes: [
      'Only the top six render — the totals above cover every category, so these bars do not sum to them',
      'Transfers, on both sides',
    ],
    q: [46, 47, 50],
  },

  // ------------------------------------------------------------------- Trends
  'trends.year-projection': {
    screen: 'Trends',
    title: 'Projected year-end',
    hint: 'Year to date plus recent pace. A projection, not a forecast.',
    what: 'Where this year lands if the rest of it looks like the part you have.',
    how: 'Year-to-date spending, extended at the pace of the days elapsed. Drawn dashed, never styled like an actual.',
    excludes: [
      'Known future costs, seasonality, and anything not yet imported',
      'Hiding a category in the legend removes it from this figure, from every year’s total and from the axis',
    ],
    next: [{ label: 'See this year’s transactions', tab: 'txns' }],
    q: [72, 132, 136, 137],
  },

  'trends.legend': {
    screen: 'Trends',
    title: 'Category legend',
    hint: 'Switching a category off restates every total on the chart, not just its own bar.',
    what: 'Which categories are counted in the chart above.',
    how: 'Each item toggles one category out of the stacks. The figure under each bar, the axis and the year-end projection are all recomputed from what remains visible.',
    excludes: ['A hidden category is not deleted or excluded anywhere else in the app — this is a chart control only'],
    q: [71, 73],
  },

  'trends.drill': {
    screen: 'Trends',
    title: 'Category drill-down',
    hint: 'The eight largest merchants. The headline totals every merchant in the window.',
    what: 'Who you paid inside one category, over the window you pick.',
    how:
      'Every expense in the category over the window, grouped by merchant and sorted descending. ' +
      'The heading totals all of them; the bars show the top eight. The Δ beside each bar compares ' +
      'this window against the equal-length window before it; "new" means the merchant had nothing there.',
    excludes: [
      'Merchants outside the top eight — they are in the heading total but have no bar',
      'Refunds and income in the category',
      'The All range has no prior window, so no Δ',
      'Merchants are grouped by their raw statement name — "NETFLIX #4821" and "NETFLIX #4822" are two rows here',
    ],
    next: [{ label: 'See this category’s transactions', tab: 'txns' }],
    q: [49, 50, 83, 91],
  },

  'trends.headline': {
    screen: 'Trends',
    title: 'Trend headline',
    hint: 'Finished months only — the current month never counts until it is over.',
    what: 'Whether your spending and income are drifting up or down, how this year compares with last, and what a typical month costs.',
    how:
      'Take the average of your last 3 finished months and set it beside the average of the up-to-6 months before — ' +
      'that is the whole trick, done once for spending and once for income. Within 3% either way it just says flat. ' +
      '"This year to date" cuts last year off at the same day of the year, so a full year is never held against a partial one. ' +
      'The typical month is the median of the last 12 finished months, and the ± covers the middle half of them — ' +
      'one expensive trip cannot move it.',
    excludes: [
      'The current month, which is not finished',
      'Months with no imported data — skipped, never counted as a zero month',
    ],
    q: [27, 42, 61, 82],
  },

  'trends.momentum': {
    screen: 'Trends',
    title: 'What’s moving',
    hint: 'Spending more or less than usual? Each row compares a category with its own past.',
    what: 'Which categories cost you more or less per month lately, and which just had their biggest month ever.',
    how:
      'Each category gets two figures: what it costs per month lately (the average of its last 3 finished months) ' +
      'and what it used to cost (the average of the up-to-6 months before). A row appears when the two differ by ' +
      'at least 20% and by at least 25 a month in your base currency. Both gates matter: without the second, a tiny ' +
      'category jumping 40% would qualify; without the first, rent drifting 2% would. The row reads was → now, and ' +
      'the small bars beside the name are that category’s last 12 months. A record flag means the latest finished ' +
      'month is the biggest that category has ever had — said only with at least 6 months of history behind it.',
    excludes: [
      'Income and Transfers, always',
      'Categories excluded from the breakdown (a user preference, Housing by default)',
      'The current month, which is not finished, and months with no imported data',
    ],
    next: [{ label: 'See these transactions', tab: 'txns' }],
    q: [73, 74, 84, 99],
  },

  'trends.income-savings': {
    screen: 'Trends',
    title: 'Income & savings rate',
    hint: 'Rate = (income − spending) ÷ income, per month, on the right-hand scale.',
    what: 'Monthly income and spending together, and the savings rate each month produced.',
    how:
      'Green bars are income and the line over them is spending, both on the money axis. The second line is the ' +
      'savings rate — (income − spending) ÷ income — on its own percentage scale at the right edge. Where a month ' +
      'has no income the rate line breaks instead of pretending: a rate needs income to divide by. The same goes ' +
      'for the current month, which is not finished, and for months with no data at all.',
    excludes: [
      'A rate for months with no income — a 0% there would be a claim, not a fact',
      'Transfers between your own accounts, on both series',
    ],
    q: [24, 27, 40, 77],
  },

  'trends.seasonality': {
    screen: 'Trends',
    title: 'Seasonality',
    hint: 'Says nothing until it has seen every calendar month at least twice.',
    what: 'Which calendar month usually costs you the most, averaged across your years.',
    how:
      'All your Januaries averaged together, all your Februaries, and so on across every finished month. The card ' +
      'appears only once each calendar month has been seen at least twice — roughly two full years. Below that an ' +
      'average is an anecdote, so the card stays hidden rather than guess. "In N of M full years" counts complete ' +
      'calendar years only, because a partial year cannot fairly name its most expensive month.',
    excludes: ['The current month, which is not finished', 'Partial years, from the per-year count'],
    q: [76],
  },

  'trends.recurring': {
    screen: 'Trends',
    title: 'Recurring digest',
    hint: 'Confirmed subscriptions only — detected-but-unconfirmed charges are never counted.',
    what: 'What your confirmed recurring charges add up to, and which ones changed recently.',
    how:
      'The totals count only charges you have marked recurring yourself — a figure that quietly included guesses ' +
      'would be a guess. New, increased and decreased are charges that landed in the last 60 days. Lapsed is the ' +
      'opposite kind of news: a charge that was expected in the last 60 days and never arrived. Expected comes from ' +
      'the gaps in your own history — a rhythm, never a due date.',
    excludes: ['Detected but unconfirmed merchants', 'Subscriptions that lapsed long ago — old news by now'],
    next: [{ label: 'Open Subscriptions', tab: 'plan' }],
    q: [89, 90, 92],
  },

  // -------------------------------------------------------------------- Plan
  'plan.budget-bar': {
    screen: 'Plan',
    title: 'Budget bar',
    hint: 'All bars share one scale — compare each bar to its own tick, not to the bar above.',
    what: 'How much of this budget you have spent, and where you are on pace to land.',
    how:
      'Spent is derived from your transactions every time you look — never stored — so an import can ' +
      'never leave a budget stale. The dashed marker is the month-end projection, and it divides by the ' +
      'days your imported statements actually cover, not by the days of the month that have passed: a ' +
      'rate has to be measured over the window the spending was measured over. It needs at least 3 days ' +
      'before it appears.',
    excludes: [
      'All bars on this screen share one horizontal scale, so a short bar can mean a small budget rather than careful spending',
      'A row with a year scope (annual, or yearly recurring) counts a calendar year: its caption shows the ≈ €/mo equivalent of the yearly amount, its "today" marker sits at the fraction of that year already gone (calendar days, not statement coverage), and its dashed marker is a year-end pace. A per-trip row counts its trip and has no marker at all.',
      'Charges you have not imported yet. When your statements stop before today, a dotted "data" marker shows where they stop — everything to the right of it is missing from the bar, not spent.',
    ],
    next: [{ label: 'Open this category’s transactions', tab: 'txns' }],
    q: [115, 116, 119, 121],
  },

  'plan.rollup': {
    screen: 'Plan',
    title: 'All budgets',
    hint: 'Monthly budgets only, with each transaction counted once.',
    what: 'Your monthly budgets added together, against what you have spent.',
    how:
      'Every budget whose scope covers the month shown: plain monthly budgets, monthly recurring budgets ' +
      'that name a category, and budgets over several categories. Budgets are allowed to overlap, so the ' +
      'spend figure adds up the TRANSACTIONS they cover rather than the budgets — a charge inside two of ' +
      'them counts once. On the plan side, a budget sitting entirely inside a wider one is a limit within ' +
      'that budget, not extra plan, so only the outermost amounts are added.',
    excludes: [
      'Annual and per-trip budgets — they cover a different period, so adding them into a monthly total would be a lie. They are listed separately as memo lines; the memo\'s "(≈ €X/mo)" is the annual amount ÷ 12, shown for reading only and never added into the total.',
      'A recurring budget that spans all categories: it is an overlay across every category rather than a period of its own, so it is a memo line too',
      'Nothing is dropped for overlapping. If two budgets share a category and neither is inside the other, both amounts are counted and the screen says so — that plan really is ambiguous.',
    ],
    q: [122, 123, 124],
  },

  'plan.movers': {
    screen: 'Plan',
    title: 'Off plan this month',
    hint: 'Distance from each budget’s own limit — not what you spent.',
    what: 'Which budgets are away from their limit, and by how much, biggest gap first.',
    how:
      'Each bar is spend minus that budget’s amount: to the right means over the limit, to the left means ' +
      'still to spend. Bar length is that gap relative to the largest gap in the list, so it ranks the ' +
      'budgets against each other rather than against their own sizes.',
    excludes: [
      'Budgets sitting exactly on their limit',
      'The figures here are gaps, not totals — a budget can show a small gap and still be your largest spend',
      'A budget covering several categories has no single category to filter by, so its row does not drill',
    ],
    next: [{ label: 'Open this category’s transactions', tab: 'txns' }],
    q: [124],
  },

  'plan.subscriptions': {
    screen: 'Plan',
    title: 'Recurring & subscriptions',
    hint: 'Confirmed recurring charges only. A cadence, never a due date.',
    what: 'What you pay on a repeating schedule, and what it totals.',
    how: 'A charge is counted once you have marked it recurring. Ledger suggests candidates when a merchant charges you at least three times, roughly monthly or yearly, at a broadly stable amount.',
    excludes: [
      'Suggestions you have not confirmed — they are listed separately and are not in the total',
      'Charges that have stopped: nothing for more than one and a half of their own periods drops them from the total. They are listed under "Stopped", with the date of the last one.',
      '"Expected ≈ 14 Aug" is a pattern in your own history, not a due date. Ledger has no billing calendar and cannot tell you when anything is actually due.',
      'A row\'s totals are what you have IMPORTED and marked, so they begin where your statements begin — not necessarily when you first subscribed. Ledger also cannot know a subscription was cancelled, only that no charge arrived.',
    ],
    next: [{ label: 'See recurring transactions', tab: 'txns', query: { status: 'recurring' } }],
    q: [89, 90, 91, 92, 93],
  },

  // ----------------------------------------------------------------- Accounts
  'accounts.net-worth': {
    screen: 'Accounts',
    title: 'Net worth',
    hint: 'Each account’s own latest snapshot, added up. Not one date.',
    what: 'What you own minus what you owe, from dated balance snapshots.',
    how: 'Every account contributes its most recent snapshot, converted at that snapshot’s own date. The dates are not the same across accounts — the caption shows the newest and the oldest.',
    excludes: [
      'Accounts you have hidden',
      'Any account you have never entered a balance for — it contributes nothing, and is not counted as zero',
      'This is a dated fact, never a live balance. Ledger has no bank connection.',
    ],
    next: [{ label: 'Update a balance', tab: 'accounts' }],
    seeSkill: 'balances',
    q: [3, 140, 141, 142, 147, 148],
  },

  'accounts.months-cover': {
    screen: 'Accounts',
    title: 'Months of cover',
    hint: 'Liquid balances ÷ average monthly expenses. Not a runway forecast.',
    what: 'How long your liquid balances would cover spending at your recent rate.',
    how: (c) =>
      `The sum of balances on accounts marked liquid, divided by the mean of your monthly ` +
      `expenses over the complete months that have data — up to twelve, excluding the current ` +
      `partial month. Your target is ${c.efTarget} months, which you set in Settings.`,
    excludes: [
      'Investment and property accounts are not counted as liquid',
      'The current month',
      'Any income at all — the figure assumes nothing more arrives',
      'This is not a runway or an overdraft warning. Ledger has no live balance and no calendar of upcoming bills, so it cannot tell you what is safe to spend before your next payday.',
    ],
    next: [{ label: 'See monthly expenses', tab: 'trends' }],
    seeSkill: 'balances',
    q: [12, 175, 176, 177],
  },

  'accounts.hidden': {
    screen: 'Accounts',
    title: 'Counted / Hidden',
    hint: 'Hidden removes the account from every chart, total and the transaction list.',
    what: 'Whether this account takes part in the rest of the app.',
    how: 'Hiding removes the account, its balances and its transactions from every figure, chart and list — except this screen, where it stays visible at reduced opacity so you can bring it back.',
    excludes: [
      'The assistant can still read hidden accounts when you ask it something. Hiding is a display choice, not a privacy boundary.',
      'Nothing is deleted',
    ],
    q: [142, 143, 236],
  },

  'accounts.gap-band': {
    screen: 'Accounts',
    title: 'Statements missing',
    hint: 'One account has no snapshot across these months. The line is not interpolated.',
    what: 'A stretch where the net-worth line rests on anchors alone.',
    how: 'The longest run of months in which a single account has no balance snapshot. The line is split rather than drawn across it — Ledger never interpolates a balance it does not have.',
    excludes: [
      'Other, shorter gaps on other accounts are not marked',
      'Hiding an account changes where this band falls',
    ],
    next: [{ label: 'Import a statement', tab: 'import' }],
    seeSkill: 'balances',
    q: [78, 240, 242],
  },

  // ------------------------------------------------------------- Transactions
  'txn.provenance': {
    screen: 'Transactions',
    title: 'Set by',
    hint: 'How this row’s category was last decided.',
    what: 'The origin of the category on this transaction.',
    how: 'In precedence order: a rule you saved; the import assistant’s suggestion (marked AI, and still awaiting your review); the transfer pairing; a category you chose by hand; a match against a row you had already categorised; or nothing matched, so it sits in Other.',
    excludes: ['An AI suggestion is a guess until you confirm it — confirming mints a rule, so it never has to guess again'],
    next: [{ label: 'See your rules', tab: 'settings' }],
    seeSkill: 'ledger-model',
    q: [254, 255, 256, 260],
  },

  'txn.duplicate': {
    screen: 'Transactions',
    title: 'Possible duplicate',
    hint: 'Another statement covering this period already holds this row.',
    what: 'A row that two overlapping statement files both describe.',
    how: 'Re-importing the same file is dropped whole, so this is never an import artefact — it means two different files overlap in time and both contain this charge.',
    excludes: ['A genuine double charge by a merchant is not this — it correctly appears as two rows'],
    next: [{ label: 'Review duplicate imports', tab: 'settings' }],
    q: [97, 243, 245, 246],
  },

  // -------------------------------------------------------------------- Trips
  'trips.timeline': {
    screen: 'Trips',
    title: 'Trips timeline',
    hint: 'Block height is € per day, on a scale shared across every trip.',
    what: 'Every dated trip on one time axis.',
    how: 'Width is the trip’s length; height is spend per day relative to your most expensive trip per day. Two blocks of equal height mean an equal daily rate, not an equal total.',
    excludes: [
      'Trips with no date window — they still appear as cards below',
      'Income, refunds and transfers',
      'Foreign rows with no exchange rate',
    ],
    next: [{ label: 'Compare two trips', tab: 'compare' }],
    q: [102, 107, 108],
  },

  'trips.daily': {
    screen: 'Trips',
    title: 'Daily spend on a trip',
    hint: 'What the trip cost on each of its days, including the quiet ones.',
    what: 'One bar per calendar day of the trip.',
    how: 'Every expense tagged to the trip, summed by its date and converted to your base currency. Days with no spend show an empty slot rather than being skipped, so the shape of the trip is honest.',
    excludes: [
      'Income, refunds and transfers',
      'Rows you excluded from the trip',
      'Foreign rows with no exchange rate',
    ],
    q: [102, 107],
  },

  'trips.categories': {
    screen: 'Trips',
    title: 'Trip category breakdown',
    hint: 'Every category in this trip, largest first — not a top five.',
    what: 'Where one trip’s money went, by category.',
    how: 'The trip’s expenses grouped by category and converted to your base currency. Clicking a row opens exactly those transactions.',
    excludes: [
      'Income, refunds and transfers',
      'Rows you excluded from the trip',
      'Foreign rows with no exchange rate',
    ],
    q: [102, 108],
  },

  'trips.forecast': {
    screen: 'Trips',
    title: 'Planned trip forecast',
    hint: 'The median € per day of your other trips × the days you plan. Nothing is stored.',
    what: 'A rough cost for a trip you have not taken.',
    how: 'The middle value of your other trips’ per-day rates, multiplied by the number of days you enter. Every field is editable and nothing is saved.',
    excludes: [
      'Flights and accommodation booked before the window',
      'Trips whose per-day rate is zero',
      'This is arithmetic on your own history, not a price estimate',
    ],
    q: [133, 136, 137],
  },

  // ---------------------------------------------------------------- Assistant
  'assistant.receipts': {
    screen: 'Assistant',
    title: 'What the assistant sent',
    hint: 'One line per tool call. A summary of the request, not the payload.',
    what: 'The record of what the assistant asked for while answering.',
    how: 'Each line names one tool call and the shape of its result. Nothing is sent until you ask a question; then the assistant fetches only what answering needs.',
    excludes: [
      'The line is a summary — a row query’s result carries each row’s date, merchant, amount, account and category',
      'Reading a skill sends that note’s whole body',
      'The conversation so far is re-sent with each follow-up',
      'Accounts you have hidden are still readable here',
    ],
    next: [{ label: 'Review what this sends', tab: 'settings' }],
    q: [261, 275],
  },
} as const satisfies Record<string, Explanation>

export type ExplainId = keyof typeof EXPLAIN

/** Stable id list, for the glossary and the generated skill. */
export const EXPLAIN_IDS = Object.keys(EXPLAIN) as ExplainId[]

/** Resolve `how`, which may need live context (a target, a symbol). */
export function howText(e: Explanation, c: ExplainCtx): string {
  return typeof e.how === 'function' ? e.how(c) : e.how
}
