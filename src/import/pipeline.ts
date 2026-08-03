import type { Account, Transaction, Vault } from '../model/types'
import { CAT_TRANSFERS } from '../model/types'
import { now, uuidv7 } from '../model/clock'
import type { ApplyImportOp, NewImportTxn } from '../model/mutations'
import type {
  AccountCandidate,
  ImportPlan,
  NormalizedRow,
  ParsedStatement,
  PlannedRow,
  Refusal,
  RowDecision,
  SourceFile,
} from './types'
import { detect } from './registry'
import { adapterById } from './registry'
import { buildPeek } from './peek'
import { fileHash, hashRows } from './identity'
import { pairTransfers } from './transfers'
import { evaluateRules, installStarterPack, shouldOfferStarterPack } from './rules'
import { buildManualHistory, historyLookup } from './history'
import { EncryptedPdfError, ScannedPdfError } from './pdf'

export interface ImportChoices {
  institution?: string
  variant?: string
  /** Which account group of a multi-account file to plan (§5.8); default the first. */
  group?: string
  accountId?: string | 'new' | `adopt:${string}`
  name?: string
  installStarterPack?: boolean
  proceedAlreadyImported?: boolean
}

const round2 = (n: number) => Math.round(n) / 100

// The money symbol a REFUSAL or a statement note prints. It follows the statement being read, not
// the vault base, so `curSym()` (ui/theme.ts, base-currency-wide) is the wrong tool here — and the
// pipeline must stay free of UI module state anyway. A hardcoded '€' told a UAH import it was off
// by euros; an unknown code prints as a prefix ("PLN 12.40") rather than a wrong glyph.
const CUR_SYM: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', UAH: '₴' }
const symOf = (cur: string) => CUR_SYM[cur.toUpperCase()] ?? `${cur.toUpperCase()} `
const money = (n: number, cur: string) => `${symOf(cur)}${Math.abs(n).toFixed(2)}`

/** Tagged identity signals a file offers for account matching (§5.8): a real RIB key (`rib:`),
 *  the account last-4 (`last4:`), and any holder name (`holder:`). A `${inst}:mask:` fingerprint is
 *  a last-4 stand-in, not a RIB, so it is not emitted as a `rib:` signal. */
/** Map an error thrown while reading/parsing a statement to a refusal. A scanned or
 *  encrypted PDF gets its specific message; anything else is `unreadable` — a corrupt
 *  or unexpected file must surface a refusal, never a silent stuck skeleton (#17). */
function refusalForParseError(e: unknown): Refusal {
  if (e instanceof ScannedPdfError) return { refusal: 'scanned-pdf', message: 'This looks like a scanned statement; text-based PDF, XLSX or CSV are supported.' }
  if (e instanceof EncryptedPdfError) return { refusal: 'encrypted-pdf', message: 'This PDF is password-protected.' }
  return { refusal: 'unreadable', message: "Couldn't read this file — it may be corrupt or in an unexpected format.", details: { error: e instanceof Error ? e.message : String(e) } }
}

