import type {
  Account,
  AnyRecord,
  BalanceSnapshot,
  Budget,
  Category,
  CollectionName,
  ConflictEntry,
  ConflictKind,
  Goal,
  MonthKey,
  Params,
  Rule,
  SaveMode,
  Skill,
  StatementRecord,
  Tracking,
  TrackingAssignment,
  Transaction,
  Vault,
} from './types'
import { CAT_TRANSFERS } from './types'
import { now, uuidv7 } from './clock'

export interface NewTxn {
  date: string
  merchant: string
  categoryId: string
  amount: number
  note?: string
}

export interface NewSnapshot {
  accountId: string
  date: string
  amount: number
  /** Import anchors only — which side of `date` the figure describes (see `BalanceSnapshot.origin`). */
  at?: 'open' | 'close'
}

export interface NewAccount {
  name: string
  institution?: string
  last4?: string
  liab: boolean
  liquid: boolean
  apr?: number
  monthlyPayment?: number
  institutionId?: string
  fingerprint?: string
  currency?: string
  holderNames?: string[]
  matchKeys?: string[]
}

/** A transaction as produced by the import pipeline (id/updatedAt minted at apply). */
export interface NewImportTxn {
  date: string
  merchant: string
  categoryId: string
  amount: number
  accountId: string
  currency?: string
  original?: { amount: number; currency: string }
  fee?: number
  counterparty?: string
  transferGroupId?: string
  provenance?: Transaction['provenance']
  importMeta: Transaction['importMeta']
}

export type NewStatement = Omit<StatementRecord, 'id' | 'updatedAt' | 'accountId'>

export interface ApplyImportOp {
  kind: 'applyImport'
  statement: NewStatement
  txns: NewImportTxn[]
  snapshots: NewSnapshot[]
  /** Create the account this import belongs to … */
  newAccount?: NewAccount
  /** … or adopt a pre-existing manual account in place (§5.8). */
  adoptAccount?: { accountId: string; institutionId: string; fingerprint?: string; currency: string }
  /** … or target an existing fingerprinted account. */
  accountId?: string
  /** Remember the user's confirmation: append these tagged signals to the account's matchKeys so a
   *  future file with the same signal auto-binds (§5.8). Undo removes exactly the added ones. */
  learnAccountKeys?: { accountId: string; keys: string[] }
  newCategories?: Category[]
  newRules?: Rule[]
  transferLinks?: { existingTxnId: string; transferGroupId: string }[]
  /** Import-raised notes (stmt-gap / stmt-mismatch) surfaced on the sync-notes sheet. */
  notes?: { kind: ConflictKind; label: string }[]
  /** Trip tags applied to freshly-minted rows by index into `txns` (ANALYTICS §8.1). */
  trackingAssignments?: { rowIndex: number; trackingId: string; dir: 'include' | 'exclude' }[]
}

/** A tracking membership direction; 'clear' drops the assignment entirely. */
export type AssignmentDir = 'include' | 'exclude' | 'clear'

export interface NewTracking {
  name: string
  kind: 'trip' | 'set'
  color?: string
  dateFrom?: string
  dateTo?: string
}

export type NewSkill = Omit<Skill, 'id' | 'updatedAt'>

export interface RevertImportOp {
  kind: 'revertImport'
  txnIds: string[]
  snapshotIds: string[]
  statementId: string
  createdAccountId?: string
  adopt?: { accountId: string; prev: Partial<Pick<Account, 'institutionId' | 'fingerprint' | 'currency'>> }
  /** matchKeys appended by a confirmation this import carried — removed on undo. */
  learnedKeys?: { accountId: string; keys: string[] }
  categoryIds?: string[]
  ruleIds?: string[]
  unlink?: { txnId: string; prevCategoryId: string }[]
  noteIds?: string[]
  assignmentIds?: string[]
}

