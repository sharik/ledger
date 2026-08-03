import { expect, test, type Page } from '@playwright/test'
import { goTab, setupVault, unlock } from './helpers'

const PROVIDER = 'https://openrouter.ai/api/v1/chat/completions'

const say = (text: string) => ({ choices: [{ message: { content: text } }] })
const call = (name: string, args: unknown, id = 'c1') => ({
  choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
})

/**
 * Serve a scripted list of replies, one per request, and record every request body. Nothing leaves
 * the machine — the point of these tests is as much what is IN those bodies as what comes back.
 */
async function serve(page: Page, replies: unknown[]) {
  const sent: string[] = []
  let at = 0
  await page.route(PROVIDER, async (route) => {
    sent.push(route.request().postData() ?? '')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(replies[Math.min(at++, replies.length - 1)]),
    })
  })
  return sent
}

/** Point the provider config at OpenRouter. Does NOT pass the tool-calling gate. */
async function configure(page: Page) {
  await goTab(page, 'settings')
  await page.getByTestId('assist-toggle').click()
  await page.getByTestId('assist-provider').selectOption('openrouter')
  await page.getByTestId('assist-model').fill('test/model')
  await page.getByTestId('assist-key').fill('sk-test')
  await page.getByTestId('assist-key').blur()
}

/**
 * Configure, pass the probe, and switch the assistant on.
 *
 * A fresh vault is on SAFE access (§2.2), so anything asking about amounts, rows or edits has to opt
 * into full explicitly — which is what most of this file does, since it predates the setting.
 */
async function enableAssistant(page: Page, access: 'safe' | 'full' = 'full') {
  await configure(page)
  await serve(page, [call('report_ready', { ready: true })])
  await page.getByTestId('assistant-probe').click()
  await expect(page.getByTestId('assistant-probe-msg')).toContainText('can call tools')
  await page.getByTestId('assistant-chat-toggle').click()
  await expect(page.getByTestId('assistant-access')).toHaveText('Safe')
  if (access === 'full') {
    await page.getByTestId('assistant-access').click()
    await expect(page.getByTestId('assistant-access')).toHaveText('Full')
  }
  await page.unroute(PROVIDER)
}

test.describe('the tool-calling gate (§4)', () => {
  test('the toggle is locked until a model is proven to call tools', async ({ page }) => {
    await setupVault(page, { demo: true })
    await configure(page)

    await expect(page.getByTestId('assistant-chat-toggle')).toBeDisabled()
    await expect(page.getByTestId('assistant-gate')).toContainText('tool calling')
    // No entry point exists while it is off.
    await expect(page.getByTestId('assistant-toggle')).toHaveCount(0)

    await serve(page, [call('report_ready', { ready: true })])
    await page.getByTestId('assistant-probe').click()
    await expect(page.getByTestId('assistant-chat-toggle')).toBeEnabled()
    await page.getByTestId('assistant-chat-toggle').click()
    await expect(page.getByTestId('assistant-toggle')).toBeVisible()
  })

  test('a model that answers in prose is refused with a reason, not degraded', async ({ page }) => {
    await setupVault(page, { demo: true })
    await configure(page)
    await serve(page, [say('Sure! I am ready.')])

    await page.getByTestId('assistant-probe').click()
    await expect(page.getByTestId('assistant-probe-msg')).toContainText('ignored the tool')
    await expect(page.getByTestId('assistant-chat-toggle')).toBeDisabled()
  })

  test('changing the model re-locks the gate', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    await expect(page.getByTestId('assistant-toggle')).toBeVisible()

    await page.getByTestId('assist-model').fill('other/model')
    await page.getByTestId('assist-model').blur()
    await expect(page.getByTestId('assistant-chat-toggle')).toBeDisabled()
    await expect(page.getByTestId('assistant-toggle')).toHaveCount(0)
  })
})

