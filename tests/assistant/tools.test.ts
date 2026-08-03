import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import type { Selection, Vault } from '../../src/model/types'
import { derive } from '../../src/model/selectors'
import { applyOp } from '../../src/model/mutations'
import { tripSummary } from '../../src/analytics/trips'
import { goalStatus } from '../../src/analytics/goals'
import { execTool, TOOLS, visibleSkills, type PendingEdit, type ToolCtx } from '../../src/assistant/tools'
import { SYSTEM_PROMPT } from '../../src/assistant/prompt'
import { buildChatRequest } from '../../src/assistant/wire'
import { acc, buildVault, catId, snap, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const TODAY = '2026-07-12'

function fixture(): { vault: Vault; dining: string; current: string; retired: string } {
  let dining = ''
  let current = ''
  let retired = ''
  const vault = buildVault((v) => {
    dining = catId(v, 'Dining out')
    const a = acc(v, { name: 'Current account', institution: 'BNP', last4: '4419', liquid: true, holderNames: ['A Person'], matchKeys: ['rib:FR7612345'] })
    const old = acc(v, { name: 'Old savings', liquid: true, hidden: true })
    current = a.id
    retired = old.id
    snap(v, a.id, '2026-06-30', 4210)
    const t1 = txn(v, '2026-06-05', 'Bistro 12345678', 'Dining out', -42.5)
    t1.accountId = a.id
    const t2 = txn(v, '2026-06-19', 'Bistro 12345678', 'Dining out', -18)
    t2.accountId = a.id
    txn(v, '2026-07-02', 'Le Comptoir', 'Dining out', -30).accountId = a.id
    // A payday inside the June window — the row that made a netted total lie about cost.
    txn(v, '2026-06-28', 'Employer', 'Income', 2400).accountId = a.id
    txn(v, '2026-06-11', 'Ghost shop', 'Shopping', -99).accountId = old.id
    // Two trips: "Japan" is cheap, "Iceland" spends more but has income in its window.
    v.trackings.push(
      { id: 'trk-japan', updatedAt: 'x', name: 'Japan', kind: 'trip', dateFrom: '2026-06-01', dateTo: '2026-06-30' },
      { id: 'trk-iceland', updatedAt: 'x', name: 'Iceland', kind: 'trip', dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    )
    // Japan is curated down to two of the four rows in its window.
    v.trackingAssignments.push(
      { id: 'ta-1', updatedAt: 'x', trackingId: 'trk-japan', txnId: v.transactions[2]!.id, dir: 'exclude' },
      { id: 'ta-2', updatedAt: 'x', trackingId: 'trk-japan', txnId: v.transactions[3]!.id, dir: 'exclude' },
      { id: 'ta-3', updatedAt: 'x', trackingId: 'trk-japan', txnId: v.transactions[4]!.id, dir: 'exclude' },
    )
  })
  return { vault, dining, current, retired }
}

function ctxOf(vault: Vault, over: Partial<ToolCtx> = {}): ToolCtx {
  // These are the full-access shapes. Safe mode has its own file, tests/assistant/safeMode.test.ts.
  return { vault, derived: derive(vault), today: TODAY, skills: [], access: 'full', ...over }
}

const json = (vault: Vault, name: string, args: Record<string, unknown> = {}, over?: Partial<ToolCtx>) =>
  JSON.parse(execTool(ctxOf(vault, over), name, args).content)

describe('nothing is injected (§1)', () => {
  it('a fresh conversation carries no vault data at all', () => {
    const { vault } = fixture()
    const { init } = buildChatRequest({ provider: 'openai', wire: 'openai', model: 'm', apiKey: 'k' }, {
      system: SYSTEM_PROMPT,
      turns: [{ role: 'user', text: 'how much did I spend?' }],
      tools: TOOLS,
    })
    const body = init.body as string
    for (const secret of ['Bistro', 'Le Comptoir', 'Current account', 'Old savings', 'BNP', '4419', '4210', '42.5', vault.vaultId]) {
      expect(body).not.toContain(secret)
    }
    // …and it does carry the tool names, which is all the model gets to start with.
    expect(body).toContain('list_categories')
  })

  it('no tool schema embeds the vault’s own ids as an enum', () => {
    expect(JSON.stringify(TOOLS)).not.toContain('enum')
  })
})

describe('discovery (§5)', () => {
  it('list_accounts includes hidden accounts and omits every identity field', () => {
    const { vault } = fixture()
    const rows = json(vault, 'list_accounts')
    expect(rows).toHaveLength(2)
    expect(rows.find((r: { name: string }) => r.name === 'Old savings').hidden).toBe(true)
    const text = JSON.stringify(rows)
    expect(text).not.toContain('4419')
    expect(text).not.toContain('A Person')
    expect(text).not.toContain('rib:')
  })

  it('list_accounts dates every balance', () => {
    const { vault } = fixture()
    const row = json(vault, 'list_accounts').find((r: { name: string }) => r.name === 'Current account')
    expect(row.balance).toEqual({ amount: 4210, asOf: '2026-06-30' })
  })

  // Ranking trips one aggregate at a time cost one round each AND returned netted totals. Both are
  // fixed by carrying spend on the listing itself.
  it('list_trackings carries spend-only totals, so ranking trips is one call', () => {
    const { vault } = fixture()
    const r = json(vault, 'list_trackings')
    expect(r.note).toContain('spend only')
    const byName = Object.fromEntries(r.trackings.map((t: { name: string }) => [t.name, t]))
    // Iceland's window holds the €2,400 payday; its total must still be what was SPENT.
    expect(byName.Iceland.totalSpend).toBe(159.5)
    expect(byName.Japan.totalSpend).toBe(60.5)
    expect(byName.Japan.memberCount).toBe(2)
  })

  it('the listing receipt names the most expensive trip, so it cannot be mis-ranked', () => {
    const { vault } = fixture()
    expect(execTool(ctxOf(vault), 'list_trackings', {}).receipt).toContain('most expensive Iceland')
  })

  it('get_overview reports coverage without any figure', () => {
    const { vault } = fixture()
    const o = json(vault, 'get_overview')
    expect(o.baseCurrency).toBe('EUR')
    expect(o.counts.hiddenAccounts).toBe(1)
    expect(o.latestTransactionDate).toBe('2026-07-02')
  })
})

describe('unknown ids teach rather than throw (§5)', () => {
  it('aggregate with a bad category id returns the valid ones', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault), 'aggregate', { selection: { categoryIds: ['cat-nope'] }, groupBy: 'category' })
    expect(out.error).toBe(true)
    const body = JSON.parse(out.content)
    expect(body.error).toContain('cat-nope')
    expect(body.validCategoryIds.some((c: { name: string }) => c.name === 'Dining out')).toBe(true)
  })

  it('an unknown tool name is an error result, not an exception', () => {
    const { vault } = fixture()
    expect(execTool(ctxOf(vault), 'no_such_tool', {}).error).toBe(true)
  })
})

