import { describe, expect, it } from 'vitest'
import { redactVault } from '../../src/ui/export'
import { emptyVault } from '../../src/model/seed'
import type { Vault } from '../../src/model/types'

function vaultWithKeys(): Vault {
  const v = emptyVault()
  v.settings.assist = {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: 'sk-secret-primary',
    perProvider: {
      anthropic: { apiKey: 'sk-secret-primary', baseUrl: 'https://api.anthropic.com' },
      openai: { apiKey: 'sk-secret-openai' },
    },
  }
  return v
}

describe('redactVault (JSON export hygiene)', () => {
  it('blanks the top-level and every per-provider API key', () => {
    const out = redactVault(vaultWithKeys())
    expect(out.settings.assist!.apiKey).toBe('')
    expect(out.settings.assist!.perProvider!.anthropic!.apiKey).toBeUndefined()
    expect(out.settings.assist!.perProvider!.openai!.apiKey).toBeUndefined()
  })

  it('keeps non-secret fields — provider, model and base URLs are not credentials', () => {
    const out = redactVault(vaultWithKeys())
    expect(out.settings.assist!.provider).toBe('anthropic')
    expect(out.settings.assist!.model).toBe('claude-haiku-4-5')
    expect(out.settings.assist!.perProvider!.anthropic!.baseUrl).toBe('https://api.anthropic.com')
  })

  it('does not mutate the source vault', () => {
    const v = vaultWithKeys()
    redactVault(v)
    expect(v.settings.assist!.apiKey).toBe('sk-secret-primary')
    expect(v.settings.assist!.perProvider!.openai!.apiKey).toBe('sk-secret-openai')
  })

  it('is a no-op when the assistant was never configured', () => {
    const v = emptyVault()
    expect(redactVault(v)).toEqual(v)
  })
})
