import type {
  Account,
  AnyRecord,
  BalanceSnapshot,
  Budget,
  CollectionName,
  ConflictEntry,
  FxOverride,
  Iso,
  PinnedWidget,
  Rule,
  SavedComparison,
  Skill,
  StatementRecord,
  Tombstone,
  Tracking,
  TrackingAssignment,
  Transaction,
  Vault,
} from '../model/types'
import { budgetKey, COLLECTIONS, TRANSIENT_FIELDS } from '../model/types'
import { isNewer, now, uuidv7 } from '../model/clock'

export interface MergeResult {
  merged: Vault
  conflicts: ConflictEntry[]
}

const DAY_MS = 24 * 3600 * 1000
export const TOMBSTONE_RETENTION_DAYS = 365
export const NOTE_RETENTION_DAYS = 30

/**
 * SYNC §4 three-way merge. `base` is the model as of the last successful sync
 * (null on a first-ever sync — everything reads as "added"). Pure function;
 * derived values are never merged because they are never stored.
 */
export function threeWayMerge(base: Vault | null, local: Vault, remote: Vault): MergeResult {
  const conflicts: ConflictEntry[] = []
  const label = makeLabeler(local, remote)
  const t = now()

  const merged: Vault = {
    ...local,
    createdAt: local.createdAt < remote.createdAt ? local.createdAt : remote.createdAt,
    tombstones: [],
    syncNotes: [],
  }

  // ---- generic per-collection pass (SYNC §4.2 decision table) ----
  for (const name of COLLECTIONS) {
    merged[name] = mergeCollection(
      name,
      (base?.[name] ?? []) as AnyRecord[],
      local[name] as AnyRecord[],
      remote[name] as AnyRecord[],
      tombsOf(local, name),
      tombsOf(remote, name),
      conflicts,
      label,
    ) as never
  }

  // ---- singletons: pure field-level LWW ----
  merged.params = mergeSingleton('params', 'Parameters', base?.params ?? null, local.params, remote.params, conflicts)
  merged.settings = mergeSingleton('settings', 'Settings', base?.settings ?? null, local.settings, remote.settings, conflicts)

  // ---- post-pass: same-(account,date) duplicate snapshots → keep both, flag once ----
  postPassSnapshots(merged, local, remote, conflicts, label)

  // ---- post-pass: unify accounts sharing a fingerprint (IMPORT §4.3) ----
  // Runs BEFORE the import dedupe: hash groups embed the fingerprint, so unified
  // accounts let the txn dedupe collapse in the same merge.
  const accountTombs = postPassAccounts(merged, conflicts, label)

  // ---- post-pass: import-dedupe by importMeta.hash → keep oldest, tombstone rest ----
  const { tombs: dedupeTombs, remap: dedupeRemap } = postPassImportDedupe(merged, conflicts)

  // ---- ANALYTICS §4.3: rewrite tags off tombstoned duplicates onto the survivor ----
  remapAssignmentTxns(merged, dedupeRemap)

  // ---- ANALYTICS §4.4: unify duplicate trackings (remaps their assignments) ----
  const trackingTombs = postPassTrackings(merged, conflicts, label)

  // ---- ANALYTICS §4.2: collapse the per-(tracking,txn) assignment invariant ----
  //      Runs after both remaps so remap-induced doubles collapse here too.
  const assignmentTombs = postPassAssignments(merged, local, conflicts, label)

  // ---- post-pass: budget uniqueness on scope identity → keep newer, tombstone other ----
  const budgetTombs = postPassBudgets(merged, conflicts, label)

  // ---- tombstones: union of both sides, minus live records, plus dedupe tombstones ----
  const liveIds = new Set<string>()
  for (const name of COLLECTIONS) for (const r of merged[name] as AnyRecord[]) liveIds.add(r.id)
  const tombMap = new Map<string, Tombstone>()
  for (const ts of [...local.tombstones, ...remote.tombstones, ...(base?.tombstones ?? [])]) {
    const k = `${ts.collection}|${ts.id}`
    const prev = tombMap.get(k)
    if (!prev || ts.updatedAt > prev.updatedAt) tombMap.set(k, ts)
  }
  merged.tombstones = [
    ...[...tombMap.values()].filter((ts) => !liveIds.has(ts.id)),
    ...accountTombs,
    ...dedupeTombs,
    ...trackingTombs,
    ...assignmentTombs,
    ...budgetTombs,
  ].filter((ts) => Date.parse(t) - Date.parse(ts.deletedAt) < TOMBSTONE_RETENTION_DAYS * DAY_MS)

  // ---- sync notes: union by id, plus fresh conflicts, minus reviewed/expired ----
  const noteMap = new Map<string, ConflictEntry>()
  for (const n of [...local.syncNotes, ...remote.syncNotes]) {
    const prev = noteMap.get(n.id)
    if (!prev || (n.reviewedAt && !prev.reviewedAt)) noteMap.set(n.id, n)
  }
  for (const c of conflicts) noteMap.set(c.id, c)
  merged.syncNotes = [...noteMap.values()].filter(
    (n) => !n.reviewedAt && Date.parse(t) - Date.parse(n.createdAt) < NOTE_RETENTION_DAYS * DAY_MS,
  )

  // Deterministic output: devices that have seen the same data must serialize
  // identically (SYNC invariant 6), regardless of which side was "local".
  for (const name of COLLECTIONS) {
    ;(merged[name] as AnyRecord[]).sort((a, b) => (a.id < b.id ? -1 : 1))
  }
  merged.tombstones.sort((a, b) => (`${a.collection}|${a.id}` < `${b.collection}|${b.id}` ? -1 : 1))
  merged.syncNotes.sort((a, b) => (a.id < b.id ? -1 : 1))

  return { merged, conflicts }
}

