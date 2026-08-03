// Help preferences — which screen intros this device has dismissed.
//
// localStorage, NOT the vault, and the reason matters. The vault is the synced financial
// record: `Settings.recurringDismissed` lives there because it encodes a decision ABOUT THE
// DATA ("this merchant is not a subscription"). "I have read the Compare intro" is not data
// about money. Putting it in the vault would cost a mutation → dirty → autosave → sync push
// → possibly a merge note, to dismiss a hint.
//
// Per-device is also the correct semantics: a new browser, or a second device, deserves the
// intro again. Precedent is unanimous — THEME_KEY, DASH_ORDER_KEY.
//
// Pure functions are kept separate from storage IO so they can be tested under the node
// vitest environment, exactly as dashOrder.ts does.

export const HELP_KEY = 'ledger.help'

export interface HelpPrefs {
  /** Screen ids whose intro strip has been dismissed on this device. */
  introDismissed?: string[]
  /**
   * Trip candidates the user has rejected, by `candidateKey`. Here rather than in the vault for
   * the reason above: "this suggestion is wrong" is a hint about a *guess*, not a decision about
   * the data — nothing was created to decide about. Vaulting it would cost a mutation → dirty →
   * autosave → sync push → possible merge note, plus a schema field and a migration.
   */
  dismissedTripCandidates?: string[]
}

/**
 * Identity of a detected candidate, for remembering a rejection.
 *
 * Deliberately the window plus currency, not a hash of the rows: an import that adds one more row
 * to a candidate shifts its bounds and it resurfaces once. Accepting that is better than the
 * fuzzy matching required to avoid it.
 */
export function candidateKey(c: { dateFrom: string; dateTo: string; currency: string }): string {
  return `${c.dateFrom}|${c.dateTo}|${c.currency}`
}

export function isCandidateDismissed(prefs: HelpPrefs, key: string): boolean {
  return (prefs.dismissedTripCandidates ?? []).includes(key)
}

export function dismissCandidate(prefs: HelpPrefs, key: string): HelpPrefs {
  if (isCandidateDismissed(prefs, key)) return prefs
  return { ...prefs, dismissedTripCandidates: [...(prefs.dismissedTripCandidates ?? []), key] }
}

export function isDismissed(prefs: HelpPrefs, id: string): boolean {
  return (prefs.introDismissed ?? []).includes(id)
}

export function dismiss(prefs: HelpPrefs, id: string): HelpPrefs {
  if (isDismissed(prefs, id)) return prefs
  return { ...prefs, introDismissed: [...(prefs.introDismissed ?? []), id] }
}

/** Bring every intro back — the "Show screen intros again" action in Settings. */
export function resetIntros(prefs: HelpPrefs): HelpPrefs {
  return { ...prefs, introDismissed: [] }
}

export function loadHelp(): HelpPrefs {
  try {
    const raw = localStorage.getItem(HELP_KEY)
    return raw ? (JSON.parse(raw) as HelpPrefs) : {}
  } catch {
    return {}
  }
}

/**
 * Every screen pane stays mounted (the shell toggles `display`, so scroll position survives),
 * which means a ScreenIntro never remounts to re-read storage. Settings broadcasts instead.
 */
export const HELP_RESET_EVENT = 'ledger:help-reset'

export function saveHelp(prefs: HelpPrefs): void {
  try {
    localStorage.setItem(HELP_KEY, JSON.stringify(prefs))
  } catch {
    // storage full/blocked — a dismissed hint is best-effort
  }
}
