// Live-provider config for the `live` Playwright project (e2e/live-*.spec.ts).
//
// Every other assistant spec stubs the provider with `page.route` and canned replies. That is
// deterministic, free, and proves the plumbing — but a canned reply cannot prove the thing that
// actually matters about a tool-calling assistant: that a real model, handed the tool catalogue
// and the system prompt, DECIDES to call the right tool with the right arguments. Only a real
// provider tests that, so it lives here, opt-in and out of the default run.
//
// Values arrive from `.env.test`, loaded by playwright.config.ts. With no key `liveConfig()`
// returns null and the spec skips itself rather than failing.
import type { Page } from '@playwright/test'
import { goTab } from './helpers'

export interface LiveConfig {
  provider: 'anthropic' | 'openai'
  model: string
  apiKey: string
}

/** Null when `.env.test` is absent or its key is blank — the signal to skip, not to fail. */
export function liveConfig(): LiveConfig | null {
  const provider = process.env.LEDGER_LIVE_PROVIDER === 'openai' ? 'openai' : 'anthropic'
  // Only the selected provider's key is read, so a file carrying both leaks neither into the
  // other's request — the same rule `chatAssist` follows in src/assistant/config.ts.
  const apiKey = (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) ?? ''
  const model = process.env.LEDGER_LIVE_MODEL ?? ''
  if (!apiKey.trim() || !model.trim()) return null
  return { provider, model: model.trim(), apiKey: apiKey.trim() }
}

/**
 * Point Settings → Assistant at the live provider. Deliberately the same click path as
 * `configure` in assistant.spec.ts — a live run that set the config some other way would prove
 * the provider works and say nothing about whether the Settings screen can reach it.
 */
export async function configureLive(page: Page, cfg: LiveConfig): Promise<void> {
  await goTab(page, 'settings')
  await page.getByTestId('assist-toggle').click()
  await page.getByTestId('assist-provider').selectOption(cfg.provider)
  await page.getByTestId('assist-model').fill(cfg.model)
  await page.getByTestId('assist-key').fill(cfg.apiKey)
  await page.getByTestId('assist-key').blur()
}