/** GC pass for the save path (same retention rules, no merge needed). */
export function gcVault(vault: Vault): Vault {
  const t = Date.parse(now())
  const tombstones = vault.tombstones.filter((ts) => t - Date.parse(ts.deletedAt) < TOMBSTONE_RETENTION_DAYS * DAY_MS)
  const syncNotes = vault.syncNotes.filter(
    (n) => !n.reviewedAt && t - Date.parse(n.createdAt) < NOTE_RETENTION_DAYS * DAY_MS,
  )
  if (tombstones.length === vault.tombstones.length && syncNotes.length === vault.syncNotes.length) return vault
  return { ...vault, tombstones, syncNotes }
}

// ---------------------------------------------------------------- internals

type Labeler = (collection: CollectionName, rec: AnyRecord) => string

function makeLabeler(local: Vault, remote: Vault): Labeler {
  const cats = new Map<string, string>()
  const accs = new Map<string, string>()
  const trks = new Map<string, string>()
  for (const v of [local, remote]) {
    for (const c of v.categories) cats.set(c.id, c.name)
    for (const a of v.accounts) accs.set(a.id, a.name)
    for (const tr of v.trackings) trks.set(tr.id, tr.name)
  }
  return (collection, rec) => {
    switch (collection) {
      case 'budgets':
        // A multi-category budget parks `categoryId` on CAT_TRANSFERS, so without the name a
        // conflict note about "Fun" would read "Transfers budget".
        return (rec as Budget).name ?? `${cats.get((rec as Budget).categoryId) ?? 'Unknown'} budget`
      case 'goals':
        return (rec as { name: string }).name
      case 'accounts':
        return (rec as { name: string }).name
      case 'categories':
        return (rec as { name: string }).name
      case 'transactions':
        return (rec as Transaction).merchant
      case 'snapshots': {
        const s = rec as BalanceSnapshot
        return `${accs.get(s.accountId) ?? 'Account'} balance · ${s.date}`
      }
      case 'statements':
        return (rec as StatementRecord).fileName
      case 'rules':
        return (rec as Rule).match.value
      case 'fxOverrides': {
        const f = rec as FxOverride
        return `${f.from}→${f.to}`
      }
      case 'trackings':
        return (rec as Tracking).name
      case 'trackingAssignments': {
        const a = rec as TrackingAssignment
        return trks.get(a.trackingId) ?? 'Tracking'
      }
      case 'savedComparisons':
        return (rec as SavedComparison).name ?? 'Comparison'
      case 'pinnedWidgets':
        return (rec as PinnedWidget).name ?? 'Pinned chart'
      case 'skills':
        return `${(rec as Skill).name} skill`
    }
  }
}

