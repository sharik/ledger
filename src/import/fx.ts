// FX stack (IMPORT §4.5). Pure resolution of a foreign amount into the vault's
// base currency along the priority chain:
//
//   bank-derived  →  FxOverride  →  API exact date  →  API nearest-earlier (≈)  →  excluded
//
// Rates are expressed as "units of `to` per unit of `from`", so converting is a
// single multiply. The provider client (fawazahmed0 currency-api) is the only
// impure part; its tables are cached in L1 KV by the app and passed in here —
// this module never touches the network on the selector path, and never writes
// the vault (overrides are ordinary FxOverride records committed by the caller).
import type { DateStr, Transaction, Vault } from '../model/types'
import { daysBetween } from '../analytics/selections'

/** accountId → its currency ('EUR' when absent, per model/types Account.currency). */
export function accountCurrencyMap(vault: Vault): Map<string, string> {
  const m = new Map<string, string>()
  for (const a of vault.accounts) m.set(a.id, a.currency ?? 'EUR')
  return m
}

/**
 * Effective row currency (model/types Transaction.currency: "defaults to
 * account's"): explicit row currency, else the account's, else `base` for
 * legacy manual rows with no account.
 */
export function rowCurrency(t: Transaction, accountCur: Map<string, string>, base: string): string {
  return t.currency ?? (t.accountId ? (accountCur.get(t.accountId) ?? base) : base)
}

export type RateSource = 'identity' | 'bank-derived' | 'override' | 'api-exact' | 'api-nearest'

export interface RateResult {
  rate: number // units of `to` per unit of `from`
  source: RateSource
  approx: boolean // true ⇒ a nearest-earlier fallback, render with `≈`
}

/** One provider table for a base currency on a date: 1 base = table[cur] units of cur. */
export type RateTable = Record<string, number>

/** date ('YYYY-MM-DD') → provider table for the vault base. Owned by the app (KV cache). */
export type RateTables = Map<DateStr, RateTable>

const norm = (c: string): string => c.trim().toLowerCase()

/**
 * Bank-derived rate `from → base`, computed from any transaction whose foreign
 * leg is in `from` and whose booked amount is in `base`:
 *   rate = (|amount| − fee) / |original.amount|      (§3 JPY example: ≈0.0060982)
 * The row nearest `date` wins (ties by later date), so a multi-month import keeps
 * the most contemporaneous derivation. Authoritative ⇒ never approximate.
 */
export function bankDerivedRate(vault: Vault, from: string, base: string, date?: DateStr): number | null {
  const f = norm(from)
  const b = norm(base)
  // The row's currency must be resolved through its ACCOUNT: `planToOp` stores `Transaction.currency`
  // only when it differs from the account's, so every row of a non-base account (a UAH card in a EUR
  // vault) carries `undefined` and would otherwise be read as being denominated in the base — turning
  // a UAH-priced foreign leg into a rate for the base currency, at the top, non-approximate rung.
  const accountCur = accountCurrencyMap(vault)
  let best: { rate: number; date: DateStr } | null = null
  for (const t of vault.transactions) {
    if (!t.original || norm(t.original.currency) !== f) continue
    const txnCur = norm(rowCurrency(t, accountCur, base))
    if (txnCur !== b) continue
    const orig = Math.abs(t.original.amount)
    if (orig === 0) continue
    const rate = (Math.abs(t.amount) - (t.fee ?? 0)) / orig
    if (!(rate > 0) || !Number.isFinite(rate)) continue
    if (!best) best = { rate, date: t.date }
    else if (date) {
      if (Math.abs(daysBetween(t.date, date)) < Math.abs(daysBetween(best.date, date))) best = { rate, date: t.date }
    } else if (t.date > best.date) best = { rate, date: t.date }
  }
  return best ? best.rate : null
}

/** Manual override `from → base` for a date; exact-date match wins, else the newest earlier one. */
function overrideRate(vault: Vault, from: string, base: string, date: DateStr): number | null {
  const f = norm(from)
  const b = norm(base)
  const cands = vault.fxOverrides
    .filter((o) => norm(o.from) === f && norm(o.to) === b && o.date <= date)
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.updatedAt < y.updatedAt ? 1 : -1))
  return cands[0]?.rate ?? null
}

/** API rate `from → base` from a cached table; exact date, else nearest earlier (≈). */
function apiRate(tables: RateTables, from: string, date: DateStr): { rate: number; approx: boolean } | null {
  const f = norm(from)
  const read = (t: RateTable): number | null => {
    const perFrom = t[f] // 1 base = perFrom `from`
    return perFrom && perFrom > 0 ? 1 / perFrom : null
  }
  const exact = tables.get(date)
  if (exact) {
    const r = read(exact)
    if (r != null) return { rate: r, approx: false }
  }
  let best: { rate: number; date: DateStr } | null = null
  for (const [d, t] of tables) {
    if (d > date) continue
    const r = read(t)
    if (r == null) continue
    if (!best || d > best.date) best = { rate: r, date: d }
  }
  return best ? { rate: best.rate, approx: true } : null
}

