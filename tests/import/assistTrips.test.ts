import { describe, it, expect } from 'vitest'
import { TRIP_MERCHANT_CAP, assistRefineTripName } from '../../src/import/assistTrips'
import { emptyVault } from '../../src/model/seed'
import type { Settings } from '../../src/model/types'

const withAssist = (): Settings => ({
  ...emptyVault().settings,
  assist: { provider: 'openai', wire: 'openai', model: 'gpt-x', apiKey: 'k' },
})

const input = { currency: 'ISK', dateFrom: '2025-08-25', dateTo: '2025-09-11', merchants: ['MESSINN', 'BONUS', 'ORKAN'] }

describe('assistRefineTripName', () => {
  it('returns the model name on success', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"name":"Reykjavík"}' } }] }),
    })) as unknown as typeof fetch
    expect(await assistRefineTripName(input, withAssist(), { fetchImpl })).toBe('Reykjavík')
  })

  it('returns null (caller keeps local name) when the provider fails', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    expect(await assistRefineTripName(input, withAssist(), { fetchImpl })).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    const fetchImpl = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await assistRefineTripName(input, withAssist(), { fetchImpl })).toBeNull()
  })

  it('returns null when assist is not configured', async () => {
    expect(await assistRefineTripName(input, emptyVault().settings, {})).toBeNull()
  })

  // The import offer states this payload before the user presses the button ("sends the trip dates
  // and N merchant names · no amounts"). It counts with TRIP_MERCHANT_CAP, so the cap has to be
  // what the request actually honours — otherwise the stated count understates what left the device.
  it('sends at most TRIP_MERCHANT_CAP merchants, and no amounts', async () => {
    let body = ''
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = String(init.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"name":"X"}' } }] }) }
    }) as unknown as typeof fetch

    const merchants = Array.from({ length: TRIP_MERCHANT_CAP + 15 }, (_, i) => `SHOP-${i}`)
    await assistRefineTripName({ ...input, merchants }, withAssist(), { fetchImpl })

    const sent = merchants.filter((m) => body.includes(m))
    expect(sent).toHaveLength(TRIP_MERCHANT_CAP)
    expect(body).toContain('SHOP-0')
    expect(body).not.toContain(`SHOP-${TRIP_MERCHANT_CAP}`) // the first one past the cap
    // Dates are sent (that is why the offer names them); amounts never are.
    expect(body).toContain('2025-08-25')
    expect(body).not.toMatch(/\d+\.\d{2}/)
  })
})
