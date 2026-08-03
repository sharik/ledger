// The agent loop (ASSISTANT §3, §10).
//
// One round is: send the transcript → get an assistant turn → if it asked for tools, run them
// locally and append the results → send again. It ends when the model answers without calling a
// tool, when the round cap is hit, or when the user presses Stop.
//
// Like `assistCategorize`, this never throws. A provider that 500s, times out, or answers with
// nothing produces an `error` string the panel shows as a line of text — the conversation stays
// intact and the next question still works. A chat that could crash the app would be worse than no
// chat at all.
import type { Settings } from '../model/types'
import { batchSignal } from '../import/assist'
import { endpointsFor, needsKey, presetFor } from '../import/providers'
import { chatAccess, chatAssist } from './config'
import { systemPromptFor } from './prompt'
import { execTool, toolsFor, type ToolCtx } from './tools'
import { parseReply, postChat, providerMessage, type ToolResult, type Turn } from './wire'

type Assist = NonNullable<Settings['assist']>

/**
 * Tool rounds per user message. Six was too tight in practice: ranking six trips one aggregate at a
 * time consumed the entire budget on a single question, and a seventh trip would have been cut off
 * mid-answer. The real fix was making that a one-call question (`list_trackings` carries totals),
 * but the cap needed headroom for genuinely multi-step work — discover, aggregate, compare, show —
 * with slack for a wrong id. Still low enough that a model stuck in a loop stops costing money fast.
 */
export const MAX_ROUNDS = 10

/** A local runtime is slow to first token but free; a hosted one should not hold the user this long. */
export const chatTimeout = (provider: string): number => (presetFor(provider)?.local ? 300_000 : 120_000)

export interface RunResult {
  /** The transcript, extended with everything this run produced. */
  turns: Turn[]
  /** Set when the run ended badly. Display only — never sent back to the provider. */
  error?: string
  /** The user pressed Stop. */
  stopped?: boolean
  rounds: number
}

export interface RunOpts {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  maxRounds?: number
  /** Called as each turn lands, so the panel fills in while the run is still going. */
  onTurn?: (turn: Turn) => void
}

/**
 * Run one user message to completion. `turns` must already include the user turn; the returned
 * array is the new transcript and should replace the old one wholesale.
 */
export async function runChat(
  settings: Settings,
  turns: Turn[],
  ctx: ToolCtx,
  opts: RunOpts = {},
): Promise<RunResult> {
  // The assistant's own provider/model when it has one, else categorization's (§2.1). Everything
  // downstream — endpoints, auth, wire, timeout, the probe — reads this resolved value.
  const assist = settings.assist && chatAssist(settings.assist)
  const bad = unusable(assist)
  if (bad) return { turns, error: bad, rounds: 0 }
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return { turns, error: 'No network available.', rounds: 0 }

  // Access comes from the stored settings, never from `opts` and never from the `ctx` the caller
  // built: a panel that forgot to narrow its ctx must not be able to widen what the model can read.
  const access = chatAccess(settings.assist)
  const system = systemPromptFor(access)
  const tools = toolsFor(access)

  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  const timeoutMs = opts.timeoutMs ?? chatTimeout(assist!.provider)
  let out = [...turns]
  const push = (t: Turn) => {
    out = [...out, t]
    opts.onTurn?.(t)
  }

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) return { turns: out, stopped: true, rounds: round }

    let reply
    try {
      const { res, errorBody } = await postChat(
        assist!,
        { system, turns: out, tools },
        f,
        batchSignal({ signal: opts.signal, timeoutMs }),
      )
      if (!res.ok) return { turns: out, error: httpMessage(res.status, providerMessage(errorBody ?? '')), rounds: round }
      reply = parseReply(await res.json())
    } catch {
      if (opts.signal?.aborted) return { turns: out, stopped: true, rounds: round }
      return { turns: out, error: 'The provider did not answer. Check the connection and try again.', rounds: round }
    }

    push({ role: 'assistant', text: reply.text, calls: reply.calls.length ? reply.calls : undefined })
    if (reply.calls.length === 0) return { turns: out, rounds: round + 1 }

    const results: ToolResult[] = reply.calls.map((call) => {
      const r = execTool({ ...ctx, access }, call.name, call.args)
      return { id: call.id, name: call.name, content: r.content, error: r.error, receipt: r.receipt }
    })
    push({ role: 'tool', results })
  }

  // The model kept calling tools without ever answering. Stop paying for it and say so.
  return {
    turns: out,
    error: `Stopped after ${maxRounds} rounds of tool calls without an answer.`,
    rounds: maxRounds,
  }
}

/**
 * Why this configuration cannot run, as a sentence — or undefined when it can. Takes the RESOLVED
 * config, so when the assistant has a provider of its own the gap is in that provider's settings and
 * the sentence says so; otherwise it is the shared categorization config, as before.
 */
function unusable(assist: Assist | undefined): string | undefined {
  if (!assist || !assist.chat) return 'The assistant is switched off. Turn it on in Settings.'
  const whose = assist.chatProvider ? 'the assistant’s' : 'this'
  if (!assist.model) return `No model configured for ${assist.chatProvider ? 'the assistant' : 'this provider'}. Set one in Settings.`
  if (needsKey(assist) && !assist.apiKey) return `No API key for ${whose} provider. Add one in Settings.`
  if (!endpointsFor(assist).chatUrl) return `${assist.chatProvider ? 'The assistant’s' : 'This'} provider has no base URL yet. Set one in Settings.`
  return undefined
}

function httpMessage(status: number, detail?: string): string {
  if (status === 401 || status === 403) return `The provider rejected the request (${status}). Check the API key in Settings.`
  if (status === 429) return 'Rate limited by the provider. Wait a moment and try again.'
  if (status >= 500) return `The provider had an error (${status}). Try again.`
  // A 4xx that is not auth or rate limiting is almost always a request the provider can explain
  // better than we can guess — a rejected parameter, an unknown model. Pass its sentence through.
  return detail
    ? `The provider refused the request (${status}): ${detail}`
    : `The provider refused the request (${status}).`
}