function tombsOf(vault: Vault, name: CollectionName): Map<string, Tombstone> {
  const m = new Map<string, Tombstone>()
  for (const ts of vault.tombstones) if (ts.collection === name) m.set(ts.id, ts)
  return m
}

function stripTransient(name: CollectionName, rec: AnyRecord): AnyRecord {
  const fields = TRANSIENT_FIELDS[name]
  if (!fields) return rec
  const out = { ...rec } as Record<string, unknown>
  for (const f of fields) delete out[f]
  return out as unknown as AnyRecord
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Winner inside the simultaneous band (§4.2): raw-compare when the timestamps
 * differ — that answer is the same on both devices. On an EXACT tie it must NOT
 * depend on which side is "local": `l.updatedAt >= r.updatedAt` was true on BOTH
 * devices, so each kept its own value and the pair ping-ponged forever. Comparing
 * the VALUES gives both devices the same answer.
 */
function tieKeepsLocal(lAt: string, rAt: string, lv: unknown, rv: unknown): boolean {
  if (lAt !== rAt) return lAt > rAt
  return JSON.stringify(lv ?? null) >= JSON.stringify(rv ?? null)
}

/** Field-inequality vs base, ignoring transient fields and updatedAt. */
function changed(name: CollectionName, base: AnyRecord, rec: AnyRecord): boolean {
  const a = stripTransient(name, base) as unknown as Record<string, unknown>
  const b = stripTransient(name, rec) as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('updatedAt')
  for (const k of keys) if (!eq(a[k], b[k])) return true
  return false
}

function newConflict(partial: Omit<ConflictEntry, 'id' | 'createdAt'>): ConflictEntry {
  return { id: uuidv7(), createdAt: now(), ...partial }
}

function mergeCollection(
  name: CollectionName,
  baseArr: AnyRecord[],
  localArr: AnyRecord[],
  remoteArr: AnyRecord[],
  localTombs: Map<string, Tombstone>,
  remoteTombs: Map<string, Tombstone>,
  conflicts: ConflictEntry[],
  label: Labeler,
): AnyRecord[] {
  const baseById = new Map(baseArr.map((r) => [r.id, r]))
  const localById = new Map(localArr.map((r) => [r.id, r]))
  const remoteById = new Map(remoteArr.map((r) => [r.id, r]))
  const ids = new Set<string>([...baseById.keys(), ...localById.keys(), ...remoteById.keys()])

  const out: AnyRecord[] = []
  const keep = (r: AnyRecord) => out.push(stripTransient(name, r))

  for (const id of ids) {
    const b = baseById.get(id)
    const l = localById.get(id)
    const r = remoteById.get(id)

    if (!b) {
      if (l && r) {
        // added/added with the same id (idempotent re-add) → field-merge
        keep(fieldMerge(name, null, l, r, conflicts, label))
      } else if (l && !r) {
        if (remoteTombs.has(id)) {
          // remote deleted something we still have but base never saw:
          // treat like edited-vs-deleted → the record survives, flagged
          keep(l)
          conflicts.push(resurrectionNote(name, l, 'local', label))
        } else {
          keep(l) // plain local add
        }
      } else if (r && !l) {
        if (localTombs.has(id)) {
          keep(r)
          conflicts.push(resurrectionNote(name, r, 'remote', label))
        } else {
          keep(r) // plain remote add
        }
      }
      // neither side has a record (tombstones only) → nothing to keep
      continue
    }

    const lDel = !l
    const rDel = !r
    if (lDel && rDel) continue // deleted/deleted → tombstone union handles it

    if (!lDel && !rDel) {
      const lc = changed(name, b, l!)
      const rc = changed(name, b, r!)
      if (!lc && !rc) keep(l!) // unchanged/unchanged → keep base (≡ local sans transient)
      else if (lc && !rc) keep(l!)
      else if (!lc && rc) keep(r!)
      else keep(fieldMerge(name, b, l!, r!, conflicts, label))
      continue
    }

    // one side deleted
    const survivor = lDel ? r! : l!
    const survivorChanged = changed(name, b, survivor)
    if (!survivorChanged) {
      // unchanged on the surviving side → the deletion wins (tombstone union keeps it)
      continue
    }
    // edited vs deleted → the edit wins; a resurrected record beats a lost one (§4.2)
    keep(survivor)
    conflicts.push(resurrectionNote(name, survivor, lDel ? 'remote' : 'local', label))
  }
  return out
}

function resurrectionNote(name: CollectionName, rec: AnyRecord, keptFrom: 'local' | 'remote', label: Labeler): ConflictEntry {
  return newConflict({
    collection: name,
    recordId: rec.id,
    recordLabel: label(name, rec),
    keptFrom,
    keptAt: rec.updatedAt,
    discardedAt: rec.updatedAt,
    kind: 'edit-delete',
  })
}

function fieldMerge(
  name: CollectionName,
  base: AnyRecord | null,
  l: AnyRecord,
  r: AnyRecord,
  conflicts: ConflictEntry[],
  label: Labeler,
): AnyRecord {
  const ls = stripTransient(name, l) as unknown as Record<string, unknown>
  const rs = stripTransient(name, r) as unknown as Record<string, unknown>
  const bs = base ? (stripTransient(name, base) as unknown as Record<string, unknown>) : null
  const keys = new Set([...Object.keys(ls), ...Object.keys(rs)])
  keys.delete('updatedAt')
  keys.delete('id')

  const out: Record<string, unknown> = { id: l.id }
  const cmp = isNewer(l.updatedAt as Iso, r.updatedAt as Iso)

  for (const k of keys) {
    const lv = ls[k]
    const rv = rs[k]
    if (eq(lv, rv)) {
      out[k] = lv
    } else if (bs && eq(lv, bs[k])) {
      out[k] = rv // only remote changed this field
    } else if (bs && eq(rv, bs[k])) {
      out[k] = lv // only local changed it
    } else {
      // same field changed on both sides → LWW slot + preserved loser (§4.2)
      const keepLocal = cmp === 'a' || (cmp === 'tie' && tieKeepsLocal(l.updatedAt as string, r.updatedAt as string, lv, rv))
      out[k] = keepLocal ? lv : rv
      conflicts.push(
        newConflict({
          collection: name,
          recordId: l.id,
          recordLabel: label(name, l),
          field: k,
          keptValue: keepLocal ? lv : rv,
          discardedValue: keepLocal ? rv : lv,
          keptFrom: keepLocal ? 'local' : 'remote',
          keptAt: (keepLocal ? l : r).updatedAt,
          discardedAt: (keepLocal ? r : l).updatedAt,
          kind: cmp === 'tie' ? 'simultaneous' : 'field-lww',
        }),
      )
    }
  }
  out.updatedAt = (l.updatedAt as string) > (r.updatedAt as string) ? l.updatedAt : r.updatedAt
  return out as unknown as AnyRecord
}

function mergeSingleton<T extends { updatedAt: Iso }>(
  collection: 'params' | 'settings',
  labelText: string,
  base: T | null,
  l: T,
  r: T,
  conflicts: ConflictEntry[],
): T {
  const lr = l as unknown as Record<string, unknown>
  const rr = r as unknown as Record<string, unknown>
  const br = base as unknown as Record<string, unknown> | null
  const keys = new Set([...Object.keys(lr), ...Object.keys(rr)])
  keys.delete('updatedAt')
  keys.delete('id')
  const cmp = isNewer(l.updatedAt, r.updatedAt)
  const out: Record<string, unknown> = { id: lr.id }
  for (const k of keys) {
    const lv = lr[k]
    const rv = rr[k]
    if (eq(lv, rv)) out[k] = lv
    else if (br && eq(lv, br[k])) out[k] = rv
    else if (br && eq(rv, br[k])) out[k] = lv
    else {
      const keepLocal = cmp === 'a' || (cmp === 'tie' && tieKeepsLocal(l.updatedAt, r.updatedAt, lv, rv))
      out[k] = keepLocal ? lv : rv
      conflicts.push(
        newConflict({
          collection,
          recordId: String(lr.id),
          recordLabel: labelText,
          field: k,
          keptValue: keepLocal ? lv : rv,
          discardedValue: keepLocal ? rv : lv,
          keptFrom: keepLocal ? 'local' : 'remote',
          keptAt: (keepLocal ? l : r).updatedAt,
          discardedAt: (keepLocal ? r : l).updatedAt,
          kind: cmp === 'tie' ? 'simultaneous' : 'field-lww',
        }),
      )
    }
  }
  out.updatedAt = l.updatedAt > r.updatedAt ? l.updatedAt : r.updatedAt
  return out as unknown as T
}

function postPassSnapshots(merged: Vault, local: Vault, remote: Vault, conflicts: ConflictEntry[], label: Labeler): void {
  const localIds = new Set(local.snapshots.map((s) => s.id))
  const remoteIds = new Set(remote.snapshots.map((s) => s.id))
  const groups = new Map<string, BalanceSnapshot[]>()
  for (const s of merged.snapshots) {
    const k = `${s.accountId}|${s.date}`
    const arr = groups.get(k) ?? []
    arr.push(s)
    groups.set(k, arr)
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    const fromLocalOnly = arr.some((s) => localIds.has(s.id) && !remoteIds.has(s.id))
    const fromRemoteOnly = arr.some((s) => remoteIds.has(s.id) && !localIds.has(s.id))
    if (!fromLocalOnly || !fromRemoteOnly) continue // duplicates existed before this merge — already flagged then
    const sorted = [...arr].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const later = sorted[sorted.length - 1]!
    const earlier = sorted[0]!
    if (later.amount === earlier.amount) continue // same value typed twice — nothing to review
    conflicts.push(
      newConflict({
        collection: 'snapshots',
        recordId: later.id,
        recordLabel: label('snapshots', later),
        keptValue: later.amount,
        discardedValue: earlier.amount,
        keptFrom: localIds.has(later.id) ? 'local' : 'remote',
        keptAt: later.createdAt,
        discardedAt: earlier.createdAt,
        kind: 'dup-snapshot',
      }),
    )
  }
}

/**
 * IMPORT §4.3: two live accounts with the same non-null fingerprint were created
 * independently (e.g. one device per statement) → keep the older id (UUIDv7
 * time-order, same rule as import dedupe), tombstone the newer, and rewrite the
 * loser's `accountId` on transactions / snapshots / statements to the winner so
 * downstream hash dedupe collapses in the same merge. One note per unified group.
 */
function postPassAccounts(merged: Vault, conflicts: ConflictEntry[], label: Labeler): Tombstone[] {
  const t = now()
  const byFp = new Map<string, Account[]>()
  for (const a of merged.accounts) {
    if (!a.fingerprint) continue
    const arr = byFp.get(a.fingerprint) ?? []
    arr.push(a)
    byFp.set(a.fingerprint, arr)
  }
  const tombs: Tombstone[] = []
  const drop = new Set<string>()
  const remap = new Map<string, string>() // loser id → winner id
  for (const arr of byFp.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => (a.id < b.id ? -1 : 1)) // oldest id wins
    const winner = sorted[0]!
    for (const loser of sorted.slice(1)) {
      drop.add(loser.id)
      remap.set(loser.id, winner.id)
      tombs.push({ id: loser.id, collection: 'accounts', deletedAt: t, updatedAt: t })
      conflicts.push(
        newConflict({
          collection: 'accounts',
          recordId: winner.id,
          recordLabel: label('accounts', winner),
          keptFrom: 'local',
          keptAt: winner.updatedAt,
          discardedAt: loser.updatedAt,
          kind: 'dup-account',
        }),
      )
    }
  }
  if (drop.size === 0) return tombs
  merged.accounts = merged.accounts.filter((a) => !drop.has(a.id))
  const to = (id: string | undefined) => (id !== undefined && remap.has(id) ? remap.get(id)! : id)
  merged.transactions = merged.transactions.map((x) =>
    x.accountId !== undefined && remap.has(x.accountId) ? { ...x, accountId: to(x.accountId) } : x,
  )
  merged.snapshots = merged.snapshots.map((s) =>
    remap.has(s.accountId) ? { ...s, accountId: remap.get(s.accountId)! } : s,
  )
  merged.statements = merged.statements.map((s) =>
    remap.has(s.accountId) ? { ...s, accountId: remap.get(s.accountId)! } : s,
  )
  // EVERY accountId foreign key moves to the winner, or the referrer dangles at a
  // tombstoned id forever — a balance goal reading €0 with no note explaining why.
  merged.goals = merged.goals.map((g) =>
    g.source?.kind === 'balance' && remap.has(g.source.accountId)
      ? { ...g, source: { ...g.source, accountId: remap.get(g.source.accountId)! } }
      : g,
  )
  merged.savedComparisons = merged.savedComparisons.map((c) =>
    c.selections.some((s) => s.accountIds?.some((id) => remap.has(id)))
      ? { ...c, selections: c.selections.map((s) => (s.accountIds ? { ...s, accountIds: s.accountIds.map((id) => remap.get(id) ?? id) } : s)) }
      : c,
  )
  return tombs
}

