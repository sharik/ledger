import { describe, expect, it } from 'vitest'
import type { Settings } from '../../src/model/types'
import { buildChatRequest, parseReply, type ToolDef, type Turn } from '../../src/assistant/wire'

const TOOLS: ToolDef[] = [
  { name: 'aggregate', description: 'totals', parameters: { type: 'object', properties: { groupBy: { type: 'string' } } } },
]

const anthropic: NonNullable<Settings['assist']> = { provider: 'anthropic', wire: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }
const openai: NonNullable<Settings['assist']> = { provider: 'openai', wire: 'openai', model: 'gpt-x', apiKey: 'k' }

const bodyOf = (init: RequestInit) => JSON.parse(init.body as string)

const CONVO: Turn[] = [
  { role: 'user', text: 'what did I spend on dining?' },
  { role: 'assistant', text: 'Looking.', calls: [{ id: 'c1', name: 'aggregate', args: { groupBy: 'category' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 'aggregate', content: '{"expense":42}', receipt: 'Dining · 42' }] },
]

describe('request shape per wire (§3)', () => {
  it('anthropic: system is top-level, tools carry input_schema, results ride a user turn', () => {
    const { url, init } = buildChatRequest(anthropic, { system: 'SYS', turns: CONVO, tools: TOOLS })
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const b = bodyOf(init)
    expect(b.system).toBe('SYS')
    expect(b.tools[0]).toMatchObject({ name: 'aggregate', input_schema: { type: 'object' } })
    expect(b.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'c1', name: 'aggregate', input: { groupBy: 'category' } },
      ],
    })
    // No `tool` role exists in the Messages API — results come back as a user turn.
    expect(b.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"expense":42}' }],
    })
  })

  it('openai: system is a message, tools are function-wrapped, arguments are a JSON string', () => {
    const { url, init } = buildChatRequest(openai, { system: 'SYS', turns: CONVO, tools: TOOLS })
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const b = bodyOf(init)
    expect(b.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(b.tools[0]).toMatchObject({ type: 'function', function: { name: 'aggregate' } })
    expect(b.messages[2].tool_calls[0].function.arguments).toBe('{"groupBy":"category"}')
    expect(b.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"expense":42}' })
    // OpenAI's own API rejects max_tokens on current models (same rule as the import path).
    expect(b.max_completion_tokens).toBeGreaterThan(0)
    expect(b.max_tokens).toBeUndefined()
  })

  it('a receipt is display-only and never reaches the provider', () => {
    for (const assist of [anthropic, openai]) {
      const { init } = buildChatRequest(assist, { system: 'SYS', turns: CONVO, tools: TOOLS })
      expect(init.body as string).not.toContain('Dining · 42')
    }
  })

  it('an empty assistant turn is dropped — both APIs reject a message with no content', () => {
    const turns: Turn[] = [{ role: 'user', text: 'hi' }, { role: 'assistant' }]
    expect(bodyOf(buildChatRequest(anthropic, { system: 'S', turns, tools: [] }).init).messages).toHaveLength(1)
    expect(bodyOf(buildChatRequest(openai, { system: 'S', turns, tools: [] }).init).messages).toHaveLength(2) // + system
  })

  it('no tools offered ⇒ no tools key, rather than an empty array some endpoints reject', () => {
    expect(bodyOf(buildChatRequest(anthropic, { system: 'S', turns: [], tools: [] }).init).tools).toBeUndefined()
    expect(bodyOf(buildChatRequest(openai, { system: 'S', turns: [], tools: [] }).init).tools).toBeUndefined()
  })
})

describe('reply parsing per wire (§3)', () => {
  it('anthropic: text and tool_use blocks', () => {
    const r = parseReply({
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', id: 'x', name: 'aggregate', input: { groupBy: 'month' } },
      ],
    })
    expect(r.text).toBe('here you go')
    expect(r.calls).toEqual([{ id: 'x', name: 'aggregate', args: { groupBy: 'month' } }])
  })

  it('openai: message content and tool_calls, arguments parsed out of the string', () => {
    const r = parseReply({
      choices: [{ message: { content: 'ok', tool_calls: [{ id: 'x', type: 'function', function: { name: 'aggregate', arguments: '{"groupBy":"month"}' } }] } }],
    })
    expect(r.text).toBe('ok')
    expect(r.calls[0]!.args).toEqual({ groupBy: 'month' })
  })

  it('malformed arguments degrade to an empty object rather than killing the run', () => {
    const r = parseReply({ choices: [{ message: { content: '', tool_calls: [{ id: 'x', function: { name: 'a', arguments: 'not json' } }] } }] })
    expect(r.calls[0]!.args).toEqual({})
  })

  it('an empty turn throws — that is a reasoning model that spent its budget, not an answer', () => {
    expect(() => parseReply({ content: [] })).toThrow()
    expect(() => parseReply({ choices: [{ message: { content: '' } }] })).toThrow()
    expect(() => parseReply({ nonsense: true })).toThrow()
  })

  it('a tool call with no text is a valid turn — the model went straight to work', () => {
    const r = parseReply({ content: [{ type: 'tool_use', id: 'x', name: 'get_overview', input: {} }] })
    expect(r.text).toBeUndefined()
    expect(r.calls).toHaveLength(1)
  })
})
