import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import type { Settings, Vault } from '../../src/model/types'
import { derive } from '../../src/model/selectors'
import { runChat } from '../../src/assistant/chat'
import { chatVerifiedKey, probeMessage, probeToolCalling, toolsVerified, verifiedKey } from '../../src/assistant/probe'
import { FULL_ONLY, TOOLS, type ToolCtx } from '../../src/assistant/tools'
import type { Turn } from '../../src/assistant/wire'
import { buildVault, txn } from '../helpers/build'

beforeAll(() => setFixedNow('2026-07-12T14:32:00Z'))

const assist: NonNullable<Settings['assist']> = {
  provider: 'openrouter',
  wire: 'openai',
  model: 'm',
  apiKey: 'k',
  chat: true,
  toolsVerified: verifiedKey('openrouter', 'm'),
  // The stored default is safe (§2.2). These tests are about the loop, so they opt into full access
  // explicitly; the default itself is asserted in the safe-mode block below.
  chatAccess: 'full',
}

const settings = (over: Partial<NonNullable<Settings['assist']>> = {}): Settings => ({
  id: 'settings',
  updatedAt: 'x',
  saveMode: 'onChange',
  assist: { ...assist, ...over },
})

function fixture(): Vault {
  return buildVault((v) => {
    txn(v, '2026-06-05', 'Bistro', 'Dining out', -42.5)
  })
}

const ctxOf = (vault: Vault, over: Partial<ToolCtx> = {}): ToolCtx => ({
  vault,
  derived: derive(vault),
  today: '2026-07-12',
  skills: [],
  access: 'full',
  ...over,
})

/** A provider that plays a scripted list of replies, one per request. */
function scripted(replies: unknown[]): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = []
  let at = 0
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''))
    const reply = replies[Math.min(at++, replies.length - 1)]
    return { ok: true, status: 200, json: async () => reply } as Response
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

const say = (text: string) => ({ choices: [{ message: { content: text } }] })
const call = (name: string, args: unknown, id = 'c1') => ({
  choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
})

const user = (text: string): Turn[] => [{ role: 'user', text }]

describe('the agent loop (§3)', () => {
  it('runs a tool, feeds the result back, and returns the answer', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([call('list_categories', {}), say('You spent €42.50 on dining.')])
    const res = await runChat(settings(), user('how much on dining?'), ctxOf(vault), { fetchImpl })

    expect(res.error).toBeUndefined()
    expect(res.rounds).toBe(2)
    expect(res.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // The second request carries the tool result — that is the only reason the model knows anything.
    expect(bodies[1]).toContain('Dining out')
  })

  it('the first request contains the question and no vault data', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('ok')])
    await runChat(settings(), user('how much on dining?'), ctxOf(vault), { fetchImpl })
    expect(bodies[0]).toContain('how much on dining?')
    expect(bodies[0]).not.toContain('Bistro')
    expect(bodies[0]).not.toContain('42.5')
  })

  it('stops at the round cap when the model never answers', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([call('get_overview', {})])
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl, maxRounds: 3 })
    expect(bodies).toHaveLength(3)
    expect(res.error).toContain('3 rounds')
  })

  it('a provider error ends the run with a sentence, never an exception', async () => {
    const vault = fixture()
    const fetchImpl = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl })
    expect(res.error).toContain('Rate limited')
    expect(res.turns).toHaveLength(1) // the user turn survives; the conversation is not destroyed
  })

  it('an unreachable provider degrades the same way', async () => {
    const vault = fixture()
    const fetchImpl = (async () => {
      throw new Error('network')
    }) as unknown as typeof fetch
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl })
    expect(res.error).toContain('did not answer')
  })

  it('Stop halts before the next request', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([call('get_overview', {})])
    const ac = new AbortController()
    ac.abort()
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl, signal: ac.signal })
    expect(res.stopped).toBe(true)
    expect(bodies).toHaveLength(0)
  })

  it('a failing tool is reported to the model, not to the user as a crash', async () => {
    const vault = fixture()
    const { fetchImpl } = scripted([call('aggregate', { selection: { categoryIds: ['nope'] }, groupBy: 'category' }), say('Let me try again.')])
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl })
    const toolTurn = res.turns.find((t): t is Extract<Turn, { role: 'tool' }> => t.role === 'tool')!
    expect(toolTurn.results[0]!.error).toBe(true)
    expect(res.error).toBeUndefined()
  })

  it('every tool turn carries a receipt for the transcript', async () => {
    const vault = fixture()
    const { fetchImpl } = scripted([call('get_overview', {}), say('done')])
    const res = await runChat(settings(), user('hi'), ctxOf(vault), { fetchImpl })
    const toolTurn = res.turns.find((t): t is Extract<Turn, { role: 'tool' }> => t.role === 'tool')!
    expect(toolTurn.results[0]!.receipt).toContain('Overview')
  })
})

