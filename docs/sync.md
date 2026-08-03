# Sync

How two devices converge on one vault without a server to arbitrate. This is the most delicate
part of the codebase: a plausible-looking change here loses data quietly, months later, on someone
else's machine. Read this before touching `src/sync/`.

## The shape of it

The remote holds **one file**: the vault, encrypted. No server logic, no per-record API, no
locking. Two devices editing at once is normal, not an error, and the merge is what makes that
safe.

```
  local vault ──encrypt──▶ [ remote file ] ◀──encrypt── other device
                    ▲            │
                    └── merge ◀──┘   on conflict: pull, merge, push again
```

## Compare-and-swap, not last-write-wins

Every remote implements `RemoteAdapter` (`src/sync/adapter.ts`):

```ts
getMetadata(): Promise<RemoteMetadata | null>   // cheap — runs on every focus/poll
read(): Promise<{ bytes, revision }>
write(bytes, { ifRevision }): Promise<{ revision }>
```

`write` is a **compare-and-swap**. Pass `ifRevision` and the write must fail with
`RevisionConflictError` if the remote moved since you read it; omit it and the write must fail if
anything exists at all (create-only).

That guard is the entire safety story. A remote that cannot honour it will silently overwrite the
other device's work. Where the storage backend has no native precondition — Google Drive — the
adapter emulates it: re-stat before writing, then verify afterwards that the revision preceding
the new one is exactly the one written against, which closes the window where a third writer
slipped in between. If it did, the adapter reports a conflict *even though the write succeeded*,
and the engine treats itself as the loser and re-merges.

On `RevisionConflictError` the engine pulls, merges, and pushes again. It never retries a write
with a stale revision.

## The three-way merge

`threeWayMerge(base, local, remote)` in `src/sync/merge.ts` is a **pure function**. `base` is the
vault as of the last successful sync; `null` on a first-ever sync, where everything reads as added.

Derived values are never merged, because they are never stored — analytics recompute from the
records.

### Per record

| base | local | remote | result |
|---|---|---|---|
| absent | added | added (same id) | field-merge — an idempotent re-add, not a conflict |
| absent | added | — | keep local |
| absent | — | added | keep remote |
| present | unchanged | unchanged | keep |
| present | changed | unchanged | keep local |
| present | unchanged | changed | keep remote |
| present | changed | changed | field-merge |
| present | deleted | unchanged | delete wins |
| present | deleted | **changed** | **the edit wins** — record survives, flagged |
| present | deleted | deleted | stays deleted |

The rule worth internalising: **an edit beats a delete**. A resurrected record beats a lost one,
because a user can delete again but cannot recover what was never kept. The resurrection is
recorded as a conflict note so it is visible rather than mysterious.

### Per field

When both sides changed the same record, the merge descends to fields:

- Changed on one side only → take that side. No conflict; this is most of the traffic.
- Changed on both sides → **last-write-wins by `updatedAt`**, and the losing value is *preserved*
  in a `ConflictEntry` rather than discarded. Ties break deterministically, so both devices reach
  the same answer independently.

Conflicts surface in the UI as notes. They are a feature: the user sees what was overwritten.

## Tombstones

Deletes are tombstones, not absence — absence is indistinguishable from "not yet synced". They are
unioned across both sides and retained for `TOMBSTONE_RETENTION_DAYS` (365), long enough that a
device offline for a year cannot resurrect everything it never saw deleted.

## Convergence is a property, not a hope

Two devices merging the same pair of vaults must land on the same result regardless of who merges
first. That is why:

- ids are minted deterministically where a migration or merge creates records,
- tie-breaks are total and content-based rather than random,
- the merge is pure, with no clock reads inside the decision path.

`tests/sync.property.test.ts` checks this with generated histories, and
`tests/merge.decision-table.test.ts` pins the table above case by case. If you change merge
behaviour, those are the tests that must change with intent — not the ones to make green.

## The remotes

| Adapter | Use |
|---|---|
| `googleDriveAdapter.ts` | OAuth, `drive.file` scope. Works everywhere, phones included. |
| `localFileAdapter.ts` | A file via the File System Access API — **Chromium desktop only**. |
| `inMemoryAdapter.ts` | Tests. |
| `httpTestAdapter.ts` | The dev server's double, behind `?remote=test:<name>`. |

Firefox and Safari have no File System Access API, so Drive is the only real sync path there. The
Sync settings card feature-detects and says so rather than offering a button that cannot work.

Google is contacted directly from the browser; there is no backend proxy. The token is single-
flighted and refreshed ten minutes before expiry. A 4xx on refresh drops the grant and asks for
re-consent (`REAUTH_NEEDED`); a 5xx or network failure keeps it and retries later. Getting that
distinction wrong either logs people out constantly or leaves them stuck.