test.describe('the conversation (§1, §3)', () => {
  test('nothing is sent before a question, and the first request carries no vault data', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    const sent = await serve(page, [say('You spent nothing at all.')])

    await page.getByTestId('assistant-toggle').click()
    await expect(page.getByTestId('assistant-panel')).toBeVisible()
    expect(sent).toHaveLength(0) // opening the panel is not a request

    await page.getByTestId('assistant-input').fill('how much did I spend on dining?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('nothing at all')

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('how much did I spend on dining?')
    // The demo vault's own names must not appear until a tool asks for them.
    expect(sent[0]).not.toContain('Dining out')
    expect(sent[0]).not.toContain('cat-dining')
  })

  test('a tool result is fed back, and its receipt is shown as the audit trail', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    const sent = await serve(page, [call('list_categories', {}), say('Fourteen categories.')])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('what categories do I have?')
    await page.getByTestId('assistant-send').click()

    await expect(page.getByTestId('assistant-receipt').first()).toContainText('Categories')
    await expect(page.getByTestId('assistant-reply')).toContainText('Fourteen')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('Dining out') // now it knows, because it asked
  })

  test('a provider failure is a line of text, not a broken panel', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    await page.route(PROVIDER, (route) => route.fulfill({ status: 500, body: '{}' }))

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('hello')
    await page.getByTestId('assistant-send').click()

    await expect(page.getByTestId('assistant-error')).toContainText('provider had an error')
    await expect(page.getByTestId('assistant-input')).toBeEnabled()
  })

  test('a model that only ever calls tools is cut off at the round cap', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    const sent = await serve(page, [call('get_overview', {})])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('loop forever')
    await page.getByTestId('assistant-send').click()

    // The cap is read back out of the message rather than imported, so the assertion cannot drift
    // from it and the spec stays free of src imports (no Vite env under the Playwright runner).
    const msg = await page.getByTestId('assistant-error').textContent({ timeout: 20_000 })
    const cap = Number(/after (\d+) rounds/.exec(msg ?? '')?.[1])
    expect(cap).toBeGreaterThan(0)
    expect(sent).toHaveLength(cap)
  })
})

test.describe('driving the app (§5)', () => {
  test('show_transactions moves the route and the visible rows', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    await serve(page, [
      call('show_transactions', { from: '2026-06-01', to: '2026-06-30' }),
      say('Opened June for you.'),
    ])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('show me june')
    await page.getByTestId('assistant-send').click()

    await expect(page.getByTestId('assistant-reply')).toContainText('Opened June')
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
    expect(page.url()).toContain('from=2026-06-01')
    expect(page.url()).toContain('to=2026-06-30')
    // The panel stays open on top of the screen it just changed — there is no scrim to dismiss.
    await expect(page.getByTestId('assistant-panel')).toBeVisible()
  })

  test('show_comparison seeds both sides of the Compare screen', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    await serve(page, [
      call('show_comparison', { a: { period: { rel: 'thisMonth' } }, b: { period: { rel: 'lastMonth' } }, normalize: 'perDay' }),
      say('This month against last.'),
    ])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('compare this month to last')
    await page.getByTestId('assistant-send').click()

    await expect(page.locator('[data-screen="compare"]')).toBeVisible()
    expect(decodeURIComponent(page.url())).toContain('"rel":"thisMonth"')
    expect(decodeURIComponent(page.url())).toContain('"rel":"lastMonth"')
  })

  test('an edit needs a click, and the undo toast reverses it', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)

    // Find a real transaction id to propose against.
    await goTab(page, 'txns')
    const rowId = await page.locator('[data-txn-id]').first().getAttribute('data-txn-id')
    expect(rowId).toBeTruthy()

    await serve(page, [
      call('propose_edit', { kind: 'set_recurring', txnIds: [rowId], recurring: 'monthly', reason: 'it repeats every month' }),
      say('I proposed marking it monthly.'),
    ])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('is this a subscription?')
    await page.getByTestId('assistant-send').click()

    const card = page.getByTestId('assistant-proposal')
    await expect(card).toContainText('monthly')
    await expect(card).toContainText('it repeats every month')

    await page.getByTestId('proposal-apply').click()
    await expect(card).toContainText('APPLIED')
    await expect(page.getByTestId('toast')).toBeVisible()
  })
})

