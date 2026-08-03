// Visual constants for the new Ledger.dc.html design. Colors are CSS custom
// properties resolved from the token blocks in index.html (:root / [data-theme]),
// so every value follows the active light/dark theme. Inline styles and SVG
// fills accept var() — this is how the mock itself works (Convention #6).
export const INK = 'var(--ink)'
export const MUT = 'var(--ink2)'
export const FAINT = 'var(--ink3)'
export const BG = 'var(--bg)'
export const SURFACE = 'var(--surface)'
export const SURFACE2 = 'var(--surface2)'
export const CHIP = 'var(--chip)'
export const HAIR = 'var(--hair)'
export const HAIR2 = 'var(--hair2)'
export const SEL = 'var(--chip)'
export const ACCENT = 'var(--accent)'
export const FOCUS = 'var(--focus)'
export const GREEN = 'var(--pos)'
export const GREENBAR = 'var(--pos)'
export const GREENDOT = 'var(--pos)'
export const BRICK = 'var(--neg)'
export const BRICKBAR = 'var(--neg)'
export const AMBER = 'var(--warn)'
export const SPOT = 'var(--accent)'
export const CMPA = 'var(--cmpa)'
export const CMPB = 'var(--cmpb)'
export const POSBG = 'var(--posbg)'
export const NEGBG = 'var(--negbg)'
export const WARNBG = 'var(--warnbg)'

export const SANS = "'IBM Plex Sans',system-ui,sans-serif"
export const SERIF = SANS // legacy alias — the new design has no serif face
export const MONO = "'IBM Plex Mono',ui-monospace,monospace"

/** Fixed category color tokens, keyed by category name (Income → positive). */
export const CAT_COLORS: Record<string, string> = {
  Housing: 'var(--c-house)',
  Utilities: 'var(--c-util)',
  Groceries: 'var(--c-groc)',
  'Dining out': 'var(--c-rest)',
  Transport: 'var(--c-trans)',
  Travel: 'var(--c-travel)',
  Shopping: 'var(--c-shop)',
  Health: 'var(--c-health)',
  Entertainment: 'var(--c-ent)',
  Insurance: 'var(--c-ins)',
  'Taxes & fees': 'var(--c-tax)',
  Other: 'var(--c-other)',
  Transfers: 'var(--c-other)',
  Income: 'var(--pos)',
}

/** Swatches offered when a user creates or recolours a category. */
export const CAT_PALETTE = [
  'var(--c-house)', 'var(--c-util)', 'var(--c-groc)', 'var(--c-rest)', 'var(--c-trans)',
  'var(--c-travel)', 'var(--c-shop)', 'var(--c-health)', 'var(--c-ent)', 'var(--c-ins)',
  'var(--c-tax)', 'var(--c-other)', 'var(--pos)', 'var(--cmpa)', 'var(--cmpb)',
]

// The money symbol follows the vault's base currency — set once at vault load
// (Shell effect). A hardcoded '€' mislabelled every figure in a non-EUR vault.
const CUR_SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', UAH: '₴' }
let SYM = '€'
export function setBaseCurrencySymbol(code: string): void {
  const c = code.toUpperCase()
  SYM = CUR_SYM[c] ?? `${c} `
}

/**
 * The active base-currency symbol, for the handful of places that build a money string
 * without going through `fmt` — chart titles ("Yearly spending — €") and hardcoded axis
 * floors. Every one of those read '€' literally and was wrong in a non-EUR vault.
 */
export function curSym(): string {
  return SYM
}

/** '€1,234' / '−€12.40'; dec=true keeps two decimals (BRIEF §13.2). */
export function fmt(n: number, dec = false): string {
  const v = Math.abs(n)
  const s =
    SYM +
    v.toLocaleString('en-US', {
      minimumFractionDigits: dec ? 2 : 0,
      maximumFractionDigits: dec ? 2 : 0,
    })
  return (n < 0 ? '−' : '') + s
}

/**
 * '€86k' / '€4.8k' axis-tick format. Below €1k it falls back to whole units —
 * rounding to 'k' there collapses a small scale into a column of '€0k'.
 */
export function fmtK(v: number): string {
  if (Math.abs(v) < 1000) return fmt(v)
  const k = Math.round(v / 100) / 10
  return SYM + (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'k'
}

/** '+€310' / '−€540' net format. */
export function netLbl(n: number): string {
  return (n >= 0 ? '+' : '−') + SYM + Math.abs(Math.round(n)).toLocaleString('en-US')
}
