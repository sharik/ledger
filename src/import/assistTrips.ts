// Optional AI refinement of a detected trip's NAME (IMPORT §10.6 sibling). The local detector
// (analytics/tripDetect) already finds the window and a currency-derived name ("Iceland"); when
// assist is configured, the model turns the merchant list into something sharper ("Reykjavík").
// Reuses the categorization engine's request builder + schema enforcement. Never throws — any
// failure returns null and the caller keeps the local name. Sends merchants + currency + window;
// unlike categorization this includes dates, so the caller states that in the offer.
import type { Settings } from '../model/types'
import { buildRequest, extractText } from './assist'
import { endpointsFor, needsKey } from './providers'

/**
 * How many merchant strings one refine request carries. Exported so the offer that states the
 * payload counts the same rows this function actually sends.
 */
export const TRIP_MERCHANT_CAP = 40

/** Schema: a single short trip name. Object root (strict mode forbids a bare value). */
const NAME_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } },
}

export interface TripRefineInput {
  currency: string
  dateFrom: string
  dateTo: string
  merchants: string[]
}

function parseName(text: string): string | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1]!.trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const obj = JSON.parse(t.slice(s, e + 1)) as Record<string, unknown>
    const name = obj.name
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : null
  } catch {
    return null
  }
}

/**
 * Ask the model for a better name for one detected trip. Returns null (caller keeps the local name)
 * when assist isn't configured, the request fails, times out, or the reply is unusable.
 */
export async function assistRefineTripName(
  input: TripRefineInput,
  settings: Settings,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const assist = settings.assist
  if (!assist || !assist.model) return null
  if (needsKey(assist) && !assist.apiKey) return null
  if (!endpointsFor(assist).chatUrl) return null
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return null

  const system =
    'You name travel trips from a list of card-payment merchants. Reply ONLY with a JSON object ' +
    '{"name": string} — no prose, no code fences. Give a short, specific name: the city or region ' +
    'if the merchants identify one, otherwise the country. No dates in the name.'
  const user =
    `Currency spent: ${input.currency}\nDates: ${input.dateFrom} to ${input.dateTo}\nMerchants:\n` +
    input.merchants.slice(0, TRIP_MERCHANT_CAP).map((m) => `- ${m}`).join('\n')

  const signal = opts.timeoutMs
    ? opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
      : AbortSignal.timeout(opts.timeoutMs)
    : opts.signal

  try {
    for (const attempt of [NAME_SCHEMA, undefined]) {
      const { url, init } = buildRequest(assist, { system, user }, 1, attempt)
      const res = await f(url, { ...init, signal })
      if (res.ok) return parseName(extractText(await res.json()))
      if (attempt === undefined || res.status < 400 || res.status >= 500) break
    }
  } catch {
    return null
  }
  return null
}