/** The full priority chain for `from → base` on `date`. Null ⇒ no rate (tier-5 exclusion). */
export function rateFor(
  vault: Vault,
  from: string,
  base: string,
  date: DateStr,
  tables: RateTables = new Map(),
): RateResult | null {
  if (norm(from) === norm(base)) return { rate: 1, source: 'identity', approx: false }
  const bank = bankDerivedRate(vault, from, base, date)
  if (bank != null) return { rate: bank, source: 'bank-derived', approx: false }
  const ovr = overrideRate(vault, from, base, date)
  if (ovr != null) return { rate: ovr, source: 'override', approx: false }
  const api = apiRate(tables, from, date)
  if (api != null) return { rate: api.rate, source: api.approx ? 'api-nearest' : 'api-exact', approx: api.approx }
  return null
}

export interface Converted {
  value: number // amount in base
  source: RateSource
  approx: boolean
}

/**
 * A synchronous converter into `base`, resolving each (currency, date) against the
 * chain once and memoizing. Consumed at selector time by compare/KPIs; when a row
 * has no rate it returns null and the caller excludes it honestly.
 */
export interface RateBook {
  base: string
  convert(amount: number, from: string | undefined, date: DateStr): Converted | null
}

/**
 * Per-row converter into base for analytics sum loops: resolves the row's
 * currency through its account (the `?? 'EUR'` trap this file warns about) and
 * converts at the row's date. `null` ⇒ no rate — exclude the row honestly,
 * exactly as `derive()` does.
 */
export function rowConverter(vault: Vault, rb: RateBook): (t: Transaction) => number | null {
  const accountCur = accountCurrencyMap(vault)
  return (t) => {
    const conv = rb.convert(t.amount, rowCurrency(t, accountCur, rb.base), t.date)
    return conv ? conv.value : null
  }
}

export function buildRateBook(vault: Vault, tables: RateTables = new Map()): RateBook {
  const base = vault.params.baseCurrency ?? 'EUR'
  const cache = new Map<string, RateResult | null>()
  return {
    base,
    convert(amount, from, date) {
      const cur = from ?? base
      if (norm(cur) === norm(base)) return { value: amount, source: 'identity', approx: false }
      const key = `${norm(cur)}|${date}`
      let r = cache.get(key)
      if (r === undefined) {
        r = rateFor(vault, cur, base, date, tables)
        cache.set(key, r)
      }
      if (!r) return null
      return { value: amount * r.rate, source: r.source, approx: r.approx }
    },
  }
}

// ---------- provider client (fawazahmed0 currency-api) ----------

export interface FxProviderOpts {
  baseUrl?: string // primary template, '{date}'/'{base}' placeholders
  fallbackUrl?: string
  fetchImpl?: typeof fetch
}

const PRIMARY = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/{base}.json'
const FALLBACK = 'https://{date}.currency-api.pages.dev/v1/currencies/{base}.json'

function fillUrl(tpl: string, date: string, base: string): string {
  return tpl.replaceAll('{date}', date).replaceAll('{base}', base.toLowerCase())
}

/** Parse the provider payload `{ date, <base>: { cur: rate } }` into a RateTable. */
export function parseRateTable(json: unknown, base: string): RateTable | null {
  if (!json || typeof json !== 'object') return null
  const table = (json as Record<string, unknown>)[base.toLowerCase()]
  if (!table || typeof table !== 'object') return null
  const out: RateTable = {}
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[norm(k)] = v
  }
  return Object.keys(out).length ? out : null
}

/**
 * Fetch one date's table for `base`; tries the primary URL then the fallback.
 * `date` is 'YYYY-MM-DD' or 'latest'. Returns null on total failure (caller
 * degrades honestly). Never throws for network/parse errors.
 */
export async function fetchRateTable(date: string, base: string, opts: FxProviderOpts = {}): Promise<RateTable | null> {
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return null
  const urls = [fillUrl(opts.baseUrl ?? PRIMARY, date, base), fillUrl(opts.fallbackUrl ?? FALLBACK, date, base)]
  for (const url of urls) {
    try {
      const res = await f(url)
      if (!res.ok) continue
      const json = await res.json()
      const table = parseRateTable(json, base)
      if (table) return table
    } catch {
      // try the next URL
    }
  }
  return null
}