function postPassImportDedupe(merged: Vault, conflicts: ConflictEntry[]): { tombs: Tombstone[]; remap: Map<string, string> } {
  const t = now()
  const groups = new Map<string, Transaction[]>()
  for (const txn of merged.transactions) {
    const hash = txn.importMeta?.hash
    if (!hash) continue
    const arr = groups.get(hash) ?? []
    arr.push(txn)
    groups.set(hash, arr)
  }
  const tombs: Tombstone[] = []
  const drop = new Set<string>()
  const remap = new Map<string, string>() // tombstoned dup id → surviving txn id (ANALYTICS §4.3)
  const flaggedFiles = new Set<string>()
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => (a.id < b.id ? -1 : 1)) // UUIDv7 = time order; keep the oldest
    const winner = sorted[0]!
    for (const dup of sorted.slice(1)) {
      drop.add(dup.id)
      remap.set(dup.id, winner.id)
      tombs.push({ id: dup.id, collection: 'transactions', deletedAt: t, updatedAt: t })
    }
    const file = winner.importMeta?.file ?? 'import'
    if (!flaggedFiles.has(file)) {
      flaggedFiles.add(file)
      conflicts.push(
        newConflict({
          collection: 'transactions',
          recordId: winner.id,
          recordLabel: file,
          keptFrom: 'local',
          keptAt: t,
          discardedAt: t,
          kind: 'dup-import',
        }),
      )
    }
  }
  if (drop.size > 0) merged.transactions = merged.transactions.filter((x) => !drop.has(x.id))
  return { tombs, remap }
}

