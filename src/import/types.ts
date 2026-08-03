import type { Category, DateStr, Rule, StatementRecord } from '../model/types'

// ---- source & detection (IMPORT §3.1) ----

export type Container = 'xlsx' | 'pdf' | 'csv' | 'tsv'

export interface SourceFile {
  name: string
  bytes: Uint8Array
  container: Container
}

export interface Detection {
  institution: string // 'revolut' | 'bnp' | 'privat' | 'pumb' | 'monobank'
  variant: string // 'xlsx' | 'csv' | 'pdf'
  confidence: number // 0..1 — <0.6 ⇒ ask the user
  hints?: { locale?: string; periodFrom?: DateStr; periodTo?: DateStr }
}

/** Cheap pre-parsed view handed to detect(): first header row / first page text. */
export interface Peek {
  container: Container
  /** Spreadsheet first-sheet header cells / CSV header line split into fields. */
  headerCells?: string[]
  /** Spreadsheet first ~6 rows as strings — a detector whose header/preamble is not row 0
   *  (BNP mabanque export: preamble on row 0, column header on row 2) reads them here. */
  sheetRows?: string[][]
  /** PDF first-page reconstructed text (lines joined by \n). */
  firstPageText?: string
  /** Raw first ~20 text lines (CSV/TSV). */
  textLines?: string[]
  fileName: string
}

// ---- parsed & normalized rows (IMPORT §3.1 / §7.1) ----

export interface ParsedRow {
  [k: string]: unknown
}

export interface ParsedStatement {
  institution: string
  variant: string
  locale?: string
  fingerprint: string | null // stable account key; null ⇒ needs mapping
  /** Masked account tail (BNP mabanque `****4242`) when the file has no full account key —
   *  correlated against an existing account's fingerprint by last-4 (§5.8). */
  accountMask?: string
  holderNames?: string[]
  /** Sub-account discriminator when the format has one (Revolut `Product`, §5.8). */
  productName?: string
  accountCurrency: string
  periodFrom: DateStr
  periodTo: DateStr
  openingBalance?: number // account currency, decimal
  closingBalance?: number
  /** Printed statement totals when the format states them (BNP `TOTAL DES OPERATIONS`). */
  printedTotals?: { debitMinor: number; creditMinor: number }
  rows: ParsedRow[] // source order preserved — identity depends on it
  skipped: { pending: number; reverted: number; unparsed: string[] }
  /** Set when header binding fell back to positional (localized-header miss). */
  headerWarning?: boolean
}

export interface NormalizedRow {
  bookedDate: DateStr
  amountMinor: number // NET signed integer, account currency
  currency: string
  original?: { amount: number; currency: string } // foreign leg, natural units as printed (Convention #3)
  feeMinor?: number // informational; already folded into amountMinor
  merchant: string
  normDesc: string // identity input, NOT for display
  /** The descriptor as an earlier build canonicalized it, when a normalizer change moved it. Ring-1
   *  hashes under this too, so rows committed before the change still dedupe (IMPORT §8.1). */
  legacyNormDesc?: string
  counterparty?: string
  kind: 'expense' | 'refund' | 'transfer-in' | 'transfer-out' | 'fee' | 'other'
  /**
   * The Ledger category NAME the source file's own classification maps to, when the format
   * carries one (Privat's `Category` column). The adapter owns the mapping; the pipeline only
   * resolves the name against categories the vault ALREADY has and never mints one (§10.1).
   */
  bankCategory?: string
  creditorId?: string // SEPA SCI when present (best categorization key)
  ref?: string // SEPA end-to-end / instant-transfer ref
  balanceAfterMinor?: number
  sourceLine: number // position in the statement — occurrence ordering
  raw: string
}

// ---- adapter contract (IMPORT §3.1) ----

export interface InstitutionAdapter {
  id: string
  displayName: string
  detect(file: SourceFile, peek: Peek): Detection | null
  parse(file: SourceFile, variant: string): Promise<ParsedStatement>
  /**
   * One statement per account the file carries (§5.8) — Revolut interleaves the
   * ledgers of every product+currency in one export, and each has its own balance
   * chain, anchors and fingerprint. Always ≥1 entry; `parse` returns the first.
   * Absent ⇒ the file is a single account.
   */
  parseAll?(file: SourceFile, variant: string): Promise<ParsedStatement[]>
  normalize(stmt: ParsedStatement): NormalizedRow[]
}

// ---- pipeline output (plan) — the contract between pipeline and UI/tests ----

