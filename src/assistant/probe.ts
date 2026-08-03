// The tool-calling capability probe (ASSISTANT §4).
//
// The assistant cannot work without tool calling: it knows nothing about the vault until a tool
// answers, and it drives the UI by calling tools. A model that cannot call one has no degraded mode
// worth shipping — it would answer confidently from nothing — so Settings blocks it outright.
//
// models.dev publishes a `tool_call` flag per model, but that catalog is community-maintained and
// patchy (the same reason `structured_output` labels rather than filters), and it knows nothing at
// all about a hand-typed model id or whatever a local runtime happens to be serving. So the flag
// warns and this probe decides: one small real request, against the configured endpoint, with one
// trivial tool. If a tool call comes back, the pair works.
import type { Settings } from '../model/types'
import { batchSignal } from '../import/assist'
import { endpointsFor, needsKey, presetFor } from '../import/providers'
import { chatAssist } from './config'
import { parseReply, postChat, providerMessage } from './wire'

type Assist = NonNullable<Settings['assist']>

export type ProbeResult =
  /** A tool call came back — the pair is usable. */
  | { kind: 'ok' }
  /** The model answered, but with prose instead of the tool call it was asked for. */
  | { kind: 'noTools' }
  /** The endpoint refused the request. `detail` is the provider's own sentence, when it gave one. */
  | { kind: 'rejected'; status: number; detail?: string }
  /** Never answered: offline, CORS, bad key, timeout. */
  | { kind: 'unreachable' }
  /** Nothing to probe — no model, or a key/base URL still missing. */
  | { kind: 'unconfigured' }

/** A local runtime is slow to first token but on this machine; a hosted one should be quick. */
export const probeTimeout = (provider: string): number => (presetFor(provider)?.local ? 60_000 : 30_000)

const PROBE_TOOL = {
  name: 'report_ready',
  description: 'Report that you can call tools. Call this immediately.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ready'],
    properties: { ready: { type: 'boolean', description: 'Always true.' } },
  },
}

/**
 * One request, one tool, no vault data. Never throws — every failure is a `ProbeResult` the card
 * turns into a sentence, because "we could not check" and "this model cannot do it" are different
 * answers and the user has to be told which one they got.
 */
export async function probeToolCalling(
  raw: Assist | undefined,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  // Resolve here rather than at the call site: the pair that has to pass is the one the ASSISTANT
  // will use (§2.1), and certifying the categorization model instead would unlock the toggle on
  // evidence about a model that never runs a chat.
  const assist = raw && chatAssist(raw)
  if (!assist || !assist.model) return { kind: 'unconfigured' }
  if (needsKey(assist) && !assist.apiKey) return { kind: 'unconfigured' }
  if (!endpointsFor(assist).chatUrl) return { kind: 'unconfigured' }
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return { kind: 'unreachable' }

  try {
    // `postChat`, not a bare fetch: the probe has to certify the pair the assistant will actually
    // run on, and the assistant retries an effort-refused tool call. Probing without that retry
    // would lock the toggle on a pair that works.
    const { res, errorBody } = await postChat(
      assist,
      {
        system: 'You are checking a connection. Use the tool you are given; do not answer in prose.',
        turns: [{ role: 'user', text: 'Call the report_ready tool with ready set to true.' }],
        tools: [PROBE_TOOL],
        maxTokens: 1024,
      },
      f,
      batchSignal({ signal: opts.signal, timeoutMs: opts.timeoutMs ?? probeTimeout(assist.provider) }),
    )
    if (!res.ok) return { kind: 'rejected', status: res.status, detail: providerMessage(errorBody ?? '') }
    const reply = parseReply(await res.json())
    return reply.calls.some((c) => c.name === PROBE_TOOL.name) ? { kind: 'ok' } : { kind: 'noTools' }
  } catch {
    // An empty turn (a reasoning model that spent its budget) parses as a throw and lands here too.
    return { kind: 'unreachable' }
  }
}

/** The stored marker that a pair passed. Changing provider or model invalidates it by construction. */
export const verifiedKey = (provider: string, model: string): string => `${provider}::${model}`

/**
 * The key for the pair the assistant actually runs on. With no override this is the categorization
 * pair, exactly as before — so changing the categorization model still re-locks the toggle. With one,
 * only the assistant's own provider and model move it.
 */
export function chatVerifiedKey(assist: Assist): string {
  const c = chatAssist(assist)
  return verifiedKey(c.provider, c.model)
}

export function toolsVerified(assist: Assist | undefined): boolean {
  if (!assist) return false
  const c = chatAssist(assist)
  return !!c.model && assist.toolsVerified === verifiedKey(c.provider, c.model)
}

/** The sentence shown under the toggle. Reads as an explanation, never a stack trace. */
export function probeMessage(r: ProbeResult, modelId: string): string {
  switch (r.kind) {
    case 'ok':
      return `${modelId} can call tools — the assistant is available.`
    case 'noTools':
      return `${modelId} answered, but ignored the tool it was given. The assistant needs tool calling, so it stays off. Pick a model that supports it.`
    case 'rejected':
      if (r.status === 401 || r.status === 403) return `The provider rejected the request (${r.status}). Check the API key.`
      // The provider's own sentence when it gave one. It names the real problem far more often than
      // the old guess did — which asserted the model had no tool calling, sending people to change
      // model when the endpoint had already said which parameter was wrong and what to set it to.
      return r.detail
        ? `The provider refused a tool-calling request (${r.status}): ${r.detail}`
        : `The provider refused a tool-calling request (${r.status}). ${modelId} may not support tools.`
    case 'unreachable':
      return 'No answer from the provider. Check the connection, the base URL, and that it allows direct browser calls (CORS).'
    case 'unconfigured':
      return 'Set a model — and a key, if this provider needs one — first.'
  }
}