/**
 * ANALYTICS §4.3 — after import dedupe tombstones a duplicate transaction, live
 * assignments pointing at the loser are rewritten to the surviving txn id, so
 * curation (a trip tag) survives dedupe. Doubles produced here are collapsed by
 * `postPassAssignments`. Mirrors `postPassAccounts`'s accountId rewrite.
 */
function remapAssignmentTxns(merged: Vault, remap: Map<string, string>): void {
  if (remap.size === 0) return
  merged.trackingAssignments = merged.trackingAssignments.map((a) =>
    remap.has(a.txnId) ? { ...a, txnId: remap.get(a.txnId)! } : a,
  )
}

/**
 * ANALYTICS §4.4 — two live trackings with the same NFKC-casefolded name, same
 * kind, and overlapping (or both-absent) windows were created independently on
 * two devices → keep the older id, tombstone the newer, remap the loser's live
 * assignments to the winner, flag once. Window-disjoint same-name trips (two
 * genuinely distinct "Poland" trips) are untouched.
 */
function postPassTrackings(merged: Vault, conflicts: ConflictEntry[], label: Labeler): Tombstone[] {
  const t = now()
  const byKey = new Map<string, Tracking[]>()
  for (const tr of merged.trackings) {
    const key = `${tr.name.normalize('NFKC').toLowerCase()}|${tr.kind}`
    const arr = byKey.get(key) ?? []
    arr.push(tr)
    byKey.set(key, arr)
  }
  const tombs: Tombstone[] = []
  const drop = new Set<string>()
  const remap = new Map<string, string>() // loser tracking id → winner id
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue
    const sorted = [...arr].sort((a, b) => (a.id < b.id ? -1 : 1)) // oldest id wins
    const winners: Tracking[] = []
    for (const cand of sorted) {
      const w = winners.find((x) => windowsOverlap(x, cand))
      if (w) {
        drop.add(cand.id)
        remap.set(cand.id, w.id)
        tombs.push({ id: cand.id, collection: 'trackings', deletedAt: t, updatedAt: t })
        conflicts.push(
          newConflict({
            collection: 'trackings',
            recordId: w.id,
            recordLabel: label('trackings', w),
            keptFrom: 'local',
            keptAt: w.updatedAt,
            discardedAt: cand.updatedAt,
            kind: 'dup-tracking',
          }),
        )
      } else {
        winners.push(cand)
      }
    }
  }
  if (drop.size === 0) return tombs
  merged.trackings = merged.trackings.filter((tr) => !drop.has(tr.id))
  merged.trackingAssignments = merged.trackingAssignments.map((a) =>
    remap.has(a.trackingId) ? { ...a, trackingId: remap.get(a.trackingId)! } : a,
  )
  // Same rule as postPassAccounts: every trackingId foreign key follows the winner —
  // a trip-scoped budget or flow goal must not point at the tombstoned duplicate.
  merged.budgets = merged.budgets.map((b) =>
    b.scope?.kind === 'tracking' && remap.has(b.scope.trackingId)
      ? { ...b, scope: { ...b.scope, trackingId: remap.get(b.scope.trackingId)! } }
      : b,
  )
  merged.goals = merged.goals.map((g) =>
    g.source?.kind === 'flow' && g.source.trackingId && remap.has(g.source.trackingId)
      ? { ...g, source: { ...g.source, trackingId: remap.get(g.source.trackingId)! } }
      : g,
  )
  merged.savedComparisons = merged.savedComparisons.map((c) =>
    c.selections.some((s) => s.trackingIds?.some((id) => remap.has(id)))
      ? { ...c, selections: c.selections.map((s) => (s.trackingIds ? { ...s, trackingIds: s.trackingIds.map((id) => remap.get(id) ?? id) } : s)) }
      : c,
  )
  return tombs
}

