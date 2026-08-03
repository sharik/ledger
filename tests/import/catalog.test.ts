import { describe, expect, it } from 'vitest'
import { detectLocal, listModelIds, modelLabel, parseCatalog, sortModels, toProviderDef } from '../../src/import/catalog'
import { LOCAL_PRESETS } from '../../src/import/providers'

const RAW = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'https://openrouter.ai/api/v1',
    npm: '@openrouter/ai-sdk-provider',
    models: {
      a: { id: 'openai/gpt-oss-20b:free', name: 'gpt-oss 20B (free)', structured_output: true, cost: { input: 0, output: 0 }, limit: { context: 131072 } },
      b: { id: 'vendor/paid', name: 'Paid', structured_output: true, cost: { input: 1, output: 3 }, limit: { context: 200000 } },
      c: { id: 'vendor/thinker', name: 'Thinker', reasoning: true, cost: { input: 0, output: 0 } },
      junk: { name: 'no id here' },
    },
  },
  someone: { id: 'someone', name: 'Someone', npm: '@ai-sdk/anthropic', models: { m: { id: 'their-model' } } },
  empty: { id: 'empty', name: 'Empty', models: {} },
}

describe('catalog — parsing', () => {
  it('reads models with cost, capability and context, skipping unusable entries', () => {
    const cat = parseCatalog(RAW)
    const or = cat.get('openrouter')!
    expect(or.api).toBe('https://openrouter.ai/api/v1')
    expect(or.wire).toBe('openai')
    expect(or.models.map((m) => m.id)).not.toContain(undefined)
    expect(or.models.length).toBe(3) // the id-less entry is dropped
    const free = or.models.find((m) => m.id === 'openai/gpt-oss-20b:free')!
    expect(free).toMatchObject({ free: true, structured: true, context: 131072 })
    expect(or.models.find((m) => m.id === 'vendor/paid')!.free).toBe(false)
    expect(cat.has('empty')).toBe(false) // a provider with no usable model is not offered
  })

  it('maps only the Anthropic-SDK providers to the messages wire', () => {
    const cat = parseCatalog(RAW)
    expect(cat.get('someone')!.wire).toBe('anthropic')
    expect(cat.get('openrouter')!.wire).toBe('openai')
  })

  it('degrades to an empty catalog on garbage rather than throwing', () => {
    expect(parseCatalog(null).size).toBe(0)
    expect(parseCatalog('nope').size).toBe(0)
    expect(parseCatalog({ x: { models: 'not an object' } }).size).toBe(0)
  })
})

describe('catalog — presentation', () => {
  it('sorts free and schema-capable models first, paid last', () => {
    const models = parseCatalog(RAW).get('openrouter')!.models
    expect(models[0]!.id).toBe('openai/gpt-oss-20b:free') // free + structured
    expect(models[models.length - 1]!.id).toBe('vendor/paid')
    expect(sortModels(models)[0]!.free).toBe(true)
  })

  it('breaks ties by price, so the head of the list is a sane default', () => {
    const cheap = { id: 'cheap', name: 'c', free: false, reasoning: false, structured: true, tools: true, costIn: 1, costOut: 5 }
    const dear = { id: 'a-dear', name: 'd', free: false, reasoning: false, structured: true, tools: true, costIn: 10, costOut: 50 }
    // `a-dear` wins alphabetically but must not win the list — this drives the default on a
    // provider switch, and categorizing descriptors does not need the flagship model.
    expect(sortModels([dear, cheap])[0]!.id).toBe('cheap')
  })

  it('labels free, price, context and capability', () => {
    const models = parseCatalog(RAW).get('openrouter')!.models
    expect(modelLabel(models.find((m) => m.id === 'openai/gpt-oss-20b:free')!)).toBe('free · 131k ctx · strict JSON')
    expect(modelLabel(models.find((m) => m.id === 'vendor/paid')!)).toBe('$1/$3 per 1M · 200k ctx · strict JSON')
    expect(modelLabel(models.find((m) => m.id === 'vendor/thinker')!)).toBe('free · reasoning')
  })

  it('turns a catalog provider into endpoints, and skips ones with no api', () => {
    const cat = parseCatalog(RAW)
    expect(toProviderDef(cat.get('openrouter')!)).toMatchObject({
      chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
      modelsUrl: 'https://openrouter.ai/api/v1/models',
      needsKey: true,
    })
    expect(toProviderDef(cat.get('someone')!)).toBeUndefined()
  })
})

describe('catalog — model lists and local detection', () => {
  it('reads ids from the shared {data:[{id}]} list shape', () => {
    expect(listModelIds({ data: [{ id: 'a' }, { id: 'b' }, { nope: 1 }] })).toEqual(['a', 'b'])
    expect(listModelIds({})).toEqual([])
    expect(listModelIds(null)).toEqual([])
  })

  it('returns the first local runtime that answers', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('11434')) return { ok: true, json: async () => ({ data: [{ id: 'qwen3.5:4b' }] }) }
      return { ok: false, status: 403 }
    }) as unknown as typeof fetch
    const hit = await detectLocal(LOCAL_PRESETS, { fetchImpl })
    expect(hit?.provider.id).toBe('ollama')
    expect(hit?.models).toEqual(['qwen3.5:4b'])
  })

  it('resolves to undefined when nothing local is listening', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    expect(await detectLocal(LOCAL_PRESETS, { fetchImpl })).toBeUndefined()
  })
})