describe('the loop refuses to run unconfigured (§2)', () => {
  it('consent off ⇒ no request is made at all', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('hi')])
    const res = await runChat(settings({ chat: false }), user('hi'), ctxOf(vault), { fetchImpl })
    expect(bodies).toHaveLength(0)
    expect(res.error).toContain('switched off')
  })

  it('a missing key stops it before the network', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('hi')])
    const res = await runChat(settings({ apiKey: '' }), user('hi'), ctxOf(vault), { fetchImpl })
    expect(bodies).toHaveLength(0)
    expect(res.error).toContain('API key')
  })
})

describe('the tool-calling gate (§4)', () => {
  it('a model that calls the probe tool passes', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => call('report_ready', { ready: true }) }) as Response) as unknown as typeof fetch
    expect(await probeToolCalling(assist, { fetchImpl })).toEqual({ kind: 'ok' })
  })

  it('a model that answers in prose fails — there is no degraded mode', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => say('Sure, I am ready!') }) as Response) as unknown as typeof fetch
    const r = await probeToolCalling(assist, { fetchImpl })
    expect(r).toEqual({ kind: 'noTools' })
    expect(probeMessage(r, 'llama-2')).toContain('ignored the tool')
  })

  it('a refusal with no explanation hedges rather than asserting a limitation', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 400, text: async () => '' }) as Response) as unknown as typeof fetch
    const r = await probeToolCalling(assist, { fetchImpl })
    expect(r).toEqual({ kind: 'rejected', status: 400 })
    // "may not", not "does not": a 400 on a tool request has several causes, and the old wording
    // asserted the one that happened to be wrong for OpenAI's reasoning models.
    expect(probeMessage(r, 'tiny-model')).toContain('may not support tools')
  })

  it('a refusal repeats the provider’s own explanation instead of guessing', async () => {
    const body = JSON.stringify({ error: { message: 'Function tools with reasoning_effort are not supported.' } })
    const fetchImpl = (async () => ({ ok: false, status: 400, text: async () => body }) as Response) as unknown as typeof fetch
    const r = await probeToolCalling(assist, { fetchImpl })
    expect(r).toEqual({ kind: 'rejected', status: 400, detail: 'Function tools with reasoning_effort are not supported.' })
    expect(probeMessage(r, 'tiny-model')).toContain('reasoning_effort')
    expect(probeMessage(r, 'tiny-model')).not.toContain('may not support tools')
  })

  // The real defect this was written for: OpenAI's gpt-5.x models refuse function tools at any
  // reasoning_effort but 'none', while answering plain chat fine. Without the retry the gate locks
  // the assistant off a model that works, blaming a capability the model has.
  it('a tools-refused-for-effort 400 is retried once with reasoning_effort none', async () => {
    const sent: string[] = []
    const refusal = JSON.stringify({
      error: { message: "Function tools with reasoning_effort are not supported for m. …set reasoning_effort to 'none'." },
    })
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(String(init.body))
      return sent.length === 1
        ? ({ ok: false, status: 400, text: async () => refusal } as Response)
        : ({ ok: true, status: 200, json: async () => call('report_ready', { ready: true }) } as Response)
    }) as unknown as typeof fetch

    expect(await probeToolCalling(assist, { fetchImpl })).toEqual({ kind: 'ok' })
    expect(sent).toHaveLength(2)
    // The first attempt must stay clean: sending the parameter unconditionally would break every
    // OpenAI-compatible endpoint that rejects an unknown field.
    expect(JSON.parse(sent[0]!).reasoning_effort).toBeUndefined()
    expect(JSON.parse(sent[1]!).reasoning_effort).toBe('none')
  })

  it('does not retry a 400 that is not about reasoning effort', async () => {
    let calls = 0
    const body = JSON.stringify({ error: { message: 'Unknown model.' } })
    const fetchImpl = (async () => {
      calls++
      return { ok: false, status: 400, text: async () => body } as Response
    }) as unknown as typeof fetch
    expect(await probeToolCalling(assist, { fetchImpl })).toEqual({ kind: 'rejected', status: 400, detail: 'Unknown model.' })
    expect(calls).toBe(1)
  })

  it('a bad key is reported as a key problem, not a capability one', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch
    expect(probeMessage(await probeToolCalling(assist, { fetchImpl }), 'm')).toContain('API key')
  })

  it('the verdict belongs to one provider+model pair', () => {
    expect(toolsVerified(assist)).toBe(true)
    expect(toolsVerified({ ...assist, model: 'other' })).toBe(false)
    expect(toolsVerified({ ...assist, provider: 'openai' })).toBe(false)
    expect(toolsVerified({ ...assist, toolsVerified: undefined })).toBe(false)
  })

  it('the pair that must pass is the ASSISTANT’s, not categorization’s (§2.1)', () => {
    // With an override, the categorization model is irrelevant to the gate: changing it must not
    // re-lock a chat model already proven, and changing the chat model must.
    const own = { ...assist, chatModel: 'big', toolsVerified: verifiedKey('openrouter', 'big') }
    expect(toolsVerified(own)).toBe(true)
    expect(toolsVerified({ ...own, model: 'anything-else' })).toBe(true)
    expect(toolsVerified({ ...own, chatModel: 'bigger' })).toBe(false)
    expect(chatVerifiedKey(own)).toBe('openrouter::big')
    // A different provider for the assistant keys the verdict to that provider.
    expect(chatVerifiedKey({ ...assist, chatProvider: 'anthropic', chatModel: 'claude-sonnet-5' })).toBe(
      'anthropic::claude-sonnet-5',
    )
  })

  it('probes the assistant’s own endpoint, with that provider’s own key', async () => {
    const seen: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return { ok: true, status: 200, json: async () => call('report_ready', { ready: true }) } as Response
    }) as unknown as typeof fetch
    await probeToolCalling(
      {
        ...assist,
        chatProvider: 'anthropic',
        chatWire: 'anthropic',
        chatModel: 'claude-sonnet-5',
        perProvider: { anthropic: { apiKey: 'sk-ant' } },
      },
      { fetchImpl },
    )
    expect(seen[0]!.url).toContain('api.anthropic.com')
    expect(String(seen[0]!.init?.body)).toContain('claude-sonnet-5')
    expect((seen[0]!.init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant')
  })

  it('nothing is probed when there is nothing configured', async () => {
    expect(await probeToolCalling(undefined)).toEqual({ kind: 'unconfigured' })
    expect(await probeToolCalling({ ...assist, apiKey: '' })).toEqual({ kind: 'unconfigured' })
    // An override with no key of its own is unconfigured even though categorization has one.
    expect(await probeToolCalling({ ...assist, chatProvider: 'anthropic', chatModel: 'x' })).toEqual({
      kind: 'unconfigured',
    })
  })
})

