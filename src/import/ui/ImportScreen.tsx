import { useNarrow } from '../../ui/responsive'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, Rule, Tracking, Transaction, Vault } from '../../model/types'
import { CAT_TRANSFERS } from '../../model/types'
import { now, nowDate, uuidv7 } from '../../model/clock'
import { useRawVault, useStore } from '../../ui/store'
import { useView } from '../../ui/view'
import { ACCENT, BRICK, CAT_PALETTE, FAINT, GREEN, HAIR, HAIR2, INK, MONO, MUT, SURFACE, SURFACE2, WARNBG, AMBER, CHIP, fmt } from '../../ui/theme'
import { MENU_MAX, btnOutline, noRoomBelow, phoneMenu } from '../../ui/styles'
import { planImport, fileFromBrowser } from './importClient'
import { planToOp, type ImportChoices } from '../pipeline'
import { adapterById, registry } from '../registry'
import { isRefusal, type ImportPlan, type PlannedRow, type Refusal, type RowDecision, type SourceFile } from '../types'
import { evaluateRules, matchesRule, mintLearnedRule, ruleKeyLabel } from '../rules'
import { lookupQuery } from '../lookup'
import { FilterChip, LookupLinks, MenuItem } from '../../ui/kit'
import { ASSIST_BATCH, ASSIST_RETRY_BATCH, assistCategorize, assistCost, assistKey, type AssistResultRow } from '../assist'
import { presetFor } from '../providers'
import { inWindow } from '../../model/trackings'
import { TripPicker, type PickerTrip } from '../../ui/TripPicker'
import { detectTrips, type TripCandidate } from '../../analytics/tripDetect'
import { TRIP_MERCHANT_CAP, assistRefineTripName } from '../assistTrips'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A statement can cover any year — an old export lists `2 Jan` rows that are years back — and
 * the review table has no year separators, so a bare day+month is ambiguous. Carry the year
 * only when it is not the current one, matching the transactions list (§TransactionsScreen).
 */