describe('analysis (§5)', () => {
  it('aggregate groups by category and separates income from expense', () => {
    const { vault, dining } = fixture()
    const r = json(vault, 'aggregate', { selection: { period: { month: '2026-06' } }, groupBy: 'category' })
    expect(r.income).toBe(2400)
    expect(r.expense).toBe(159.5) // 42.5 + 18 + 99 (the hidden account's row is in scope)
    expect(r.breakdown.find((b: { key: string }) => b.key === dining).expense).toBe(60.5)
  })

  // The bug behind a confidently wrong answer: a period containing a payday netted positive, so a
  // trip that cost thousands looked like a gain and was ranked as the CHEAPEST.
  it('cost is expense, never net — income in the window does not cancel spending', () => {
    const { vault } = fixture()
    const r = json(vault, 'aggregate', { selection: { period: { month: '2026-06' } }, groupBy: 'none' })
    expect(r.expense).toBe(159.5)
    expect(r.income).toBe(2400)
    expect(r.net).toBe(2240.5)
    expect(r.costIs).toBe('expense')
  })

  it('the receipt leads with spend, so a netted figure can never read as a cost', () => {
    const { vault } = fixture()
    const receipt = execTool(ctxOf(vault), 'aggregate', { selection: { period: { month: '2026-06' } }, groupBy: 'none' }).receipt
    expect(receipt).toContain('spent 160 EUR')
    expect(receipt).toContain('in 2,400 EUR')
    expect(receipt).not.toContain('by none') // groupBy 'none' has nothing to announce
  })

  it('a selection touching hidden accounts says so', () => {
    const { vault, retired } = fixture()
    const r = json(vault, 'aggregate', { selection: { period: { month: '2026-06' } }, groupBy: 'category' })
    expect(r.includesHiddenAccounts).toEqual([retired])
  })

  it('query_transactions caps rows but reports the true count and sum', () => {
    const { vault } = fixture()
    const r = json(vault, 'query_transactions', { selection: { period: { month: '2026-06' } }, limit: 1 })
    expect(r.rows).toHaveLength(1)
    expect(r.returned).toBe(1)
    expect(r.totalCount).toBe(4)
    expect(r.sum).toBe(2240.5)
  })

  it('long digit runs in a merchant are redacted, as on the import path', () => {
    const { vault } = fixture()
    const r = json(vault, 'query_transactions', { selection: { merchantQuery: 'Bistro' } })
    expect(r.rows[0].merchant).toBe('Bistro ########')
  })

  it('the recurring axis filters rows without living in Selection', () => {
    const { vault } = fixture()
    vault.transactions[0]!.recurring = 'monthly'
    expect(json(vault, 'aggregate', { selection: { recurring: 'monthly' }, groupBy: 'none' }).matched).toBe(1)
    expect(json(vault, 'aggregate', { selection: {}, groupBy: 'none' }).matched).toBe(5)
  })

  it('a trip total says when transfer legs were left out, so it reconciles with the trip card', () => {
    const { vault } = fixture()
    vault.transactions[0]!.transferGroupId = 'grp-1' // now a transfer leg, not spending
    const r = json(vault, 'aggregate', { selection: { trackingIds: ['trk-japan'] }, groupBy: 'none' })
    expect(r.matched).toBe(1)
    expect(r.transferRowsExcluded).toBe(1)
    expect(r.transferRowsReason).toContain('trip card counts them')
  })

  // `trackingOf` resolved membership inside the per-row loop, and `members()` rescans the vault:
  // ~60M operations on a real 3k-transaction vault, on the main thread.
  it('groupBy tracking stays fast on a realistic vault', () => {
    const vault = buildVault((v) => {
      for (let i = 0; i < 2000; i++) txn(v, `2026-0${(i % 9) + 1}-15`, `M${i}`, 'Shopping', -10)
      for (let t = 0; t < 6; t++) {
        v.trackings.push({ id: `trk-${t}`, updatedAt: 'x', name: `T${t}`, kind: 'trip', dateFrom: '2026-01-01', dateTo: '2026-12-31' })
      }
    })
    const started = performance.now()
    const r = JSON.parse(execTool(ctxOf(vault), 'aggregate', { selection: {}, groupBy: 'tracking' }).content)
    expect(r.matched).toBe(2000)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('compare_selections reports both sides, the delta and the movers', () => {
    const { vault, dining } = fixture()
    const r = json(vault, 'compare_selections', { a: { period: { month: '2026-06' } }, b: { period: { month: '2026-05' } } })
    expect(r.a.total).toBe(159.5)
    expect(r.b.total).toBe(0)
    expect(r.delta).toBe(159.5)
    expect(r.byCategory.some((c: { categoryId: string }) => c.categoryId === dining)).toBe(true)
  })
})

describe('control (§5)', () => {
  it('show_transactions drives the router and reports what the user will see', () => {
    const { vault, dining } = fixture()
    const seen: unknown[] = []
    const r = json(vault, 'show_transactions', { categoryId: dining, from: '2026-06-01', to: '2026-06-30' }, {
      nav: { goTab: () => {}, goTxns: (f) => seen.push(f), goCompare: () => {} },
    })
    expect(seen).toEqual([{ cat: dining, acct: undefined, tracking: undefined, from: '2026-06-01', to: '2026-06-30', merchant: undefined, q: undefined, status: undefined }])
    expect(r.rowsShown).toBe(2)
  })

  // The bug that made the assistant contradict the screen: the count ignored `search` and `status`,
  // so a text filter matching nothing was reported as a whole date range's worth of rows.
  it('the reported count honours search text and status, not just the coarse axes', () => {
    const { vault } = fixture()
    const nav = { goTab: () => {}, goTxns: () => {}, goCompare: () => {} }
    expect(json(vault, 'show_transactions', { from: '2026-06-01', to: '2026-06-30' }, { nav }).rowsShown).toBe(4)
    expect(json(vault, 'show_transactions', { from: '2026-06-01', to: '2026-06-30', search: 'Japan' }, { nav }).rowsShown).toBe(0)
    expect(json(vault, 'show_transactions', { from: '2026-06-01', to: '2026-06-30', search: 'Bistro' }, { nav }).rowsShown).toBe(2)
    expect(json(vault, 'show_transactions', { status: 'recurring' }, { nav }).rowsShown).toBe(0)
  })

  it('a trip is shown by id, because its date range is not the same set of rows', () => {
    const { vault } = fixture()
    const trip = vault.trackings[0]!
    const seen: { tracking?: string }[] = []
    const r = json(vault, 'show_transactions', { trackingId: trip.id }, {
      nav: { goTab: () => {}, goTxns: (f) => seen.push(f), goCompare: () => {} },
    })
    expect(seen[0]!.tracking).toBe(trip.id)
    // Two curated members, though four rows fall inside the trip's window.
    expect(r.rowsShown).toBe(2)
  })

  it('an unknown trip id is refused with the valid ones', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { nav: { goTab: () => {}, goTxns: () => {}, goCompare: () => {} } }), 'show_transactions', { trackingId: 'nope' })
    expect(out.error).toBe(true)
    expect(out.content).toContain('Japan')
  })

  it('navigate refuses an unknown screen and names the real ones', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { nav: { goTab: () => {}, goTxns: () => {}, goCompare: () => {} } }), 'navigate', { tab: 'wat' })
    expect(out.error).toBe(true)
    expect(out.content).toContain('accounts')
  })

  it('show_comparison hands both selections to the router', () => {
    const { vault } = fixture()
    const sides: Selection[] = []
    json(vault, 'show_comparison', { a: { period: { rel: 'thisMonth' } }, b: { period: { rel: 'lastMonth' } }, normalize: 'perDay' }, {
      nav: { goTab: () => {}, goTxns: () => {}, goCompare: (a, b) => sides.push(a, b) },
    })
    expect(sides).toEqual([{ period: { rel: 'thisMonth' } }, { period: { rel: 'lastMonth' } }])
  })

  it('without a router, control tools report unavailable instead of throwing', () => {
    const { vault } = fixture()
    expect(execTool(ctxOf(vault), 'navigate', { tab: 'dash' }).error).toBe(true)
  })
})