test.describe('layout (§9)', () => {
  // Cards used to be appended after the whole transcript, so a proposal from three questions ago
  // sat below the newest reply and no longer said which answer it belonged to.
  test('a proposal card stays with the answer that raised it', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)

    await goTab(page, 'txns')
    const ids = await page.locator('[data-txn-id]').evaluateAll((els) => els.slice(0, 2).map((e) => (e as HTMLElement).dataset.txnId!))

    await serve(page, [
      call('propose_edit', { kind: 'set_recurring', txnIds: [ids[0]], recurring: 'monthly', reason: 'first' }),
      say('First proposal made.'),
      call('propose_edit', { kind: 'set_recurring', txnIds: [ids[1]], recurring: 'yearly', reason: 'second' }, 'c2'),
      say('Second proposal made.'),
    ])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('first question')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-proposal')).toHaveCount(1)

    await page.getByTestId('assistant-input').fill('second question')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-proposal')).toHaveCount(2)

    // Read the transcript in DOM order: the first card must sit before the second question, not
    // after everything.
    const order = await page
      .locator('[data-testid="assistant-user"], [data-testid="assistant-proposal"]')
      .evaluateAll((els) =>
        els.map((e) => ((e as HTMLElement).dataset.testid === 'assistant-user' ? 'Q' : 'CARD')),
      )
    expect(order).toEqual(['Q', 'CARD', 'Q', 'CARD'])
  })

  // The panel exists to open the screen that proves its answer, so it must not cover that screen —
  // and reserving the space must not break centring when it is closed. The first attempt put
  // `marginRight` on a `margin: 0 auto` column, which cancelled the right auto-margin and shoved
  // everything to the right edge, panel open or shut.
  test('content stays centred when closed, and is never covered when open', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)

    const box = async () => {
      const b = await page.locator('[data-main-scroll] > div').boundingBox()
      return { left: Math.round(b!.x), right: Math.round(b!.x + b!.width) }
    }
    const viewport = page.viewportSize()!.width

    const closed = await box()
    // Centred: equal slack either side, within a pixel of rounding.
    expect(Math.abs(closed.left - (viewport - closed.right))).toBeLessThanOrEqual(1)

    await page.getByTestId('assistant-toggle').click()
    await expect(page.getByTestId('assistant-panel')).toBeVisible()
    await page.waitForTimeout(300) // the reservation transitions

    const open = await box()
    const panelLeft = Math.round((await page.getByTestId('assistant-panel').boundingBox())!.x)
    expect(open.right).toBeLessThanOrEqual(panelLeft + 1) // never underneath the drawer
    expect(open.left).toBeGreaterThanOrEqual(0) // and never pushed off the left edge either
    // Centred in what is left. Below the max-width the column simply fills the space, so both
    // margins are 0 and this still holds.
    expect(Math.abs(open.left - (panelLeft - open.right))).toBeLessThanOrEqual(1)

    await page.getByTestId('assistant-close').click()
    await page.waitForTimeout(300)
    expect(await box()).toEqual(closed) // and it goes back exactly
  })
})

test.describe('skills (§6)', () => {
  test('an imported skill is listed by description, and its body is sent only when read', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)

    await page.getByTestId('skill-file').setInputFiles({
      name: 'valuation.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: my-flat\ndescription: what my flat is worth\n---\n\nThe flat is worth 320000 EUR as of Jan 2026.\n'),
    })
    await page.getByTestId('skill-save').click()
    await expect(page.getByTestId('skill-edit-my-flat')).toBeVisible()

    const sent = await serve(page, [call('list_skills', {}), call('read_skill', { name: 'my-flat' }, 'c2'), say('Around €320,000.')])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('what is my net worth including the flat?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('320,000')

    // Progressive disclosure: the description travelled on the list call, the body only after read.
    expect(sent[1]).toContain('what my flat is worth')
    expect(sent[1]).not.toContain('320000')
    expect(sent[2]).toContain('320000')
  })

  test('a markdown file without frontmatter is refused, not half-imported', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)

    await page.getByTestId('skill-file').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('just some notes about money'),
    })
    await expect(page.getByTestId('skill-note')).toContainText('frontmatter')
    await expect(page.getByTestId('skill-editor')).toHaveCount(0)
  })

  test('a built-in can be switched off', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page)
    await page.getByTestId('skill-toggle-comparisons').click()
    await expect(page.getByTestId('skill-toggle-comparisons')).toContainText('Off')

    const sent = await serve(page, [call('list_skills', {}), say('done')])
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('what do you know?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('done')
    expect(sent[1]).not.toContain('comparisons')
  })
})

