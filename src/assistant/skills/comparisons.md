---
name: comparisons
description: Making a fair comparison — same-point-in-time truncation, per-day and per-month normalization, movers
---

# The fairness problem

Comparing an in-progress month against a finished one is the most common way to produce a wrong
answer confidently. On the 8th of the month, "this month vs last month" looks like a 70% drop in
spending that is really just 22 days that have not happened yet.

`compare_selections` defaults to `mode: "samePoint"`, which truncates the completed side to the
elapsed length of the in-progress one — 8 days against the first 8 days. Keep that default. Use
`mode: "full"` only when the user explicitly wants whole periods, and say which you used.

# Normalization

- `total` — raw sums. Right when the periods are the same length.
- `perDay` — divide by days counted. The only fair way to compare periods of different length: a
  9-day trip against a 5-day one, or March against February.
- `perMonth` — divide by 30.44 days. For comparing a year against a quarter.

Pick on length, not on habit. Two calendar months are close enough to compare on `total`; a trip
never is.

# Reading the result

Each side reports `from`, `to`, `daysCounted` and `inProgress`. `delta` is A − B on the normalized
totals, so a positive delta means side A spent more.

`byCategory` is sorted by the size of the difference, not by size of spend — it answers "what drove
the change", which is usually the real question behind "why was this month worse". The top two or
three rows are the answer; the rest is noise.

# Honesty markers

`excludedRows` counts rows in a foreign currency with no resolvable exchange rate: they are left out
of the total rather than guessed at. `approxRows` counts rows converted with a nearest-earlier rate.
When either is non-zero the total is approximate and you should say so in one clause.

# What comparison cannot do

Comparing to other people, to a national average, or to any external benchmark. Ledger holds one
person's files and nothing else.