describe('skills (§6)', () => {
  const builtin = [
    { name: 'ledger-model', description: 'how it works', body: 'BUILTIN BODY', builtin: true },
    { name: 'valuation', description: 'template', body: 'TEMPLATE', builtin: true },
  ]

  it('list_skills sends descriptions only — a body leaves only when asked for', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { skills: builtin }), 'list_skills', {})
    expect(out.content).not.toContain('BUILTIN BODY')
    expect(JSON.parse(out.content)).toEqual([
      { name: 'ledger-model', description: 'how it works' },
      { name: 'valuation', description: 'template' },
    ])
    expect(JSON.parse(execTool(ctxOf(vault, { skills: builtin }), 'read_skill', { name: 'ledger-model' }).content).body).toBe('BUILTIN BODY')
  })

  it('an unknown skill name comes back with the available ones', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { skills: builtin }), 'read_skill', { name: 'nope' })
    expect(out.error).toBe(true)
    expect(JSON.parse(out.content).available).toEqual(['ledger-model', 'valuation'])
  })

  it('visibleSkills: off-list hides a built-in, a user skill of the same name shadows it', () => {
    const user = [{ id: '1', updatedAt: 'x', name: 'valuation', description: 'mine', body: 'MY BODY' }]
    const out = visibleSkills(builtin, user, ['ledger-model'])
    expect(out.map((s) => s.name)).toEqual(['valuation'])
    expect(out[0]!.body).toBe('MY BODY')
    expect(out[0]!.builtin).toBe(false)
  })

  it('a disabled user skill is not offered', () => {
    expect(visibleSkills([], [{ id: '1', updatedAt: 'x', name: 'a', description: 'd', body: 'b', enabled: false }], [])).toEqual([])
  })
})