const shortDate = (d: string, currentYear: number) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}${Number(d.slice(0, 4)) === currentYear ? '' : ` ${d.slice(2, 4)}`}`

/** Width of the date column — fits `27 Jul 23`, the widest form above. */
const DATE_W = 62

interface CatInfo {
  name: string
  color: string
}

/** Rows the rule ladder left at `Other` — the only rows the assist is ever asked about (§10.6). */
const fallbackRows = (plan: ImportPlan): PlannedRow[] =>
  plan.rows.filter((r) => r.status === 'new' && r.provenance === 'fallback')

// ---------- review list: display-only filter / sort ----------

type ReviewFilter = 'all' | 'review' | 'ai' | 'rule' | 'transfer' | 'history' | 'uncat'

const REVIEW_FILTER_LABEL: Record<ReviewFilter, string> = {
  all: 'All',
  review: 'Needs review',
  ai: 'AI',
  rule: 'By rule',
  transfer: 'Transfer',
  history: 'From history',
  uncat: 'Uncategorized',
}

/**
 * Does a review row match the toolbar's filter? Reuses the exact effective-state logic
 * `ReviewRow` renders from, so a filter and the row's own badge never disagree — a hand
 * decision (`dec`) overrides the row's own provenance the same way it does on screen.
 */
function reviewMatches(r: PlannedRow, dec: RowDecision | undefined, needle: string, f: ReviewFilter, from: string, to: string): boolean {
  if (needle) {
    const n = r.norm
    if (!`${n.merchant} ${n.normDesc} ${n.raw ?? ''}`.toLowerCase().includes(needle)) return false
  }
  if (from && r.norm.bookedDate < from) return false
  if (to && r.norm.bookedDate > to) return false
  switch (f) {
    case 'all': return true
    case 'review': return (r.needsReview && !dec?.categoryId) || (!!r.ambiguous && !dec?.keepAsIncome)
    case 'ai': return r.provenance === 'ai' && !dec?.categoryId
    case 'rule': return r.provenance.startsWith('rule')
    case 'transfer': return !!r.transferGroupId || (dec?.categoryId ?? r.categoryId) === CAT_TRANSFERS
    case 'history': return r.provenance === 'history' && !dec?.categoryId
    case 'uncat': return r.provenance === 'fallback' && !dec?.categoryId
  }
}

/** Fold assist predictions into a plan. ≥0.7 ⇒ auto-categorized with `ai` provenance. */
function mergeAssist(plan: ImportPlan, results: Map<string, AssistResultRow>): ImportPlan {
  if (results.size === 0) return plan
  const rows = plan.rows.map((r) => {
    if (r.status !== 'new' || r.provenance !== 'fallback') return r
    const hit = results.get(assistKey(r.norm))
    if (!hit) return r
    return { ...r, categoryId: hit.categoryId, provenance: 'ai' as const, aiConfidence: hit.confidence, needsReview: !hit.auto }
  })
  const newRows = rows.filter((r) => r.status === 'new')
  return {
    ...plan,
    rows,
    counts: {
      ...plan.counts,
      autoCategorized: newRows.filter((r) => r.provenance !== 'fallback' && !r.needsReview).length,
      needReview: newRows.filter((r) => r.needsReview).length,
    },
  }
}

/** Per-batch deadline. Local models generate slowly; a free hosted tier queues. */
const assistTimeout = (provider: string): number => (presetFor(provider)?.local ? 300_000 : 180_000)

type AssistRun =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; suggested: number; failed: number; batches: number; retried: boolean; stopped?: boolean }

/**
 * The assist offer (§10.6). States what leaves the device *before* it leaves: how many distinct
 * merchants — not rows — and how many requests that is. Silence used to be the failure mode here,
 * so a run that returns nothing says so rather than looking like a model with no opinion.
 */
function AssistStrip({
  plan,
  configured,
  run,
  onRun,
  onRetry,
  onStop,
}: {
  plan: ImportPlan
  configured: boolean
  run: AssistRun
  onRun: () => void
  onRetry: () => void
  onStop: () => void
}) {
  const pending = fallbackRows(plan)
  if (!configured || (pending.length === 0 && run.state === 'idle')) return null
  const { descriptors, batches } = assistCost(pending.map((r) => r.norm))

  return (
    <div style={{ marginTop: 10 }} data-testid="assist-strip">
      {run.state === 'idle' && descriptors > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="hov-invert" data-testid="assist-run" onClick={onRun} style={btnOutline}>
            Suggest categories with AI
          </button>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
            {pending.length} unmatched {pending.length === 1 ? 'row' : 'rows'} · {descriptors} distinct{' '}
            {descriptors === 1 ? 'merchant' : 'merchants'} sent in {batches} {batches === 1 ? 'request' : 'requests'} ·
            no amounts or dates
          </span>
        </div>
      )}
      {run.state === 'running' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: MUT }} data-testid="assist-progress">
            Asking the model… request {Math.max(1, run.done)} of {run.total}. This can take a few minutes on a free tier.
          </div>
          <button className="hov-invert" data-testid="assist-stop" onClick={onStop} style={btnOutline}>Stop</button>
        </div>
      )}
      {run.state === 'done' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div
            style={{ fontFamily: MONO, fontSize: 10.5, color: run.failed > 0 ? AMBER : run.suggested > 0 ? GREEN : MUT }}
            data-testid="assist-outcome"
          >
            {run.stopped
              ? `Stopped — ${run.suggested} ${run.suggested === 1 ? 'merchant' : 'merchants'} categorized so far.`
              : run.failed > 0
              ? `Smart categorization failed on ${run.failed} of ${run.batches} ${run.batches === 1 ? 'request' : 'requests'} (timeout or provider error) — showing rule results only.`
              : run.suggested > 0
                ? `${run.suggested} ${run.suggested === 1 ? 'merchant' : 'merchants'} categorized by AI — check the ones marked AI before confirming.`
                : 'The model had no confident suggestion for these rows.'}
          </div>
          {/* Retrying the same 80-descriptor request that just timed out would fail the same way, so
              the retry asks in smaller batches — and only about what is still unplaced. */}
          {pending.length > 0 && (
            <button className="hov-invert" data-testid="assist-retry" onClick={onRetry} style={btnOutline}>
              {run.failed > 0 ? `Retry in smaller batches (${assistCost(pending.map((r) => r.norm), ASSIST_RETRY_BATCH).batches})` : 'Ask again'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Trip suggestion (§8): a run of foreign-currency rows the local detector spotted. "Mark these
 * rows" creates the windowed trip and pre-excludes recurring bills inline in the review list;
 * nothing commits until the import is approved.
 */
function TripSuggestStrip({ cand, assistOn, onMark, onRefine, onDismiss }: { cand: TripCandidate; assistOn: boolean; onMark: (cand: TripCandidate, name?: string) => Tracking | null; onRefine: (cand: TripCandidate) => Promise<string | null>; onDismiss: () => void }) {
  const [name, setName] = useState(cand.name)
  const [busy, setBusy] = useState(false)
  const currentYear = nowDate().getFullYear()
  const sentMerchants = Math.min(cand.txnIds.length, TRIP_MERCHANT_CAP)
  const improve = async () => {
    setBusy(true)
    const better = await onRefine(cand)
    if (better) setName(better)
    setBusy(false)
  }
  return (
    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="trip-suggest">
      <span style={{ fontSize: 13, color: INK, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        ✈️ Looks like a trip:
        <input
          data-testid="trip-suggest-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          title="Trip name — edit it, or seed it from the detected currency / AI"
          style={{ fontSize: 13, fontWeight: 600, color: INK, background: 'transparent', border: 'none', borderBottom: `1px dashed ${HAIR}`, padding: '1px 2px', width: `${Math.max(8, name.length + 1)}ch`, minWidth: 60 }}
        />
      </span>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
        {shortDate(cand.dateFrom, currentYear)} – {shortDate(cand.dateTo, currentYear)} · {cand.count} {cand.currency} payments · {fmt(cand.total)}
      </span>
      <button className="hov-invert" data-testid="trip-mark" onClick={() => onMark(cand, name.trim() || cand.name)} style={btnOutline}>Mark these rows</button>
      {assistOn && (
        <>
          <button data-testid="trip-improve" onClick={() => void improve()} disabled={busy} style={{ fontFamily: MONO, fontSize: 10.5, color: busy ? FAINT : ACCENT, background: 'none', border: 'none', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Asking AI…' : 'Improve name with AI'}
          </button>
          {/* Unlike categorization, this request carries dates and unredacted merchants — so it says so
              before you press it (ASSIST §2: consent is per-payload, not per-toggle). */}
          <span data-testid="trip-improve-cost" style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>
            sends the trip dates and {sentMerchants} merchant {sentMerchants === 1 ? 'name' : 'names'} · no amounts
          </span>
        </>
      )}
      <button data-testid="trip-dismiss" onClick={onDismiss} style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, background: 'none', border: 'none', cursor: 'pointer' }}>Dismiss</button>
    </div>
  )
}

export function ImportScreen() {
  const currentYear = nowDate().getFullYear()
  const store = useStore()
  // RAW, deliberately: identity resolution (fingerprint/matchKeys), ring-1 dedupe, the
  // overlap check and transfer pairing must all see hidden accounts, or a re-import mints
  // a ghost account (§5.8) and re-adds rows it should recognize as duplicates.
  const vault = useRawVault()
  const view = useView()

  const [queue, setQueue] = useState<SourceFile[]>([])
  const [active, setActive] = useState<SourceFile | null>(null)
  const [choices, setChoices] = useState<ImportChoices>({})
  const [plan, setPlan] = useState<ImportPlan | Refusal | null>(null)
  const [busy, setBusy] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({})
  const [learned, setLearned] = useState<Rule[]>([])
  // The strip under one row: either the §10.3 *Always* offer, or — when the pick contradicts the
  // row's direction (#19) — the note that says so instead of an offer to generalize it.
  const [always, setAlways] = useState<{ hash: string; categoryName: string; keyLabel: string; ruleValue: string; polarity?: boolean } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [changeAcct, setChangeAcct] = useState(false)
  const [tripTags, setTripTags] = useState<{ hash: string; trackingId: string; dir: 'include' | 'exclude' }[]>([])
  const [dismissedTrips, setDismissedTrips] = useState<Set<string>>(new Set())
  const [backfill, setBackfill] = useState<{ hash: string; ids: string[]; categoryId: string; categoryName: string } | null>(null)
  const [assistRun, setAssistRun] = useState<AssistRun>({ state: 'idle' })
  // Hides the §10.4 starter-pack offer once it has been answered this session — a local
  // toggle so declining costs nothing, versus a `choices` change that re-plans the whole file.
  const [starterDismissed, setStarterDismissed] = useState(false)
  const reqId = useRef(0)
  const assistAbort = useRef<AbortController | null>(null)
  // Cached AI predictions, keyed by merchant tuple (account-independent). Changing the account
  // (rename/switch) re-plans the whole file; without this cache the assist results merged into the
  // plan would be discarded — forcing a costly, slow re-run. Cleared only when the file changes.
  const assistResults = useRef<Map<string, AssistResultRow> | null>(null)
  const prevActive = useRef<SourceFile | null>(null)

  /**
   * §10.6, on approval only: ask the configured model about the rows nothing else could place.
   * A retry re-asks about **what is still unplaced** — rows the first run categorized are not paid
   * for twice — and in smaller batches, since a batch that timed out will time out again at the
   * same size.
   */
  const runAssist = async (p: ImportPlan, retry = false) => {
    const rows = fallbackRows(p).map((r) => r.norm)
    if (rows.length === 0) return
    const batchSize = retry ? ASSIST_RETRY_BATCH : ASSIST_BATCH
    const { batches } = assistCost(rows, batchSize)
    const ac = new AbortController()
    assistAbort.current = ac
    setAssistRun({ state: 'running', done: 0, total: batches })
    const outcome = await assistCategorize(rows, vault.categories, vault.settings, {
      timeoutMs: assistTimeout(vault.settings.assist?.provider ?? ''),
      batchSize,
      signal: ac.signal,
      onProgress: (done, total) => setAssistRun({ state: 'running', done, total }),
    })
    assistAbort.current = null
    // Accumulate across runs/retries and cache, so a later re-plan (account change) re-applies
    // these without paying the model again. Whatever batches returned before a Stop are kept.
    const prev = assistResults.current
    const acc = prev ? new Map([...prev, ...outcome.results]) : outcome.results
    if (acc.size) assistResults.current = acc
    setPlan((cur) => (cur && !isRefusal(cur) && assistResults.current ? mergeAssist(cur, assistResults.current) : cur))
    setAssistRun({
      state: 'done',
      suggested: outcome.results.size,
      failed: outcome.failed,
      batches: outcome.batches,
      retried: retry,
      stopped: ac.signal.aborted,
    })
  }

  const catById = useMemo(() => {
    const m = new Map<string, CatInfo>()
    for (const c of vault.categories) m.set(c.id, { name: c.name, color: c.color })
    return m
  }, [vault.categories])
  const pickCats = vault.categories.filter((c) => c.id !== CAT_TRANSFERS)
  // Offered apart from the ordinary categories (§9.4): a row the pairing pass could not
  // prove internal — an FX leg, a move to an account outside the vault — is still the
  // user's to call, and an “Always” rule then keeps it out of cash-flow on every import.
  const transfersCat = vault.categories.find((c) => c.id === CAT_TRANSFERS)

  /**
   * §10.3 within the batch: a rule minted by “Always” also applies to the rows still
   * on screen — including ones the assist already guessed (`provenance: 'ai'`), since an
   * explicit user rule outranks an AI guess. A this-session hand decision (`decisions`),
   * a paired transfer and an ambiguous row all keep what they have.
   */
  const viewPlan: ImportPlan | null = useMemo(() => {
    if (!plan || isRefusal(plan)) return null
    if (learned.length === 0) return plan
    const rows = plan.rows.map((r): PlannedRow => {
      if (r.status !== 'new' || (r.provenance !== 'fallback' && r.provenance !== 'ai') || r.transferGroupId || r.ambiguous || decisions[r.hash]) return r
      const hit = evaluateRules(r.norm, learned)
      if (!hit) return r
      return { ...r, categoryId: hit.categoryId, provenance: `rule:${hit.ruleId}`, needsReview: false }
    })
    const newRows = rows.filter((r) => r.status === 'new')
    return {
      ...plan,
      rows,
      counts: {
        ...plan.counts,
        autoCategorized: newRows.filter((r) => r.provenance !== 'fallback' && !r.needsReview).length,
        needReview: newRows.filter((r) => r.needsReview).length,
      },
    }
  }, [plan, learned, decisions])

  // (Re)build the plan when the active file or an account/starter/proceed choice changes.
  useEffect(() => {
    if (!active) {
      setPlan(null)
      return
    }
    // A `choices` change (account rename/switch, starter, proceed) re-plans the SAME file — the AI
    // work must survive it. Only a genuinely new file clears the cache and resets the outcome line.
    const newFile = active !== prevActive.current
    prevActive.current = active
    if (newFile) assistResults.current = null
    const id = ++reqId.current
    setBusy(true)
    // The plan is shown the moment it exists. The assist is a separate, opt-in step (§10.6): it is
    // network-bound and can take minutes on a free tier, and holding the review list hostage to it
    // meant an empty screen with no explanation — the whole point of the ladder is that rules and
    // transfers already produced a usable result.
    void planImport(active, vault, choices)
      .then((p) => {
        if (id !== reqId.current) return
        // Re-apply cached AI predictions so re-planning (e.g. after an account change) never
        // discards the model's work — it is keyed by merchant tuple, so it carries over.
        setPlan(!isRefusal(p) && assistResults.current ? mergeAssist(p, assistResults.current) : p)
        if (newFile) setAssistRun({ state: 'idle' })
        setBusy(false)
      })
      .catch(() => {
        // planImport maps known parse failures to refusals; this only fires on an
        // unexpected throw. Surface it instead of leaving `busy` stuck on the skeleton.
        if (id !== reqId.current) return
        setPlan({ refusal: 'unreadable', message: "Couldn't read this file — it may be corrupt or in an unexpected format." })
        if (newFile) setAssistRun({ state: 'idle' })
        setBusy(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, choices])

  const reset = () => {
    assistAbort.current?.abort() // stop any in-flight assist before the review is torn down
    assistResults.current = null // a fresh import starts with no cached AI predictions
    setChoices({})
    setDecisions({})
    setLearned([])
    setAlways(null)
    setMenuFor(null)
    setChangeAcct(false)
    setTripTags([])
    setDismissedTrips(new Set())
    setBackfill(null)
    setStarterDismissed(false)
  }

  // All non-archived trips — offered on every row (pick an existing one or create a new one),
  // not just the ones whose window already contains the row's date.
  const allTrips: PickerTrip[] = useMemo(
    () => vault.trackings.filter((t) => t.kind === 'trip' && !t.archived).map((t) => ({ id: t.id, name: t.name, color: t.color })),
    [vault.trackings],
  )
  const trackingById = useMemo(() => new Map(vault.trackings.map((t) => [t.id, t])), [vault.trackings])

  // A row's membership of a trip, given the pending tags: in-window rows are members unless an
  // exclude tag removes them; out-of-window rows are members only with an include tag.
  const tripStateFor = (hash: string, date: string, trackingId: string): 'member' | 'excluded' | 'out' => {
    const tr = trackingById.get(trackingId)
    if (!tr) return 'out'
    const tag = tripTags.find((t) => t.hash === hash && t.trackingId === trackingId)
    if (inWindow(date, tr)) return tag?.dir === 'exclude' ? 'excluded' : 'member'
    return tag?.dir === 'include' ? 'member' : 'out'
  }
  // One tap cycles member ⇄ off, recording the right direction relative to the window.
  const toggleTrip = (hash: string, date: string, trackingId: string) => {
    const tr = trackingById.get(trackingId)
    if (!tr) return
    const win = inWindow(date, tr)
    const st = tripStateFor(hash, date, trackingId)
    setTripTags((tags) => {
      const without = tags.filter((t) => !(t.hash === hash && t.trackingId === trackingId))
      if (st === 'member') return win ? [...without, { hash, trackingId, dir: 'exclude' }] : without
      return win ? without : [...without, { hash, trackingId, dir: 'include' }]
    })
  }
  // Trips to render as chips for a row: those it is a member of or explicitly excluded from.
  const rowTripChips = (hash: string, date: string) =>
    allTrips
      .map((t) => ({ ...t, state: tripStateFor(hash, date, t.id) }))
      .filter((t): t is PickerTrip & { state: 'member' | 'excluded' } => t.state !== 'out')

  const onFiles = (files: SourceFile[]) => {
    if (files.length === 0) return
    reset()
    setActive(files[0]!)
    setQueue(files.slice(1))
  }

  const advance = () => {
    // A file can carry several accounts (§5.8) — review them one after another
    // before moving on to the next file. `reset()` clears choices first, so the
    // group has to be re-set after it.
    const p = plan && !isRefusal(plan) ? plan : null
    const nextGroup = p ? p.groups[p.groups.findIndex((g) => g.key === p.groupKey) + 1] : undefined
    reset()
    if (nextGroup) {
      setChoices({ group: nextGroup.key })
      return
    }
    const next = queue[0]
    setActive(next ?? null)
    setQueue(queue.slice(1))
    if (!next) view.goTab('txns')
  }

  const cancel = () => {
    setActive(null)
    setQueue([])
    reset()
    view.goTab('txns')
  }

  const confirm = (p: ImportPlan) => {
    if (p.account.mode === 'choose') return // must resolve the account first (no-op otherwise)
    const applyImportOp = planToOp(p, Object.values(decisions), tripTags)
    if (learned.length) applyImportOp.newRules = [...(applyImportOp.newRules ?? []), ...learned]
    // §10.4: the offer is one-time. It was never actually persisted — the flag is written nowhere —
    // so it re-qualified on every French import and survived reloads. Committing the import that
    // showed it records the answer, in one undoable step with the import itself.
    const op =
      p.starterPackOffer && !vault.settings.starterPackOffered
        ? { kind: 'batch' as const, ops: [applyImportOp, { kind: 'setSingletonField' as const, collection: 'settings' as const, field: 'starterPackOffered', value: true }] }
        : applyImportOp
    const msg = applyImportOp.txns.length === 0
      ? `Statement balances recorded from ${p.statement.fileName}`
      : `${applyImportOp.txns.length} transaction${applyImportOp.txns.length === 1 ? '' : 's'} imported from ${p.statement.fileName}`
    store.commit(op, { msg, undoable: true })
    advance()
  }

  const recategorize = (row: PlannedRow, cat: Category) => {
    setDecisions((d) => ({ ...d, [row.hash]: { ...d[row.hash], hash: row.hash, categoryId: cat.id } }))
    setMenuFor(null)
    // #19: the pick itself always stands — one row is the user's call. What is refused is
    // GENERALIZING a contradiction: Income is money in, so an outflow filed there teaches a rule
    // that would re-assert income on every future outflow of that counterparty. The reverse
    // (a positive in an expense category) is the legitimate refund of §5.4 and says nothing.
    if (cat.role === 'income' && row.norm.amountMinor < 0) {
      setAlways({ hash: row.hash, categoryName: cat.name, keyLabel: '', ruleValue: '', polarity: true })
      return
    }
    const rule = mintLearnedRule(row.norm, cat.id)
    if (rule) setAlways({ hash: row.hash, categoryName: cat.name, keyLabel: ruleKeyLabel(rule), ruleValue: rule.match.value })
  }

  const acceptAlways = () => {
    if (!always) return
    const row = active && plan && !isRefusal(plan) ? plan.rows.find((r) => r.hash === always.hash) : undefined
    const dec = decisions[always.hash]
    if (row && dec?.categoryId) {
      const rule = mintLearnedRule(row.norm, dec.categoryId)
      if (rule) {
        setLearned((ls) => [...ls.filter((l) => l.match.value !== rule.match.value), rule])
        // §10.3 step 3: the rule speaks for rows already in the vault too. Transfers are
        // never recategorized — a paired leg belongs to Transfers by construction.
        const ids = vault.transactions
          .filter((t) => t.categoryId !== dec.categoryId && !t.transferGroupId && t.categoryId !== CAT_TRANSFERS && matchesRule(t, rule))
          .map((t) => t.id)
        if (ids.length > 0) {
          setBackfill({ hash: always.hash, ids, categoryId: dec.categoryId, categoryName: always.categoryName })
        }
      }
    }
    setAlways(null)
  }

  const applyBackfill = () => {
    if (!backfill) return
    const n = backfill.ids.length
    store.commit(
      { kind: 'recategorizeBatch', txnIds: backfill.ids, categoryId: backfill.categoryId },
      { msg: `${n} existing transaction${n === 1 ? '' : 's'} moved to ${backfill.categoryName}`, undoable: true },
    )
    setBackfill(null)
  }

  /** Inline “new category” from the picker — same mint-and-restore shape as Settings. */
  const createCategory = (raw: string): Category | null => {
    const name = raw.trim()
    if (!name || vault.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return null
    const cat: Category = { id: uuidv7(), updatedAt: now(), name, color: CAT_PALETTE[vault.categories.length % CAT_PALETTE.length]! }
    store.commit({ kind: 'restore', collection: 'categories', records: [cat] }, { msg: `Category “${name}” added`, undoable: true })
    return cat
  }

  /**
   * Inline “new trip” from the review row. The id is minted here rather than inside
   * `addTracking` because the row is tagged with it in the same gesture.
   */
  const createTrip = (raw: string, date: string): Tracking | null => {
    const name = raw.trim() || `Trip · ${shortDate(date, currentYear)}`
    const color = CAT_PALETTE[vault.trackings.length % CAT_PALETTE.length]!
    const tracking: Tracking = { id: uuidv7(), updatedAt: now(), name, kind: 'trip', color, dateFrom: date, dateTo: date }
    store.commit({ kind: 'restore', collection: 'trackings', records: [tracking] }, { msg: `Trip “${name}” created`, undoable: true })
    return tracking
  }

  // Local trip detection over the batch: a run of foreign-currency rows close in time (§8, the
  // Iceland case). Offered as a strip; nothing is written until the user marks the rows and
  // approves the import.
  const detected: TripCandidate[] = useMemo(() => {
    if (!viewPlan) return []
    const rows = viewPlan.rows.filter((r) => r.status === 'new')
    return detectTrips(
      rows.map((r) => ({ id: r.hash, date: r.norm.bookedDate, amount: r.norm.amountMinor / 100, currency: r.norm.original?.currency, merchant: r.norm.merchant })),
      { home: viewPlan.account.currency },
    ).filter((c) => !dismissedTrips.has(`${c.dateFrom}|${c.currency}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPlan, dismissedTrips])

  /**
   * "Mark these rows": create the trip over the detected window, but mark ONLY the detected
   * foreign-currency rows. Every other in-window row (a home Decathlon run that happens to fall in
   * the dates) is excluded by default — the window is kept for display, but nothing unrelated is
   * swept in. The user can include any excluded row with one tap on its (hollow) chip. Reuses a
   * same-named trip instead of minting a second one, so re-marking never duplicates.
   */
  const markTrip = (cand: TripCandidate, name = cand.name): Tracking | null => {
    if (!viewPlan) return null
    const existing = vault.trackings.find((t) => t.kind === 'trip' && !t.archived && t.name.toLowerCase() === name.toLowerCase())
    const tracking: Tracking = existing ?? { id: uuidv7(), updatedAt: now(), name, kind: 'trip', color: CAT_PALETTE[vault.trackings.length % CAT_PALETTE.length]!, dateFrom: cand.dateFrom, dateTo: cand.dateTo }
    if (!existing) store.commit({ kind: 'restore', collection: 'trackings', records: [tracking] }, { msg: `Trip “${name}” created`, undoable: true })
    const detected = new Set(cand.txnIds)
    type Tag = { hash: string; trackingId: string; dir: 'include' | 'exclude' }
    // Detected rows are members (include if the window doesn't already cover them); every other
    // in-window row is excluded so only the detected spend is marked.
    const tags = viewPlan.rows
      .filter((r) => r.status === 'new')
      .flatMap((r): Tag[] => {
        const inWin = inWindow(r.norm.bookedDate, tracking)
        if (detected.has(r.hash)) return inWin ? [] : [{ hash: r.hash, trackingId: tracking.id, dir: 'include' }]
        return inWin ? [{ hash: r.hash, trackingId: tracking.id, dir: 'exclude' }] : []
      })
    setTripTags((cur) => [...cur.filter((t) => t.trackingId !== tracking.id), ...tags])
    setDismissedTrips((s) => new Set(s).add(`${cand.dateFrom}|${cand.currency}`))
    return tracking
  }

  // Optional: sharpen a candidate's name with the model (city-level). Sends merchants + dates.
  const refineTrip = async (cand: TripCandidate): Promise<string | null> => {
    if (!viewPlan) return null
    const byHash = new Map(viewPlan.rows.map((r) => [r.hash, r.norm.merchant]))
    const merchants = cand.txnIds.map((h) => byHash.get(h)).filter((m): m is string => !!m)
    return assistRefineTripName({ currency: cand.currency, dateFrom: cand.dateFrom, dateTo: cand.dateTo, merchants }, vault.settings, { timeoutMs: 60_000 })
  }

  // ---- render ----
  if (!active) return <DropStep onFiles={onFiles} />

  return (
    <div data-screen="import" style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Import transactions</h1>
          <div style={{ fontSize: 13, color: FAINT, marginTop: 2 }}>Review before committing — nothing is saved until you confirm.</div>
        </div>
        <button data-testid="import-cancel" onClick={cancel} aria-label="Cancel" style={{ width: 30, height: 30, border: `1px solid ${HAIR}`, borderRadius: 6, color: MUT, background: 'transparent', cursor: 'pointer' }}>
          ✕
        </button>
      </div>

      {busy && <SkeletonReview />}

      {!busy && plan && isRefusal(plan) && (
        <RefusalCard refusal={plan} onProceed={() => setChoices((c) => ({ ...c, proceedAlreadyImported: true }))} onPickInstitution={(inst) => setChoices((c) => ({ ...c, institution: inst }))} onCancel={cancel} />
      )}

      {!busy && viewPlan && (
        <>
          {/* Shown for every plan, including `existing`. A resolved account — auto-bound by RIB
              or picked by hand — is precisely when you want to see where 134 rows are about to
              land; hiding the card there left the screen silent about the destination. */}
          <MappingCard
            plan={viewPlan}
            vault={vault}
            open={changeAcct}
            setOpen={setChangeAcct}
            onChoose={(accountId, name) => {
              setChoices((c) => ({ ...c, accountId, name }))
              setChangeAcct(false)
            }}
          />

          {viewPlan.starterPackOffer && !starterDismissed && !choices.installStarterPack && (
            <section style={{ border: `1px dashed ${HAIR}`, borderRadius: 6, padding: '13px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 14 }} data-testid="starter-offer">
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: INK }}>Install starter rules for French banks?</div>
                <div style={{ fontSize: 12, color: FAINT, marginTop: 2 }}>Seed rules and categories — every one visible and deletable in Settings.</div>
              </div>
              {/* Declining just hides the card — no `choices` change, so the file is not re-planned. */}
              <button onClick={() => setStarterDismissed(true)} style={pill(false)}>Not now</button>
              {/* Installing re-plans so the seed rules categorize the rows on screen; the card then hides. */}
              <button data-testid="starter-install" onClick={() => setChoices((c) => ({ ...c, installStarterPack: true }))} style={pill(true)}>Install</button>
            </section>
          )}

          <ReviewList
            plan={viewPlan}
            vault={vault}
            catById={catById}
            pickCats={pickCats}
            transfersCat={transfersCat}
            decisions={decisions}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            recategorize={recategorize}
            onCreateCategory={createCategory}
            always={always}
            acceptAlways={acceptAlways}
            dismissAlways={() => setAlways(null)}
            backfill={backfill}
            applyBackfill={applyBackfill}
            dismissBackfill={() => setBackfill(null)}
            onKeepIncome={(hash) => setDecisions((d) => ({ ...d, [hash]: { ...d[hash], hash, keepAsIncome: true } }))}
            onKeepAnyway={(hash) => setDecisions((d) => ({ ...d, [hash]: { ...d[hash], hash, keepAnyway: !d[hash]?.keepAnyway } }))}
            allTrips={allTrips}
            rowTripChips={rowTripChips}
            tripStateFor={tripStateFor}
            onToggleTrip={toggleTrip}
            onCreateTrip={createTrip}
            detected={detected}
            onMarkTrip={markTrip}
            onRefineTrip={refineTrip}
            onDismissTrip={(c) => setDismissedTrips((s) => new Set(s).add(`${c.dateFrom}|${c.currency}`))}
            onConfirm={() => confirm(viewPlan)}
            assistConfigured={!!vault.settings.assist}
            assistRun={assistRun}
            onRunAssist={() => void runAssist(viewPlan)}
            onRetryAssist={() => void runAssist(viewPlan, true)}
            onStopAssist={() => assistAbort.current?.abort()}
          />
        </>
      )}
    </div>
  )
}

