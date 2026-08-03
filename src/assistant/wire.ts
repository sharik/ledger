// Tool-calling wire adapters (ASSISTANT §3). The import path speaks one-shot strict JSON; the
// assistant is multi-turn and has to call tools, so it needs the other half of both provider APIs.
//
// The transcript is kept in ONE wire-agnostic shape (`Turn`) and converted at request time. Storing
// provider JSON instead would mean a conversation could not survive the user switching provider
// mid-session, and would leak Anthropic's block model into the UI layer.
//
// Nothing here reads the vault. Everything the model learns about the user arrives through a tool
// result — see ASSISTANT §1 for why no context is injected.
import type { Settings } from '../model/types'
import { authHeaders, endpointsFor, maxTokensField, wireOf } from '../import/providers'

type Assist = NonNullable<Settings['assist']>

/** A model's request to run one tool. `args` is already parsed — OpenAI ships it as a JSON string. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** What the executor sent back. `content` is JSON text; `error` marks a refusal, not a crash. */
export interface ToolResult {
  id: string
  name: string
  content: string
  error?: boolean
  /** One line for the transcript. Display only — never serialized into a request. */
  receipt?: string
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text?: string; calls?: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] }

/** A tool as offered to the model. `parameters` is JSON Schema, identical for both wires. */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Output budget per assistant turn. Generous for the same reason `maxTokensFor` is on the import
 * path: a reasoning model spends its budget before the first answer character, and a truncated reply
 * loses the tool call entirely. The parameter is a ceiling, not a charge.
 */
export const CHAT_MAX_TOKENS = 4096

export interface ChatRequest {
  system: string
  turns: Turn[]
  tools: ToolDef[]
  maxTokens?: number
  /** OpenAI wire only, and only ever set by `postChat`'s retry — see `postChat`. */
  reasoningEffort?: 'none'
}

export function buildChatRequest(assist: Assist, req: ChatRequest): { url: string; init: RequestInit } {
  const { chatUrl } = endpointsFor(assist)
  const headers = { 'content-type': 'application/json', ...authHeaders(assist) }
  const max = req.maxTokens ?? CHAT_MAX_TOKENS
  const body =
    wireOf(assist) === 'anthropic'
      ? {
          model: assist.model,
          max_tokens: max,
          system: req.system,
          messages: anthropicMessages(req.turns),
          ...(req.tools.length > 0
            ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
            : {}),
        }
      : {
          model: assist.model,
          // OpenAI's own API rejects `max_tokens` on current models; compatible endpoints still want it.
          [maxTokensField(chatUrl)]: max,
          messages: [{ role: 'system', content: req.system }, ...openaiMessages(req.turns)],
          ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
          ...(req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        }
  return { url: chatUrl, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** `{"error":{"message":"…"}}` — the shape both wires use. Undefined when the body is not that. */
export function providerMessage(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } }
    const m = j.error?.message
    return typeof m === 'string' && m.trim() ? m.trim() : undefined
  } catch {
    return undefined
  }
}

export interface ChatPost {
  res: Response
  /** The provider's error text, read once when the response was not ok. Never read on success. */
  errorBody?: string
}

/**
 * POST a chat request, retrying once when the endpoint refuses tools *only* because of its
 * reasoning-effort default.
 *
 * OpenAI's gpt-5.x reasoning models reject function tools on `/v1/chat/completions` at any
 * `reasoning_effort` other than `none` — a 400 naming the parameter, while the same model answers
 * plain chat fine. Sending `none` unconditionally is not an option: non-reasoning models and most
 * OpenAI-compatible endpoints (OpenRouter, Ollama, LM Studio, custom proxies) reject the unknown
 * field, so a blanket parameter would break every configuration that works today. Keying the retry
 * on the provider's own complaint costs one wasted request on exactly the models that need it and
 * nothing anywhere else — the shape `assistCategorize` already uses for its schema-less retry.
 *
 * The error body is returned rather than discarded so callers can report what the provider actually
 * said. Guessing at a 400 is how this cost an afternoon: the endpoint named the parameter and the
 * fix, and the UI said "this model does not support tools", which was false.
 */