export type Op =
  | { kind: 'addTransaction'; txn: NewTxn }
  | { kind: 'delete'; collection: CollectionName; ids: string[] }
  | { kind: 'restore'; collection: CollectionName; records: AnyRecord[] }
  | { kind: 'addBudget'; categoryId: string; amount: number; name?: string; scope?: Budget['scope'] }
  /** Whole-form replace, mirroring `updateGoal`: the budget dialog always holds every field.
   *  `categoryId` is part of it because changing scope kind moves the parking between a real
   *  category and CAT_TRANSFERS. */
  | { kind: 'updateBudget'; id: string; categoryId: string; amount: number; name?: string; scope?: Budget['scope'] }
  /** `saved`, `source` and `targetDate` are optional so the plain three-field call still works;
   *  the goal dialog supplies them so creating a linked goal is ONE op and one undo. */
  | { kind: 'addGoal'; name: string; target: number; monthly: number; saved?: number; source?: Goal['source']; targetDate?: MonthKey }
  | { kind: 'updateGoal'; id: string; name: string; target: number; monthly: number }
  | { kind: 'setGoalMonthly'; id: string; monthly: number }
  | { kind: 'setGoalSaved'; id: string; saved: number }
  | { kind: 'appendSnapshots'; snapshots: NewSnapshot[] }
  | { kind: 'addAccount'; account: NewAccount }
  | { kind: 'setField'; collection: CollectionName; id: string; field: string; value: unknown }
  | { kind: 'setSingletonField'; collection: 'params' | 'settings'; field: string; value: unknown }
  | { kind: 'setParam'; key: Exclude<keyof Omit<Params, 'id' | 'updatedAt'>, 'baseCurrency' | 'reconTolerance' | 'rulesOfThumb'>; value: number }
  | { kind: 'setSaveMode'; saveMode: SaveMode }
  | { kind: 'useOtherValue'; noteId: string }
  | { kind: 'markNoteReviewed'; noteId: string }
  | ApplyImportOp
  | RevertImportOp
  | { kind: 'recategorizeBatch'; txnIds: string[]; categoryId: string }
  | { kind: 'setTxnCategories'; entries: { id: string; categoryId: string; provenance?: Transaction['provenance'] }[] }
  | { kind: 'resolveTransferPair'; txnIds: string[]; transferGroupId: string }
  | { kind: 'unlinkTransferPair'; transferGroupId: string; restore?: { id: string; categoryId: string }[] }
  | { kind: 'addTracking'; tracking: NewTracking; assignments?: { txnId: string; dir: 'include' | 'exclude' }[] }
  | { kind: 'removeTracking'; trackingId: string }
  | { kind: 'restoreTracking'; tracking: Tracking; assignments: TrackingAssignment[] }
  /** Removal and edits go through the generic `delete`/`restore`/`setField` arms. */
  | { kind: 'addSkill'; skill: NewSkill }
  | { kind: 'setAssignment'; trackingId: string; txnId: string; dir: AssignmentDir }
  | { kind: 'setAssignments'; trackingId: string; entries: { txnId: string; dir: AssignmentDir }[] }
  /** One gesture that spans collections, so it undoes as one (SYNC §2.3). Applied in order. */
  | { kind: 'batch'; ops: Op[] }

export interface ApplyResult {
  vault: Vault
  /** Forward mutation that undoes this op (SYNC §2.3: undo is just another mutation). */
  inverse?: Op
}

/**
 * Pure, immutable application of a mutation. Every touched record is stamped
 * with updatedAt = now(). The caller (store) is responsible for persistence
 * side effects (dirty-marking, autosave, broadcast).
 */