/** Overlapping [dateFrom,dateTo] ranges, or both windows absent (ANALYTICS §4.4). */
function windowsOverlap(a: Tracking, b: Tracking): boolean {
  const aHas = a.dateFrom != null || a.dateTo != null
  const bHas = b.dateFrom != null || b.dateTo != null
  if (!aHas && !bHas) return true
  if (!aHas || !bHas) return false
  const a1 = a.dateFrom ?? '0000-00-00'
  const a2 = a.dateTo ?? '9999-99-99'
  const b1 = b.dateFrom ?? '0000-00-00'
  const b2 = b.dateTo ?? '9999-99-99'
  return a1 <= b2 && b1 <= a2
}

/**
 * ANALYTICS §4.2 — enforce the §3 per-`(trackingId, txnId)` invariant across
 * devices. Same-dir doubles collapse to the oldest id silently; opposite dirs
 * resolve by newer `updatedAt` (exclude wins the < 2 s tie) and flag once.
 * Runs after both remaps so remap-induced doubles collapse here too.
 */
function postPassAssignments(
  merged: Vault,
  local: Vault,
  conflicts: ConflictEntry[],
  label: Labeler,
): Tombstone[] {
  const t = now()
  const localIds = new Set(local.trackingAssignments.map((a) => a.id))
  const groups = new Map<string, TrackingAssignment[]>()
  for (const a of merged.trackingAssignments) {
    const k = `${a.trackingId}|${a.txnId}`
    const arr = groups.get(k) ?? []
    arr.push(a)
    groups.set(k, arr)
  }
  const tombs: Tombstone[] = []
  const drop = new Set<string>()
  const oldestById = (arr: TrackingAssignment[]): TrackingAssignment | undefined =>
    arr.length === 0 ? undefined : [...arr].sort((a, b) => (a.id < b.id ? -1 : 1))[0]
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    const includes = arr.filter((a) => a.dir === 'include')
    const excludes = arr.filter((a) => a.dir === 'exclude')
    const incRep = oldestById(includes)
    const excRep = oldestById(excludes)
    // Same-dir doubles: keep the representative, tombstone the rest (idempotent double-tag).
    for (const a of arr) {
      if (a === incRep || a === excRep) continue
      drop.add(a.id)
      tombs.push({ id: a.id, collection: 'trackingAssignments', deletedAt: t, updatedAt: t })
    }
    // Opposite dirs remaining: resolve by recency; exclude wins the near-simultaneous tie.
    if (incRep && excRep) {
      const cmp = isNewer(incRep.updatedAt, excRep.updatedAt)
      const winner = cmp === 'tie' ? excRep : cmp === 'a' ? incRep : excRep
      const loser = winner === incRep ? excRep : incRep
      drop.add(loser.id)
      tombs.push({ id: loser.id, collection: 'trackingAssignments', deletedAt: t, updatedAt: t })
      conflicts.push(
        newConflict({
          collection: 'trackingAssignments',
          recordId: winner.id,
          recordLabel: label('trackingAssignments', winner),
          keptValue: winner.dir,
          discardedValue: loser.dir,
          keptFrom: localIds.has(winner.id) ? 'local' : 'remote',
          keptAt: winner.updatedAt,
          discardedAt: loser.updatedAt,
          kind: 'tag-conflict',
        }),
      )
    }
  }
  if (drop.size > 0) merged.trackingAssignments = merged.trackingAssignments.filter((a) => !drop.has(a.id))
  return tombs
}