// ---------- drop step ----------
function DropStep({ onFiles }: { onFiles: (f: SourceFile[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  const handle = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const arr = [...files].sort((a, b) => a.name.localeCompare(b.name))
    const sources = await Promise.all(arr.map(async (f) => fileFromBrowser(f.name, new Uint8Array(await f.arrayBuffer()))))
    onFiles(sources)
  }

  return (
    <div data-screen="import" style={{ maxWidth: 640, margin: '10px auto 0' }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', color: INK }}>Import transactions</h1>
      <div style={{ fontSize: 13, color: FAINT, margin: '2px 0 18px' }}>Statement files stay on this device — parsed, deduplicated, and categorized locally.</div>
      <div
        data-testid="dropzone"
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        style={{ border: `1.5px dashed ${drag ? INK : HAIR}`, borderRadius: 8, padding: '48px 26px', textAlign: 'center', cursor: 'pointer', background: drag ? CHIP : 'transparent' }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, color: INK }}>Drop a bank export here</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.08em', color: FAINT, marginTop: 8 }}>CSV · XLS/XLSX · PDF STATEMENT</div>
        <button data-testid="browse-files" onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }} style={{ ...btnOutline, marginTop: 16 }}>Browse files</button>
        <input ref={inputRef} data-testid="import-file" type="file" multiple accept=".csv,.tsv,.xls,.xlsx,.pdf" style={{ display: 'none' }} onChange={(e) => void handle(e.target.files)} />
      </div>
      <div style={{ fontSize: 11.5, color: FAINT, marginTop: 12, textAlign: 'center' }}>
        Dates, amounts, and merchants are detected automatically; categories are predicted from your history. Duplicates are skipped.
      </div>
    </div>
  )
}

