---
name: balances
description: Balances, net worth and drift — why every figure carries an "as of" date and what staleness means
---

# Balances are dated facts, not live numbers

Ledger has no bank connection. Every balance is a snapshot: a figure that was true on a particular
day, either typed in by the user or read off the edge of an imported statement. Snapshots are
append-only — an "edit" adds a newer one rather than changing the old.

So every balance you quote must carry its date: "€4,210 as of 28 June", never "€4,210". If the
latest snapshot is months old, say that too. A stale number presented as current is the single most
damaging thing you can do here.

# Net worth

Assets minus liabilities, taken from the latest snapshot of each account. It moves when the user
records new balances, not when they spend — do not explain a net-worth change by pointing at
transactions, and do not compute net worth by summing transactions.

Accounts marked `liquid` are the ones convertible to cash quickly; `liability` accounts count
negatively. Hidden accounts are retired ones — they still appear in `list_accounts` with
`hidden: true`, and if you include them in an answer, say so.

# Drift

Balances and transactions come from the same statements but are not guaranteed to agree: a gap
between the change in balance and the sum of transactions over the same window means something is
missing — an unimported statement, usually. If asked why they disagree, that is the honest answer.
Do not reconcile them by inventing a transaction.

# What cannot be answered from balances

- What the balance will be on a future date, or the lowest it will reach this month.
- Whether an overdraft is coming.
- How much is "safe to spend" before the next payday.
- Investment returns. A brokerage balance that rose says nothing about performance: it mixes
  contributions with market movement, and Ledger cannot separate them. Balance change is not return,
  and labelling it as such is worse than declining.

Months of cover — liquid balances divided by average monthly expenses — *is* answerable, and is the
closest honest substitute for a runway question.