function postPassBudgets(merged: Vault, conflicts: ConflictEntry[], label: Labeler): Tombstone[] {
  const t = now()
  const byCat = new Map<string, Budget[]>()
  for (const b of merged.budgets) {
    const key = budgetKey(b)
    const arr = byCat.get(key) ?? []
    arr.push(b)
    byCat.set(key, arr)
  }
  const tombs: Tombstone[] = []
  const drop = new Set<string>()
  for (const arr of byCat.values()) {
    if (arr.length < 2) continue
    // Tie-break by id like the sibling passes: a comparator that never returns 0
    // preserves input order, and input order is local/remote-dependent — on an
    // `updatedAt` tie the two devices tombstoned DIFFERENT budgets, and one
    // round-trip later the deletion-wins arm removed both.
    const sorted = [...arr].sort((a, b) =>
      a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1,
    )
    const winner = sorted[sorted.length - 1]!
    for (const loser of sorted.slice(0, -1)) {
      drop.add(loser.id)
      tombs.push({ id: loser.id, collection: 'budgets', deletedAt: t, updatedAt: t })
      conflicts.push(
        newConflict({
          collection: 'budgets',
          recordId: winner.id,
          recordLabel: label('budgets', winner),
          field: 'amount',
          keptValue: winner.amount,
          discardedValue: loser.amount,
          keptFrom: 'local',
          keptAt: winner.updatedAt,
          discardedAt: loser.updatedAt,
          kind: 'dup-budget',
        }),
      )
    }
  }
  if (drop.size > 0) merged.budgets = merged.budgets.filter((b) => !drop.has(b.id))
  return tombs
}