export type RefusalKind =
  | 'unrecognized'
  | 'scanned-pdf'
  | 'reconcile-mismatch'
  | 'chain-break'
  | 'encrypted-pdf'
  | 'already-imported'
  | 'unreadable'

export interface Refusal {
  refusal: RefusalKind
  message: string
  details?: unknown
}

export function isRefusal(x: ImportPlan | Refusal): x is Refusal {
  return (x as Refusal).refusal !== undefined
}

export interface TransferCandidate {
  txnId: string
  accountId: string
  score: number
}

export interface PlannedRow {
  norm: NormalizedRow
  hash: string
  status: 'new' | 'duplicate' | 'pending' | 'reverted'
  /** For a `duplicate` row: the id of the existing vault transaction it matched (verify panel). */
  duplicateOf?: string
  /**
   * Ring-1 found no hash match, but this file restates a period an existing statement already covers
   * and a row there has the same amount within a day — the shape a cross-variant descriptor takes
   * (IMPORT §8.1). Stays `status: 'new'` because it is a suspicion, not proof: it is excluded from
   * the commit by default and one click puts it back (`RowDecision.keepAnyway`).
   */
  suspectedDuplicateOf?: string
  categoryId: string
  provenance: 'transfer' | `rule:${string}` | 'bank' | 'fallback' | 'ai' | 'history'
  needsReview: boolean
  /** Assist confidence when provenance === 'ai' (§10.6). */
  aiConfidence?: number
  transferGroupId?: string
  /** Populated when two candidate matches are within a score point (§9.2). */
  ambiguous?: TransferCandidate[]
}

export interface AccountCandidate {
  accountId: string
  name: string
  reason: 'fingerprint' | 'signal' | 'adopt' | 'pick' // proven auto-match · weak signal to confirm · manual account to adopt · existing account offered to pick
  preselect?: boolean
  /** For a `signal` candidate: the matched clue to show the user (e.g. `····4242`). */
  signal?: string
}

export interface NewSnapshotPlan {
  date: DateStr
  amount: number
  /** Which side of `date` the figure describes (see `BalanceSnapshot.origin`). */
  at: 'open' | 'close'
}

export interface ImportPlan {
  detection: Detection
  parsed: ParsedStatement
  fileHash: string
  /** Every account this file carries (§5.8); one entry for an ordinary statement. */
  groups: { key: string; label: string; rows: number }[]
  /** Which of `groups` this plan is for — the rest are reviewed one after another. */
  groupKey: string
  account: {
    // 'confirm' = a weak signal suggests an account; the user must confirm before importing (§5.8).
    mode: 'existing' | 'create' | 'adopt' | 'choose' | 'confirm'
    accountId?: string
    suggestedName: string
    currency: string
    fingerprint: string | null
    institutionId: string
    candidates: AccountCandidate[]
    /** A no-signal 'create' the user hasn't confirmed: block the import until they name it or pick an
     *  existing account, so an unidentifiable file never silently mints a generic ghost account (§5.8). */
    mustName?: boolean
  }
  /** Remember a user-confirmed file→account binding: append these signals to the account's
   *  matchKeys so a future file carrying one auto-binds (§5.8). */
  learnAccountKeys?: { accountId: string; keys: string[] }
  rows: PlannedRow[]
  counts: {
    total: number
    toAdd: number
    autoCategorized: number
    /** Rows pre-filled from the user's own past hand-categorizations (§10.1) — a subset of needReview. */
    fromHistory: number
    needReview: number
    duplicates: number
    /** Rows an overlapping statement appears to already hold — excluded from `toAdd` unless kept. */
    suspected: number
    pending: number
    reverted: number
    unparsed: number
  }
  snapshots: NewSnapshotPlan[]
  statement: Omit<StatementRecord, 'id' | 'updatedAt' | 'accountId'>
  transferLinks: { existingTxnId: string; transferGroupId: string }[]
  notes: { kind: 'stmt-gap' | 'stmt-mismatch' | 'stmt-overlap'; label: string }[]
  reconciliation: { ok: true; closing: number } | { ok: false; delta: number }
  starterPackOffer: boolean
  /** Present when this plan was built with the starter pack accepted (§10.4). */
  newCategories?: Category[]
  newRules?: Rule[]
}

/** A row decision confirmed by the review UI (category override / keep as income). */
export interface RowDecision {
  hash: string
  categoryId?: string
  keepAsIncome?: boolean // for txfr-ambiguous rows the user chose not to pair
  /** Import a `suspectedDuplicateOf` row anyway — the user says it is a genuine second charge. */
  keepAnyway?: boolean
}