function signalsOf(parsed: ParsedStatement, institution: string): string[] {
  const out: string[] = []
  if (parsed.fingerprint && !parsed.fingerprint.startsWith(`${institution}:mask:`)) out.push(`rib:${parsed.fingerprint}`)
  if (parsed.accountMask) out.push(`last4:${parsed.accountMask}`)
  for (const h of parsed.holderNames ?? []) out.push(`holder:${h.toUpperCase()}`)
  return out
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function suggestedName(institution: string, currency: string, holderNames: string[] | undefined, product: string | undefined, choiceName?: string): string {
  if (choiceName) return choiceName
  // Product only when it is not the default one — a Savings pocket and a Current
  // account in the same currency are distinct accounts and must not share a name.
  if (institution === 'revolut') return product && !/^current$/i.test(product) ? `Revolut ${titleCase(product)} ${currency}` : `Revolut ${currency}`
  if (institution === 'bnp') {
    // Same rule as Revolut above: the holder alone does not identify the account. A Livret A and
    // a compte chèques share bank, branch and holder, so the product must reach the name or both
    // would suggest `BNP Durand`. The current account carries no product and keeps its name.
    const base =
      (holderNames?.length ?? 0) >= 2 ? 'BNP Joint' : holderNames && holderNames[0] ? `BNP ${titleCase(holderNames[0].split(/\s+/)[0]!)}` : 'BNP Paribas'
    return product ? `${base} ${product}` : base
  }
  // Privat keys an account on the card, and one export commonly carries two — without the masked
  // tail both would suggest the same `Privat UAH` and read as one account.
  if (institution === 'privat') return product ? `Privat ${currency} ${product}` : `Privat ${currency}`
  // PUMB keys on the IBAN and prints one `Клієнт` line. Two accounts of one household are both
  // UAH, so the currency alone would name them identically; the surname is what separates them.
  // Kept as printed (Cyrillic) — transliterating would invent a spelling the user never wrote.
  if (institution === 'pumb') {
    return holderNames?.[0] ? `PUMB ${titleCase(holderNames[0].split(/\s+/)[0]!)}` : `PUMB ${currency}`
  }
  return `${titleCase(institution)} ${currency}`
}

/**
 * Build a full import plan — PURE against the vault, commits nothing. Detect →
 * parse → normalize → reconcile → dedupe → transfers → categorize → account map
 * → counts/anchors/notes (IMPORT §2).
 */
export async function buildImportPlan(
  file: SourceFile,
  vault: Vault,
  choices: ImportChoices = {},
): Promise<ImportPlan | Refusal> {
  const fh = await fileHash(file.bytes)

  // Detection. `buildPeek` reads the first page of a PDF and can throw when a file
  // is corrupt or in an unexpected shape — turn that into a refusal rather than
  // letting it propagate as an unhandled rejection that would leave the review
  // stuck on its skeleton.
  let peek
  try {
    peek = await buildPeek(file)
  } catch (e) {
    return refusalForParseError(e)
  }
  let institution = choices.institution
  let variant = choices.variant
  if (!institution) {
    const det = detect(file, peek)
    if (det.ambiguous || !det.best) {
      return { refusal: 'unrecognized', message: "Couldn't recognize this file — which bank is it from?", details: { candidates: det.candidates } }
    }
    institution = det.best.institution
    variant = det.best.variant
  }
  const adapter = adapterById(institution)
  if (!adapter) return { refusal: 'unrecognized', message: `Unknown institution "${institution}".` }

  // Parse. One file can carry several accounts (§5.8) — each is planned, reviewed
  // and committed on its own, so everything below works on a single group.
  let statements: ParsedStatement[]
  try {
    statements = adapter.parseAll ? await adapter.parseAll(file, variant ?? '') : [await adapter.parse(file, variant ?? '')]
  } catch (e) {
    return refusalForParseError(e)
  }
  const groups = statements.map((s, i) => ({
    key: s.fingerprint ?? `#${i}`,
    label: s.productName ? `${s.productName} · ${s.accountCurrency}` : s.accountCurrency,
    rows: s.rows.length,
  }))
  const groupIdx = Math.max(0, groups.findIndex((g) => g.key === choices.group))
  const parsed = statements[groupIdx]!
  const groupKey = groups[groupIdx]!.key

  // Normalize.
  const norm = adapter.normalize(parsed)

  // Reconciliation gate — the balance chain of THIS account (§5.6).
  const recon = reconcile(norm, parsed.openingBalance, parsed.closingBalance, parsed.printedTotals)
  if (!recon.ok) {
    const kind = recon.reason === 'chain' ? 'chain-break' : 'reconcile-mismatch'
    // recon.delta is already in major units — do NOT run it through round2 (minor→major).
    const where = recon.at ? ` at row ${recon.at.line + 1} (${fmtDate(recon.at.date)}, ${recon.at.merchant})` : ''
    return {
      refusal: kind,
      message: `Couldn't read this statement reliably — off by ${money(recon.delta, parsed.accountCurrency)}${where}. Nothing was imported.`,
      details: { delta: recon.delta, at: recon.at },
    }
  }

  // Account resolution by SIGNALS, never silently on a weak one (§5.8). Identity clues (RIB,
  // last-4, holder name) suggest a match; the user confirms it (or picks/creates). Only proven
  // signals auto-bind: a stored `matchKeys` entry (a RIB, or a last-4/holder the user confirmed
  // before). A last-4/holder that merely *looks* right asks first, then is remembered.
  const fileSignals = signalsOf(parsed, institution)
  const instAccounts = vault.accounts.filter((a) => a.institutionId === institution)
  // An account's own fingerprint is its identity (§5.8): a real (non-mask) fingerprint that
  // equals this file's auto-binds, so re-importing the same product+currency ALWAYS lands on the
  // one account — never a second with the same fingerprint. This does not depend on `matchKeys`,
  // which a legacy account (created before match-keys existed) may lack; without it such an account
  // could never be re-adopted, so its file re-imported into a duplicate account and skipped dedup.
  const fpMatch = (a: Account): boolean =>
    parsed.fingerprint != null && !parsed.fingerprint.startsWith(`${institution}:mask:`) && a.fingerprint === parsed.fingerprint
  const autoAccounts = instAccounts.filter((a) => fpMatch(a) || (a.matchKeys ?? []).some((k) => fileSignals.includes(k)))
  const holdersUpper = (parsed.holderNames ?? []).map((h) => h.toUpperCase())
  const signalAccounts = instAccounts.filter(
    (a) =>
      !autoAccounts.includes(a) &&
      ((parsed.accountMask != null && a.last4 === parsed.accountMask) ||
        (holdersUpper.length > 0 && (a.holderNames ?? []).some((h) => holdersUpper.includes(h.toUpperCase())))),
  )

  const signalLabel = parsed.accountMask ? `····${parsed.accountMask}` : parsed.holderNames?.[0]
  const fpCandidates: AccountCandidate[] = autoAccounts.map((a) => ({ accountId: a.id, name: a.name, reason: 'fingerprint' as const, preselect: true }))
  const signalCandidates: AccountCandidate[] = signalAccounts.map((a, i) => ({ accountId: a.id, name: a.name, reason: 'signal' as const, preselect: i === 0, signal: signalLabel }))
  const adoptCandidates: AccountCandidate[] = vault.accounts
    .filter((a) => !a.fingerprint && a.institutionId === undefined)
    .map((a) => ({ accountId: a.id, name: a.name, reason: 'adopt' as const }))
  // Every other account of this institution, offered so the user can map an unidentifiable file
  // (no RIB, no last-4, no holder) onto the right existing account instead of silently spawning a
  // new one — the exact hole that split a BNP xls into a fingerprint-less ghost (§5.8).
  const pickCandidates: AccountCandidate[] = instAccounts
    .filter((a) => !autoAccounts.includes(a) && !signalAccounts.includes(a))
    .map((a) => ({ accountId: a.id, name: a.name, reason: 'pick' as const }))

  const name = suggestedName(institution, parsed.accountCurrency, parsed.holderNames, parsed.productName, choices.name)
  let mode: ImportPlan['account']['mode']
  let accountId: string | undefined
  if (choices.accountId === 'new') mode = 'create'
  else if (typeof choices.accountId === 'string' && choices.accountId.startsWith('adopt:')) {
    mode = 'adopt'
    accountId = choices.accountId.slice('adopt:'.length)
  } else if (choices.accountId) {
    mode = 'existing'
    accountId = choices.accountId
  } else if (autoAccounts.length === 1) {
    mode = 'existing'
    accountId = autoAccounts[0]!.id
  } else if (autoAccounts.length > 1) {
    mode = 'choose'
  } else if (signalAccounts.length >= 1) {
    mode = 'confirm' // suggest the match; the user must confirm before import proceeds
  } else {
    mode = 'create'
  }

  // An *unidentifiable* file — no fingerprint, no last-4, no holder — must never be committed to a
  // silently-created account: with nothing to key on it would mint a generic ghost that a re-import
  // can't re-adopt, splitting one real account in two and skipping cross-account dedup (§5.8, the
  // BNP-xls ghost). Gate it: the user must name it or pick an existing account first. A file that
  // DOES carry a signal (Revolut's product key, a BNP last-4) still auto-creates as before; an
  // explicit account choice (`new` or an id) clears the gate.
  const mustName = mode === 'create' && choices.accountId == null && parsed.fingerprint == null && fileSignals.length === 0

  // Remember the user's confirmation: an explicit pick of an existing account (via the confirm
  // card or a manual change) teaches that account this file's signals, so a future file carrying
  // one auto-binds. Auto-bind itself never learns — that would silently promote a last-4 the user
  // hasn't blessed.
  const userPickedExisting = mode === 'existing' && accountId != null && choices.accountId != null && choices.accountId !== 'new'
  const learnAccountKeys = userPickedExisting && fileSignals.length > 0 ? { accountId: accountId!, keys: fileSignals } : undefined

  // Hash under the RESOLVED account's key (§7.3), so a file confirmed to an existing account
  // adopts that account's identity and dedupes against its rows — regardless of import order or
  // which file created the account. A brand-new account falls back to the file's own key.
  const resolvedAccount = accountId ? vault.accounts.find((a) => a.id === accountId) : undefined
  const accountKey = resolvedAccount?.fingerprint ?? parsed.fingerprint ?? `local:${institution}:${parsed.accountCurrency.toLowerCase()}`
  const hashes = await hashRows(norm, accountKey)
  // A row whose canon a normalizer change moved also hashes under the OLD canon, so a statement
  // re-imported after that change still recognises the rows it committed before it (IMPORT §8.1).
  // Only the identity lookup uses these; what gets stored is always the current hash.
  const legacyHashes = norm.some((r) => r.legacyNormDesc)
    ? await hashRows(norm.map((r) => (r.legacyNormDesc ? { ...r, normDesc: r.legacyNormDesc } : r)), accountKey)
    : hashes

  // Ring-1 file-level short-circuit (§12.3) — scoped to the account this group maps
  // to, because a multi-account file (§5.8) writes one StatementRecord per account:
  // committing its first group must not read as "already imported" for the second.
  const prior = choices.proceedAlreadyImported || !accountId ? undefined : vault.statements.find((s) => s.fileHash === fh && s.accountId === accountId)
  if (prior) {
    return { refusal: 'already-imported', message: `Already imported on ${prior.importedAt.slice(0, 10)} (${prior.rowsImported} rows) — import again anyway?`, details: { statementId: prior.id } }
  }

  // Ring-1 dedupe: a hash already on THIS account ⇒ skip (§8.1). Scoping to the
  // target account matters when two accounts share a shape (his-and-hers Revolut
  // EUR Current collapse to one fingerprint, §5.8) — an identical-looking row on a
  // different account must not be dropped. Create/adopt targets have no import rows
  // yet, so their set is empty and every row counts as new.
  const existingByHash = new Map<string, string>() // hash → existing txn id (duplicate → verify link)
  if (accountId) {
    for (const tx of vault.transactions) {
      if (tx.accountId !== accountId || !tx.importMeta?.hash) continue
      if (!existingByHash.has(tx.importMeta.hash)) existingByHash.set(tx.importMeta.hash, tx.id)
      // A row that absorbed a duplicate answers for that identity too — otherwise re-importing the
      // statement the duplicate came from would resurrect it and the audit would never converge.
      for (const h of tx.importMeta.dupHashes ?? []) if (!existingByHash.has(h)) existingByHash.set(h, tx.id)
    }
  }

  // Transfers (§9) over non-duplicate candidate rows.
  const targetAccountId = accountId ?? `pending:${accountKey}`
  // A row counts as already-present under either canon (see `legacyHashes`).
  const priorIdOf = (i: number): string | undefined => existingByHash.get(hashes[i]!) ?? existingByHash.get(legacyHashes[i]!)
  const nonDup = norm.filter((_, i) => priorIdOf(i) === undefined)
  const pairing = pairTransfers(nonDup, targetAccountId, vault)
  const pairByLine = new Map(pairing.map((p) => [p.line, p]))
  const transferLinks: { existingTxnId: string; transferGroupId: string }[] = []

  // Categorization ladder (§10.1) + starter pack (accepted → merge its rules).
  const pack = choices.installStarterPack ? installStarterPack(vault) : undefined
  const rulesForEval = pack ? [...vault.rules, ...pack.rules] : vault.rules
  // Fallback category for unmatched/ambiguous rows. Never CAT_TRANSFERS — that would
  // silently drop needs-review rows out of cash-flow. Prefer "Other"; if the user
  // deleted it, any non-Transfers category beats Transfers.
  const otherCat =
    vault.categories.find((c) => c.role === 'other')?.id ??
    vault.categories.find((c) => c.id !== CAT_TRANSFERS)?.id ??
    CAT_TRANSFERS

  // §10.1 rung between rules and fallback: a category the user set BY HAND on the same merchant
  // before beats the "Other" fallback. Only `manual` transactions seed it (§10.5), so it never
  // feeds its own output back; the suggestion stays needs-review and is left for the AI to skip.
  const manualHistory = buildManualHistory(vault.transactions)

  // §10.1 rung between rules and history: a category the FILE itself states (Privat prints one per
  // row). Resolved by name against what the vault already holds — a category the user does not have
  // is never minted, the row just falls through. Above `history` because a merchant the user has
  // hand-categorized already mints a `learned` rule that beat this rung one step earlier.
  const catIdByName = new Map<string, string>()
  for (const c of [...vault.categories, ...(pack?.categories ?? [])]) catIdByName.set(c.name.toLowerCase(), c.id)

  const rows: PlannedRow[] = norm.map((r, i) => {
    const hash = hashes[i]!
    const prior = priorIdOf(i)
    if (prior !== undefined) {
      return { norm: r, hash, status: 'duplicate', duplicateOf: prior, categoryId: otherCat, provenance: 'fallback', needsReview: false }
    }
    const pair = pairByLine.get(r.sourceLine)
    if (pair?.existingTxnId) {
      const gid = uuidv7()
      transferLinks.push({ existingTxnId: pair.existingTxnId, transferGroupId: gid })
      return { norm: r, hash, status: 'new', categoryId: CAT_TRANSFERS, provenance: 'transfer', needsReview: false, transferGroupId: gid }
    }
    if (pair?.ambiguous) {
      return { norm: r, hash, status: 'new', categoryId: otherCat, provenance: 'fallback', needsReview: true, ambiguous: pair.ambiguous }
    }
    const hit = evaluateRules(r, rulesForEval)
    if (hit) return { norm: r, hash, status: 'new', categoryId: hit.categoryId, provenance: `rule:${hit.ruleId}`, needsReview: false }
    const bankCat = r.bankCategory ? catIdByName.get(r.bankCategory.toLowerCase()) : undefined
    if (bankCat) return { norm: r, hash, status: 'new', categoryId: bankCat, provenance: 'bank', needsReview: false }
    const seen = historyLookup(r, manualHistory)
    if (seen) return { norm: r, hash, status: 'new', categoryId: seen, provenance: 'history', needsReview: true }
    return { norm: r, hash, status: 'new', categoryId: otherCat, provenance: 'fallback', needsReview: true }
  })

  const newRows = rows.filter((r) => r.status === 'new')
  const duplicates = rows.filter((r) => r.status === 'duplicate').length
  // History rows are needs-review suggestions, not auto-applied — counted apart from `autoCategorized`.
  const fromHistory = newRows.filter((r) => r.provenance === 'history').length
  const autoCategorized = newRows.filter((r) => r.provenance !== 'fallback' && r.provenance !== 'history').length
  const needReview = newRows.filter((r) => r.needsReview).length

  // Balance anchors (§5.6 / §6.7): the two period endpoints, plus one per covered month when the
  // file carries a per-row balance chain (see `chainAnchors`). An endpoint whose date a chain
  // anchor already holds is dropped: snapshots are day-granular, so two on one date can't be
  // ordered, and the chain anchor is the end-of-day figure while the implied opening describes
  // the moment *before* the first row. Without a chain (BNP) the endpoints are all there is.
  const chain = chainAnchors(norm)
  const anchoredDates = new Set(chain.map((a) => a.date))
  const snapshots: ImportPlan['snapshots'] = []
  if (parsed.openingBalance !== undefined && !anchoredDates.has(parsed.periodFrom)) snapshots.push({ date: parsed.periodFrom, amount: parsed.openingBalance, at: 'open' })
  snapshots.push(...chain)
  if (parsed.closingBalance !== undefined && !anchoredDates.has(parsed.periodTo)) snapshots.push({ date: parsed.periodTo, amount: parsed.closingBalance, at: 'close' })

  // Gap / mismatch notes vs existing statements of the same account (§6.7).
  const notes: ImportPlan['notes'] = []
  if (accountId) {
    const priors = vault.statements.filter((s) => s.accountId === accountId).sort((a, b) => (a.periodTo < b.periodTo ? -1 : 1))
    const before = [...priors].reverse().find((s) => s.periodTo <= parsed.periodFrom)
    if (before && before.closingBalance !== undefined && parsed.openingBalance !== undefined) {
      const contiguous = daysBetween(before.periodTo, parsed.periodFrom) <= 1
      const sym = symOf(parsed.accountCurrency)
      if (!contiguous) {
        notes.push({ kind: 'stmt-gap', label: `Statements missing between ${fmtDate(before.periodTo)} (${sym}${before.closingBalance.toLocaleString('en')}) and ${fmtDate(parsed.periodFrom)} (${sym}${parsed.openingBalance.toLocaleString('en')})` })
      } else if (Math.abs(Math.round(before.closingBalance * 100) - Math.round(parsed.openingBalance * 100)) > 0) {
        notes.push({ kind: 'stmt-mismatch', label: `Balance disagrees at ${fmtDate(parsed.periodFrom)}: ${sym}${before.closingBalance} vs ${sym}${parsed.openingBalance}` })
      }
    }

    // Overlap warning. Ring-1 only catches a re-import when the hash matches; a row whose descriptor
    // the adapter spells differently in this variant (an ATM withdrawal, a merchant an export renames
    // to its payment processor) sails through as new and double-imports. So when this file restates a
    // period some statement already covers, check the rows it wants to ADD against what is already
    // on the account by (amount, ±1 day) and say so. Never a refusal — a legitimately overlapping
    // export must still import; the point is that the user sees it before committing.
    const overlapping = priors.filter((s) => s.periodFrom <= parsed.periodTo && s.periodTo >= parsed.periodFrom)
    if (overlapping.length > 0 && newRows.length > 0) {
      const lo = overlapping.reduce((m, s) => (s.periodFrom > m ? s.periodFrom : m), parsed.periodFrom)
      const hi = overlapping.reduce((m, s) => (s.periodTo < m ? s.periodTo : m), parsed.periodTo)
      const inWindow = newRows.filter((r) => r.norm.bookedDate >= lo && r.norm.bookedDate <= hi)
      const already = vault.transactions.filter(
        (t) => t.accountId === accountId && t.date >= shiftDate(lo, -1) && t.date <= shiftDate(hi, 1),
      )
      const claimed = new Set<string>()
      let matched = 0
      const hits: { row: PlannedRow; txnId: string }[] = []
      for (const r of inWindow) {
        const hit = already.find(
          (t) => !claimed.has(t.id) && Math.round(t.amount * 100) === r.norm.amountMinor && daysBetween(t.date, r.norm.bookedDate) <= 1,
        )
        if (hit) {
          claimed.add(hit.id)
          matched++
          hits.push({ row: r, txnId: hit.id })
        }
      }
      // Mark the matched rows so the review can leave them out by default. Gated on the same
      // threshold as the note: a couple of coincidental amounts inside an overlap is not evidence,
      // a whole file's worth is. Marking is not deleting — the row is shown, explained, and one
      // click puts it back in.
      if (matched >= 3 && matched / inWindow.length >= 0.9) {
        for (const h of hits) h.row.suspectedDuplicateOf = h.txnId
      }
      if (matched >= 3 && matched / inWindow.length >= 0.9) {
        const names = overlapping.map((s) => s.fileName).join(', ')
        notes.push({
          kind: 'stmt-overlap',
          label: `Overlaps ${names} (${fmtDate(lo)} → ${fmtDate(hi)}) — ${matched} of ${inWindow.length} rows to add already exist under a different descriptor. Likely duplicates.`,
        })
      }
    }
  }

  const statement: ImportPlan['statement'] = {
    institutionId: institution,
    variant: variant ?? parsed.variant,
    fileName: file.name,
    fileHash: fh,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    openingBalance: parsed.openingBalance,
    closingBalance: parsed.closingBalance,
    rowsTotal: norm.length + parsed.skipped.pending + parsed.skipped.reverted,
    rowsImported: newRows.length,
    rowsSkipped: { duplicate: duplicates, pending: parsed.skipped.pending, reverted: parsed.skipped.reverted, unparsed: parsed.skipped.unparsed.length },
    importedAt: '', // stamped at commit
  }

  return {
    detection: { institution, variant: variant ?? parsed.variant, confidence: choices.institution ? 1 : 0.95, hints: { locale: parsed.locale } },
    parsed,
    fileHash: fh,
    groups,
    groupKey,
    account: {
      mode,
      accountId,
      suggestedName: name,
      currency: parsed.accountCurrency,
      fingerprint: resolvedAccount?.fingerprint ?? parsed.fingerprint ?? null,
      institutionId: institution,
      candidates: [...fpCandidates, ...signalCandidates, ...adoptCandidates, ...pickCandidates],
      mustName,
    },
    learnAccountKeys,
    rows,
    counts: {
      total: norm.length,
      // Suspected duplicates are excluded by default, so they are not part of what will be added.
      toAdd: newRows.filter((r) => !r.suspectedDuplicateOf).length,
      autoCategorized,
      fromHistory,
      needReview,
      duplicates,
      suspected: newRows.filter((r) => r.suspectedDuplicateOf).length,
      pending: parsed.skipped.pending,
      reverted: parsed.skipped.reverted,
      unparsed: parsed.skipped.unparsed.length,
    },
    snapshots,
    statement,
    transferLinks,
    notes,
    reconciliation: { ok: true, closing: parsed.closingBalance ?? 0 },
    starterPackOffer: shouldOfferStarterPack(vault, institution),
    newCategories: pack?.categories,
    newRules: pack?.rules,
  }
}

/**
 * One balance anchor per month the file covers, read off a per-row balance chain (§5.6).
 *
 * A chain file (Revolut) knows the account's balance on every day it covers, but only the two
 * period endpoints were ever anchored. The net-worth chart buckets snapshots by month and hatches
 * any anchor-free interior month as "statements missing", so a multi-year export anchored at its
 * ends alone read as a multi-year hole in an account whose history is in fact complete.
 *
 * `norm` is in chain order — `reconcile` refuses the file otherwise — so the last row seen for a
 * month carries that month's closing balance. No chain (BNP) ⇒ no anchors beyond the endpoints.
 */
function chainAnchors(norm: NormalizedRow[]): ImportPlan['snapshots'] {
  if (norm.length === 0 || !norm.every((r) => r.balanceAfterMinor !== undefined)) return []
  const byMonth = new Map<string, ImportPlan['snapshots'][number]>()
  for (const r of norm) byMonth.set(r.bookedDate.slice(0, 7), { date: r.bookedDate, amount: round2(r.balanceAfterMinor!), at: 'close' })
  return [...byMonth.values()]
}

interface ReconcileOk {
  ok: true
}
interface ReconcileFail {
  ok: false
  reason: 'chain' | 'totals'
  delta: number
  /** The row the chain breaks at — named in the refusal instead of a bare delta. */
  at?: { line: number; date: string; merchant: string }
}

function reconcile(
  norm: NormalizedRow[],
  opening: number | undefined,
  closing: number | undefined,
  printedTotals: { debitMinor: number; creditMinor: number } | undefined,
): ReconcileOk | ReconcileFail {
  // Revolut: per-row balance chain (§5.6).
  const hasChain = norm.length > 0 && norm.every((r) => r.balanceAfterMinor !== undefined)
  if (hasChain) {
    for (let i = 1; i < norm.length; i++) {
      const expected = norm[i - 1]!.balanceAfterMinor! + norm[i]!.amountMinor
      if (expected !== norm[i]!.balanceAfterMinor!) {
        const r = norm[i]!
        return { ok: false, reason: 'chain', delta: (r.balanceAfterMinor! - expected) / 100, at: { line: r.sourceLine, date: r.bookedDate, merchant: r.merchant } }
      }
    }
    return { ok: true }
  }
  // BNP: opening + Σ == closing, and printed totals match (§6.6).
  if (opening !== undefined && closing !== undefined) {
    const sum = norm.reduce((t, r) => t + r.amountMinor, 0)
    const expectedClose = Math.round(opening * 100) + sum
    if (expectedClose !== Math.round(closing * 100)) {
      return { ok: false, reason: 'totals', delta: (Math.round(closing * 100) - expectedClose) / 100 }
    }
    if (printedTotals) {
      const debit = norm.filter((r) => r.amountMinor < 0).reduce((t, r) => t - r.amountMinor, 0)
      const credit = norm.filter((r) => r.amountMinor > 0).reduce((t, r) => t + r.amountMinor, 0)
      if (debit !== printedTotals.debitMinor || credit !== printedTotals.creditMinor) {
        return { ok: false, reason: 'totals', delta: (credit - debit - (printedTotals.creditMinor - printedTotals.debitMinor)) / 100 }
      }
    }
    return { ok: true }
  }
  return { ok: true } // no declared balances → nothing to gate on
}

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

function shiftDate(d: string, days: number): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)
}

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`
}

/**
 * Which rung of the §10.1 ladder placed a row, in the form the vault stores — carried past
 * the commit so a committed transaction can still be told apart from a rule hit or a hand
 * decision. `rule:${id}` collapses to `rule`: the rule may later be deleted, but the fact
 * that *a* rule decided it survives.
 */
function committedProvenance(p: PlannedRow['provenance']): Transaction['provenance'] {
  return p === 'ai' || p === 'transfer' || p === 'fallback' || p === 'history' ? p : 'rule'
}

/** Turn a confirmed plan into the single atomic `applyImport` op (§12.1). */
export function planToOp(plan: ImportPlan, decisions: RowDecision[] = [], tripTags: { hash: string; trackingId: string; dir?: 'include' | 'exclude' }[] = []): ApplyImportOp {
  const byHash = new Map(decisions.map((d) => [d.hash, d]))
  const tagsByHash = new Map<string, { trackingId: string; dir: 'include' | 'exclude' }[]>()
  for (const t of tripTags) tagsByHash.set(t.hash, [...(tagsByHash.get(t.hash) ?? []), { trackingId: t.trackingId, dir: t.dir ?? 'include' }])
  const trackingAssignments: ApplyImportOp['trackingAssignments'] = []
  const txns: NewImportTxn[] = []
  for (const row of plan.rows) {
    if (row.status !== 'new') continue
    const dec = byHash.get(row.hash)
    // A row an overlapping statement already appears to hold is left out unless the user said to
    // keep it — the whole point of marking it (IMPORT §8.1).
    if (row.suspectedDuplicateOf && !dec?.keepAnyway) continue
    for (const tag of tagsByHash.get(row.hash) ?? []) trackingAssignments.push({ rowIndex: txns.length, trackingId: tag.trackingId, dir: tag.dir })
    let categoryId = dec?.categoryId ?? row.categoryId
    let transferGroupId = row.transferGroupId
    if (row.ambiguous && dec?.keepAsIncome) transferGroupId = undefined
    const r = row.norm
    txns.push({
      date: r.bookedDate,
      merchant: r.merchant,
      categoryId,
      amount: round2(r.amountMinor),
      accountId: '', // filled from resolved account at apply
      currency: r.currency !== plan.account.currency ? r.currency : undefined,
      original: r.original,
      fee: r.feeMinor !== undefined ? round2(r.feeMinor) : undefined,
      counterparty: r.counterparty,
      transferGroupId,
      provenance: dec?.categoryId ? 'manual' : committedProvenance(row.provenance),
      importMeta: {
        hash: row.hash,
        file: plan.statement.fileName,
        source: plan.detection.institution,
        variant: plan.detection.variant,
        line: r.sourceLine,
        ref: r.ref,
        balanceAfter: r.balanceAfterMinor !== undefined ? round2(r.balanceAfterMinor) : undefined,
        raw: r.raw,
      },
    })
  }

  const op: ApplyImportOp = {
    kind: 'applyImport',
    statement: { ...plan.statement, importedAt: now() },
    txns,
    snapshots: plan.snapshots.map((s) => ({ accountId: '', date: s.date, amount: s.amount, at: s.at })),
    transferLinks: plan.transferLinks.length ? plan.transferLinks : undefined,
    // Remember a user-confirmed binding so a future file with the same signal auto-binds (§5.8).
    learnAccountKeys: plan.learnAccountKeys,
    newCategories: plan.newCategories,
    newRules: plan.newRules,
    notes: plan.notes.length ? plan.notes : undefined,
    trackingAssignments: trackingAssignments.length ? trackingAssignments : undefined,
  }
  if (plan.account.mode === 'create') {
    const fp = plan.account.fingerprint ?? undefined
    op.newAccount = {
      name: plan.account.suggestedName,
      liab: false,
      liquid: true,
      institutionId: plan.account.institutionId,
      fingerprint: fp,
      // Store the account's identity signals. `last4`/`holderNames` are the suggestion pool; only a
      // real RIB seeds `matchKeys` (self-proving ⇒ auto next time). A last-4/holder becomes an
      // auto-key only once the user confirms it, via `learnAccountKeys` (§5.8).
      last4: plan.parsed.accountMask,
      holderNames: plan.parsed.holderNames,
      matchKeys: fp && !fp.startsWith(`${plan.account.institutionId}:mask:`) ? [`rib:${fp}`] : undefined,
      currency: plan.account.currency,
    }
  } else if (plan.account.mode === 'adopt' && plan.account.accountId) {
    op.adoptAccount = {
      accountId: plan.account.accountId,
      institutionId: plan.account.institutionId,
      // Never fabricate a fingerprint — a non-account-unique value (e.g. the bare
      // institution id) would make the merge unify two distinct adopted accounts.
      fingerprint: plan.account.fingerprint ?? undefined,
      currency: plan.account.currency,
    }
  } else if (plan.account.accountId) {
    op.accountId = plan.account.accountId
  }
  return op
}