export async function postChat(
  assist: Assist,
  req: ChatRequest,
  f: typeof fetch,
  signal?: AbortSignal,
): Promise<ChatPost> {
  const send = (r: ChatRequest) => {
    const { url, init } = buildChatRequest(assist, r)
    return f(url, { ...init, signal })
  }

  const res = await send(req)
  if (res.ok) return { res }

  const body = await bodyText(res)
  const retryable = res.status === 400 && req.tools.length > 0 && wireOf(assist) === 'openai' && /reasoning_effort/i.test(body)
  if (!retryable) return { res, errorBody: body }

  const second = await send({ ...req, reasoningEffort: 'none' })
  return second.ok ? { res: second } : { res: second, errorBody: await bodyText(second) }
}

/**
 * Anthropic Messages: tool calls are `tool_use` blocks on the assistant turn, and their results come
 * back as `tool_result` blocks on a *user* turn — the API has no `tool` role. An assistant turn with
 * no content at all is rejected, so an empty one is dropped rather than sent.
 */
function anthropicMessages(turns: Turn[]): unknown[] {
  const out: unknown[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.text })
      continue
    }
    if (turn.role === 'assistant') {
      const content: unknown[] = []
      if (turn.text) content.push({ type: 'text', text: turn.text })
      for (const c of turn.calls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      if (content.length > 0) out.push({ role: 'assistant', content })
      continue
    }
    out.push({
      role: 'user',
      content: turn.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        ...(r.error ? { is_error: true } : {}),
      })),
    })
  }
  return out
}

/**
 * OpenAI chat completions: tool calls hang off the assistant message and each result is its own
 * message with the `tool` role. Arguments travel as a JSON *string*, not an object.
 */
function openaiMessages(turns: Turn[]): unknown[] {
  const out: unknown[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.text })
      continue
    }
    if (turn.role === 'assistant') {
      const calls = turn.calls ?? []
      if (!turn.text && calls.length === 0) continue
      out.push({
        role: 'assistant',
        content: turn.text ?? '',
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      })
      continue
    }
    for (const r of turn.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content })
  }
  return out
}

export interface Reply {
  text?: string
  calls: ToolCall[]
}

/**
 * The assistant turn from either wire's response body. A reply carrying neither text nor a tool call
 * is a failure — that is what a reasoning model looks like when it burned its budget thinking — so
 * it throws rather than returning an empty turn the loop would treat as "done".
 */
export function parseReply(json: unknown): Reply {
  const j = (json ?? {}) as Record<string, unknown>

  // Anthropic: a flat array of content blocks.
  if (Array.isArray(j.content)) {
    const texts: string[] = []
    const calls: ToolCall[] = []
    for (const raw of j.content) {
      const b = raw as Record<string, unknown>
      if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') texts.push(b.text)
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        calls.push({ id: b.id, name: b.name, args: asArgs(b.input) })
      }
    }
    return done(texts.join('\n'), calls)
  }

  // OpenAI: one message with optional tool_calls.
  if (Array.isArray(j.choices)) {
    const msg = (j.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
    const text = typeof msg?.content === 'string' ? msg.content : ''
    const calls: ToolCall[] = []
    if (Array.isArray(msg?.tool_calls)) {
      for (const raw of msg.tool_calls) {
        const c = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
        if (typeof c?.id !== 'string' || typeof c.function?.name !== 'string') continue
        calls.push({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })
      }
    }
    return done(text, calls)
  }

  throw new Error('no assistant turn in provider response')
}

function done(text: string, calls: ToolCall[]): Reply {
  if (!text && calls.length === 0) throw new Error('provider returned an empty turn')
  return { ...(text ? { text } : {}), calls }
}

/** OpenAI hands arguments over as a JSON string; a model can still emit junk, which is not fatal. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    return asArgs(JSON.parse(raw))
  } catch {
    return {}
  }
}

function asArgs(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
