// Rows in base currency, with the two counts a total has to disclose.
//
// This is the conversion half of what four places do today: `derive()` (selectors.ts),
// `compare()`'s `resolveSide`, `tripSummary`'s `tripRows`, and the assistant's `rowsOf`. Each one
// walks the same chain — resolve the row's effective currency, convert into base, count the
// nearest-date approximations, drop and count what has no rate at all — and then goes on to sum
// the result in a way none of the others share (`MonthFlow`, a signed side total, expense-only,
// an income/expense/net breakdown). So only the shared half lives here; the summing does not.
//
// Nothing above this line decides what a row MEANS. No `isCashflow`, no income-vs-refund rule, no
// sign convention: this hands back the same rows it was given with `amount` in base currency, and
// the caller applies whatever semantics its screen owes its reader.
//
// The four existing call sites are deliberately not folded onto this yet — two of them are the FX
// correctness core with their own tests, and mixing a refactor into a behaviour change is how you
// lose the ability to tell which one broke something. `tests/analytics/rows.test.ts` cross-checks
// this against `compare()` instead, so the day they are folded in is a mechanical change with a
// contract already proving the two agree.
import type { Transaction, Vault } from '../model/types'
import { accountCurrencyMap, rowCurrency, type RateBook } from '../import/fx'

export interface ConvertedRow {
  t: Transaction
  /** `t.amount` in base currency. Same sign as the original. */
  amount: number
}

export interface ConvertedRows {
  rows: ConvertedRow[]
  /** Rows dropped because no rate could be resolved. Never silently zeroed — always disclosed. */
  excluded: number
  /** Rows converted at a nearest-earlier rate, which a figure renders with `≈`. */
  approx: number
}

export function convertRows(txns: readonly Transaction[], vault: Vault, rates?: RateBook): ConvertedRows {
  const base = vault.params.baseCurrency ?? 'EUR'
  const accountCur = accountCurrencyMap(vault)
  const rows: ConvertedRow[] = []
  let excluded = 0
  let approx = 0

  for (const t of txns) {
    const cur = rowCurrency(t, accountCur, base)
    if (cur === base) {
      rows.push({ t, amount: t.amount })
      continue
    }
    const conv = rates?.convert(t.amount, cur, t.date)
    // No rate ⇒ the row leaves the total and is counted, rather than entering it as €0. A
    // silently-zeroed foreign row is a total that is quietly wrong (IMPORT §4.5).
    if (!conv) {
      excluded++
      continue
    }
    if (conv.approx) approx++
    rows.push({ t, amount: conv.value })
  }
  return { rows, excluded, approx }
}

/** Base-currency amount per transaction id, for a screen that already has the rows in hand. */
export function convertedById(r: ConvertedRows): Map<string, number> {
  const m = new Map<string, number>()
  for (const { t, amount } of r.rows) m.set(t.id, amount)
  return m
}
