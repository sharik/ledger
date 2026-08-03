// Smart categorization (IMPORT §10.6). Batched LLM calls per import over the unique (merchant,
// redacted descriptor, sign) tuples the rule ladder left as fallback. Amounts are NEVER sent; digit
// runs ≥6 are redacted. The reply is schema-enforced — the category id is an enum of the user's own
// ids, so an id that does not exist cannot be produced. Predictions ≥0.7 auto-categorize with `ai`
// provenance, the rest stay needs-review. Any failure (network, timeout, malformed JSON, a provider
// that rejects the schema) degrades silently to fallback — assist can only ever help, never block or
// corrupt. Runs on the main thread (needs fetch + the api key from the vault), after the worker's plan.
import type { Category, Settings } from '../model/types'
import { authHeaders, endpointsFor, maxTokensField, needsKey, wireOf } from './providers'
import type { NormalizedRow } from './types'

export const ASSIST_THRESHOLD = 0.7
/** Descriptors per request. Keeps the reply inside the output budget of small free/local models. */
export const ASSIST_BATCH = 80
const UNKNOWN = 'unknown'

export interface AssistInput {
  merchant: string
  descriptor: string // redacted normDesc
  sign: 'debit' | 'credit'
}

export interface AssistPrediction {
  descriptor: string
  categoryId: string | null
  confidence: number
}

/** Redact digit runs of length ≥6 (cards, IBAN tails, refs). Length-preserving. */
export function redactDescriptor(s: string): string {
  return s.replace(/\d{6,}/g, (m) => '#'.repeat(m.length))
}

/** Unique (merchant, redacted descriptor, sign) tuples — one row per distinct shape.
 *  Transfer rows are excluded outright: their "merchant" IS the counterparty, so a
 *  `VIREMENT EMIS VERS <name>` row would ship a person's full name to the provider —
 *  and a transfer needs no model to categorize anyway. The merchant is run through
 *  the same digit redaction as the descriptor (cards, IBAN tails, refs). */
