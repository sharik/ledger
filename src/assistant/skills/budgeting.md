---
name: budgeting
description: Setting up or revising budgets from spending history — orientation, rhythm, native periods, trailing averages, one proposal at a time
---

# Budgets have a native period

A budget covers one **calendar-aligned, evergreen period**: month, quarter (Q1 = Jan–Mar),
half-year (H1 = Jan–Jun) or year. "€300 per quarter" applies to every quarter until it is
changed. A budget can always be *viewed* at a coarser horizon (a monthly budget rolls up into
the quarter view), never a finer one — so lumpy spending belongs on the period where it is
honest: a quarterly insurance premium on a quarterly budget, taxes on a yearly one, never an
impossible monthly bar.

# Orient before proposing

Call `list_budgets` first — what already exists (and at which periods) decides whether anything
should be created at all — and `get_overview` for how many months the data covers. A suggestion
from two months of history is a guess; say so instead of making one.

# Read the rhythm, then pick the period

Call `spending_cadence`: for every category it reports the detected rhythm (monthly, quarterly,
semiannual, yearly — or none), how many scanned months had spend, whether a steady base carries
periodic lumps, and the suggested native period. Pick each budget's `period` from that rhythm —
it works in safe mode too, where the rhythm is visible but amounts are not. With full access,
`aggregate` grouped by `month` over one category is the way to look closer at a rhythm; exclude
the current month — it is partial, and averaging it in understates everything.

# Propose one budget per call

`propose_plan` makes one proposal, and each gets its own approval card. Pass the `period` you
picked, and for the amount prefer `amount: "trailing-3"` or `"trailing-6"` — Ledger computes the
mean of that exact scope's last complete **native periods** (months for a monthly budget,
quarters for a quarterly one), so the card shows the same number the app itself would suggest.
Never invent an amount, never propose 0, and state the basis in your reply ("the average of the
last 3 quarters"). If Ledger answers that there is not enough history to average, ask the user
for a figure rather than guessing one. A full multi-period setup is fine as a series of calls —
one card per budget, each applied or dismissed on its own.

If the duplicate error comes back, that exact budget already exists — it names the id; switch to
`action: "update"` on that id instead of retrying the create. The same category can carry
budgets at *different* periods (a monthly base beside a quarterly lump cover); the app counts
the shared money once.

# Standing up many budgets at once

For a first full setup, point the user at **Plan → "Suggest from history"**: it suggests a
budget for every category with enough history, at the period matching its detected rhythm, with
every amount editable, and applies the whole set as one undoable step. That flow, your
`trailing-*` proposals and `spending_cadence` all compute from the same primitives, so the
numbers agree.

# In safe mode

The rhythm is visible; amounts are not. Use `spending_cadence` to pick periods, propose with
`trailing-3`/`trailing-6`, and tell the user the resolved figure appears on the approval card —
it is computed on their device and never returned to you. If they want a specific limit, ask for
the number and pass it literally.