// ---------- mapping card ----------
function MappingCard({ plan, vault, open, setOpen, onChoose }: { plan: ImportPlan; vault: Vault; open: boolean; setOpen: (b: boolean) => void; onChoose: (accountId: string | 'new' | `adopt:${string}`, name?: string) => void }) {
  const currentYear = nowDate().getFullYear()
  const inst = plan.account.institutionId.toUpperCase().slice(0, 3)
  const facts = `${adapterById(plan.parsed.institution)?.displayName ?? plan.parsed.institution} · ${plan.account.currency}`
  const sub = `${plan.parsed.fingerprint ?? 'no account key'} · ${plan.counts.total} rows · ${shortDate(plan.parsed.periodFrom, currentYear)} – ${shortDate(plan.parsed.periodTo, currentYear)}`
  const [name, setName] = useState(plan.account.suggestedName)
  // Once an account is actually bound, its own name is the truth — `suggestedName` is derived
  // from the FILE and can differ (a Livret A file suggests `BNP Durand Livret A` while the
  // account it binds to may be named anything). Showing the suggestion would name the wrong place.
  const bound = plan.account.accountId ? vault.accounts.find((a) => a.id === plan.account.accountId) : undefined
  const mapsTo = bound?.name ?? plan.account.suggestedName
  const suggested = plan.account.candidates.find((c) => c.reason === 'signal' && c.preselect) ?? plan.account.candidates.find((c) => c.reason === 'signal')
  const confirming = plan.account.mode === 'confirm' && suggested
  // A no-signal file: force the choice menu open and block until the user names it or picks an
  // existing account — never let it silently create a generic ghost.
  const mustName = !!plan.account.mustName
  const menuOpen = open || mustName
  return (
    <section data-testid="mapping-card" style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: '16px 18px', marginBottom: 12 }}>
      {mustName && (
        <div data-testid="must-name" style={{ marginBottom: 12, padding: '11px 14px', background: WARNBG, borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: INK }}>
            Couldn’t identify this account — the file carries no RIB, last-4, or holder name.
          </div>
          <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>
            Pick the existing account it belongs to, or name a new one below — so its rows merge with what’s already there instead of starting a separate account.
          </div>
        </div>
      )}
      {confirming && (
        <div data-testid="confirm-account" style={{ marginBottom: 12, padding: '11px 14px', background: WARNBG, borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: INK }}>
            Looks like <b>{suggested!.name}</b>
            {suggested!.signal ? <> — matched on <span style={{ fontFamily: MONO }}>{suggested!.signal}</span></> : null}. Is this the same account?
          </div>
          <div style={{ fontSize: 11.5, color: FAINT, marginTop: 3 }}>A last-4 or name is a hint, not proof — confirm so its rows merge with what’s already there.</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
            <button data-testid="confirm-account-yes" onClick={() => onChoose(suggested!.accountId)} style={pill(true)}>Yes, this account</button>
            <button data-testid="confirm-account-no" onClick={() => setOpen(true)} style={pill(false)}>No — choose or create</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 8, background: CHIP, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 600, color: MUT, flex: 'none' }}>{inst}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{facts}</div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.04em' }}>MAPS TO</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
            <span data-testid="maps-to" style={{ fontSize: 13, fontWeight: 600, background: CHIP, borderRadius: 5, padding: '5px 11px', color: INK }}>{mapsTo}</span>
            <button data-testid="mapping-change" onClick={() => setOpen(!open)} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer' }}>Change</button>
          </div>
        </div>
      </div>
      {menuOpen && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${HAIR2}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="mapping-menu">
          {plan.account.candidates.map((c) => (
            <button key={c.accountId} onClick={() => onChoose(c.reason === 'adopt' ? `adopt:${c.accountId}` : c.accountId)} style={rowBtn}>
              {c.name}{' '}
              <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>
                {c.reason === 'adopt' ? 'link to existing' : c.reason === 'signal' ? `matched on ${c.signal ?? 'signal'}` : c.reason === 'pick' ? 'existing account' : 'account key match'}
              </span>
            </button>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="new-account-name" style={{ flex: 1, height: 30, border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, padding: '0 8px', fontSize: 12.5, color: INK }} />
            <button data-testid="create-account" onClick={() => onChoose('new', name)} style={pill(true)}>Create new account</button>
          </div>
        </div>
      )}
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 11, paddingTop: 11, borderTop: `1px solid ${HAIR2}` }}>
        {bound
          ? `Existing account · rows merge into ${bound.name}`
          : plan.parsed.institution === 'bnp'
            ? `Matched by RIB · holder line → ${plan.account.suggestedName}`
            : plan.parsed.institution === 'privat'
              ? `Matched by card + currency → ${plan.account.suggestedName}`
              : plan.parsed.institution === 'pumb'
                ? `Matched by IBAN · holder line → ${plan.account.suggestedName}`
                : plan.parsed.institution === 'monobank'
                  ? 'No account key in the file · choose where these rows go'
                  : `Matched by product + currency → ${plan.account.suggestedName}`}
        {vault.accounts.length === 0 && ' · first import creates the account'}
      </div>
    </section>
  )
}