export function assistInputs(rows: NormalizedRow[]): AssistInput[] {
  const seen = new Set<string>()
  const out: AssistInput[] = []
  for (const r of rows) {
    if (r.kind === 'transfer-in' || r.kind === 'transfer-out') continue
    const descriptor = redactDescriptor(r.normDesc)
    const merchant = redactDescriptor(r.merchant)
    const sign: AssistInput['sign'] = r.amountMinor < 0 ? 'debit' : 'credit'
    const key = `${merchant}\0${descriptor}\0${sign}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ merchant, descriptor, sign })
  }
  return out
}

/**
 * The response schema. Object root (strict mode forbids a bare array) and `categoryId` as an enum of
 * the vault's own ids plus `unknown` — the grammar, not the prompt, is what stops invented ids.
 * `confidence` carries no minimum/maximum: numeric constraints are unsupported by both providers'
 * schema subsets, so the caller clamps instead.
 */
export function buildSchema(categories: Category[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['predictions'],
    properties: {
      predictions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['descriptor', 'categoryId', 'confidence'],
          properties: {
            descriptor: { type: 'string' },
            categoryId: { enum: [...categories.map((c) => c.id), UNKNOWN] },
            confidence: { type: 'number' },
          },
        },
      },
    },
  }
}

/**
 * Output budget for a batch. A truncated reply is invalid JSON, so this errs high: the parameter is
 * a ceiling, not a charge — a model that answers in 80 tokens costs 80 either way. The generous floor
 * exists for reasoning models, which spend their budget thinking before the first character of the
 * answer: measured against a local qwen3.5:4b, a 352-token budget produced 1472 characters of
 * reasoning, `finish_reason: length`, and empty content.
 */
export function maxTokensFor(count: number): number {
  return Math.min(8192, Math.max(4096, count * 64))
}

interface Prompt {
  system: string
  user: string
}

function buildPrompt(inputs: AssistInput[], categories: Category[]): Prompt {
  const cats = categories.map((c) => `${c.id} = ${c.name}`).join('\n')
  const system =
    'You categorize bank transactions. Reply ONLY with a JSON object, no prose, no code fences. ' +
    'Shape: {"predictions": [{"descriptor": string, "categoryId": string, "confidence": number between 0 and 1}]}. ' +
    `Use categoryId "${UNKNOWN}" when unsure. Never invent category ids outside the provided list. ` +
    'Return one element per transaction.'
  const user =
    `Categories:\n${cats}\n\nTransactions (categorize each by its descriptor):\n` +
    inputs.map((i) => `- descriptor="${i.descriptor}" merchant="${i.merchant}" ${i.sign}`).join('\n')
  return { system, user }
}

/**
 * Strict-JSON parse of a provider reply into predictions. Accepts the schema's `{predictions:[…]}`
 * and a bare `[…]` — the shape the no-schema retry path and unconstrained providers produce.
 * Tolerates a fenced block either way.
 */
export function parsePredictions(text: string): AssistPrediction[] {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1]!.trim()
  const arr = extractArray(t)
  const out: AssistPrediction[] = []
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue
    const descriptor = (el as Record<string, unknown>).descriptor
    const categoryId = (el as Record<string, unknown>).categoryId
    const confidence = (el as Record<string, unknown>).confidence
    if (typeof descriptor !== 'string' || typeof confidence !== 'number') continue
    const id = typeof categoryId === 'string' && categoryId !== UNKNOWN ? categoryId : null
    out.push({ descriptor, categoryId: id, confidence: Math.min(1, Math.max(0, confidence)) })
  }
  return out
}

/** The prediction array, from either envelope. Throws when the text holds neither. */
function extractArray(t: string): unknown[] {
  const objStart = t.indexOf('{')
  const objEnd = t.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const obj = JSON.parse(t.slice(objStart, objEnd + 1)) as Record<string, unknown>
      if (Array.isArray(obj.predictions)) return obj.predictions
    } catch {
      // not an object envelope — fall through to the bare-array form
    }
  }
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('no JSON predictions in response')
  const arr = JSON.parse(t.slice(start, end + 1))
  if (!Array.isArray(arr)) throw new Error('not an array')
  return arr
}

/**
 * Build the provider HTTP request. `schema` present ⇒ ask for schema-enforced output in whichever
 * dialect the wire speaks; absent ⇒ the plain request used by the retry after a provider rejects it.
 */
export function buildRequest(
  assist: NonNullable<Settings['assist']>,
  p: Prompt,
  count: number,
  schema?: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const { chatUrl } = endpointsFor(assist)
  const max = maxTokensFor(count)
  const headers = { 'content-type': 'application/json', ...authHeaders(assist) }

  if (wireOf(assist) === 'anthropic') {
    const body: Record<string, unknown> = {
      model: assist.model,
      max_tokens: max,
      system: p.system,
      messages: [{ role: 'user', content: p.user }],
    }
    if (schema) body.output_config = { format: { type: 'json_schema', schema } }
    return { url: chatUrl, init: { method: 'POST', headers, body: JSON.stringify(body) } }
  }

  const body: Record<string, unknown> = {
    model: assist.model,
    // OpenAI's own API rejects `max_tokens` on current models; compatible endpoints still want it.
    [maxTokensField(chatUrl)]: max,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
  }
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'predictions', strict: true, schema } }
  }
  return { url: chatUrl, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

/** Pull the assistant text out of an Anthropic or OpenAI response body. */
export function extractText(json: unknown): string {
  const j = json as Record<string, unknown>
  const content = j.content
  if (Array.isArray(content)) {
    const first = content.find((c) => (c as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined
    if (first && typeof first.text === 'string') return first.text
  }
  const choices = j.choices
  if (Array.isArray(choices)) {
    const msg = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
    // A reasoning model that ran out of budget answers with empty content and a full `reasoning`
    // field — treat that as a failure so the batch degrades rather than parsing nothing.
    if (msg && typeof msg.content === 'string' && msg.content !== '') return msg.content
  }
  throw new Error('no text in provider response')
}

export interface AssistResultRow {
  categoryId: string
  confidence: number
  auto: boolean // confidence ≥ threshold ⇒ auto-categorize; else needs-review
}

export interface AssistOutcome {
  results: Map<string, AssistResultRow>
  /** Unique descriptors asked about — not rows. Repeats of a merchant cost nothing. */
  descriptors: number
  batches: number
  /** Batches that returned nothing because the request failed or timed out. */
  failed: number
}

/** Descriptors per request on a retry: a batch that timed out is unlikely to answer if repeated. */
export const ASSIST_RETRY_BATCH = 20

/** What an assist run would cost, for the confirmation the user gives before it runs. */
export function assistCost(rows: NormalizedRow[], batchSize = ASSIST_BATCH): { descriptors: number; batches: number } {
  const descriptors = assistInputs(rows).length
  return { descriptors, batches: Math.ceil(descriptors / Math.max(1, batchSize)) }
}

/** One batch: schema-enforced request, then one plain retry if the provider rejected the schema. */
async function runBatch(
  inputs: AssistInput[],
  categories: Category[],
  assist: NonNullable<Settings['assist']>,
  f: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<AssistPrediction[]> {
  const prompt = buildPrompt(inputs, categories)
  const schema = buildSchema(categories)
  for (const attempt of [schema, undefined]) {
    const { url, init } = buildRequest(assist, prompt, inputs.length, attempt)
    const res = await f(url, { ...init, signal })
    if (res.ok) return parsePredictions(extractText(await res.json()))
    // 4xx on the constrained attempt is usually "this model has no structured output" — retry plain.
    // Anything else (auth, rate limit, 5xx) is not worth a second call.
    if (attempt === undefined || res.status < 400 || res.status >= 500) break
  }
  return []
}

/** Caller's cancel signal plus the per-batch deadline, whichever fires first. Shared with the
 *  assistant's request loop, which has the same stop-or-time-out shape (ASSISTANT §10). */
export function batchSignal(opts: { signal?: AbortSignal; timeoutMs?: number }): AbortSignal | undefined {
  if (!opts.timeoutMs) return opts.signal
  const deadline = AbortSignal.timeout(opts.timeoutMs)
  return opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
}

/**
 * Categorize `rows` via the assist provider. `results` is keyed by
 * `${merchant}\0${redactedDescriptor}\0${sign}` (matching `assistInputs`) — NUL-separated, so a
 * merchant or descriptor containing spaces cannot collide with a different tuple.
 * Predictions with unknown categories or confidence 0 are dropped.
 * Never throws — a failed batch is counted in `failed` rather than propagated, so the caller can
 * tell "the provider had no opinion" apart from "the provider never answered".
 */
export async function assistCategorize(
  rows: NormalizedRow[],
  categories: Category[],
  settings: Settings,
  opts: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs?: number
    /** Descriptors per request. Smaller batches answer sooner — the retry path after a timeout. */
    batchSize?: number
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<AssistOutcome> {
  const out = new Map<string, AssistResultRow>()
  const nothing = (descriptors = 0): AssistOutcome => ({ results: out, descriptors, batches: 0, failed: 0 })
  const assist = settings.assist
  if (!assist || !assist.model) return nothing()
  if (needsKey(assist) && !assist.apiKey) return nothing()
  if (!endpointsFor(assist).chatUrl) return nothing() // custom provider with no base URL yet
  const inputs = assistInputs(rows)
  if (inputs.length === 0) return nothing()
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return nothing(inputs.length)

  const validCat = new Set(categories.map((c) => c.id))
  // "Other" is the fallback bucket every unmatched row already sits in (pipeline §10.1). A model
  // answering "Other" is saying it has no idea — the same state as no answer — so it is dropped
  // here rather than applied as a confident suggestion that only adds AI provenance to noise.
  const fallbackCat = categories.find((c) => c.role === 'other')?.id
  // Index inputs by descriptor for mapping predictions back to full keys.
  const byDesc = new Map<string, AssistInput[]>()
  for (const i of inputs) {
    const arr = byDesc.get(i.descriptor) ?? []
    arr.push(i)
    byDesc.set(i.descriptor, arr)
  }

  // Batches run in sequence: free tiers rate-limit per minute, and a partial result is still useful.
  // The timeout is per batch, so a large import is not penalised for being large.
  const size = Math.max(1, opts.batchSize ?? ASSIST_BATCH)
  const total = Math.ceil(inputs.length / size)
  let failed = 0
  for (let at = 0; at < inputs.length; at += size) {
    if (opts.signal?.aborted) break // user stopped the run — keep what completed, fire no more batches
    const batch = inputs.slice(at, at + size)
    let preds: AssistPrediction[]
    try {
      preds = await runBatch(batch, categories, assist, f, batchSignal(opts))
    } catch {
      if (opts.signal?.aborted) break // the abort that just threw is a Stop, not a provider failure
      failed++ // this batch stays fallback; the rest still get their chance
      opts.onProgress?.(Math.floor(at / size) + 1, total)
      continue
    }
    opts.onProgress?.(Math.floor(at / size) + 1, total)
    for (const p of preds) {
      if (!p.categoryId || p.categoryId === fallbackCat || !validCat.has(p.categoryId) || !(p.confidence > 0)) continue
      const matches = byDesc.get(p.descriptor)
      if (!matches) continue
      for (const i of matches) {
        const key = `${i.merchant}\0${i.descriptor}\0${i.sign}`
        out.set(key, { categoryId: p.categoryId, confidence: p.confidence, auto: p.confidence >= ASSIST_THRESHOLD })
      }
    }
  }
  return { results: out, descriptors: inputs.length, batches: total, failed }
}

/** The lookup key for a normalized row, matching `assistCategorize`'s output map. */
export function assistKey(r: NormalizedRow): string {
  const descriptor = redactDescriptor(r.normDesc)
  const sign = r.amountMinor < 0 ? 'debit' : 'credit'
  return `${redactDescriptor(r.merchant)}\0${descriptor}\0${sign}`
}
