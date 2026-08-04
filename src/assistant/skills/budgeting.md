---
name: budgeting
description: Setting up or revising budgets from spending history — orientation, rhythm, trailing averages, one proposal at a time
---

# Orient before proposing

Call `list_budgets` first — what already exists decides whether anything should be created at
all — and `get_overview` for how many months the data covers. A suggestion from two months of
history is a guess; say so instead of making one.

# See the shape of spending first

With full access, `aggregate` grouped by `category` over the last 6–12 **complete** months shows
what each category actually costs. Exclude the current month from the range — it is partial, and
averaging it in understates everything. To judge rhythm, aggregate one category grouped by
`month`: spend in most months suits a monthly budget; spend that arrives in lumps (insurance,
taxes, holidays) suits a yearly one (`cadence: "yearly"`), sized on the yearly total, so the lump
does not read as a blown month.

# Propose one budget per call

`propose_plan` makes one proposal, and each gets its own approval card. For a monthly amount,
prefer `amount: "trailing-3"` or `"trailing-6"` — Ledger computes the figure from that exact
scope's complete months, so the card shows the same number the app itself would suggest. Never
invent an amount, never propose 0, and state the basis in your reply ("the 6-month average").
If Ledger answers that there is not enough history to average, ask the user for a figure rather
than guessing one.

If the duplicate error comes back, that exact budget already exists — it names the id; switch to
`action: "update"` on that id instead of retrying the create.

# Standing up many budgets at once

For a first full setup, point the user at **Plan → "From history"**: it suggests a budget for
every category with enough history — monthly where spending has a monthly rhythm, annual where
it arrives in lumps — with every amount editable, and applies the whole set as one undoable step.
That flow and your `trailing-*` proposals compute from the same primitive, so the numbers agree.

# In safe mode

Amounts cannot be read or computed, so `trailing-3`/`trailing-6` are refused. Ask the user for
each figure and pass the literal number they give you.