// ---------- review list ----------
function ReviewList(props: {
  plan: ImportPlan
  vault: Vault
  catById: Map<string, CatInfo>
  pickCats: Category[]
  transfersCat: Category | undefined
  decisions: Record<string, RowDecision>
  menuFor: string | null
  setMenuFor: (h: string | null) => void
  recategorize: (row: PlannedRow, cat: Category) => void
  onCreateCategory: (name: string) => Category | null
  /** `polarity` ⇒ the pick contradicts the row's direction (#19): a note, not an offer. */
  always: { hash: string; categoryName: string; keyLabel: string; polarity?: boolean } | null
  acceptAlways: () => void
  dismissAlways: () => void
  backfill: { hash: string; ids: string[]; categoryName: string } | null
  applyBackfill: () => void
  dismissBackfill: () => void
  onKeepIncome: (hash: string) => void
  onKeepAnyway: (hash: string) => void
  allTrips: PickerTrip[]
  rowTripChips: (hash: string, date: string) => (PickerTrip & { state: 'member' | 'excluded' })[]
  tripStateFor: (hash: string, date: string, trackingId: string) => 'member' | 'excluded' | 'out'
  onToggleTrip: (hash: string, date: string, trackingId: string) => void
  onCreateTrip: (name: string, date: string) => Tracking | null
  detected: TripCandidate[]
  onMarkTrip: (cand: TripCandidate, name?: string) => Tracking | null
  onRefineTrip: (cand: TripCandidate) => Promise<string | null>
  onDismissTrip: (cand: TripCandidate) => void
  onConfirm: () => void
  assistConfigured: boolean
  assistRun: AssistRun
  onRunAssist: () => void
  onRetryAssist: () => void
  onStopAssist: () => void
}) {
  const narrow = useNarrow()
  const { plan, vault, catById, pickCats, transfersCat, decisions, menuFor, setMenuFor, recategorize, onCreateCategory, always, acceptAlways, dismissAlways, backfill, applyBackfill, dismissBackfill, onKeepIncome, onKeepAnyway, allTrips, rowTripChips, tripStateFor, onToggleTrip, onCreateTrip, detected, onMarkTrip, onRefineTrip, onDismissTrip, onConfirm, assistConfigured, assistRun, onRunAssist, onRetryAssist, onStopAssist } = props
  const currentYear = nowDate().getFullYear()
  const newRows = plan.rows.filter((r) => r.status === 'new')
  const dupRows = plan.rows.filter((r) => r.status === 'duplicate')
  const [showDups, setShowDups] = useState(false)
  const [q, setQ] = useState('')
  const [rfilter, setRfilter] = useState<ReviewFilter>('all')
  const [from, setFrom] = useState('') // '' = open end
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<{ key: 'amount' | 'date'; dir: 'asc' | 'desc' } | null>(null) // null = source order
  const [rmenu, setRmenu] = useState<'filter' | 'date' | null>(null)

  // Display-only. The search / filter / sort narrow what is *shown*; they never change what is
  // imported (confirm runs over the whole plan) nor the counts (which describe the whole import).
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = newRows.filter((r) => reviewMatches(r, decisions[r.hash], needle, rfilter, from, to))
    if (!sort) return rows
    const { key, dir } = sort
    return [...rows].sort((a, b) => {
      const av = key === 'amount' ? a.norm.amountMinor : a.norm.bookedDate
      const bv = key === 'amount' ? b.norm.amountMinor : b.norm.bookedDate
      const c = av < bv ? -1 : av > bv ? 1 : a.hash < b.hash ? -1 : 1
      return dir === 'asc' ? c : -c
    })
  }, [newRows, decisions, q, rfilter, from, to, sort])

  // A header click cycles source-order → desc → asc → source-order, so the statement's own
  // ordering is always recoverable.
  const cycleSort = (key: 'amount' | 'date') =>
    setSort((s) => (s?.key !== key ? { key, dir: 'desc' } : s.dir === 'desc' ? { key, dir: 'asc' } : null))
  const clearFilters = () => { setQ(''); setRfilter('all'); setFrom(''); setTo('') }
  const txnById = useMemo(() => new Map(vault.transactions.map((t) => [t.id, t])), [vault.transactions])
  // A paired row is locked to its matching leg (§9.2). Resolve that leg — an existing vault
  // transaction — so the row can say what it paired with and why, instead of a mute locked chip.
  const pairByGid = useMemo(() => {
    const acctName = new Map(vault.accounts.map((a) => [a.id, a.name]))
    const m = new Map<string, { amount: number; date: string; account: string }>()
    for (const link of plan.transferLinks) {
      const t = txnById.get(link.existingTxnId)
      if (t) m.set(link.transferGroupId, { amount: t.amount, date: t.date, account: (t.accountId && acctName.get(t.accountId)) || 'another account' })
    }
    return m
  }, [plan.transferLinks, txnById, vault.accounts])
  const groupIdx = plan.groups.findIndex((g) => g.key === plan.groupKey)
  const recon = plan.reconciliation.ok
  const c = plan.counts
  // Live "needs review": a plan-level fallback/ambiguous row the user hasn't resolved yet.
  const liveNeedReview = newRows.filter((r) => (r.needsReview && !decisions[r.hash]?.categoryId) || (r.ambiguous && !decisions[r.hash]?.keepAsIncome)).length
  // Suspected duplicates are out of the commit unless the user put one back, so the count moves live.
  const liveToAdd = newRows.filter((r) => !r.suspectedDuplicateOf || decisions[r.hash]?.keepAnyway).length
  // 'choose' (two matches), 'confirm' (a weak signal to accept), or an unconfirmed no-signal 'create'
  // (`mustName`) all require the user to resolve the account before importing — otherwise rows could
  // land on the wrong account, double-import, or spawn a silent ghost account.
  const needsAccount = plan.account.mode === 'choose' || plan.account.mode === 'confirm' || !!plan.account.mustName
  // An all-duplicate statement (toAdd === 0) still carries authoritative balance
  // anchors and a coverage record worth committing (#18) — allow the commit when it
  // has snapshots to record. Dedup on apply keeps re-committing the same file idempotent.
  const hasBalancesToRecord = plan.snapshots.length > 0
  const balancesOnly = liveToAdd === 0 && hasBalancesToRecord
  const blocked = needsAccount || (liveToAdd === 0 && !hasBalancesToRecord)

  // No `overflow: hidden` on the section: the category popover on the last row has to escape this
  // box, and clipping it left those categories unreachable — the list is already scrolled to its end.
  return (
    <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6 }} data-testid="review-list">
      <div style={{ padding: '15px 18px', borderBottom: `1px solid ${HAIR}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: INK }}>
            {plan.statement.fileName}
            {plan.groups.length > 1 && (
              <span data-testid="group-progress" style={{ fontWeight: 400, fontSize: 10.5, color: FAINT, marginLeft: 9 }}>
                {plan.groups[groupIdx]?.label} · account {groupIdx + 1} of {plan.groups.length}
              </span>
            )}
          </div>
          <div data-testid="review-counts" style={{ fontSize: 12.5, color: MUT }}>
            {c.total} rows · <span style={{ color: INK }}>{liveToAdd} to add</span>
            {liveNeedReview > 0 && <> · <span style={{ color: AMBER }}>{liveNeedReview} need review</span></>}
            {c.suspected > 0 && <> · <span style={{ color: AMBER }} data-testid="suspected-count">{c.suspected} likely already imported</span></>}
          </div>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {c.duplicates > 0 ? (
            <button
              data-testid="dup-count"
              onClick={() => setShowDups((v) => !v)}
              title="Show the skipped rows and the transactions they match"
              style={{ fontFamily: MONO, fontSize: 10.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              {c.duplicates} duplicates skipped {showDups ? '▾' : '▸'}
            </button>
          ) : (
            <span data-testid="dup-count">{c.duplicates} duplicates skipped</span>
          )}
          <span>{c.autoCategorized} auto-categorized</span>
          {c.fromHistory > 0 && <span data-testid="history-count">{c.fromHistory} from history</span>}
          {recon ? (
            <span style={{ color: GREEN }} data-testid="recon-ok">✓ statement total matches <span>{fmt(plan.reconciliation.ok ? plan.reconciliation.closing : 0, true)}</span></span>
          ) : null}
          {plan.notes.map((n, i) => (
            <span key={i} style={{ color: AMBER }} data-testid="review-note">{n.label}</span>
          ))}
        </div>
        <AssistStrip plan={plan} configured={assistConfigured} run={assistRun} onRun={onRunAssist} onRetry={onRetryAssist} onStop={onStopAssist} />
        {detected.map((cand) => (
          <TripSuggestStrip key={`${cand.dateFrom}|${cand.currency}`} cand={cand} assistOn={assistConfigured} onMark={onMarkTrip} onRefine={onRefineTrip} onDismiss={() => onDismissTrip(cand)} />
        ))}
      </div>

      {newRows.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 18px', borderBottom: `1px solid ${HAIR}` }}>
            <input
              data-testid="review-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search descriptors…"
              style={{ flex: '1 1 160px', minWidth: 120, height: 34, border: `1px solid ${HAIR}`, borderRadius: 6, background: SURFACE, padding: '0 10px', fontSize: 12.5, color: INK }}
            />
            <FilterChip testid="review-filter" label={REVIEW_FILTER_LABEL[rfilter]} open={rmenu === 'filter'} onClick={() => setRmenu(rmenu === 'filter' ? null : 'filter')}>
              {(Object.keys(REVIEW_FILTER_LABEL) as ReviewFilter[]).map((k) => (
                <MenuItem key={k} label={REVIEW_FILTER_LABEL[k]} onClick={() => { setRfilter(k); setRmenu(null) }} />
              ))}
            </FilterChip>
            <FilterChip testid="review-date" label={from || to ? `${from ? shortDate(from, currentYear) : '…'} → ${to ? shortDate(to, currentYear) : '…'}` : 'Date'} open={rmenu === 'date'} onClick={() => setRmenu(rmenu === 'date' ? null : 'date')}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '4px 6px' }}>
                <span style={{ color: MUT }}>From</span>
                <input data-testid="review-date-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ fontSize: 12.5, padding: '5px 7px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, fontFamily: MONO }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '4px 6px' }}>
                <span style={{ color: MUT }}>To</span>
                <input data-testid="review-date-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ fontSize: 12.5, padding: '5px 7px', border: `1px solid ${HAIR}`, borderRadius: 5, background: SURFACE, color: INK, fontFamily: MONO }} />
              </div>
              {(from || to) && <button data-testid="review-date-clear" onClick={() => { setFrom(''); setTo('') }} style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '4px 6px' }}>Clear dates</button>}
            </FilterChip>
            <span data-testid="review-showing" style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginLeft: 'auto' }}>showing {shown.length} of {newRows.length}</span>
          </div>
          {/* Column headings mean nothing once the row stops being columns — but the two SORT
              controls inside them still do, so on a phone the labels go and the sorts stay. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? 10 : 14, padding: '8px 18px 0', fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.05em' }}>
            <div style={{ flex: 1, minWidth: 0 }}>{narrow ? 'SORT' : 'DESCRIPTOR'}</div>
            <button data-testid="review-sort-amount" onClick={() => cycleSort('amount')} style={{ width: narrow ? 'auto' : 92, textAlign: 'right', fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: sort?.key === 'amount' ? MUT : FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>AMOUNT{sort?.key === 'amount' ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
            <button data-testid="review-sort-date" onClick={() => cycleSort('date')} style={{ width: narrow ? 'auto' : DATE_W, textAlign: 'left', fontFamily: MONO, fontSize: 10, letterSpacing: '.05em', color: sort?.key === 'date' ? MUT : FAINT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>DATE{sort?.key === 'date' ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
            {!narrow && <div style={{ width: 190 }}>CATEGORY</div>}
            {!narrow && <div style={{ width: 150, textAlign: 'right' }}>TRIPS</div>}
          </div>
        </>
      )}

      <div style={{ padding: '2px 18px 6px' }}>
        {shown.map((row) => (
          <ReviewRow
            key={row.hash}
            row={row}
            catById={catById}
            pickCats={pickCats}
            transfersCat={transfersCat}
            pair={row.transferGroupId ? pairByGid.get(row.transferGroupId) : undefined}
            decision={decisions[row.hash]}
            menuOpen={menuFor === row.hash}
            openMenu={() => setMenuFor(menuFor === row.hash ? null : row.hash)}
            onPick={(cat) => recategorize(row, cat)}
            onCreateCategory={onCreateCategory}
            onKeepIncome={() => onKeepIncome(row.hash)}
            onKeepAnyway={() => onKeepAnyway(row.hash)}
            allTrips={allTrips}
            tripChips={rowTripChips(row.hash, row.norm.bookedDate)}
            isMember={(trackingId) => tripStateFor(row.hash, row.norm.bookedDate, trackingId) === 'member'}
            onToggleTrip={(trackingId) => onToggleTrip(row.hash, row.norm.bookedDate, trackingId)}
            onCreateTrip={(name) => onCreateTrip(name, row.norm.bookedDate)}
            alwaysStrip={
              always && always.hash === row.hash && always.polarity ? (
                <PolarityStrip
                  categoryName={always.categoryName}
                  onTransfers={transfersCat ? () => recategorize(row, transfersCat) : undefined}
                  onDismiss={dismissAlways}
                />
              ) : always && always.hash === row.hash ? (
                <AlwaysStrip info={always} onAlways={acceptAlways} onOnce={dismissAlways} />
              ) : backfill && backfill.hash === row.hash ? (
                <BackfillStrip info={backfill} onApply={applyBackfill} onDismiss={dismissBackfill} />
              ) : null
            }
          />
        ))}
        {newRows.length === 0 && <div style={{ padding: '24px 0', textAlign: 'center', color: FAINT, fontSize: 13 }}>Nothing new to add — every row is already in your vault.</div>}
        {newRows.length > 0 && shown.length === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: FAINT, fontSize: 13 }} data-testid="review-empty">
            No rows match these filters · <button onClick={clearFilters} style={{ color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>clear</button>
          </div>
        )}
      </div>

      {showDups && dupRows.length > 0 && <DuplicatesPanel rows={dupRows} txnById={txnById} catById={catById} />}

      <div style={{ position: 'sticky', bottom: 0, background: SURFACE2, borderTop: `1px solid ${HAIR}`, padding: '14px 18px calc(14px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: MUT }}>
          <span style={{ fontFamily: MONO, color: ACCENT }}>{liveToAdd} to add · {c.duplicates + (c.suspected - (liveToAdd - c.toAdd))} skipped</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {needsAccount && <span style={{ fontSize: 12, color: AMBER }} data-testid="needs-account">{plan.account.mode === 'confirm' ? 'Confirm the account first ↑' : plan.account.mustName ? 'Name this account or pick an existing one first ↑' : 'Pick an account first ↑'}</span>}
          <button data-testid="confirm-import" onClick={onConfirm} disabled={blocked} style={{ background: blocked ? FAINT : ACCENT, color: 'var(--on-accent)', borderRadius: 6, padding: '9px 16px', textAlign: 'left', border: 'none', cursor: blocked ? 'default' : 'pointer' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.1 }}>{balancesOnly ? 'Record statement balances' : `Add ${liveToAdd} transaction${liveToAdd === 1 ? '' : 's'}`}</div>
            {balancesOnly && <div style={{ fontFamily: MONO, fontSize: 10, opacity: 0.85, marginTop: 2 }}>all rows already imported · anchors + coverage</div>}
            {liveNeedReview > 0 && <div style={{ fontFamily: MONO, fontSize: 10, opacity: 0.85, marginTop: 2 }}>{liveNeedReview} unreviewed keep prediction</div>}
          </button>
        </div>
      </div>
    </section>
  )
}

/**
 * Read-only verification of the rows Ring-1 skipped (§8.1): each skipped row next to the
 * transaction already in the vault it matched, so the user can confirm the skip was right.
 * Nothing here mutates or re-imports — it exists purely to make "duplicates skipped" auditable.
 */
function DuplicatesPanel({ rows, txnById, catById }: { rows: PlannedRow[]; txnById: Map<string, Transaction>; catById: Map<string, CatInfo> }) {
  const [open, setOpen] = useState<string | null>(null)
  const currentYear = nowDate().getFullYear()
  const field = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
      <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, width: 66, flex: 'none', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      <span style={{ fontSize: 12, color: INK, wordBreak: 'break-word', minWidth: 0 }}>{value}</span>
    </div>
  )
  return (
    <div data-testid="dup-panel" style={{ borderTop: `1px solid ${HAIR}`, background: SURFACE2 }}>
      <div style={{ padding: '9px 18px 4px', fontFamily: MONO, fontSize: 10, color: FAINT, letterSpacing: '.06em' }}>
        SKIPPED — ALREADY IN YOUR VAULT · TAP A ROW TO VERIFY
      </div>
      {rows.map((row) => {
        const n = row.norm
        const existing = row.duplicateOf ? txnById.get(row.duplicateOf) : undefined
        const isOpen = open === row.hash
        return (
          <div key={row.hash} data-testid="dup-row" style={{ borderTop: `1px solid ${HAIR2}` }}>
            <button
              onClick={() => setOpen(isOpen ? null : row.hash)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ color: FAINT, fontFamily: MONO, fontSize: 10, width: 10 }}>{isOpen ? '▾' : '▸'}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: MUT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.merchant}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT, width: DATE_W }}>{shortDate(n.bookedDate, currentYear)}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: MUT, width: 92, textAlign: 'right' }}>{fmt(n.amountMinor / 100, true)}</span>
            </button>
            {isOpen && (
              <div data-testid="dup-detail" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '4px 18px 14px 40px' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: ACCENT, letterSpacing: '.05em', marginBottom: 2 }}>INCOMING · FROM THIS FILE</div>
                  {field('name', n.merchant)}
                  {field('date', n.bookedDate)}
                  {field('amount', fmt(n.amountMinor / 100, true))}
                  {n.ref && field('ref', <span style={{ fontFamily: MONO, fontSize: 11 }}>{n.ref}</span>)}
                  {field('original', <span style={{ fontFamily: MONO, fontSize: 10.5, color: MUT }}>{n.raw}</span>)}
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT, letterSpacing: '.05em', marginBottom: 2 }}>ALREADY IN YOUR VAULT</div>
                  {existing ? (
                    <>
                      {field('name', existing.merchant)}
                      {field('date', existing.date)}
                      {field('amount', fmt(existing.amount, true))}
                      {field('category', catById.get(existing.categoryId)?.name ?? '—')}
                      {existing.importMeta?.file && field('source', <span style={{ fontFamily: MONO, fontSize: 10.5, color: MUT }}>{existing.importMeta.file}{existing.importMeta.variant ? ` · ${existing.importMeta.variant}` : ''}</span>)}
                      {existing.importMeta?.raw && field('original', <span style={{ fontFamily: MONO, fontSize: 10.5, color: MUT }}>{existing.importMeta.raw}</span>)}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: FAINT, marginTop: 3 }}>Matched an existing transaction (details unavailable).</div>
                  )}
                  <div style={{ fontFamily: MONO, fontSize: 10, color: GREEN, marginTop: 8 }}>
                    ✓ {n.ref ? `same reference ${n.ref}` : 'same date, amount & descriptor'}
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ReviewRow({ row, catById, pickCats, transfersCat, pair, decision, menuOpen, openMenu, onPick, onCreateCategory, onKeepIncome, allTrips, tripChips, isMember, onToggleTrip, onCreateTrip, alwaysStrip, onKeepAnyway }: {
  row: PlannedRow
  catById: Map<string, CatInfo>
  pickCats: Category[]
  transfersCat: Category | undefined
  pair: { amount: number; date: string; account: string } | undefined
  decision: RowDecision | undefined
  menuOpen: boolean
  openMenu: () => void
  onPick: (cat: Category) => void
  onCreateCategory: (name: string) => Category | null
  onKeepIncome: () => void
  allTrips: PickerTrip[]
  tripChips: (PickerTrip & { state: 'member' | 'excluded' })[]
  isMember: (trackingId: string) => boolean
  onToggleTrip: (trackingId: string) => void
  onCreateTrip: (name: string) => Tracking | null
  alwaysStrip: React.ReactNode
  onKeepAnyway: () => void
}) {
  const narrow = useNarrow()
  const [newCat, setNewCat] = useState<string | null>(null)
  const [dropUp, setDropUp] = useState(false)
  const currentYear = nowDate().getFullYear()
  const n = row.norm
  const catId = decision?.categoryId ?? row.categoryId
  const cat = catById.get(catId) ?? { name: 'Other', color: FAINT }
  const paired = !!row.transferGroupId
  const ambiguous = row.ambiguous && !decision?.keepAsIncome
  const needsReview = (row.needsReview && !decision?.categoryId) || !!ambiguous
  const prov = paired
    ? 'paired · locked'
    : catId === CAT_TRANSFERS
      ? 'not cash-flow'
      : row.provenance.startsWith('rule')
        ? (n.creditorId ? 'rule: SEPA id' : 'rule')
        : row.provenance === 'bank' && !decision?.categoryId
          ? 'from bank'
          : row.provenance === 'history' && !decision?.categoryId
            ? 'from history'
            : needsReview
              ? 'needs review'
              : row.provenance === 'ai' && !decision?.categoryId
                ? `AI · ${Math.round((row.aiConfidence ?? 0) * 100)}%`
                : 'confirmed'

  const skipped = !!row.suspectedDuplicateOf && !decision?.keepAnyway
  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${HAIR2}`, opacity: skipped ? 0.55 : 1 }} data-testid="review-row" data-merchant={n.merchant} data-suspected={row.suspectedDuplicateOf ? '1' : undefined}>
      {row.suspectedDuplicateOf && (
        <div data-testid="suspected-strip" style={{ fontFamily: MONO, fontSize: 10.5, color: AMBER, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>{skipped ? 'SKIPPED — already on this account from an earlier statement' : 'IMPORTING ANYWAY — a genuine second charge'}</span>
          <button data-testid="keep-anyway" onClick={onKeepAnyway} style={{ fontFamily: MONO, fontSize: 10.5, color: ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            {skipped ? 'import it anyway' : 'skip it'}
          </button>
        </div>
      )}
      {/* 92 + date + 190px of fixed cells plus three 14px gaps needs far more than 366, so on a
          phone the row wraps: descriptor and amount on one line, date / category / trip on the
          next. The zero-height spacer below is what forces that break. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: narrow ? 8 : 14, flexWrap: narrow ? 'wrap' : 'nowrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.merchant}</div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: FAINT, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.normDesc}</div>
          {paired && (
            <div data-testid="pair-detail" style={{ fontFamily: MONO, fontSize: 10, color: MUT, marginTop: 3 }}>
              ⇄ internal transfer{pair ? ` · matches ${fmt(pair.amount, true)} in ${pair.account} · ${shortDate(pair.date, currentYear)}` : ' · matched to its opposite leg'}
            </div>
          )}
          <LookupLinks query={lookupQuery(n.merchant, n.raw)} style={{ marginTop: 3, fontSize: 11 }} />
        </div>
        <div style={{ fontFamily: MONO, fontSize: 12.5, width: narrow ? 'auto' : 92, flex: 'none', textAlign: 'right', color: n.amountMinor >= 0 ? GREEN : INK }} data-testid="review-amount">
          {fmt(n.amountMinor / 100, true)}
        </div>
        {narrow && <div style={{ flexBasis: '100%', height: 0 }} />}
        <div style={{ fontFamily: MONO, fontSize: 11, color: FAINT, width: narrow ? 'auto' : DATE_W, flex: 'none' }}>{shortDate(n.bookedDate, currentYear)}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: narrow ? 'auto' : 190, position: 'relative' }}>
          {paired ? (
            <span title="Internal transfer — matched to its opposite leg by equal-and-opposite amount (§9.2), so it is locked to Transfers here. Pairing sits above rules on the ladder (§10.1), which is why another row of the same counterparty can carry a rule's category instead. To change it, import first, then use “Unlink pair” on the Transactions screen." style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: CHIP, color: MUT, borderRadius: 12, padding: '4px 10px', cursor: 'help' }}>⇄ Transfers</span>
          ) : ambiguous ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11.5, border: `1px dashed ${AMBER}`, color: AMBER, borderRadius: 12, padding: '3px 9px' }}>txfr-ambiguous</span>
          ) : (
            <button data-testid="recat-chip" onClick={(e) => { setDropUp(noRoomBelow(e.currentTarget)); openMenu() }} aria-label="Recategorize" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: needsReview ? 'transparent' : CHIP, border: needsReview ? `1px dashed ${AMBER}` : 'none', color: needsReview ? AMBER : INK, borderRadius: 12, padding: '3px 10px', cursor: 'pointer' }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: cat.color }} />
              {cat.name}
            </button>
          )}
          {!ambiguous && <span style={{ fontFamily: MONO, fontSize: 9, color: prov === 'needs review' ? AMBER : FAINT }}>{prov}</span>}
          {menuOpen && (
            <div data-testid="cat-menu" style={{ position: 'absolute', left: 0, ...(dropUp ? { bottom: 28 } : { top: 28 }), zIndex: 30, background: SURFACE2, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 5, minWidth: 168, maxHeight: MENU_MAX, overflowY: 'auto', boxShadow: '0 10px 28px rgba(10,9,7,.16)', display: 'flex', flexDirection: 'column', gap: 1, ...phoneMenu(narrow) }}>
              {pickCats.map((c) => (
                <button key={c.id} data-cat={c.name} onClick={() => onPick(c)} style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>{c.name}</button>
              ))}
              {transfersCat && (
                <button data-cat={transfersCat.name} data-testid="cat-menu-transfer" onClick={() => onPick(transfersCat)} title="Not spending — an internal move" style={{ textAlign: 'left', fontSize: 12.5, color: MUT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer', borderTop: `1px solid ${HAIR2}`, marginTop: 3, paddingTop: 8 }}>⇄ {transfersCat.name}</button>
              )}
              <div style={{ borderTop: `1px solid ${HAIR2}`, marginTop: 3, paddingTop: 3 }}>
                {newCat === null ? (
                  <button data-testid="cat-menu-new" onClick={() => setNewCat('')} style={{ textAlign: 'left', width: '100%', fontSize: 12.5, color: ACCENT, padding: '7px 9px', borderRadius: 4, background: 'none', border: 'none', cursor: 'pointer' }}>+ New category…</button>
                ) : (
                  <input
                    data-testid="cat-menu-new-name"
                    autoFocus
                    value={newCat}
                    placeholder="Name, then Enter"
                    onChange={(e) => setNewCat(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setNewCat(null)
                      if (e.key !== 'Enter') return
                      const cat = onCreateCategory(newCat)
                      setNewCat(null)
                      if (cat) onPick(cat)
                    }}
                    style={{ width: '100%', boxSizing: 'border-box', height: 28, border: `1px solid ${HAIR}`, borderRadius: 4, background: SURFACE, color: INK, fontSize: 12.5, padding: '0 7px' }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
        <div style={{ width: 150, display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          {paired ? (
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>excluded from cash-flow</span>
          ) : (
            <>
              {tripChips.map((c) => {
                const on = c.state === 'member'
                return (
                  <button
                    key={c.id}
                    data-testid="review-trip-chip"
                    data-on={on ? '1' : '0'}
                    data-state={c.state}
                    onClick={() => onToggleTrip(c.id)}
                    title={on ? `In ${c.name} — tap to exclude` : `Excluded from ${c.name} — tap to include`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 9.5, padding: '2px 8px', borderRadius: 12, cursor: 'pointer', color: on ? INK : FAINT, background: on ? CHIP : 'transparent', border: on ? `1px solid ${HAIR}` : `1px dashed ${HAIR}` }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: c.color ?? 'var(--cmpa)', opacity: on ? 1 : 0.4 }} />
                    {c.name.split(/[·|]/)[0]!.trim()}
                  </button>
                )
              })}
              <TripPicker trips={allTrips} isOn={isMember} onToggle={onToggleTrip} onCreate={(name) => onCreateTrip(name)} compact />
            </>
          )}
        </div>
      </div>
      {ambiguous && (
        <div style={{ marginTop: 9, padding: '9px 13px', background: WARNBG, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }} data-testid="ambiguous-panel">
          <span style={{ fontSize: 12.5, color: MUT, flex: 1, minWidth: 220 }}>Two possible matches for this transfer — pick one, or keep it as income.</span>
          <button data-testid="keep-income" onClick={onKeepIncome} style={{ fontSize: 12, color: MUT, border: `1px solid ${HAIR}`, background: SURFACE, padding: '6px 11px', borderRadius: 5, cursor: 'pointer' }}>Keep as income</button>
        </div>
      )}
      {alwaysStrip}
    </div>
  )
}

function AlwaysStrip({ info, onAlways, onOnce }: { info: { categoryName: string; keyLabel: string }; onAlways: () => void; onOnce: () => void }) {
  return (
    <div style={{ margin: '8px 0 0', padding: '11px 14px', background: CHIP, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="always-offer">
      <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: INK }}>
        <b>Always → {info.categoryName}?</b> <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>{info.keyLabel}</span>
      </div>
      <button data-testid="always-yes" onClick={onAlways} style={pill(true)}>Always</button>
      <button data-testid="always-once" onClick={onOnce} style={pill(false)}>Just once</button>
    </div>
  )
}

/**
 * #19 — the pick stands, but it contradicts the row's direction, so no rule is offered. The
 * alternative is named rather than implied: money leaving for an account the vault does not
 * track is a transfer (§9.4), which is what the user almost always means here.
 */
function PolarityStrip({ categoryName, onTransfers, onDismiss }: { categoryName: string; onTransfers?: () => void; onDismiss: () => void }) {
  return (
    <div style={{ margin: '8px 0 0', padding: '11px 14px', background: WARNBG, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="polarity-warning">
      <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: MUT }}>
        <b style={{ color: INK }}>{categoryName} is money in — this row is money out.</b> Kept as you picked it, but no rule was
        learned from it. If it is a move to an account you don’t track, mark it a transfer.
      </div>
      {onTransfers && <button data-testid="polarity-transfers" onClick={onTransfers} style={pill(true)}>⇄ Transfers</button>}
      <button data-testid="polarity-dismiss" onClick={onDismiss} style={pill(false)}>Keep {categoryName}</button>
    </div>
  )
}

/** §10.3 step 3 — the rule just minted also fits rows already in the vault. */
function BackfillStrip({ info, onApply, onDismiss }: { info: { ids: string[]; categoryName: string }; onApply: () => void; onDismiss: () => void }) {
  const n = info.ids.length
  return (
    <div style={{ margin: '8px 0 0', padding: '11px 14px', background: CHIP, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="backfill-offer">
      <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: INK }}>
        Apply to <b data-testid="backfill-count">{n}</b> existing transaction{n === 1 ? '' : 's'}?{' '}
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT }}>already in your vault → {info.categoryName}</span>
      </div>
      <button data-testid="backfill-apply" onClick={onApply} style={pill(true)}>Apply</button>
      <button data-testid="backfill-dismiss" onClick={onDismiss} style={pill(false)}>Not now</button>
    </div>
  )
}

// ---------- refusal ----------
function RefusalCard({ refusal, onProceed, onPickInstitution, onCancel }: { refusal: Refusal; onProceed: () => void; onPickInstitution: (inst: string) => void; onCancel: () => void }) {
  return (
    <section data-testid="refusal" data-kind={refusal.refusal} style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: refusal.refusal === 'already-imported' ? INK : BRICK }}>{refusal.message}</div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        {refusal.refusal === 'already-imported' && <button data-testid="reimport" onClick={onProceed} style={pill(true)}>Import again anyway</button>}
        {/* Rendered from the registry: the picker is the one surface that must list every
            adapter, and a hardcoded pair silently omitted each new bank. */}
        {refusal.refusal === 'unrecognized' &&
          registry.map((a) => (
            <button key={a.id} onClick={() => onPickInstitution(a.id)} style={pill(false)}>
              {a.displayName}
            </button>
          ))}
        <button data-testid="refusal-cancel" onClick={onCancel} style={{ ...btnOutline, color: MUT, border: `1px solid ${HAIR}` }}>Cancel</button>
      </div>
    </section>
  )
}

function SkeletonReview() {
  return (
    <section style={{ background: SURFACE, border: `1px solid ${HAIR}`, borderRadius: 6, padding: 18 }} data-testid="planning">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} style={{ height: 14, background: CHIP, borderRadius: 4, margin: '12px 0', width: `${90 - i * 8}%` }} />
      ))}
    </section>
  )
}

const pill = (primary: boolean): React.CSSProperties => ({
  fontSize: 12.5,
  color: primary ? '#fff' : MUT,
  background: primary ? ACCENT : 'transparent',
  border: primary ? 'none' : `1px solid ${HAIR}`,
  padding: '6px 13px',
  borderRadius: 5,
  fontWeight: primary ? 500 : 400,
  cursor: 'pointer',
})

const rowBtn: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 12.5,
  color: INK,
  padding: '8px 9px',
  borderRadius: 4,
  background: CHIP,
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  justifyContent: 'space-between',
}
