// Safe mode (ASSISTANT §2.2, §5.1).
//
// The load-bearing test here is a LEAK PROPERTY, not a field-by-field comparison. A field list has to
// be updated by hand whenever a tool grows a field, and the day someone forgets is the day an amount
// escapes; "no amount and no date appears anywhere in any safe result" holds without maintenance and
// fails loudly the moment a new field carries money.
//
// Every assertion is paired with the same run under full access, so a fixture that accidentally
// contains no money cannot make the whole file pass vacuously.
import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import type { Settings, Vault } from '../../src/model/types'
import { derive } from '../../src/model/selectors'
import { chatAccess, chatAssist } from '../../src/assistant/config'
import { execTool, FULL_ONLY, safeModeGaps, TOOLS, toolsFor, type PendingEdit, type ToolCtx } from '../../src/assistant/tools'
import type { ToolDef } from '../../src/assistant/wire'
import { SYSTEM_PROMPT, SYSTEM_PROMPT_SAFE, systemPromptFor } from '../../src/assistant/prompt'
import { acc, buildVault, catId, goal, snap, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const TODAY = '2026-07-12'

/**
 * Distinctive amounts and dates, all well away from the current month, so a match in a safe result is
 * unambiguously a leak and not a coincidence with `today`.
 */
const AMOUNTS = ['123.45', '987.65', '4210.99', '333.33', '5000', '2750']
const DATES = ['2026-03-17', '2026-03-29', '2026-02-04', '2026-03-31']

function fixture(): { vault: Vault; dining: string; account: string } {
  let dining = ''
  let account = ''
  const vault = buildVault((v) => {
    dining = catId(v, 'Dining out')
    const a = acc(v, { name: 'Current account', institution: 'BNP', liquid: true })
    account = a.id
    snap(v, a.id, '2026-03-31', 4210.99)
    txn(v, '2026-03-17', 'Bistro', 'Dining out', -123.45).accountId = a.id
    txn(v, '2026-03-29', 'Supermarket', 'Groceries', -987.65).accountId = a.id
    txn(v, '2026-02-04', 'Employer', 'Income', 333.33).accountId = a.id
    v.trackings.push({ id: 'trk-1', updatedAt: 'x', name: 'Iceland', kind: 'trip', dateFrom: '2026-03-17', dateTo: '2026-03-29' })
    v.budgets.push({ id: 'bud-1', updatedAt: 'x', categoryId: dining, amount: 2750 })
    goal(v, { name: 'Rainy day', target: 5000, saved: 333.33, monthly: 123.45 })
    goal(v, {
      name: 'Pay off card',
      target: 0,
      saved: 0,
      monthly: 0,
      source: { kind: 'balance', accountId: a.id, direction: 'down', target: 0 },
    })
    goal(v, { name: 'Eat out less', target: 5000, saved: 0, monthly: 0, source: { kind: 'flow', categoryId: dining } })
  })
  return { vault, dining, account }
}

const ctxOf = (vault: Vault, over: Partial<ToolCtx> = {}): ToolCtx => ({
  vault,
  derived: derive(vault),
  today: TODAY,
  skills: [{ name: 'notes', description: 'a note', body: 'The flat is worth 320000.', builtin: false }],
  access: 'safe',
  ...over,
})

/** Every tool safe mode offers, run with empty arguments, as one blob of text. */
function sweep(vault: Vault, access: 'safe' | 'full'): string {
  const ctx = ctxOf(vault, { access })
  const names = access === 'safe' ? toolsFor('safe').map((t) => t.name) : TOOLS.map((t) => t.name)
  return names
    .map((name) => {
      const r = execTool(ctx, name, {})
      return `${name} ${r.content} ${r.receipt}`
    })
    .join('\n')
}

describe('the safe catalogue (§5.1)', () => {
  it('is TOOLS minus exactly the tools that carry money, and full access is TOOLS whole', () => {
    const safe = toolsFor('safe').map((t) => t.name)
    const full = toolsFor('full').map((t) => t.name)
    expect(full).toEqual(TOOLS.map((t) => t.name))
    expect(safe).toEqual(TOOLS.map((t) => t.name).filter((n) => !FULL_ONLY.includes(n)))
    for (const n of FULL_ONLY) expect(safe).not.toContain(n)
    // Discovery, skills and the three control tools survive — a safe assistant is not a mute one.
    for (const n of ['get_overview', 'list_categories', 'list_accounts', 'list_trackings', 'list_budgets', 'list_goals', 'list_skills', 'read_skill', 'navigate', 'show_transactions', 'show_comparison']) {
      expect(safe).toContain(n)
    }
    // A write is not a read: propose_plan stays, because the figures in a plan proposal come from the
    // person asking, not from the vault. Its two reading paths are closed inside the executor.
    expect(safe).toContain('propose_plan')
  })

  it('every withheld tool is REFUSED, not merely unadvertised', () => {
    // The catalogue decides what the model is offered; this decides what it gets. A model can name a
    // tool it was never given, so filtering the list alone would not be a boundary.
    const { vault } = fixture()
    const ctx = ctxOf(vault)
    for (const name of FULL_ONLY) {
      const r = execTool(ctx, name, { selection: {}, groupBy: 'category' })
      expect(r.error, name).toBe(true)
      expect(JSON.parse(r.content).error, name).toMatch(/safe mode/)
    }
  })

  it('the same calls succeed under full access', () => {
    const { vault } = fixture()
    const ctx = ctxOf(vault, { access: 'full' })
    expect(execTool(ctx, 'aggregate', { selection: {}, groupBy: 'category' }).error).toBeUndefined()
    expect(execTool(ctx, 'query_transactions', { selection: {} }).error).toBeUndefined()
  })
})

describe('no amount and no date leaves the device (§2.2)', () => {
  it('no safe result contains a decimal figure', () => {
    const { vault } = fixture()
    const safe = sweep(vault, 'safe')
    expect(safe).not.toMatch(/\d+\.\d/)
    // Not a vacuous pass: the same sweep under full access is full of them.
    expect(sweep(vault, 'full')).toMatch(/\d+\.\d/)
  })

  it('no safe result contains any of the fixture’s amounts', () => {
    const { vault } = fixture()
    const safe = sweep(vault, 'safe')
    const full = sweep(vault, 'full')
    for (const amount of AMOUNTS) {
      expect(safe, amount).not.toContain(amount)
      expect(full, amount).toContain(amount)
    }
  })

  it('the only date in a safe result is today', () => {
    const { vault } = fixture()
    const safe = sweep(vault, 'safe')
    for (const m of safe.match(/\d{4}-\d{2}-\d{2}/g) ?? []) expect(m).toBe(TODAY)
    for (const date of DATES) {
      expect(safe, date).not.toContain(date)
      expect(sweep(vault, 'full'), date).toContain(date)
    }
    // Month keys leak a span too: the data starts in February, and safe mode must not say so.
    expect(safe).not.toContain('2026-02')
    expect(safe).not.toContain('2026-03')
  })
})

describe('what safe mode does report', () => {
  const json = (vault: Vault, name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(execTool(ctxOf(vault), name, args).content)

  it('get_overview: counts and today, no span', () => {
    const { vault } = fixture()
    const r = json(vault, 'get_overview')
    expect(r).toMatchObject({ access: 'safe', today: TODAY, baseCurrency: 'EUR', monthsCovered: 2 })
    expect(r.counts.transactions).toBe(3)
    expect(r.firstMonth).toBeUndefined()
    expect(r.lastMonth).toBeUndefined()
    expect(r.latestTransactionDate).toBeUndefined()
  })

  it('list_accounts: whether a balance exists, and how many rows — never the balance', () => {
    const { vault, account } = fixture()
    const row = json(vault, 'list_accounts').find((a: { id: string }) => a.id === account)
    expect(row).toMatchObject({ name: 'Current account', institution: 'BNP', hasBalance: true, transactionCount: 3 })
    expect(row.balance).toBeUndefined()
  })

  it('list_categories: names with a per-category count', () => {
    const { vault, dining } = fixture()
    const row = json(vault, 'list_categories').find((c: { id: string }) => c.id === dining)
    expect(row).toMatchObject({ name: 'Dining out', transactionCount: 1 })
  })

  it('list_trackings: member count, no window and no total', () => {
    const { vault } = fixture()
    const r = json(vault, 'list_trackings')
    expect(r.trackings[0]).toEqual({ id: 'trk-1', name: 'Iceland', kind: 'trip', archived: false, memberCount: 2 })
  })

  it('list_budgets: how many charges the scope matched, not the limit or the spend', () => {
    const { vault, dining } = fixture()
    const r = json(vault, 'list_budgets', { month: '2026-03' })
    expect(r.budgets[0]).toMatchObject({ id: 'bud-1', categoryIds: [dining], transactionCount: 1 })
    expect(r.budgets[0].amount).toBeUndefined()
    expect(r.budgets[0].spent).toBeUndefined()
  })

  it('list_goals: kind and what it is measured from, never a target or progress', () => {
    const { vault, account } = fixture()
    const byName = new Map(json(vault, 'list_goals').goals.map((g: { name: string }) => [g.name, g]))
    expect(byName.get('Rainy day')).toEqual({ id: expect.any(String), name: 'Rainy day', kind: 'legacy', archived: false })
    expect(byName.get('Pay off card')).toMatchObject({ kind: 'balance', accountId: account, direction: 'down', snapshotCount: 1 })
    expect(byName.get('Eat out less')).toMatchObject({ kind: 'flow', contributionCount: 1 })
    for (const g of byName.values()) {
      const row = g as Record<string, unknown>
      expect(row.target).toBeUndefined()
      expect(row.progress).toBeUndefined()
      expect(row.fraction).toBeUndefined()
      expect(row.asOf).toBeUndefined()
    }
  })

  it('skills are NOT restricted: a body the user wrote still reaches the model', () => {
    // The user's decision, and the reason Settings marks the skills that lean on a withheld tool
    // instead of quietly dropping them.
    const { vault } = fixture()
    expect(json(vault, 'read_skill', { name: 'notes' }).body).toContain('320000')
  })

  it('show_transactions still opens a filtered list and reports its row count', () => {
    const { vault, dining } = fixture()
    const opened: unknown[] = []
    const ctx = ctxOf(vault, {
      nav: { goTab: () => {}, goTxns: (f) => opened.push(f), goCompare: () => {} },
    })
    const r = JSON.parse(execTool(ctx, 'show_transactions', { categoryId: dining }).content)
    expect(r.rowsShown).toBe(1)
    expect(opened).toHaveLength(1)
  })
})

describe('plan changes in safe mode (§5.0)', () => {
  /** A ctx that can queue, so propose_plan gets past its `ctx.propose` guard. */
  const proposingCtx = (vault: Vault, access: 'safe' | 'full' = 'safe') => {
    const queued: PendingEdit[] = []
    return { ctx: ctxOf(vault, { access, propose: (e) => queued.push(e) }), queued }
  }

  it('archiving a goal is allowed: it names a goal and reads no money', () => {
    const { vault } = fixture()
    const goalId = vault.goals.find((g) => g.name === 'Rainy day')!.id
    const { ctx, queued } = proposingCtx(vault)
    const r = execTool(ctx, 'propose_plan', { action: 'archive', target: 'goal', id: goalId, reason: 'done with it' })
    expect(r.error).toBeUndefined()
    expect(JSON.parse(r.content)).toMatchObject({ proposed: 'goal.archive', awaitingApproval: true })
    expect(queued[0]!.summary).toBe('Archive the goal “Rainy day”')
    // And the proposal is still only a proposal.
    expect(vault.goals.find((g) => g.id === goalId)!.archived).toBeUndefined()
  })

  it('a limit the user said out loud is allowed, and no vault figure comes back', () => {
    const { vault } = fixture()
    const { ctx, queued } = proposingCtx(vault)
    const r = execTool(ctx, 'propose_plan', {
      action: 'create',
      target: 'budget',
      categoryIds: [catId(vault, 'Groceries')], // dining already has one; that clash is its own test
      amount: '400',
      reason: 'they asked for 400',
    })
    expect(r.error).toBeUndefined()
    // 400 is the model's own number, echoed back. Nothing was read to produce it.
    expect(JSON.parse(r.content)).toMatchObject({ proposed: 'budget.create', amount: 400 })
    expect(queued[0]!.summary).toContain('400')
  })

  it('a trailing average is refused, because working one out means reading real spending', () => {
    const { vault, dining } = fixture()
    const { ctx, queued } = proposingCtx(vault)
    for (const amount of ['trailing-3', 'trailing-6']) {
      const r = execTool(ctx, 'propose_plan', { action: 'create', target: 'budget', categoryIds: [dining], amount })
      expect(r.error, amount).toBe(true)
      expect(JSON.parse(r.content).error, amount).toMatch(/safe mode withholds/)
    }
    expect(queued).toHaveLength(0)
    // Under full access the same call gets PAST the gate and into the arithmetic, which is what
    // proves the gate is what stopped it. This fixture has no recent months to average, so the
    // honest answer there is "not enough history" rather than a figure.
    const full = proposingCtx(vault, 'full')
    const err = JSON.parse(
      execTool(full.ctx, 'propose_plan', { action: 'create', target: 'budget', categoryIds: [dining], amount: 'trailing-3' }).content,
    ).error
    expect(err).toMatch(/Not enough history/)
    expect(err).not.toMatch(/safe mode/)
  })

  it('the duplicate-budget error withholds the existing amount', () => {
    const { vault, dining } = fixture()
    const args = { action: 'create', target: 'budget', categoryIds: [dining], amount: '100' }
    const safeErr = JSON.parse(execTool(proposingCtx(vault).ctx, 'propose_plan', args).content)
    expect(safeErr.existingBudgetId).toBe('bud-1')
    expect(safeErr.existingAmount).toBeUndefined()
    // The id is what redirects the model to an update; the amount is a vault figure.
    const fullErr = JSON.parse(execTool(proposingCtx(vault, 'full').ctx, 'propose_plan', args).content)
    expect(fullErr.existingAmount).toBe(2750)
  })

  it('the schema does not advertise the trailing average it is about to refuse', () => {
    // A model that reads "trailing-3", calls it, and gets refused has burned a round on the tool's
    // own advice. One real conversation did that three times before the safe schema existed.
    const amountDesc = (tool: ToolDef) =>
      (tool.parameters.properties as Record<string, { description: string }>).amount!.description
    const safe = toolsFor('safe').find((t) => t.name === 'propose_plan')!
    expect(amountDesc(safe)).not.toContain('trailing-3')
    expect(amountDesc(safe)).toContain('has to come from the user')
    // Unchanged under full access, and TOOLS itself is never mutated.
    const full = toolsFor('full').find((t) => t.name === 'propose_plan')!
    expect(amountDesc(full)).toContain('trailing-3')
    expect(full).toBe(TOOLS.find((t) => t.name === 'propose_plan'))
  })

  it('a category-fed goal is proposable in safe mode: the target is the user’s number', () => {
    // The shape the transcript should have produced for "I want to invest 30k per year": progress
    // comes from the Investment category, so nothing has to be read to set it up and nothing has to
    // be typed in later to keep it current.
    const { vault, dining } = fixture()
    const { ctx, queued } = proposingCtx(vault)
    const r = execTool(ctx, 'propose_plan', {
      action: 'create',
      target: 'goal',
      name: 'Eat out less',
      targetAmount: '1000',
      categoryIds: [dining],
    })
    expect(r.error).toBeUndefined()
    expect(queued[0]!.op).toMatchObject({ kind: 'addGoal', source: { kind: 'flow', categoryId: dining } })
  })

  it('transaction edits stay withheld, since their ids can only come from a withheld tool', () => {
    const { vault } = fixture()
    const { ctx, queued } = proposingCtx(vault)
    const r = execTool(ctx, 'propose_edit', { kind: 'set_recurring', txnIds: ['whatever'], recurring: 'monthly' })
    expect(r.error).toBe(true)
    expect(queued).toHaveLength(0)
  })
})

describe('the access level itself (§2.2)', () => {
  const base: NonNullable<Settings['assist']> = { provider: 'openrouter', model: 'm', apiKey: 'k' }

  it('absent means safe, for every vault — including one that already consented to chat', () => {
    expect(chatAccess(undefined)).toBe('safe')
    expect(chatAccess(base)).toBe('safe')
    expect(chatAccess({ ...base, chat: true, toolsVerified: 'openrouter::m' })).toBe('safe')
  })

  it('only the exact string "full" opens the vault', () => {
    expect(chatAccess({ ...base, chatAccess: 'full' })).toBe('full')
    expect(chatAccess({ ...base, chatAccess: 'safe' })).toBe('safe')
    // A malformed value fails closed rather than granting access.
    expect(chatAccess({ ...base, chatAccess: 'FULL' as 'full' })).toBe('safe')
  })

  it('each access level gets its own prompt, and both carry the honesty rules', () => {
    expect(systemPromptFor('full')).toBe(SYSTEM_PROMPT)
    expect(systemPromptFor('safe')).toBe(SYSTEM_PROMPT_SAFE)
    for (const p of [SYSTEM_PROMPT, SYSTEM_PROMPT_SAFE]) {
      expect(p).toContain('Flow and stock never mix')
      expect(p).toContain('the figures that inform the decision, not a verdict')
    }
    // The safe prompt must not send the model after tools it does not have.
    expect(SYSTEM_PROMPT_SAFE).not.toContain('Prefer aggregate over query_transactions')
    expect(SYSTEM_PROMPT_SAFE).toContain('safe mode')
    // Neither prompt carries vault data — the posture this whole feature rests on.
    for (const p of [SYSTEM_PROMPT, SYSTEM_PROMPT_SAFE]) expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('skills that lean on a withheld tool', () => {
  it('are named, so Settings can mark them', () => {
    expect(safeModeGaps('Use aggregate to total the month, then compare_selections.')).toEqual([
      'aggregate',
      'compare_selections',
    ])
    expect(safeModeGaps('Call show_transactions and read the screens skill.')).toEqual([])
  })
})

describe('the assistant’s own provider and model (§2.1)', () => {
  const base: NonNullable<Settings['assist']> = {
    provider: 'ollama',
    wire: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    apiKey: '',
    perProvider: { anthropic: { apiKey: 'sk-ant' } },
  }

  it('with no override, the categorization config is returned untouched', () => {
    expect(chatAssist(base)).toBe(base)
  })

  it('a model-only override keeps the provider, key and base URL', () => {
    const r = chatAssist({ ...base, chatModel: 'qwen3:30b' })
    expect(r).toMatchObject({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:30b' })
  })

  it('a provider override takes that provider’s OWN banked credentials, never the active one’s', () => {
    const r = chatAssist({ ...base, chatProvider: 'anthropic', chatWire: 'anthropic', chatModel: 'claude-sonnet-5' })
    expect(r).toMatchObject({ provider: 'anthropic', wire: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant' })
    // The local runtime's base URL must not follow the request to Anthropic.
    expect(r.baseUrl).toBeUndefined()
  })

  it('an override with nothing banked yields an empty key rather than borrowing one', () => {
    const withKey = { ...base, apiKey: 'sk-local-secret' }
    const r = chatAssist({ ...withKey, chatProvider: 'openai', chatModel: 'gpt-5' })
    expect(r.apiKey).toBe('')
  })
})
