import { beforeAll, describe, expect, it } from 'vitest'
import { setFixedNow } from '../../src/model/clock'
import { buildVault, catId } from '../helpers/build'
import type { NormalizedRow } from '../../src/import/types'
import {
  ASSIST_BATCH,
  ASSIST_THRESHOLD,
  assistCategorize,
  assistCost,
  assistInputs,
  assistKey,
  buildSchema,
  maxTokensFor,
  parsePredictions,
  redactDescriptor,
} from '../../src/import/assist'

beforeAll(() => setFixedNow('2026-07-12T00:00:00Z'))

function row(partial: Partial<NormalizedRow> & { merchant: string; normDesc: string; amountMinor: number }): NormalizedRow {
  return { sourceLine: 0, bookedDate: '2026-05-01', currency: 'EUR', kind: 'expense', raw: '', ...partial } as NormalizedRow
}

describe('assist — redaction & inputs', () => {
  it('never sends transfer rows — their merchant is a person, not a shop', () => {
    const inputs = assistInputs([
      row({ merchant: 'MARIE DUPONT', normDesc: 'VIREMENTEMISVERSMARIEDUPONT', amountMinor: -10000, kind: 'transfer-out' }),
      row({ merchant: 'IVAN P', normDesc: 'VIREMENTDEIVANP', amountMinor: 10000, kind: 'transfer-in' }),
      row({ merchant: 'SPAR', normDesc: 'PAIEMENTCBSPAR', amountMinor: -500 }),
    ])
    expect(inputs.map((i) => i.merchant)).toEqual(['SPAR'])
  })

  it('redacts long digit runs in the merchant too, and assistKey matches', () => {
    const r = row({ merchant: 'REF 1234567890 SHOP', normDesc: 'X1234567890Y', amountMinor: -500 })
    const [i] = assistInputs([r])
    expect(i!.merchant).toBe('REF ########## SHOP')
    expect(assistKey(r)).toBe(`${i!.merchant}\0${i!.descriptor}\0debit`)
  })

  it('redacts digit runs ≥6, keeps shorter ones', () => {
    expect(redactDescriptor('CARD 4974123456787214 DU 1234')).toBe('CARD ################ DU 1234')
  })

  it('separates key fields with NUL so a space in a merchant cannot forge another tuple', () => {
    const a = row({ merchant: 'A B', normDesc: 'C', amountMinor: -1 })
    const b = row({ merchant: 'A', normDesc: 'B C', amountMinor: -1 })
    expect(assistKey(a)).not.toBe(assistKey(b))
  })

  it('collapses to unique (merchant, redacted descriptor, sign) tuples', () => {
    const rows = [
      row({ merchant: 'AMZ', normDesc: 'AMZ 111111', amountMinor: -1000 }),
      row({ merchant: 'AMZ', normDesc: 'AMZ 222222', amountMinor: -2000 }), // same after redaction
      row({ merchant: 'AMZ', normDesc: 'AMZ 111111', amountMinor: 500 }), // different sign
    ]
    const inputs = assistInputs(rows)
    expect(inputs.length).toBe(2)
    expect(inputs.every((i) => i.descriptor === 'AMZ ######')).toBe(true)
    expect(new Set(inputs.map((i) => i.sign))).toEqual(new Set(['debit', 'credit']))
  })
})

describe('assist — strict JSON parsing', () => {
  it('parses a fenced array and drops malformed elements', () => {
    const preds = parsePredictions('```json\n[{"descriptor":"A","categoryId":"c1","confidence":0.9},{"nope":1}]\n```')
    expect(preds).toEqual([{ descriptor: 'A', categoryId: 'c1', confidence: 0.9 }])
  })

  it('parses the schema envelope, maps "unknown" to null, and clamps confidence', () => {
    const preds = parsePredictions(
      '{"predictions":[{"descriptor":"A","categoryId":"unknown","confidence":1.4},{"descriptor":"B","categoryId":"c1","confidence":-0.2}]}',
    )
    expect(preds).toEqual([
      { descriptor: 'A', categoryId: null, confidence: 1 },
      { descriptor: 'B', categoryId: 'c1', confidence: 0 },
    ])
  })

  it('throws on non-array output', () => {
    expect(() => parsePredictions('sorry, I cannot help')).toThrow()
  })
})

describe('assist — response schema', () => {
  it('enumerates every vault category id plus the unknown sentinel', () => {
    const v = buildVault()
    const schema = buildSchema(v.categories) as any
    const item = schema.properties.predictions.items
    expect(item.properties.categoryId.enum).toEqual([...v.categories.map((c) => c.id), 'unknown'])
    expect(item.additionalProperties).toBe(false)
    expect(item.required).toEqual(['descriptor', 'categoryId', 'confidence'])
    // Numeric bounds are unsupported by both providers' schema subsets — clamping happens at parse.
    expect(item.properties.confidence).toEqual({ type: 'number' })
  })

  it('keeps the output budget above a reasoning model’s thinking spend, and caps it', () => {
    // A small batch must still leave room for a model that thinks before answering — an empty reply
    // behind `finish_reason: length` is the failure this floor exists to prevent.
    expect(maxTokensFor(1)).toBeGreaterThanOrEqual(4096)
    expect(maxTokensFor(ASSIST_BATCH)).toBeGreaterThan(maxTokensFor(1))
    expect(maxTokensFor(10_000)).toBe(8192)
  })
})

