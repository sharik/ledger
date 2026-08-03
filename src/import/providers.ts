// Assist provider registry (IMPORT §10.6). Resolves `settings.assist` into the two URLs and the wire
// shape the request builder needs. Full URLs, never `baseUrl + '/v1/...'`: the compatible endpoints
// do not agree on the prefix (Groq serves `/openai/v1`, Gemini `/v1beta/openai`), so assembling paths
// silently breaks half the providers. Presets cover what a browser can actually reach — every URL
// below was CORS-probed from a page origin; anything else arrives via the catalog or 'custom'.
import type { Settings } from '../model/types'

export type Wire = 'anthropic' | 'openai'

export interface ProviderDef {
  id: string
  label: string
  wire: Wire
  chatUrl: string
  /** OpenAI-shaped `{data:[{id}]}` model list; absent when the provider has none reachable. */
  modelsUrl?: string
  needsKey: boolean
  /** True for localhost providers — no key, nothing leaves the machine, and a longer timeout. */
  local?: boolean
  note?: string
}

export const PRESETS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    chatUrl: 'https://api.anthropic.com/v1/messages',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    wire: 'openai',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    needsKey: true,
    note: 'Model ids ending in :free cost nothing.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    wire: 'openai',
    chatUrl: 'http://localhost:11434/v1/chat/completions',
    modelsUrl: 'http://localhost:11434/v1/models',
    needsKey: false,
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    wire: 'openai',
    chatUrl: 'http://127.0.0.1:1234/v1/chat/completions',
    modelsUrl: 'http://127.0.0.1:1234/v1/models',
    needsKey: false,
    local: true,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    chatUrl: '',
    needsKey: true,
  },
]

export const LOCAL_PRESETS = PRESETS.filter((p) => p.local)

const byId = new Map(PRESETS.map((p) => [p.id, p]))

/** Wire shape for a stored config: explicit if present, else the pre-catalog default. */
export function wireOf(assist: NonNullable<Settings['assist']>): Wire {
  return assist.wire ?? (assist.provider === 'anthropic' ? 'anthropic' : 'openai')
}

/**
 * Add the API version to a base URL that lacks one. Two conventions collide here: configs written
 * before the catalog stored the origin only (`https://openrouter.ai/api`), while models.dev publishes
 * the versioned root (`https://openrouter.ai/api/v1`, `.../v1beta/openai`). Accepting both keeps old
 * vaults working — a base with any `/v{n}` path segment is taken as already versioned.
 */
function versioned(base: string): string {
  const clean = base.replace(/\/+$/, '')
  return /\/v\d/.test(new URL(clean).pathname) ? clean : `${clean}/v1`
}

/**
 * The endpoints a stored config resolves to. `baseUrl` wins when set (custom provider, a catalog
 * entry, or a preset the user re-pointed at a mirror); otherwise the preset's own URLs.
 */
export function endpointsFor(assist: NonNullable<Settings['assist']>): { chatUrl: string; modelsUrl?: string } {
  if (assist.baseUrl) {
    let root: string
    try {
      root = versioned(assist.baseUrl)
    } catch {
      return { chatUrl: '' } // unparseable URL — caller degrades to fallback
    }
    const path = wireOf(assist) === 'anthropic' ? 'messages' : 'chat/completions'
    return { chatUrl: `${root}/${path}`, modelsUrl: `${root}/models` }
  }
  const preset = byId.get(assist.provider)
  return { chatUrl: preset?.chatUrl ?? '', modelsUrl: preset?.modelsUrl }
}

/** Auth headers for a provider call. Anthropic needs its own scheme plus the browser opt-in. */
export function authHeaders(assist: NonNullable<Settings['assist']>): Record<string, string> {
  if (!assist.apiKey) return {}
  return wireOf(assist) === 'anthropic'
    ? {
        'x-api-key': assist.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      }
    : { authorization: `Bearer ${assist.apiKey}` }
}

export function presetFor(id: string): ProviderDef | undefined {
  return byId.get(id)
}

/**
 * Which token-limit field an OpenAI-wire request should carry. OpenAI's own API deprecated
 * `max_tokens` and its current models (o-series, GPT-5, …) *reject* it —
 * `400 unsupported_parameter: use 'max_completion_tokens' instead`. Every other OpenAI-compatible
 * endpoint (OpenRouter, Ollama, LM Studio, Groq, custom proxies) still expects `max_tokens`, so the
 * choice is keyed on the resolved endpoint host, not the provider label (a re-pointed base URL wins).
 */
export function maxTokensField(chatUrl: string): 'max_tokens' | 'max_completion_tokens' {
  try {
    return new URL(chatUrl).host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens'
  } catch {
    return 'max_tokens'
  }
}

/** Local runtimes take no key; everything else (including unknown catalog ids) does. */
export function needsKey(assist: NonNullable<Settings['assist']>): boolean {
  return byId.get(assist.provider)?.needsKey ?? true
}