export function applyOp(vault: Vault, op: Op): ApplyResult {
  const t = now()

  switch (op.kind) {
    case 'batch': {
      let v = vault
      const inverses: Op[] = []
      for (const sub of op.ops) {
        const res = applyOp(v, sub)
        if (res.vault === v) continue // a no-op sub-op contributes nothing to undo
        v = res.vault
        if (res.inverse) inverses.unshift(res.inverse) // undo runs in reverse
      }
      if (v === vault) return { vault }
      return { vault: v, inverse: { kind: 'batch', ops: inverses } }
    }

    case 'addTransaction': {
      const txn: Transaction = { id: uuidv7(), updatedAt: t, ...op.txn }
      return {
        vault: { ...vault, transactions: [...vault.transactions, txn] },
        inverse: { kind: 'delete', collection: 'transactions', ids: [txn.id] },
      }
    }

    case 'delete': {
      const idSet = new Set(op.ids)
      const removed = (vault[op.collection] as AnyRecord[]).filter((r) => idSet.has(r.id))
      if (removed.length === 0) return { vault }
      const kept = (vault[op.collection] as AnyRecord[]).filter((r) => !idSet.has(r.id))
      const tombstones = [
        ...vault.tombstones,
        ...removed.map((r) => ({ id: r.id, collection: op.collection, deletedAt: t, updatedAt: t })),
      ]
      return {
        vault: { ...vault, [op.collection]: kept, tombstones },
        inverse: { kind: 'restore', collection: op.collection, records: removed },
      }
    }

    case 'restore': {
      const ids = new Set(op.records.map((r) => r.id))
      const restored = op.records.map((r) => ({ ...r, updatedAt: t }))
      return {
        vault: {
          ...vault,
          [op.collection]: [...(vault[op.collection] as AnyRecord[]), ...restored],
          tombstones: vault.tombstones.filter((ts) => !(ts.collection === op.collection && ids.has(ts.id))),
        },
        inverse: { kind: 'delete', collection: op.collection, ids: [...ids] },
      }
    }

    case 'addBudget': {
      const b: Budget = { id: uuidv7(), updatedAt: t, categoryId: op.categoryId, amount: op.amount, name: op.name, scope: op.scope }
      return {
        vault: { ...vault, budgets: [...vault.budgets, b] },
        inverse: { kind: 'delete', collection: 'budgets', ids: [b.id] },
      }
    }

    case 'updateBudget': {
      const prev = vault.budgets.find((b) => b.id === op.id)
      if (!prev) return { vault }
      return {
        vault: {
          ...vault,
          // Every field written verbatim, `undefined` included — that is how the inverse
          // restores a budget that carried no name or no scope.
          budgets: vault.budgets.map((b) =>
            b.id === op.id ? { ...b, categoryId: op.categoryId, amount: op.amount, name: op.name, scope: op.scope, updatedAt: t } : b,
          ),
        },
        inverse: { kind: 'updateBudget', id: op.id, categoryId: prev.categoryId, amount: prev.amount, name: prev.name, scope: prev.scope },
      }
    }

    case 'addGoal': {
      const g: Goal = {
        id: uuidv7(), updatedAt: t, name: op.name, target: op.target, saved: op.saved ?? 0, monthly: op.monthly,
        source: op.source, targetDate: op.targetDate,
      }
      return {
        vault: { ...vault, goals: [...vault.goals, g] },
        inverse: { kind: 'delete', collection: 'goals', ids: [g.id] },
      }
    }

    case 'updateGoal': {
      const prev = vault.goals.find((g) => g.id === op.id)
      if (!prev) return { vault }
      return {
        vault: {
          ...vault,
          goals: vault.goals.map((g) => (g.id === op.id ? { ...g, name: op.name, target: op.target, monthly: op.monthly, updatedAt: t } : g)),
        },
        inverse: { kind: 'updateGoal', id: op.id, name: prev.name, target: prev.target, monthly: prev.monthly },
      }
    }

    case 'setGoalMonthly': {
      const prev = vault.goals.find((g) => g.id === op.id)
      if (!prev) return { vault }
      return {
        vault: {
          ...vault,
          goals: vault.goals.map((g) => (g.id === op.id ? { ...g, monthly: op.monthly, updatedAt: t } : g)),
        },
        inverse: { kind: 'setGoalMonthly', id: op.id, monthly: prev.monthly },
      }
    }

    case 'setGoalSaved': {
      const prev = vault.goals.find((g) => g.id === op.id)
      if (!prev) return { vault }
      return {
        vault: {
          ...vault,
          goals: vault.goals.map((g) => (g.id === op.id ? { ...g, saved: op.saved, updatedAt: t } : g)),
        },
        inverse: { kind: 'setGoalSaved', id: op.id, saved: prev.saved },
      }
    }

    case 'appendSnapshots': {
      const snaps: BalanceSnapshot[] = op.snapshots.map((s) => ({
        id: uuidv7(),
        updatedAt: t,
        createdAt: t,
        ...s,
      }))
      return {
        vault: { ...vault, snapshots: [...vault.snapshots, ...snaps] },
        inverse: { kind: 'delete', collection: 'snapshots', ids: snaps.map((s) => s.id) },
      }
    }

    case 'addAccount': {
      const a: Account = { id: uuidv7(), updatedAt: t, ...op.account }
      return {
        vault: { ...vault, accounts: [...vault.accounts, a] },
        inverse: { kind: 'delete', collection: 'accounts', ids: [a.id] },
      }
    }

    case 'setField': {
      const list = vault[op.collection] as AnyRecord[]
      const prev = list.find((r) => r.id === op.id)
      if (!prev) return { vault }
      const next = list.map((r) => (r.id === op.id ? { ...r, [op.field]: op.value, updatedAt: t } : r))
      return {
        vault: { ...vault, [op.collection]: next },
        inverse: {
          kind: 'setField',
          collection: op.collection,
          id: op.id,
          field: op.field,
          value: (prev as unknown as Record<string, unknown>)[op.field],
        },
      }
    }

    case 'setSingletonField': {
      const prev = (vault[op.collection] as unknown as Record<string, unknown>)[op.field]
      return {
        vault: { ...vault, [op.collection]: { ...vault[op.collection], [op.field]: op.value, updatedAt: t } },
        inverse: { kind: 'setSingletonField', collection: op.collection, field: op.field, value: prev },
      }
    }

    case 'setParam': {
      const prev = vault.params[op.key]
      return {
        vault: { ...vault, params: { ...vault.params, [op.key]: op.value, updatedAt: t } },
        inverse: { kind: 'setParam', key: op.key, value: prev },
      }
    }

    case 'setSaveMode': {
      const prev = vault.settings.saveMode
      return {
        vault: { ...vault, settings: { ...vault.settings, saveMode: op.saveMode, updatedAt: t } },
        inverse: { kind: 'setSaveMode', saveMode: prev },
      }
    }

    case 'useOtherValue': {
      const note = vault.syncNotes.find((n) => n.id === op.noteId)
      if (!note || !note.field) return { vault }
      const notesReviewed = vault.syncNotes.map((n) => (n.id === op.noteId ? { ...n, reviewedAt: t } : n))
      if (note.collection === 'params' || note.collection === 'settings') {
        const prev = (vault[note.collection] as unknown as Record<string, unknown>)[note.field]
        return {
          vault: {
            ...vault,
            [note.collection]: { ...vault[note.collection], [note.field]: note.discardedValue, updatedAt: t },
            syncNotes: notesReviewed,
          },
          inverse: { kind: 'setSingletonField', collection: note.collection, field: note.field, value: prev },
        }
      }
      const list = vault[note.collection] as AnyRecord[]
      const rec = list.find((r) => r.id === note.recordId)
      if (!rec) return { vault: { ...vault, syncNotes: notesReviewed } }
      const next = list.map((r) =>
        r.id === note.recordId ? { ...r, [note.field!]: note.discardedValue, updatedAt: t } : r,
      )
      return {
        vault: { ...vault, [note.collection]: next, syncNotes: notesReviewed },
        inverse: {
          kind: 'setField',
          collection: note.collection,
          id: note.recordId,
          field: note.field,
          value: note.keptValue,
        },
      }
    }

    case 'markNoteReviewed': {
      return {
        vault: {
          ...vault,
          syncNotes: vault.syncNotes.map((n) => (n.id === op.noteId ? { ...n, reviewedAt: t } : n)),
        },
      }
    }

    case 'applyImport': {
      // Resolve the target account (create / adopt / existing).
      let accounts = vault.accounts
      let accountId = op.accountId
      let createdAccountId: string | undefined
      let adopt: RevertImportOp['adopt']
      if (op.newAccount) {
        const a: Account = { id: uuidv7(), updatedAt: t, ...op.newAccount }
        accounts = [...accounts, a]
        accountId = a.id
        createdAccountId = a.id
      } else if (op.adoptAccount) {
        accountId = op.adoptAccount.accountId
        const prevAcc = vault.accounts.find((a) => a.id === accountId)
        adopt = {
          accountId: op.adoptAccount.accountId,
          prev: {
            institutionId: prevAcc?.institutionId,
            fingerprint: prevAcc?.fingerprint,
            currency: prevAcc?.currency,
          },
        }
        accounts = accounts.map((a) =>
          a.id === accountId
            ? { ...a, institutionId: op.adoptAccount!.institutionId, fingerprint: op.adoptAccount!.fingerprint, currency: op.adoptAccount!.currency, updatedAt: t }
            : a,
        )
      }
      if (!accountId) return { vault } // nothing to import into

      // Remember a confirmed file→account binding: append its signals to matchKeys so a future
      // file carrying the same signal auto-binds (§5.8). Only genuinely-new keys are recorded, so
      // the inverse removes exactly what this import added.
      let learnedKeys: RevertImportOp['learnedKeys']
      if (op.learnAccountKeys) {
        const target = accounts.find((a) => a.id === op.learnAccountKeys!.accountId)
        if (target) {
          const have = new Set(target.matchKeys ?? [])
          const added = op.learnAccountKeys.keys.filter((k) => !have.has(k))
          if (added.length) {
            accounts = accounts.map((a) => (a.id === target.id ? { ...a, matchKeys: [...(a.matchKeys ?? []), ...added], updatedAt: t } : a))
            learnedKeys = { accountId: target.id, keys: added }
          }
        }
      }

      const statement: StatementRecord = { id: uuidv7(), updatedAt: t, accountId, ...op.statement }
      const txns: Transaction[] = op.txns.map((n) => ({
        id: uuidv7(),
        updatedAt: t,
        date: n.date,
        merchant: n.merchant,
        categoryId: n.categoryId,
        amount: n.amount,
        accountId: n.accountId || accountId,
        currency: n.currency,
        original: n.original,
        fee: n.fee,
        counterparty: n.counterparty,
        transferGroupId: n.transferGroupId,
        provenance: n.provenance,
        importMeta: n.importMeta ? { ...n.importMeta, statementId: statement.id } : undefined,
        isNew: true,
      }))
      // Dedup anchors against what the account already holds (and within this op) so
      // re-committing an overlapping / all-duplicate statement (#18) doesn't pile up
      // identical same-(account,date,amount) snapshots. The inverse then lists only the
      // snapshots actually added, so undo removes exactly those.
      const seenSnap = new Set(vault.snapshots.map((s) => `${s.accountId}|${s.date}|${s.amount}`))
      const snapshots: BalanceSnapshot[] = []
      for (const s of op.snapshots) {
        const accId = s.accountId || accountId
        const key = `${accId}|${s.date}|${s.amount}`
        if (seenSnap.has(key)) continue
        seenSnap.add(key)
        snapshots.push({ id: uuidv7(), updatedAt: t, createdAt: t, accountId: accId, date: s.date, amount: s.amount, origin: { kind: 'anchor', statementId: statement.id, at: s.at ?? 'close' } })
      }
      const newCategories = op.newCategories ?? []
      const newRules = op.newRules ?? []

      const importNotes: ConflictEntry[] = (op.notes ?? []).map((n) => ({
        id: uuidv7(),
        createdAt: t,
        collection: 'statements',
        recordId: statement.id,
        recordLabel: n.label,
        keptFrom: 'local',
        keptAt: t,
        discardedAt: t,
        kind: n.kind,
      }))

      // Retro-link existing legs → Transfers, remembering prior category for undo.
      const unlink: { txnId: string; prevCategoryId: string }[] = []
      const linkMap = new Map((op.transferLinks ?? []).map((l) => [l.existingTxnId, l.transferGroupId]))
      let transactions = vault.transactions
      if (linkMap.size > 0) {
        transactions = transactions.map((x) => {
          const gid = linkMap.get(x.id)
          if (!gid) return x
          unlink.push({ txnId: x.id, prevCategoryId: x.categoryId })
          return { ...x, transferGroupId: gid, categoryId: CAT_TRANSFERS, updatedAt: t }
        })
      }

      // Trip tags on freshly-minted rows (ANALYTICS §8.1): resolve rowIndex → new txn id.
      const trackingAssignments: TrackingAssignment[] = (op.trackingAssignments ?? [])
        .filter((a) => txns[a.rowIndex])
        .map((a) => ({ id: uuidv7(), updatedAt: t, trackingId: a.trackingId, txnId: txns[a.rowIndex]!.id, dir: a.dir }))

      const inverse: RevertImportOp = {
        kind: 'revertImport',
        txnIds: txns.map((x) => x.id),
        snapshotIds: snapshots.map((s) => s.id),
        statementId: statement.id,
        createdAccountId,
        adopt,
        learnedKeys,
        categoryIds: newCategories.length ? newCategories.map((c) => c.id) : undefined,
        ruleIds: newRules.length ? newRules.map((r) => r.id) : undefined,
        unlink: unlink.length ? unlink : undefined,
        noteIds: importNotes.length ? importNotes.map((n) => n.id) : undefined,
        assignmentIds: trackingAssignments.length ? trackingAssignments.map((a) => a.id) : undefined,
      }
      return {
        vault: {
          ...vault,
          accounts,
          statements: [...vault.statements, statement],
          transactions: [...transactions, ...txns],
          snapshots: [...vault.snapshots, ...snapshots],
          categories: [...vault.categories, ...newCategories],
          rules: [...vault.rules, ...newRules],
          trackingAssignments: [...vault.trackingAssignments, ...trackingAssignments],
          syncNotes: [...vault.syncNotes, ...importNotes],
        },
        inverse,
      }
    }

    case 'revertImport': {
      const txnSet = new Set(op.txnIds)
      const snapSet = new Set(op.snapshotIds)
      const catSet = new Set(op.categoryIds ?? [])
      const ruleSet = new Set(op.ruleIds ?? [])
      const accSet = new Set(op.createdAccountId ? [op.createdAccountId] : [])
      const tombstones = [...vault.tombstones]
      const tomb = (collection: CollectionName, ids: Iterable<string>) => {
        for (const id of ids) tombstones.push({ id, collection, deletedAt: t, updatedAt: t })
      }
      tomb('transactions', txnSet)
      tomb('snapshots', snapSet)
      tomb('statements', [op.statementId])
      if (op.createdAccountId) tomb('accounts', accSet)
      if (op.categoryIds?.length) tomb('categories', catSet)
      if (op.ruleIds?.length) tomb('rules', ruleSet)

      const noteSet = new Set(op.noteIds ?? [])
      const asgSet = new Set(op.assignmentIds ?? [])
      if (op.assignmentIds?.length) tomb('trackingAssignments', asgSet)
      const unlinkMap = new Map((op.unlink ?? []).map((u) => [u.txnId, u.prevCategoryId]))
      let accounts = vault.accounts
      if (op.adopt) {
        accounts = accounts.map((a) =>
          a.id === op.adopt!.accountId
            ? { ...a, institutionId: op.adopt!.prev.institutionId, fingerprint: op.adopt!.prev.fingerprint, currency: op.adopt!.prev.currency, updatedAt: t }
            : a,
        )
      }
      if (op.learnedKeys) {
        const drop = new Set(op.learnedKeys.keys)
        accounts = accounts.map((a) =>
          a.id === op.learnedKeys!.accountId ? { ...a, matchKeys: (a.matchKeys ?? []).filter((k) => !drop.has(k)), updatedAt: t } : a,
        )
      }
      return {
        vault: {
          ...vault,
          accounts: accounts.filter((a) => !accSet.has(a.id)),
          transactions: vault.transactions
            .filter((x) => !txnSet.has(x.id))
            .map((x) =>
              unlinkMap.has(x.id) ? { ...x, transferGroupId: undefined, categoryId: unlinkMap.get(x.id)!, updatedAt: t } : x,
            ),
          snapshots: vault.snapshots.filter((s) => !snapSet.has(s.id)),
          statements: vault.statements.filter((s) => s.id !== op.statementId),
          categories: vault.categories.filter((c) => !catSet.has(c.id)),
          rules: vault.rules.filter((r) => !ruleSet.has(r.id)),
          trackingAssignments: asgSet.size ? vault.trackingAssignments.filter((a) => !asgSet.has(a.id)) : vault.trackingAssignments,
          syncNotes: noteSet.size ? vault.syncNotes.filter((n) => !noteSet.has(n.id)) : vault.syncNotes,
          tombstones,
        },
      }
    }

    case 'recategorizeBatch': {
      const idSet = new Set(op.txnIds)
      // Prior provenance rides along in the inverse: undo has to put back the rung the
      // ladder recorded (or restore its absence), not leave the row reading `manual`.
      const prev: { id: string; categoryId: string; provenance?: Transaction['provenance'] }[] = []
      for (const x of vault.transactions) if (idSet.has(x.id)) prev.push({ id: x.id, categoryId: x.categoryId, provenance: x.provenance })
      if (prev.length === 0) return { vault }
      // Every caller of this op is a person acting on rows (row chip, bulk bar, backfill,
      // mark-as-transfer), so the category is no longer the classifier's opinion.
      const transactions = vault.transactions.map((x) =>
        idSet.has(x.id) ? { ...x, categoryId: op.categoryId, provenance: 'manual' as const, updatedAt: t } : x,
      )
      return {
        vault: { ...vault, transactions },
        inverse: { kind: 'setTxnCategories', entries: prev },
      }
    }

    case 'setTxnCategories': {
      const map = new Map(op.entries.map((e) => [e.id, e]))
      const prev: { id: string; categoryId: string; provenance?: Transaction['provenance'] }[] = []
      for (const x of vault.transactions) if (map.has(x.id)) prev.push({ id: x.id, categoryId: x.categoryId, provenance: x.provenance })
      if (prev.length === 0) return { vault }
      // The entry's provenance is written verbatim — `undefined` included, which is how the
      // inverse restores a row that never carried one.
      const transactions = vault.transactions.map((x) =>
        map.has(x.id) ? { ...x, categoryId: map.get(x.id)!.categoryId, provenance: map.get(x.id)!.provenance, updatedAt: t } : x,
      )
      return {
        vault: { ...vault, transactions },
        inverse: { kind: 'setTxnCategories', entries: prev },
      }
    }

    case 'resolveTransferPair': {
      const idSet = new Set(op.txnIds)
      // Remember each leg's prior category so undo can restore it (not leave it
      // stranded in Transfers, silently excluded from cash-flow).
      const prev = vault.transactions.filter((x) => idSet.has(x.id)).map((x) => ({ id: x.id, categoryId: x.categoryId }))
      if (prev.length === 0) return { vault }
      const transactions = vault.transactions.map((x) =>
        idSet.has(x.id) ? { ...x, transferGroupId: op.transferGroupId, categoryId: CAT_TRANSFERS, updatedAt: t } : x,
      )
      return {
        vault: { ...vault, transactions },
        inverse: { kind: 'unlinkTransferPair', transferGroupId: op.transferGroupId, restore: prev },
      }
    }

    case 'unlinkTransferPair': {
      const legs = vault.transactions.filter((x) => x.transferGroupId === op.transferGroupId)
      if (legs.length === 0) return { vault }
      const restore = new Map((op.restore ?? []).map((r) => [r.id, r.categoryId]))
      const transactions = vault.transactions.map((x) =>
        x.transferGroupId === op.transferGroupId
          ? { ...x, transferGroupId: undefined, categoryId: restore.get(x.id) ?? x.categoryId, updatedAt: t }
          : x,
      )
      return {
        vault: { ...vault, transactions },
        inverse: { kind: 'resolveTransferPair', txnIds: legs.map((x) => x.id), transferGroupId: op.transferGroupId },
      }
    }

    case 'addTracking': {
      const tracking: Tracking = { id: uuidv7(), updatedAt: t, ...op.tracking }
      const assignments: TrackingAssignment[] = (op.assignments ?? []).map((a) => ({
        id: uuidv7(),
        updatedAt: t,
        trackingId: tracking.id,
        txnId: a.txnId,
        dir: a.dir,
      }))
      return {
        vault: {
          ...vault,
          trackings: [...vault.trackings, tracking],
          trackingAssignments: [...vault.trackingAssignments, ...assignments],
        },
        inverse: { kind: 'removeTracking', trackingId: tracking.id },
      }
    }

    case 'removeTracking': {
      const tracking = vault.trackings.find((tr) => tr.id === op.trackingId)
      if (!tracking) return { vault }
      const assignments = vault.trackingAssignments.filter((a) => a.trackingId === op.trackingId)
      const tombstones = [
        ...vault.tombstones,
        { id: tracking.id, collection: 'trackings' as const, deletedAt: t, updatedAt: t },
        ...assignments.map((a) => ({ id: a.id, collection: 'trackingAssignments' as const, deletedAt: t, updatedAt: t })),
      ]
      return {
        vault: {
          ...vault,
          trackings: vault.trackings.filter((tr) => tr.id !== op.trackingId),
          trackingAssignments: vault.trackingAssignments.filter((a) => a.trackingId !== op.trackingId),
          tombstones,
        },
        inverse: { kind: 'restoreTracking', tracking, assignments },
      }
    }

    case 'restoreTracking': {
      const ids = new Set([op.tracking.id, ...op.assignments.map((a) => a.id)])
      return {
        vault: {
          ...vault,
          trackings: [...vault.trackings, { ...op.tracking, updatedAt: t }],
          trackingAssignments: [...vault.trackingAssignments, ...op.assignments.map((a) => ({ ...a, updatedAt: t }))],
          tombstones: vault.tombstones.filter(
            (ts) => !((ts.collection === 'trackings' || ts.collection === 'trackingAssignments') && ids.has(ts.id)),
          ),
        },
        inverse: { kind: 'removeTracking', trackingId: op.tracking.id },
      }
    }

    case 'addSkill': {
      const skill: Skill = { id: uuidv7(), updatedAt: t, ...op.skill }
      return {
        vault: { ...vault, skills: [...vault.skills, skill] },
        inverse: { kind: 'delete', collection: 'skills', ids: [skill.id] },
      }
    }

    case 'setAssignment': {
      const res = setAssignments(vault, op.trackingId, [{ txnId: op.txnId, dir: op.dir }], t)
      if (!res) return { vault }
      return {
        vault: res.vault,
        inverse: { kind: 'setAssignment', trackingId: op.trackingId, txnId: op.txnId, dir: res.prior[0]!.dir },
      }
    }

    case 'setAssignments': {
      const res = setAssignments(vault, op.trackingId, op.entries, t)
      if (!res) return { vault }
      return {
        vault: res.vault,
        inverse: { kind: 'setAssignments', trackingId: op.trackingId, entries: res.prior },
      }
    }
  }
}