describe('proposals commit nothing on their own (§5)', () => {
  it('recategorize queues a proposal and returns awaitingApproval', () => {
    const { vault, dining } = fixture()
    const shopping = catId(vault, 'Shopping')
    const queued: PendingEdit[] = []
    const id = vault.transactions[0]!.id // a Dining out row
    const r = json(vault, 'propose_edit', { kind: 'recategorize', txnIds: [id], categoryId: shopping, reason: 'a coat, not a meal' }, {
      propose: (e) => queued.push(e),
    })
    expect(r.awaitingApproval).toBe(true)
    expect(queued[0]!.op).toEqual({ kind: 'recategorizeBatch', txnIds: [id], categoryId: shopping })
    expect(queued[0]!.summary).toContain('Shopping')
    // The vault is untouched: only the user's click, through store.commit, can change it.
    expect(vault.transactions[0]!.categoryId).toBe(dining)
  })

  // Membership is `(rows in the window − excludes) ∪ includes`. Only the ∪ half was wired, so the
  // assistant could describe a subscription inflating a trip total and had no way to offer the fix.
  it('tag_tracking removes as well as adds', () => {
    const { vault } = fixture()
    const member = vault.transactions[0]!.id // in the Japan trip
    const queued: PendingEdit[] = []
    const r = json(vault, 'propose_edit', { kind: 'tag_tracking', txnIds: [member], trackingId: 'trk-japan', direction: 'remove', reason: 'a subscription, not the trip' }, {
      propose: (e) => queued.push(e),
    })
    expect(r.direction).toBe('remove')
    expect(queued[0]!.summary).toBe('Remove 1 transaction from Japan')
    expect(queued[0]!.op).toEqual({
      kind: 'setAssignments',
      trackingId: 'trk-japan',
      entries: [{ txnId: member, dir: 'exclude' }],
    })
  })

  // The card promises a total will drop; this proves the op it carries actually does that.
  it('applying a removal drops the trip total and undoes cleanly', () => {
    const { vault } = fixture()
    const member = vault.transactions[0]! // −42.50, in the Japan trip
    const queued: PendingEdit[] = []
    json(vault, 'propose_edit', { kind: 'tag_tracking', txnIds: [member.id], trackingId: 'trk-japan', direction: 'remove' }, {
      propose: (e) => queued.push(e),
    })
    expect(tripSummary(vault, 'trk-japan').total).toBe(60.5)

    const applied = applyOp(vault, queued[0]!.op)
    expect(tripSummary(applied.vault, 'trk-japan').total).toBe(18)
    expect(tripSummary(applied.vault, 'trk-japan').memberCount).toBe(1)

    // The undo toast has to put it back — this is an ordinary mutation, nothing special.
    expect(tripSummary(applyOp(applied.vault, applied.inverse!).vault, 'trk-japan').total).toBe(60.5)
  })

  it('defaults to adding, so an omitted direction cannot silently remove anything', () => {
    const { vault } = fixture()
    const queued: PendingEdit[] = []
    json(vault, 'propose_edit', { kind: 'tag_tracking', txnIds: [vault.transactions[2]!.id], trackingId: 'trk-japan' }, {
      propose: (e) => queued.push(e),
    })
    expect(queued[0]!.summary).toBe('Add 1 transaction to Japan')
    expect((queued[0]!.op as { entries: { dir: string }[] }).entries[0]!.dir).toBe('include')
  })

  it('removing rows that are not in the trip is refused, not shown as a card that does nothing', () => {
    const { vault } = fixture()
    const queued: PendingEdit[] = []
    const out = execTool(ctxOf(vault, { propose: (e) => queued.push(e) }), 'propose_edit', {
      kind: 'tag_tracking',
      txnIds: [vault.transactions[2]!.id], // outside the Japan window
      trackingId: 'trk-japan',
      direction: 'remove',
    })
    expect(out.error).toBe(true)
    expect(out.content).toContain('are in Japan')
    expect(queued).toHaveLength(0)
  })

  it('a direction that is neither add nor remove is refused', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { propose: () => {} }), 'propose_edit', {
      kind: 'tag_tracking',
      txnIds: [vault.transactions[0]!.id],
      trackingId: 'trk-japan',
      direction: 'purge',
    })
    expect(out.error).toBe(true)
  })

  it('an unknown transaction id is refused before anything is queued', () => {
    const { vault, dining } = fixture()
    const queued: PendingEdit[] = []
    const out = execTool(ctxOf(vault, { propose: (e) => queued.push(e) }), 'propose_edit', {
      kind: 'recategorize',
      txnIds: ['nope'],
      categoryId: dining,
    })
    expect(out.error).toBe(true)
    expect(queued).toHaveLength(0)
  })

  // One merchant spelled two ways reads as two subscriptions. The assistant can offer the merge;
  // it can no more apply it than any other edit here.
  it('merge_merchant queues a rename of the rows spelled the other way', () => {
    const { vault } = fixture()
    const t = vault.transactions[0]!
    const queued: PendingEdit[] = []
    const r = json(vault, 'propose_edit', { kind: 'merge_merchant', txnIds: [t.id], merchant: 'DEEZER', reason: 'same subscription, new descriptor' }, {
      propose: (e) => queued.push(e),
    })
    expect(r.awaitingApproval).toBe(true)
    expect(queued[0]!.summary).toBe('Rename 1 transaction to “DEEZER”')
    expect(queued[0]!.op).toEqual({
      kind: 'batch',
      ops: [{ kind: 'setField', collection: 'transactions', id: t.id, field: 'merchant', value: 'DEEZER' }],
    })
    expect(vault.transactions[0]!.merchant).toBe(t.merchant) // nothing committed
  })

  it('merging rows that already read that way is refused rather than shown as a no-op card', () => {
    const { vault } = fixture()
    const t = vault.transactions[0]!
    const queued: PendingEdit[] = []
    const out = execTool(ctxOf(vault, { propose: (e) => queued.push(e) }), 'propose_edit', {
      kind: 'merge_merchant',
      txnIds: [t.id],
      merchant: t.merchant,
    })
    expect(out.error).toBe(true)
    expect(queued).toHaveLength(0)
  })

  it('merge_merchant without a spelling to keep is refused', () => {
    const { vault } = fixture()
    const out = execTool(ctxOf(vault, { propose: () => {} }), 'propose_edit', {
      kind: 'merge_merchant',
      txnIds: [vault.transactions[0]!.id],
    })
    expect(out.error).toBe(true)
  })

  it('only the four approved kinds exist', () => {
    const { vault } = fixture()
    const queued: PendingEdit[] = []
    const out = execTool(ctxOf(vault, { propose: (e) => queued.push(e) }), 'propose_edit', {
      kind: 'delete_everything',
      txnIds: [vault.transactions[0]!.id],
    })
    expect(out.error).toBe(true)
    expect(queued).toHaveLength(0)
  })
})

