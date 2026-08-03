---
name: ledger-model
description: How Ledger models money — selections, trips and sets, transfers, flow vs stock, provenance, the recurring axis
---

# Selections

Every analysis tool takes a *selection*: a period, plus optional categories, accounts, trips/sets and
a merchant substring. The fields combine with AND; within `trackingIds` it is OR. Omit a field to
leave that axis unconstrained — an empty selection means "everything, all time".

Periods are either relative (`thisMonth`, `lastMonth`, `thisYear`, `lastYear`, `sameMonthLastYear`),
a specific `{"month":"2026-03"}` or `{"year":2025}`, or an explicit `{"from":…,"to":…}` range. The
relative ones resolve against today, so prefer them when the user says "this month".

# Trips and sets (trackings)

A tracking is a named group of transactions — a trip, a wedding, a house move, a business. It is the
one grouping that is *not* expressible as a filter, because membership is curated by hand:

    members = (rows inside the date window − explicit excludes) ∪ explicit includes

So a deposit paid a week before a trip can belong to it, and the rent that fell mid-trip can be
excluded. Rows imported later land in the trip automatically if they fall in the window. There are no
free-text tags in Ledger; sets *are* the tagging mechanism.

# Transfers are not spending

Money moved between the user's own accounts is not income and not expense. A transfer is recognised
either by both legs being paired (`transferGroupId`) or by the row sitting in the Transfers category.
Selections drop these by default. `includeNonCashflow: true` puts them back, which is almost never
what a question wants — use it only when the user explicitly asks to see transfers.

# Flow versus stock

Two different kinds of number, never to be mixed:

- **Flow** comes from transactions: income, expense, net cash flow, savings rate, budgets.
- **Stock** comes from balance snapshots: account balances, net worth, debt outstanding.

A savings rate is always flow-derived — never "the balance went up by this much". A balance is always
a dated fact, never a running total of transactions.

# Provenance

Each transaction records how its category was last decided: `rule` (a stored mapping matched),
`ai` (suggested by the import assistant), `transfer`, `fallback` (nothing matched, so it sits in
Other), `manual` (a person chose it), `history` (matched a previously categorised row). Rows with
`fallback` provenance are the uncategorised backlog; `ai` rows may still be awaiting review.

# The recurring axis

`recurring` is `monthly` or `yearly` and is *orthogonal to category* — Netflix is Entertainment and
monthly-recurring at the same time. It is set by the user (often from a detected suggestion), not
derived, so its absence means "not marked", not "not recurring". Filter on it via the `recurring`
field of a selection.

# Categories

There are fourteen by default. Four carry logic through a stable `role` rather than their name —
`income`, `housing`, `other`, `transfers` — so the names can be renamed or translated freely. Always
resolve a category by id from `list_categories`; never assume an id from its name.