test.describe('access levels (§2.2)', () => {
  test('a newly enabled assistant is Safe, and offers no tool that carries money', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')
    await expect(page.getByTestId('assistant-access')).toHaveText('Safe')
    await expect(page.getByTestId('assistant-access-hint')).toContainText('never sees an amount')

    const sent = await serve(page, [say('Safe mode keeps the amounts on your device.')])
    await page.getByTestId('assistant-toggle').click()
    await expect(page.getByTestId('assistant-safe-empty')).toContainText('Safe')
    await page.getByTestId('assistant-input').fill('how much did I spend on dining?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('on your device')

    const tools = JSON.parse(sent[0]!).tools.map((t: { function: { name: string } }) => t.function.name)
    expect(tools).not.toContain('aggregate')
    expect(tools).not.toContain('query_transactions')
    expect(tools).not.toContain('propose_edit')
    expect(tools).toContain('show_transactions')
    // A write is not a read: plan changes stay on the table, with their reading paths closed.
    expect(tools).toContain('propose_plan')
  })

  test('a goal can still be archived in safe mode, and the amount stays home', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')

    // Read the goal's id the way the assistant would, from the tool it is allowed to call.
    const listed = await serve(page, [call('list_goals', {}), say('Which one did you mean?')])
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('what goals do I have?')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('Which one')
    // The OpenAI wire carries a tool result as a `role: 'tool'` message with the JSON as a string.
    const toolMsg = JSON.parse(listed[1]!).messages.find((m: { role: string }) => m.role === 'tool')
    const result = JSON.parse(toolMsg.content)
    expect(result.access).toBe('safe')
    const goal = result.goals[0]
    expect(goal.target).toBeUndefined() // no figure came back with the id
    await page.unroute(PROVIDER)

    await serve(page, [
      call('propose_plan', { action: 'archive', target: 'goal', id: goal.id, reason: 'you asked' }),
      say(`I put an archive of ${goal.name} in front of you.`),
    ])
    await page.getByTestId('assistant-input').fill(`archive ${goal.name}`)
    await page.getByTestId('assistant-send').click()

    const card = page.getByTestId('assistant-proposal')
    await expect(card).toContainText('Archive the goal')
    await page.getByTestId('proposal-apply').click()
    await expect(card).toContainText('APPLIED')
  })

  test('a withheld tool is refused even when the model calls it anyway', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')
    await serve(page, [
      call('aggregate', { selection: { period: { rel: 'lastMonth' } }, groupBy: 'category' }),
      say('I cannot read amounts in safe mode.'),
    ])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('total last month')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-receipt').first()).toContainText('safe mode')
    await expect(page.getByTestId('assistant-reply')).toContainText('cannot read amounts')
  })

  test('safe mode still opens a filtered list, and reports the rows on screen', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')
    await serve(page, [call('show_transactions', { from: '2026-06-01', to: '2026-06-30' }), say('June is on screen.')])

    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('show me june')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('June is on screen')
    await expect(page.locator('[data-screen="txns"]')).toBeVisible()
  })

  test('switching to Full restores the whole catalogue, and it survives a reload', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'full')
    await page.waitForTimeout(1400) // let the save debounce flush before reloading
    await page.reload()
    await unlock(page)
    await goTab(page, 'settings')
    await expect(page.getByTestId('assistant-access')).toHaveText('Full')

    const sent = await serve(page, [say('ok')])
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('anything')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('ok')
    const tools = JSON.parse(sent[0]!).tools.map((t: { function: { name: string } }) => t.function.name)
    expect(tools).toContain('aggregate')
    expect(tools).toContain('propose_edit')
  })

  test('a skill that leans on a withheld tool is marked in Settings', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')
    // The built-in comparisons skill tells the assistant to use compare_selections.
    await expect(page.getByTestId('skill-gap-comparisons')).toBeVisible()
    await expect(page.getByTestId('skills-safe-note')).toContainText('sent whatever the access level')

    await page.getByTestId('assistant-access').click()
    await expect(page.getByTestId('skill-gap-comparisons')).toHaveCount(0)
  })
})

test.describe('the assistant’s own model (§2.1)', () => {
  test('it can run a different model from categorization, on the same provider', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')

    await page.getByTestId('assistant-model').fill('test/bigger-model')
    await page.getByTestId('assistant-model').blur()
    // Moving the assistant's pair re-arms the gate: nothing proved THIS model can call a tool.
    await expect(page.getByTestId('assistant-chat-toggle')).toBeDisabled()
    await expect(page.getByTestId('assistant-gate')).toContainText('test/bigger-model')

    await serve(page, [call('report_ready', { ready: true })])
    await page.getByTestId('assistant-probe').click()
    await expect(page.getByTestId('assistant-probe-msg')).toContainText('test/bigger-model')
    await page.getByTestId('assistant-chat-toggle').click()
    await page.unroute(PROVIDER)

    const sent = await serve(page, [say('ok')])
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-input').fill('anything')
    await page.getByTestId('assistant-send').click()
    await expect(page.getByTestId('assistant-reply')).toContainText('ok')
    expect(JSON.parse(sent[0]!).model).toBe('test/bigger-model')
  })

  test('changing the categorization model leaves an overridden assistant alone', async ({ page }) => {
    await setupVault(page, { demo: true })
    await enableAssistant(page, 'safe')
    await page.getByTestId('assistant-model').fill('test/bigger-model')
    await page.getByTestId('assistant-model').blur()
    await serve(page, [call('report_ready', { ready: true })])
    await page.getByTestId('assistant-probe').click()
    await page.getByTestId('assistant-chat-toggle').click()
    await expect(page.getByTestId('assistant-toggle')).toBeVisible()
    await page.unroute(PROVIDER)

    // Re-typing the categorization model used to re-lock the assistant. It no longer runs that model.
    await page.getByTestId('assist-model').fill('test/other-classifier')
    await page.getByTestId('assist-model').blur()
    await expect(page.getByTestId('assistant-chat-toggle')).toBeEnabled()
    await expect(page.getByTestId('assistant-toggle')).toBeVisible()
  })
})