/**
 * The assistant may now propose budgets and goals — the boundary ASSISTANT §5 previously drew at
 * transactions only. The guards that keep it safe are what these assert: nothing commits, the
 * delete surface is two collections wide, and the app computes any derived figure itself.
 */
describe('propose_plan (budgets & goals)', () => {
  const queueOf = (vault: Vault, args: Record<string, unknown>) => {
    const queued: PendingEdit[] = []
    const out = JSON.parse(execTool(ctxOf(vault, { propose: (e) => queued.push(e) }), 'propose_plan', args).content)
    return { queued, out }
  }

  it('queues a budget without touching the vault', () => {
    const { vault } = fixture()
    const before = vault.budgets.length
    const { queued, out } = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [catId(vault, 'Shopping')], amount: '250' })
    expect(out.awaitingApproval).toBe(true)
    expect(queued[0]!.op).toMatchObject({ kind: 'addBudget', amount: 250 })
    expect(vault.budgets).toHaveLength(before)
  })

  it('a create really does land and undo through the ordinary mutation path', () => {
    const { vault } = fixture()
    const { queued } = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [catId(vault, 'Shopping')], amount: '250', name: 'Clothes' })
    const applied = applyOp(vault, queued[0]!.op)
    expect(applied.vault.budgets.at(-1)).toMatchObject({ amount: 250, name: 'Clothes' })
    const undone = applyOp(applied.vault, applied.inverse!)
    expect(undone.vault.budgets).toHaveLength(vault.budgets.length)
  })

  /** The card is the last thing a user reads before real data lands, so it has to read like English. */
  it('a named budget reads as a phrase on the card, not as a bare name', () => {
    const { vault } = fixture()
    const named = queueOf(vault, {
      action: 'create', target: 'budget', categoryIds: [catId(vault, 'Shopping')], amount: '250', name: 'Investments (yearly)',
    })
    expect(named.queued[0]!.summary).toBe('Add a budget “Investments (yearly)” of 250 EUR')
    const plain = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [catId(vault, 'Shopping')], amount: '250' })
    expect(plain.queued[0]!.summary).toBe('Add a Shopping budget of 250 EUR')
  })

  it('a multi-category budget carries its members and needs a name', () => {
    const { vault } = fixture()
    const ids = [catId(vault, 'Shopping'), catId(vault, 'Dining out')]
    expect(queueOf(vault, { action: 'create', target: 'budget', categoryIds: ids, amount: '400' }).out.error).toBeTruthy()
    const { queued } = queueOf(vault, { action: 'create', target: 'budget', categoryIds: ids, amount: '400', name: 'Fun' })
    expect(queued[0]!.op).toMatchObject({ kind: 'addBudget', name: 'Fun', scope: { kind: 'group', categoryIds: ids } })
  })

  // The model picks the policy; Ledger works out the figure, so the approval card and the budget
  // dialog's own suggestion can never show different numbers.
  it('resolves "trailing-3" through the app’s own arithmetic', () => {
    const { vault } = fixture()
    const dining = catId(vault, 'Dining out')
    const { queued } = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [dining], amount: 'trailing-3' })
    // June is the only complete month with data: €60.50 of Dining out.
    expect(queued[0]!.op).toMatchObject({ kind: 'addBudget', amount: 61 })
    expect(queued[0]!.summary).toContain('3-month average')
  })

  it('refuses a trailing average it cannot compute, rather than proposing €0', () => {
    const { vault } = fixture()
    const out = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [catId(vault, 'Health')], amount: 'trailing-6' }).out
    expect(out.error).toBeTruthy()
    expect(JSON.stringify(out)).toContain('Not enough history')
  })

  it('refuses a duplicate and names the budget to update instead', () => {
    const { vault } = fixture()
    const shopping = catId(vault, 'Shopping')
    vault.budgets.push({ id: 'b-existing', updatedAt: 'x', categoryId: shopping, amount: 100 })
    const out = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [shopping], amount: '250' }).out
    expect(out.error).toBeTruthy()
    expect(out.existingBudgetId).toBe('b-existing')
  })

  it('a goal update round-trips targetDate and source instead of dropping them', () => {
    const { vault } = fixture()
    vault.goals.push({ id: 'g1', updatedAt: 'x', name: 'House', target: 10000, monthly: 0, saved: 0 })
    const shopping = catId(vault, 'Shopping')
    const { queued } = queueOf(vault, {
      action: 'update', target: 'goal', id: 'g1', targetDate: '2030-06', categoryIds: [shopping],
    })
    const applied = applyOp(vault, queued[0]!.op)
    const g = applied.vault.goals.find((x) => x.id === 'g1')!
    expect(g.targetDate).toBe('2030-06') // the docblock's own failure mode: said "by 2030", stored nothing
    expect(g.source).toEqual({ kind: 'flow', categoryId: shopping })
    expect(queued[0]!.summary).toContain('2030-06')
  })

  it('rejects a malformed targetDate on update, exactly like create', () => {
    const { vault } = fixture()
    vault.goals.push({ id: 'g1', updatedAt: 'x', name: 'House', target: 10000, monthly: 0, saved: 0 })
    const { out } = queueOf(vault, { action: 'update', target: 'goal', id: 'g1', targetDate: 'summer 2030' })
    expect(out.error).toBeTruthy()
  })

  it('an unknown id comes back with the valid list, as everywhere else', () => {
    const { vault } = fixture()
    expect(queueOf(vault, { action: 'create', target: 'budget', categoryIds: ['nope'], amount: '10' }).out.validCategoryIds).toBeTruthy()
    expect(queueOf(vault, { action: 'remove', target: 'goal', id: 'nope' }).out.validGoalIds).toBeTruthy()
  })

  it('archives a goal and deletes it — both undoable, and archive is offered first', () => {
    const { vault } = fixture()
    vault.goals.push({ id: 'g1', updatedAt: 'x', name: 'Bike', target: 2000, saved: 0, monthly: 0 })
    const arch = queueOf(vault, { action: 'archive', target: 'goal', id: 'g1' })
    expect(arch.queued[0]!.op).toEqual({ kind: 'setField', collection: 'goals', id: 'g1', field: 'archived', value: true })

    const rm = queueOf(vault, { action: 'remove', target: 'goal', id: 'g1' })
    expect(rm.queued[0]!.op).toEqual({ kind: 'delete', collection: 'goals', ids: ['g1'] })
    const applied = applyOp(vault, rm.queued[0]!.op)
    expect(applied.vault.goals.some((g) => g.id === 'g1')).toBe(false)
    // `delete` inverts to a `restore` carrying the whole record, so nothing is lost.
    expect(applyOp(applied.vault, applied.inverse!).vault.goals.some((g) => g.id === 'g1')).toBe(true)
  })

  it('creates a balance-linked goal, which the old form could never do', () => {
    const { vault, current } = fixture()
    const { queued } = queueOf(vault, {
      action: 'create', target: 'goal', name: 'Emergency fund', targetAmount: '40000', accountId: current, direction: 'up',
    })
    expect(queued[0]!.op).toMatchObject({ kind: 'addGoal', source: { kind: 'balance', accountId: current, direction: 'up' } })
    expect(queued[0]!.summary).toContain('from the Current account balance')
  })

  /**
   * The failure this closes: the parameters were camelCase except `target_amount`, so a model that had
   * just used that wrote `target_date` by analogy, the old lookup returned undefined, and the goal was
   * created with no date while the reply promised one. Silence was the bug, not the spelling.
   */
  it('reads a snake_case key the model guessed, instead of dropping it', () => {
    const { vault, current } = fixture()
    const { queued, out } = queueOf(vault, {
      action: 'create', target: 'goal', name: 'Net worth', target_amount: '500000', target_date: '2036-07', account_id: current,
    })
    expect(out.error).toBeUndefined()
    expect(queued[0]!.op).toMatchObject({ kind: 'addGoal', target: 500000, targetDate: '2036-07' })
    expect(queued[0]!.op).toMatchObject({ source: { kind: 'balance', accountId: current } })
  })

  it('a malformed date is reported, not stored and not silently dropped', () => {
    const { vault } = fixture()
    const out = queueOf(vault, { action: 'create', target: 'goal', name: 'X', targetAmount: '100', targetDate: 'July 2036' }).out
    expect(out.error).toContain('YYYY-MM')
  })

  it('the card states the date and what will drive the goal', () => {
    const { vault, dining } = fixture()
    const hand = queueOf(vault, { action: 'create', target: 'goal', name: 'Net worth', targetAmount: '500000', targetDate: '2036-07' })
    // "updated by hand" on the card is how a user learns, before Apply, that nothing fills it in.
    expect(hand.queued[0]!.summary).toBe('Add the goal “Net worth” · 500,000 EUR by 2036-07 · updated by hand')
    const derived = queueOf(vault, { action: 'create', target: 'goal', name: 'Eat out less', targetAmount: '1000', categoryIds: [dining] })
    expect(derived.queued[0]!.summary).toBe('Add the goal “Eat out less” · 1,000 EUR · from the Dining out category')
  })

  /**
   * A goal fed by a category keeps itself current: progress is the running sum of that category's
   * transactions. The tool always supported it, but the schema documented `categoryIds` as
   * budget-only while naming `trackingId` as a goal source — so the assistant read its own tool
   * definition and told a user that a category cannot drive a goal, which is the opposite of true.
   */
  it('creates a category-fed goal whose progress is derived, not typed in', () => {
    const { vault, dining } = fixture()
    const { queued } = queueOf(vault, {
      action: 'create', target: 'goal', name: 'Eat out less', targetAmount: '1000', categoryIds: [dining],
    })
    expect(queued[0]!.op).toMatchObject({ kind: 'addGoal', source: { kind: 'flow', categoryId: dining } })

    // Apply it, and the progress is already there without anybody editing a "saved" field.
    const applied = applyOp(vault, queued[0]!.op)
    const goal = applied.vault.goals.at(-1)!
    expect(goal.saved).toBe(0)
    const status = goalStatus(applied.vault, goal, TODAY)
    expect(status.kind).toBe('flow')
    expect(status.progress).toBe(90.5) // the three Dining out rows, summed by the app
  })

  it('the schema says a category can drive a goal, so the model does not have to guess', () => {
    const def = TOOLS.find((t) => t.name === 'propose_plan')!
    const schema = JSON.stringify(def)
    expect(schema).toContain('progress is the sum of that category’s transactions')
    expect(schema).toContain('the running sum of that category’s transactions')
    // Each of the four ways a goal tracks progress is named where the model will read it.
    for (const source of ['accountId', 'categoryIds', 'trackingId', 'monthly/saved']) {
      expect(def.description, source).toContain(source)
    }
    // And the two limits that make a plausible-looking goal measure the wrong thing: a flow source
    // has no period, and a goal follows at most one account.
    expect(def.description).toContain('A GOAL HAS NO PERIOD')
    expect(def.description).toContain('at most ONE account')
    // The card is take-it-or-leave-it, so a placeholder figure is not a draft the user can correct.
    expect(def.description).toContain('THE CARD CANNOT BE EDITED')
  })

  /**
   * `flowProgress` sums every matching transaction with `date <= today` and takes no period, so a
   * category-fed goal measures LIFETIME contributions. "Invest 30k a year" as a goal would therefore
   * read as 30k of all-time investing and never reset in January; the instrument with a period is a
   * yearly budget. The schema says so, because the arithmetic will not.
   */
  it('a category-fed goal measures all time, which is why a yearly target is a budget', () => {
    const { vault, dining } = fixture()
    const goal = { id: 'g-flow', updatedAt: 'x', name: 'Eat out less', target: 1000, saved: 0, monthly: 0, source: { kind: 'flow' as const, categoryId: dining } }
    vault.goals.push(goal)
    // The fixture's Dining out rows span June and July; the goal counts both, with no year boundary.
    expect(goalStatus(vault, goal, TODAY).progress).toBe(90.5)

    // The same category as a yearly budget is period-scoped, and that is what a per-year target needs.
    const { queued } = queueOf(vault, { action: 'create', target: 'budget', categoryIds: [dining], cadence: 'yearly', amount: '1000' })
    expect(queued[0]!.op).toMatchObject({ kind: 'addBudget', scope: { kind: 'category-year', year: 2026 } })
  })

  it('list_goals says what drives each goal, not only how far along it is', () => {
    const { vault, dining, current } = fixture()
    vault.goals.push(
      { id: 'g-hand', updatedAt: 'x', name: 'By hand', target: 100, saved: 10, monthly: 5 },
      { id: 'g-flow', updatedAt: 'x', name: 'From a category', target: 100, saved: 0, monthly: 0, source: { kind: 'flow', categoryId: dining } },
      { id: 'g-bal', updatedAt: 'x', name: 'From a balance', target: 100, saved: 0, monthly: 0, source: { kind: 'balance', accountId: current, direction: 'up', target: 100 } },
    )
    const byId = new Map(json(vault, 'list_goals').map((g: { id: string }) => [g.id, g]))
    expect(byId.get('g-hand')).toMatchObject({ kind: 'legacy' })
    expect(byId.get('g-flow')).toMatchObject({ kind: 'flow', categoryId: dining })
    expect(byId.get('g-bal')).toMatchObject({ kind: 'balance', accountId: current, direction: 'up' })
  })

  // The whole reason this is a separate tool: its delete arm reaches two collections and no more.
  it('cannot reach any collection but budgets and goals', () => {
    const { vault } = fixture()
    for (const target of ['transaction', 'account', 'category', 'statements']) {
      expect(queueOf(vault, { action: 'remove', target, id: 'x' }).out.error).toBeTruthy()
    }
    // And a budget cannot be "archived" — there is no such field, so it says so.
    vault.budgets.push({ id: 'b9', updatedAt: 'x', categoryId: catId(vault, 'Shopping'), amount: 100 })
    expect(queueOf(vault, { action: 'archive', target: 'budget', id: 'b9' }).out.error).toBeTruthy()
  })

  it('propose_edit still has exactly its four transaction kinds', () => {
    const def = TOOLS.find((t) => t.name === 'propose_edit')!
    expect(JSON.stringify(def.parameters)).toContain('recategorize, set_recurring, tag_tracking, merge_merchant')
    expect(def.parameters.required).toContain('txnIds')
  })
})