describe('the loop reads access from settings, not from the caller (§2.2, §5.1)', () => {
  it('a vault that never set access gets the safe prompt and the safe catalogue', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('ok')])
    // `chatAccess: undefined` — a vault that consented to chat before safe mode existed.
    await runChat(settings({ chatAccess: undefined }), user('how much on dining?'), ctxOf(vault), { fetchImpl })
    const body = JSON.parse(bodies[0]!)
    const names = body.tools.map((t: { function: { name: string } }) => t.function.name)
    for (const n of FULL_ONLY) expect(names).not.toContain(n)
    expect(names).toContain('show_transactions')
    expect(JSON.stringify(body)).toContain('safe mode')
  })

  it('full access advertises the whole catalogue', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('ok')])
    await runChat(settings({ chatAccess: 'full' }), user('hi'), ctxOf(vault), { fetchImpl })
    const names = JSON.parse(bodies[0]!).tools.map((t: { function: { name: string } }) => t.function.name)
    expect(names).toEqual(TOOLS.map((t) => t.name))
  })

  it('a ctx that claims full access cannot widen a safe run', async () => {
    // The panel builds the ctx; settings decide what it may read. If the two disagree, settings win —
    // otherwise a caller that forgot to narrow its ctx would silently hand over the vault.
    const vault = fixture()
    const { fetchImpl } = scripted([call('aggregate', { selection: {}, groupBy: 'category' }), say('sorry')])
    const res = await runChat(settings({ chatAccess: undefined }), user('hi'), ctxOf(vault, { access: 'full' }), {
      fetchImpl,
    })
    const toolTurn = res.turns.find((t): t is Extract<Turn, { role: 'tool' }> => t.role === 'tool')!
    expect(toolTurn.results[0]!.error).toBe(true)
    expect(toolTurn.results[0]!.content).toContain('safe mode')
  })

  it('sends the assistant’s own model when it has one', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('ok')])
    await runChat(settings({ chatModel: 'a-bigger-model' }), user('hi'), ctxOf(vault), { fetchImpl })
    expect(JSON.parse(bodies[0]!).model).toBe('a-bigger-model')
  })

  it('says whose configuration is incomplete when the assistant has its own provider', async () => {
    const vault = fixture()
    const { fetchImpl, bodies } = scripted([say('hi')])
    const res = await runChat(
      settings({ chatProvider: 'anthropic', chatModel: 'claude-sonnet-5' }),
      user('hi'),
      ctxOf(vault),
      { fetchImpl },
    )
    expect(bodies).toHaveLength(0)
    expect(res.error).toContain('assistant')
    expect(res.error).toContain('API key')
  })
})