/**
 * Move a set of transactions to a direction on one tracking, enforcing the
 * one-live-assignment-per-(tracking,txn) invariant (ANALYTICS §3): tombstone what was
 * live, then add the new direction unless clearing. Returns null when nothing would
 * change, plus the prior direction of every row it did touch (its own inverse).
 */
function setAssignments(
  vault: Vault,
  trackingId: string,
  entries: { txnId: string; dir: AssignmentDir }[],
  t: string,
): { vault: Vault; prior: { txnId: string; dir: AssignmentDir }[] } | null {
  const live = new Map<string, TrackingAssignment>()
  for (const a of vault.trackingAssignments) {
    if (a.trackingId === trackingId && !live.has(a.txnId)) live.set(a.txnId, a)
  }
  const changes = entries.filter((e) => (live.get(e.txnId)?.dir ?? 'clear') !== e.dir)
  if (changes.length === 0) return null

  const touched = new Set(changes.map((e) => e.txnId))
  const removed = vault.trackingAssignments.filter((a) => a.trackingId === trackingId && touched.has(a.txnId))
  const assignments = vault.trackingAssignments.filter((a) => !(a.trackingId === trackingId && touched.has(a.txnId)))
  for (const e of changes) {
    if (e.dir !== 'clear') assignments.push({ id: uuidv7(), updatedAt: t, trackingId, txnId: e.txnId, dir: e.dir })
  }
  return {
    vault: {
      ...vault,
      trackingAssignments: assignments,
      tombstones: [
        ...vault.tombstones,
        ...removed.map((a) => ({ id: a.id, collection: 'trackingAssignments' as const, deletedAt: t, updatedAt: t })),
      ],
    },
    prior: changes.map((e) => ({ txnId: e.txnId, dir: live.get(e.txnId)?.dir ?? ('clear' as const) })),
  }
}
