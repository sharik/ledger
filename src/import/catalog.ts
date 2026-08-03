// Model catalog for the Settings → Smart categorization picker (IMPORT §10.6). One static JSON file
// from models.dev lists ~170 providers and their models with cost, context window and capability
// flags. It is refetchable ⇒ derived ⇒ cached in L1 KV, never in the vault (SYNC §4.3, same rule the
// FX tables follow). Fetched lazily when the card needs it, and every failure path degrades to typing
// the model id by hand — the picker is a convenience, never a dependency.
import { KV } from '../persist/idb'
import type { ProviderDef, Wire } from './providers'

export const CATALOG_URL = 'https://models.dev/api.json'
const KEY = 'assist.catalog'
const TTL_MS = 24 * 60 * 60 * 1000

export interface CatalogModel {
  id: string
  name: string
  free: boolean
  /** Reasoning models spend their token budget before answering — sorted last, labelled in the UI. */
  reasoning: boolean
  /** models.dev's `structured_output`. Community-maintained and patchy, so it labels, never filters. */
  structured: boolean
  /** models.dev's `tool_call`. The assistant requires it (ASSISTANT §4), but this flag only WARNS:
   *  it is as patchy as `structured`, and knows nothing about a hand-typed id or a local runtime.
   *  The live probe is what actually decides. */
  tools: boolean
  context?: number
  costIn?: number
  costOut?: number
}

export interface CatalogProvider {
  id: string
  label: string
  wire: Wire
  /** Versioned API root; absent for providers models.dev has no endpoint for (Anthropic, OpenAI…). */
  api?: string
  models: CatalogModel[]
}

export type Catalog = Map<string, CatalogProvider>

/** Shape of the slice of models.dev/api.json we read. Everything is treated as optional. */
interface RawModel {
  id?: unknown
  name?: unknown
  reasoning?: unknown
  structured_output?: unknown
  tool_call?: unknown
  limit?: { context?: unknown }
  cost?: { input?: unknown; output?: unknown }
}
interface RawProvider {
  id?: unknown
  name?: unknown
  api?: unknown
  npm?: unknown
  models?: Record<string, RawModel>
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Parse the raw file. Unknown/garbage entries are skipped rather than failing the whole catalog. */
export function parseCatalog(raw: unknown): Catalog {
  const out: Catalog = new Map()
  if (!raw || typeof raw !== 'object') return out
  for (const [pid, rp] of Object.entries(raw as Record<string, RawProvider>)) {
    if (!rp || typeof rp !== 'object' || !rp.models || typeof rp.models !== 'object') continue
    const models: CatalogModel[] = []
    for (const rm of Object.values(rp.models)) {
      if (!rm || typeof rm !== 'object' || typeof rm.id !== 'string') continue
      const costIn = num(rm.cost?.input)
      const costOut = num(rm.cost?.output)
      models.push({
        id: rm.id,
        name: typeof rm.name === 'string' ? rm.name : rm.id,
        free: costIn === 0 && costOut === 0,
        reasoning: rm.reasoning === true,
        structured: rm.structured_output === true,
        tools: rm.tool_call === true,
        context: num(rm.limit?.context),
        costIn,
        costOut,
      })
    }
    if (models.length === 0) continue
    out.set(pid, {
      id: pid,
      label: typeof rp.name === 'string' ? rp.name : pid,
      // Only the Anthropic-SDK providers speak the Messages API; the other 160+ are OpenAI-shaped.
      wire: rp.npm === '@ai-sdk/anthropic' ? 'anthropic' : 'openai',
      api: typeof rp.api === 'string' ? rp.api : undefined,
      models: sortModels(models),
    })
  }
  return out
}

/**
 * Free first, then schema-capable, then non-reasoning, then cheapest — so the head of the list is
 * also the right default for this job: categorizing short descriptors wants the cheapest model that
 * can honour a schema, not the most capable one.
 */
export function sortModels(models: CatalogModel[]): CatalogModel[] {
  const rank = (m: CatalogModel) => (m.free ? 0 : 1) * 4 + (m.structured ? 0 : 1) * 2 + (m.reasoning ? 1 : 0)
  const price = (m: CatalogModel) => (m.costIn ?? Infinity) + (m.costOut ?? Infinity)
  return [...models].sort((a, b) => rank(a) - rank(b) || price(a) - price(b) || a.id.localeCompare(b.id))
}

/** One-line annotation for a datalist option. */
export function modelLabel(m: CatalogModel): string {
  const bits: string[] = []
  if (m.free) bits.push('free')
  else if (m.costIn !== undefined && m.costOut !== undefined) bits.push(`$${m.costIn}/$${m.costOut} per 1M`)
  if (m.context) bits.push(`${Math.round(m.context / 1000)}k ctx`)
  if (m.structured) bits.push('strict JSON')
  if (m.tools) bits.push('tools')
  if (m.reasoning) bits.push('reasoning')
  return bits.join(' · ')
}

interface Cached {
  fetchedAt: number
  raw: unknown
}

/**
 * The catalog, from the 24h L1 cache when fresh. `force` refetches (the card's Refresh action).
 * Returns an empty map on any failure — offline, 404, or a file that no longer parses.
 */
export async function loadCatalog(opts: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<Catalog> {
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  const now = opts.now ?? Date.now()
  let kv: KV | undefined
  try {
    kv = await KV.open()
  } catch {
    kv = undefined // private mode / no IDB: fetch every time rather than fail
  }
  try {
    if (!opts.force && kv) {
      const hit = await kv.get<Cached>(KEY)
      if (hit && now - hit.fetchedAt < TTL_MS) return parseCatalog(hit.raw)
    }
    if (!f) return new Map()
    const res = await f(CATALOG_URL)
    if (!res.ok) return new Map()
    const raw = await res.json()
    const catalog = parseCatalog(raw)
    if (kv && catalog.size > 0) await kv.put(KEY, { fetchedAt: now, raw } satisfies Cached)
    return catalog
  } catch {
    return new Map()
  } finally {
    kv?.close()
  }
}

/** Merge a catalog provider into the registry shape the request builder consumes. */
export function toProviderDef(p: CatalogProvider): ProviderDef | undefined {
  if (!p.api) return undefined
  const root = p.api.replace(/\/+$/, '')
  return {
    id: p.id,
    label: p.label,
    wire: p.wire,
    chatUrl: `${root}/${p.wire === 'anthropic' ? 'messages' : 'chat/completions'}`,
    modelsUrl: `${root}/models`,
    needsKey: true,
  }
}

/**
 * Probe the local runtimes for a live model list. Ollama and LM Studio both expose an OpenAI-shaped
 * `/v1/models` and both allow browser calls from a localhost origin out of the box — Ollama answers
 * 403 for any other origin unless started with OLLAMA_ORIGINS, which is what the card reports on a
 * miss. Probes run in parallel; the first runtime that answers wins.
 */
export async function detectLocal(
  candidates: ProviderDef[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ provider: ProviderDef; models: string[] } | undefined> {
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!f) return undefined
  const probes = candidates.map(async (provider) => {
    if (!provider.modelsUrl) throw new Error('no models url')
    const res = await f(provider.modelsUrl, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) })
    if (!res.ok) throw new Error(String(res.status))
    const models = listModelIds(await res.json())
    if (models.length === 0) throw new Error('no models')
    return { provider, models }
  })
  return Promise.any(probes).catch(() => undefined)
}

/** Model ids from an OpenAI- or Anthropic-shaped list response — both return `{data:[{id}]}`. */
export function listModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string')
}