describe('assist — request shape per wire', () => {
  const capture = () => {
    const seen: { url: string; body: any }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"predictions":[]}' }] }) }
    }) as unknown as typeof fetch
    return { seen, fetchImpl }
  }
  const rows = [row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })]

  it('asks Anthropic for schema-enforced output via output_config', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }
    })
    const { seen, fetchImpl } = capture()
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen[0]!.body.output_config.format.type).toBe('json_schema')
    expect(seen[0]!.body.output_config.format.schema.properties.predictions).toBeTruthy()
    expect(seen[0]!.body.max_tokens).toBe(maxTokensFor(1))
  })

  it('asks OpenAI-compatible providers via strict response_format, and sets max_tokens', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'openrouter', wire: 'openai', model: 'openai/gpt-oss-20b:free', apiKey: 'k' }
    })
    const { seen, fetchImpl } = capture()
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(seen[0]!.body.response_format.json_schema.strict).toBe(true)
    expect(seen[0]!.body.max_tokens).toBe(maxTokensFor(1))
  })

  // Regression: OpenAI's own API rejects `max_tokens` on current models (400 unsupported_parameter);
  // it must receive `max_completion_tokens` instead, while compatible providers keep `max_tokens`.
  it('sends max_completion_tokens (not max_tokens) to the official OpenAI endpoint', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'openai', wire: 'openai', model: 'gpt-5', apiKey: 'k' }
    })
    const { seen, fetchImpl } = capture()
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(seen[0]!.body.max_completion_tokens).toBe(maxTokensFor(1))
    expect(seen[0]!.body.max_tokens).toBeUndefined()
  })

  it('appends the version to a legacy base URL but leaves a versioned one alone', async () => {
    for (const [baseUrl, expected] of [
      ['https://my.proxy/api', 'https://my.proxy/api/v1/chat/completions'],
      ['https://my.proxy/api/v1', 'https://my.proxy/api/v1/chat/completions'],
      ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ] as const) {
      const v = buildVault((v) => {
        v.settings.assist = { provider: 'custom', wire: 'openai', baseUrl, model: 'm', apiKey: 'k' }
      })
      const { seen, fetchImpl } = capture()
      await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
      expect(seen[0]!.url).toBe(expected)
    }
  })

  it('runs a local provider with no api key', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'ollama', wire: 'openai', model: 'qwen3.5:4b', apiKey: '' }
    })
    const { seen, fetchImpl } = capture()
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(seen[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
  })
})

describe('assist — categorize routing', () => {
  const groceries = (v: ReturnType<typeof buildVault>) => catId(v, 'Groceries')

  it('routes ≥0.7 to auto, below to needs-review; unknown categories dropped', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    })
    const gid = groceries(v)
    const rows = [
      row({ merchant: 'CARREFOUR', normDesc: 'CARREFOUR', amountMinor: -1000 }),
      row({ merchant: 'MYSTERY', normDesc: 'MYSTERY', amountMinor: -500 }),
      row({ merchant: 'BOGUS', normDesc: 'BOGUS', amountMinor: -700 }),
    ]
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { descriptor: 'CARREFOUR', categoryId: gid, confidence: 0.95 },
          { descriptor: 'MYSTERY', categoryId: gid, confidence: 0.4 },
          { descriptor: 'BOGUS', categoryId: 'does-not-exist', confidence: 0.9 },
        ]) }],
      }),
    })) as unknown as typeof fetch

    const { results: res } = await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(res.get(assistKey(rows[0]!))).toEqual({ categoryId: gid, confidence: 0.95, auto: true })
    expect(res.get(assistKey(rows[1]!))).toEqual({ categoryId: gid, confidence: 0.4, auto: false })
    expect(res.has(assistKey(rows[2]!))).toBe(false) // unknown category dropped
    expect(ASSIST_THRESHOLD).toBe(0.7)
  })

  it('drops an answer of the fallback "Other" category — no idea is not a suggestion', async () => {
    const v = buildVault((v) => {
      v.settings.assist = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'k' }
    })
    const other = catId(v, 'Other')
    const rows = [
      row({ merchant: 'CARREFOUR', normDesc: 'CARREFOUR', amountMinor: -1000 }),
      row({ merchant: 'MYSTERY', normDesc: 'MYSTERY', amountMinor: -500 }),
    ]
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { descriptor: 'CARREFOUR', categoryId: groceries(v), confidence: 0.95 },
          { descriptor: 'MYSTERY', categoryId: other, confidence: 0.95 }, // confident, but says "Other"
        ]) }],
      }),
    })) as unknown as typeof fetch

    const { results: res } = await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(res.get(assistKey(rows[0]!))).toEqual({ categoryId: groceries(v), confidence: 0.95, auto: true })
    // The high-confidence "Other" leaves no trace — the row stays fallback, not an AI-placed Other.
    expect(res.has(assistKey(rows[1]!))).toBe(false)
    expect(res.size).toBe(1)
  })

  it('degrades silently to empty on a non-ok response', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openai', model: 'gpt', apiKey: 'k' } })
    const fetchImpl = (async () => ({ ok: false })) as unknown as typeof fetch
    const { results: res } = await assistCategorize([row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })], v.categories, v.settings, { fetchImpl })
    expect(res.size).toBe(0)
  })

  it('degrades silently on malformed JSON', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openai', model: 'gpt', apiKey: 'k' } })
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'garbage' } }] }) })) as unknown as typeof fetch
    const { results: res } = await assistCategorize([row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })], v.categories, v.settings, { fetchImpl })
    expect(res.size).toBe(0)
  })

  it('retries once without the schema when the provider rejects it, then succeeds', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openai', wire: 'openai', model: 'legacy', apiKey: 'k' } })
    const gid = groceries(v)
    const bodies: any[] = []
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      if (body.response_format) return { ok: false, status: 400 }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify([{ descriptor: 'X', categoryId: gid, confidence: 0.9 }]) } }] }),
      }
    }) as unknown as typeof fetch

    const rows = [row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })]
    const { results: res } = await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(bodies.length).toBe(2)
    expect(bodies[1].response_format).toBeUndefined()
    expect(res.get(assistKey(rows[0]!))?.categoryId).toBe(gid)
  })

  it('does not retry a 5xx — only a schema rejection earns a second call', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openai', wire: 'openai', model: 'm', apiKey: 'k' } })
    let calls = 0
    const fetchImpl = (async () => { calls++; return { ok: false, status: 503 } }) as unknown as typeof fetch
    await assistCategorize([row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })], v.categories, v.settings, { fetchImpl })
    expect(calls).toBe(1)
  })

  it('splits large imports into batches so the reply cannot outgrow the output budget', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openai', wire: 'openai', model: 'm', apiKey: 'k' } })
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"predictions":[]}' } }] }) }
    }) as unknown as typeof fetch
    const rows = Array.from({ length: ASSIST_BATCH + 10 }, (_, i) => row({ merchant: `M${i}`, normDesc: `M${i}`, amountMinor: -1 }))
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(calls).toBe(2)
  })

  it('reports a timed-out batch instead of passing it off as "no opinion"', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openrouter', wire: 'openai', model: 'm', apiKey: 'k' } })
    // An aborted request throws rather than resolving — the shape a deadline produces.
    const fetchImpl = (async () => { throw new DOMException('aborted', 'TimeoutError') }) as unknown as typeof fetch
    const rows = Array.from({ length: ASSIST_BATCH + 1 }, (_, i) => row({ merchant: `M${i}`, normDesc: `M${i}`, amountMinor: -1 }))
    const outcome = await assistCategorize(rows, v.categories, v.settings, { fetchImpl })
    expect(outcome.results.size).toBe(0)
    expect(outcome.batches).toBe(2)
    expect(outcome.failed).toBe(2) // both batches attempted, both lost — the UI can say so
    expect(outcome.descriptors).toBe(ASSIST_BATCH + 1)
  })

  it('reports progress per batch so a long run is not a blank wait', async () => {
    const v = buildVault((v) => { v.settings.assist = { provider: 'openrouter', wire: 'openai', model: 'm', apiKey: 'k' } })
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"predictions":[]}' } }] }) })) as unknown as typeof fetch
    const rows = Array.from({ length: ASSIST_BATCH + 1 }, (_, i) => row({ merchant: `M${i}`, normDesc: `M${i}`, amountMinor: -1 }))
    const seen: string[] = []
    await assistCategorize(rows, v.categories, v.settings, { fetchImpl, onProgress: (d, t) => seen.push(`${d}/${t}`) })
    expect(seen).toEqual(['1/2', '2/2'])
  })

  it('counts the cost in distinct merchants, not rows — repeats are free', () => {
    const rows = [
      ...Array.from({ length: 40 }, () => row({ merchant: 'CARREFOUR', normDesc: 'CARREFOUR', amountMinor: -1 })),
      row({ merchant: 'SNCF', normDesc: 'SNCF', amountMinor: -1 }),
    ]
    expect(assistCost(rows)).toEqual({ descriptors: 2, batches: 1 })
  })

  it('never calls the provider when assist is not configured', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    const v = buildVault() // no settings.assist
    const { results: res } = await assistCategorize([row({ merchant: 'X', normDesc: 'X', amountMinor: -1 })], v.categories, v.settings, { fetchImpl })
    expect(called).toBe(false)
    expect(res.size).toBe(0)
  })
})
