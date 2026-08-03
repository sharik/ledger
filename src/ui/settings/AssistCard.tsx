// Settings → Smart categorization (mock 1221–1229, IMPORT §10.6). The provider, model and API key
// live in `settings.assist` — in the encrypted vault. Amounts are never sent; digit runs ≥6 are
// redacted before a batched, schema-enforced request. Models come from the catalog, or — for a local
// runtime — from asking it directly on select; the text input underneath always holds the exact id, so
// an unreachable catalog costs autocomplete and never function. Toggling off clears the config.
import { useEffect, useRef, useState } from 'react'
import type { Settings } from '../../model/types'
import { PRESETS, presetFor, type ProviderDef } from '../../import/providers'
import { detectLocal, loadCatalog, modelLabel, toProviderDef, type Catalog, type CatalogModel } from '../../import/catalog'
import { chatAccess, chatAssist } from '../../assistant/config'
import { chatVerifiedKey, probeMessage, probeToolCalling, toolsVerified } from '../../assistant/probe'
import { useRawVault, useStore } from '../store'
import { INK, MUT, FAINT, HAIR, ACCENT, GREEN, MONO } from '../theme'
import { hairBottom, italicNote } from '../styles'

type Assist = NonNullable<Settings['assist']>

const DEFAULT_MODEL = 'claude-haiku-4-5'

export function AssistCard() {
  const vault = useRawVault() // provider settings, not account-anchored
  const store = useStore()
  const assist = vault.settings.assist
  const on = !!assist

  const [provider, setProvider] = useState(assist?.provider ?? 'anthropic')
  const [model, setModel] = useState(assist?.model ?? DEFAULT_MODEL)
  const [apiKey, setApiKey] = useState(assist?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(assist?.baseUrl ?? '')
  // Credentials for providers other than the active one. Seeded from a pre-`perProvider` vault so an
  // existing key is adopted rather than stranded.
  const [perProvider, setPerProvider] = useState<NonNullable<Assist['perProvider']>>(
    () => assist?.perProvider ?? (assist?.apiKey ? { [assist.provider]: { apiKey: assist.apiKey, baseUrl: assist.baseUrl } } : {}),
  )
  const [catalog, setCatalog] = useState<Catalog>(() => new Map())
  const [localModels, setLocalModels] = useState<string[] | null>(null)
  const [detectMsg, setDetectMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const loaded = useRef(false)

  // Lazily — only once the card is actually on. Never on app load, and offline is a no-op. A local
  // provider is probed at the same time, so a saved Ollama config shows its models without a click.
  useEffect(() => {
    if (!on || loaded.current) return
    loaded.current = true
    void loadCatalog().then(setCatalog)
    const local = presetFor(provider)
    if (local?.local) void probeLocal(local)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on])

  const def = defFor(provider, catalog)
  // `|| !!baseUrl`: a preset carrying a base URL (e.g. one planted by a synced device) must always be
  // visible and clearable — endpointsFor honours it regardless, so hiding the field hid a redirect.
  const showBaseUrl = provider === 'custom' || (!presetFor(provider) && !!def) || !!baseUrl
  const options = optionsFor(provider, catalog, localModels)

  const config = (over: Partial<Assist> = {}): Assist => {
    const p = over.provider ?? provider
    const key = over.apiKey ?? apiKey
    const url = (over.baseUrl ?? baseUrl) || undefined
    const m = over.model ?? model
    const next: Assist = {
      provider: p,
      wire: defFor(p, catalog)?.wire ?? 'openai',
      baseUrl: url,
      model: m,
      apiKey: key,
      // Record the active credentials under their own provider on every save, so the retained copy
      // is never behind what is on screen.
      perProvider: { ...(over.perProvider ?? perProvider), [p]: { apiKey: key, baseUrl: url } },
      // Consent, access level, the assistant's own pair and skill preferences survive an unrelated
      // edit (a re-typed key, a new base URL).
      skillsOff: assist?.skillsOff,
      chatProvider: assist?.chatProvider,
      chatWire: assist?.chatWire,
      chatModel: assist?.chatModel,
      chatAccess: assist?.chatAccess,
    }
    // A tool-calling verdict belongs to one (provider, model) pair — the pair the ASSISTANT runs on.
    // Changing it invalidates the verdict and re-locks the toggle rather than letting a chat run
    // against an unproven model. When the assistant has a model of its own, editing this one no
    // longer disturbs it.
    const stillVerified = !!assist?.toolsVerified && assist.toolsVerified === chatVerifiedKey(next)
    return {
      ...next,
      chat: stillVerified ? assist?.chat : undefined,
      toolsVerified: stillVerified ? assist?.toolsVerified : undefined,
    }
  }

  const save = (next: Settings['assist']) =>
    store.commit({ kind: 'setSingletonField', collection: 'settings', field: 'assist', value: next }, { msg: next ? 'Smart categorization saved' : 'Smart categorization off', undoable: true })

  const toggle = () => (on ? save(undefined) : save(config()))

  /** Ask a local runtime what it is serving. Its answer replaces the catalog for that provider. */
  const probeLocal = async (target: ProviderDef): Promise<string[] | undefined> => {
    setBusy(true)
    setDetectMsg('')
    const hit = await detectLocal([target])
    setBusy(false)
    setLocalModels(hit?.models ?? null)
    setDetectMsg(
      hit
        ? `${hit.provider.label} — ${hit.models.length} model${hit.models.length === 1 ? '' : 's'} available.`
        : `${target.label} did not answer. It only accepts browser requests from a localhost origin — for any other origin, start it with OLLAMA_ORIGINS set to this page’s origin.`,
    )
    return hit?.models
  }

  // Changing provider retires the old model id — it means nothing to the new endpoint. Pick that
  // provider's best default (cheapest schema-capable, per the catalog ordering); with no list to draw
  // on, blank the field so the user types one rather than inheriting an id that would 404. A local
  // runtime is asked directly, since no catalog knows which models you happen to have pulled.
  const pickProvider = async (id: string) => {
    // Bank the outgoing provider's credentials before switching, then load the incoming provider's.
    // A key belongs to the endpoint that issued it: carrying one across would send a secret to the
    // wrong provider on the next import, and discarding it would throw away something you typed.
    const banked = { ...perProvider, [provider]: { apiKey, baseUrl: baseUrl || undefined } }
    setPerProvider(banked)
    const restored = banked[id]

    setProvider(id)
    const url = restored?.baseUrl ?? (presetFor(id) ? '' : (catalog.get(id)?.api ?? ''))
    setBaseUrl(url)
    const nextKey = restored?.apiKey ?? ''
    setApiKey(nextKey)

    const preset = presetFor(id)
    const nextModel = preset?.local
      ? ((await probeLocal(preset))?.[0] ?? '')
      : (optionsFor(id, catalog, localModels)[0]?.id ?? '')
    setModel(nextModel)
    save(config({ provider: id, baseUrl: url, model: nextModel, apiKey: nextKey, perProvider: banked }))
  }

  /** One control: re-ask a local runtime, or refetch the catalog for everything else. */
  const reload = async () => {
    const preset = presetFor(provider)
    if (preset?.local) {
      const models = await probeLocal(preset)
      if (models?.length && !models.includes(model)) {
        setModel(models[0]!)
        save(config({ model: models[0]! }))
      }
      return
    }
    setBusy(true)
    setCatalog(await loadCatalog({ force: true }))
    setBusy(false)
  }

  return (
    <div style={{ borderTop: `1.5px solid ${INK}`, paddingTop: 12 }} data-testid="assist-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Smart categorization</div>
        <button data-testid="assist-toggle" onClick={toggle} className="hov-ink" style={{ fontSize: 11.5, color: on ? ACCENT : FAINT, background: 'none', border: `1px solid ${HAIR}`, borderRadius: 12, padding: '3px 12px', cursor: 'pointer' }}>
          {on ? 'On' : 'Off'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4, lineHeight: 1.5 }}>
        Optional. For rows no rule matched, Ledger asks your chosen model to suggest a category. Only the merchant and a
        redacted descriptor are sent — never amounts, dates, or account numbers. Confirming a suggestion mints a rule, so
        assist works itself out of a job.
        {' '}
        This setting also powers “Improve name with AI” on a detected trip, which sends that trip’s dates and merchant
        names — still never amounts or account numbers. The import screen states the payload before each request.
      </div>

      {on && (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          <Row label="Provider">
            <select data-testid="assist-provider" value={provider} onChange={(e) => void pickProvider(e.target.value)} style={ctrl}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              {catalogProviders(catalog).length > 0 && (
                <optgroup label="models.dev catalog">
                  {catalogProviders(catalog).map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>
          {/* One setting, two ways in. The dropdown is a real <select>, not a datalist — a datalist
              only offers options matching what is already typed, so a pre-filled field looks like a
              near-empty list. The text box stays the source of truth: it holds the exact id sent, and
              accepts ids no catalog knows (a custom endpoint, a model released this morning, a local
              runtime). With no list to show, it is the only control. */}
          <Row label="Model">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {options.length > 0 && (
                  <select
                    data-testid="assist-model-pick"
                    value={options.some((o) => o.id === model) ? model : ''}
                    onChange={(e) => {
                      setModel(e.target.value)
                      save(config({ model: e.target.value }))
                    }}
                    style={{ ...ctrl, maxWidth: 300 }}
                  >
                    <option value="" disabled>
                      Choose from {options.length}…
                    </option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label ? `${o.id} — ${o.label}` : o.id}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  data-testid="assist-reload"
                  onClick={() => void reload()}
                  disabled={busy}
                  title={presetFor(provider)?.local ? 'Ask this runtime what it is serving' : 'Refresh the model list'}
                  aria-label="Reload models"
                  style={reloadBtn(busy)}
                >
                  ↻
                </button>
              </div>
              <input
                data-testid="assist-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => save(config())}
                placeholder="model id"
                style={{ ...ctrl, fontFamily: MONO, fontSize: 11.5 }}
              />
            </div>
          </Row>
          {showBaseUrl && (
            <Row label="Base URL">
              <input data-testid="assist-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => save(config())} placeholder="https://…" style={ctrl} />
            </Row>
          )}
          {presetFor(provider) && !!baseUrl && (
            <div data-testid="assist-baseurl-warn" style={{ ...italicNote, marginTop: 6 }}>
              Requests for this preset go to a custom endpoint, not the provider&rsquo;s default. Clear the field to restore it.
            </div>
          )}
          {def?.needsKey !== false && (
            <Row label="API key">
              <input data-testid="assist-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} onBlur={() => save(config())} placeholder="sk-…" style={ctrl} />
            </Row>
          )}

          {detectMsg && (
            <div data-testid="assist-detect-msg" style={{ fontSize: 11.5, color: localModels ? GREEN : MUT, marginTop: 8, lineHeight: 1.5 }}>
              {detectMsg}
            </div>
          )}

          <div style={{ ...italicNote, marginTop: 8 }}>
            {def?.needsKey === false
              ? 'A local model runs on this machine — nothing leaves it.'
              : 'Stored encrypted in your vault. Runs in the browser, so your provider must allow direct calls (CORS).'}
          </div>
        </div>
      )}

      {on && (
        <AssistantSection assist={assist} save={save} catalog={catalog} localModels={localModels} hostProvider={provider} />
      )}
    </div>
  )
}

/**
 * Settings → Assistant (ASSISTANT §2, §4). Three controls, and the order on screen is the order of
 * the decisions:
 *
 *  1. Access (§2.2). How much of the vault a question may reach. **Safe** — names, flags and counts,
 *     never an amount, a date or a transaction — is the default for every vault, including one that
 *     consented to chat before this existed. Full is one deliberate click, described before it.
 *  2. Its own provider and model (§2.1). Categorization wants a cheap classifier; this wants a model
 *     that calls tools correctly. Absent ⇒ inherit, so a vault that ignores this is unaffected.
 *  3. Tool calling, then consent. The assistant has no degraded mode — without tools it knows nothing
 *     about the vault and would answer from thin air — so the toggle is locked until a live probe
 *     against the pair the ASSISTANT will use comes back with an actual tool call. Consent is separate
 *     from Smart categorization on purpose: that toggle bought permission to send redacted merchant
 *     strings and no amounts. Reusing it as cover for this one would be a bait-and-switch.
 */
function AssistantSection({
  assist,
  save,
  catalog,
  localModels,
  hostProvider,
}: {
  assist: Assist
  save: (next: Settings['assist']) => void
  catalog: Catalog
  localModels: string[] | null
  /** The categorization provider — what "same as categorization" resolves to. */
  hostProvider: string
}) {
  const [probing, setProbing] = useState(false)
  const [msg, setMsg] = useState('')
  const verified = toolsVerified(assist)
  const chatOn = !!assist.chat
  const safe = chatAccess(assist) === 'safe'
  // Drafts for the free-text fields, like the categorization row above: every save is an undoable
  // mutation, so they commit on blur rather than on each keystroke. Reset when the provider changes.
  const [draft, setDraft] = useState(() => {
    const banked = assist.chatProvider ? (assist.perProvider?.[assist.chatProvider] ?? {}) : {}
    return { model: assist.chatModel ?? '', apiKey: banked.apiKey ?? '', baseUrl: banked.baseUrl ?? '' }
  })

  // What the assistant will actually use, whether or not it was overridden.
  const eff = chatAssist(assist)
  const own = !!assist.chatProvider
  const effDef = defFor(eff.provider, catalog)
  const options = optionsFor(eff.provider, catalog, eff.provider === hostProvider ? localModels : null)
  const creds = (id: string) => assist.perProvider?.[id] ?? {}

  /**
   * Persist a change to the assistant's own pair. Moving that pair invalidates the tool-calling
   * verdict, which re-locks consent — the same rule the categorization row follows, for the same
   * reason: chat must never run against a model nobody proved can call a tool.
   */
  const savePair = (next: Assist) => {
    const stillVerified = !!next.toolsVerified && next.toolsVerified === chatVerifiedKey(next)
    save(stillVerified ? next : { ...next, toolsVerified: undefined, chat: false })
  }

  // Picking a provider for the assistant banks nothing and steals nothing: credentials come from that
  // provider's own slot, and a catalog provider's endpoint is seeded the way `pickProvider` seeds it.
  const pickChatProvider = (id: string) => {
    if (!id) {
      setDraft({ model: '', apiKey: '', baseUrl: '' })
      return savePair({ ...assist, chatProvider: undefined, chatWire: undefined, chatModel: undefined })
    }
    const banked = creds(id)
    const url = banked.baseUrl ?? (presetFor(id) ? undefined : catalog.get(id)?.api)
    const nextModel = optionsFor(id, catalog, null)[0]?.id ?? ''
    setDraft({ model: nextModel, apiKey: banked.apiKey ?? '', baseUrl: url ?? '' })
    savePair({
      ...assist,
      perProvider: { ...assist.perProvider, [id]: { apiKey: banked.apiKey, baseUrl: url } },
      chatProvider: id,
      chatWire: defFor(id, catalog)?.wire ?? 'openai',
      chatModel: nextModel,
    })
  }

  const saveCred = (field: 'apiKey' | 'baseUrl', value: string) => {
    const id = assist.chatProvider
    if (!id) return
    save({ ...assist, perProvider: { ...assist.perProvider, [id]: { ...creds(id), [field]: value || undefined } } })
  }

  const check = async () => {
    setProbing(true)
    setMsg('')
    const r = await probeToolCalling(assist)
    setProbing(false)
    setMsg(probeMessage(r, eff.model || 'this model'))
    if (r.kind === 'ok') save({ ...assist, toolsVerified: chatVerifiedKey(assist) })
    else if (verified) save({ ...assist, toolsVerified: undefined, chat: false })
  }

  return (
    <div style={{ borderTop: `1px solid ${HAIR}`, marginTop: 14, paddingTop: 12 }} data-testid="assistant-card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>Assistant</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            data-testid="assistant-probe"
            onClick={() => void check()}
            disabled={probing}
            style={{ fontSize: 11.5, color: MUT, background: 'none', border: `1px solid ${HAIR}`, borderRadius: 12, padding: '3px 12px', cursor: probing ? 'default' : 'pointer' }}
          >
            {probing ? 'Checking…' : 'Check tool calling'}
          </button>
          <button
            data-testid="assistant-chat-toggle"
            onClick={() => save({ ...assist, chat: !chatOn })}
            disabled={!verified}
            title={verified ? undefined : 'Check tool calling first'}
            className={verified ? 'hov-ink' : undefined}
            style={{
              fontSize: 11.5,
              color: !verified ? FAINT : chatOn ? ACCENT : FAINT,
              background: 'none',
              border: `1px solid ${HAIR}`,
              borderRadius: 12,
              padding: '3px 12px',
              cursor: verified ? 'pointer' : 'not-allowed',
              opacity: verified ? 1 : 0.55,
            }}
          >
            {chatOn ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: MUT, marginTop: 4, lineHeight: 1.5 }}>
        A chat panel that can read this vault and drive the app — open a screen, filter a list, build a comparison. It
        needs a model that supports tool calling.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
        <Row label="Access">
          <button
            data-testid="assistant-access"
            onClick={() => save({ ...assist, chatAccess: safe ? 'full' : 'safe' })}
            className="hov-ink"
            style={{
              fontSize: 11.5,
              color: safe ? GREEN : ACCENT,
              background: 'none',
              border: `1px solid ${HAIR}`,
              borderRadius: 12,
              padding: '3px 12px',
              cursor: 'pointer',
            }}
          >
            {safe ? 'Safe' : 'Full'}
          </button>
        </Row>
        <div data-testid="assistant-access-hint" style={{ fontSize: 11.5, color: MUT, marginTop: 6, lineHeight: 1.5 }}>
          {safe ? (
            <>
              Safe: the assistant sees what your accounts, categories, trips, budgets and goals are called, and how many
              transactions sit under each. It never sees an amount, a date, or a single transaction row; of a balance it
              learns only that one is on record. It can still explain how a screen worked its figure out, and open
              screens so you read the numbers here yourself. It can propose a budget or goal change using a figure you
              give it, and it cannot touch transactions at all.
            </>
          ) : (
            <>
              Full: nothing is sent until you ask something, and then the assistant fetches only what answering needs,
              which can include amounts, dates, merchants, and category and account names. Smart categorization above
              never sends an amount; this does. Account numbers and holder names are never sent by either.
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
        <Row label="Provider">
          <select
            data-testid="assistant-provider"
            value={assist.chatProvider ?? ''}
            onChange={(e) => pickChatProvider(e.target.value)}
            style={ctrl}
          >
            <option value="">Same as categorization</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
            {catalogProviders(catalog).length > 0 && (
              <optgroup label="models.dev catalog">
                {catalogProviders(catalog).map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </optgroup>
            )}
          </select>
        </Row>
        {/* Same two-control shape as the categorization row: a list to browse and a text box that holds
            the exact id. Empty means "whatever categorization uses", so the placeholder shows what that
            currently is rather than leaving the field looking unset. */}
        <Row label="Model">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
            {options.length > 0 && (
              <select
                data-testid="assistant-model-pick"
                value={options.some((o) => o.id === eff.model) ? eff.model : ''}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, model: e.target.value }))
                  savePair({ ...assist, chatModel: e.target.value })
                }}
                style={{ ...ctrl, maxWidth: 300 }}
              >
                <option value="" disabled>
                  Choose from {options.length}…
                </option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label ? `${o.id} — ${o.label}` : o.id}
                  </option>
                ))}
              </select>
            )}
            <input
              data-testid="assistant-model"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              onBlur={() => savePair({ ...assist, chatModel: draft.model || undefined })}
              placeholder={own ? 'model id' : assist.model || 'model id'}
              style={{ ...ctrl, fontFamily: MONO, fontSize: 11.5 }}
            />
          </div>
        </Row>
        {own && (assist.chatProvider === 'custom' || !presetFor(assist.chatProvider!) || !!draft.baseUrl) && (
          <Row label="Base URL">
            <input
              data-testid="assistant-baseurl"
              value={draft.baseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              onBlur={() => saveCred('baseUrl', draft.baseUrl)}
              placeholder="https://…"
              style={ctrl}
            />
          </Row>
        )}
        {own && !!presetFor(assist.chatProvider!) && !!draft.baseUrl && (
          <div data-testid="assistant-baseurl-warn" style={{ ...italicNote, marginTop: 6 }}>
            Requests for this preset go to a custom endpoint, not the provider&rsquo;s default. Clear the field to restore it.
          </div>
        )}
        {own && effDef?.needsKey !== false && (
          <Row label="API key">
            <input
              data-testid="assistant-key"
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              onBlur={() => saveCred('apiKey', draft.apiKey)}
              placeholder="sk-…"
              style={ctrl}
            />
          </Row>
        )}
      </div>

      {!verified && (
        <div data-testid="assistant-gate" style={{ fontSize: 11.5, color: MUT, marginTop: 8, lineHeight: 1.5 }}>
          Locked until <span style={{ fontFamily: MONO }}>{eff.model || 'a model'}</span> is confirmed to support tool
          calling.
        </div>
      )}

      {msg && (
        <div data-testid="assistant-probe-msg" style={{ fontSize: 11.5, color: verified ? GREEN : MUT, marginTop: 8, lineHeight: 1.5 }}>
          {msg}
        </div>
      )}
    </div>
  )
}

/** Provider definition for an id: a preset, else a catalog entry that publishes an endpoint. */
function defFor(id: string, catalog: Catalog): ProviderDef | undefined {
  const preset = presetFor(id)
  if (preset) return preset
  const entry = catalog.get(id)
  return entry ? toProviderDef(entry) : undefined
}

/** Catalog providers that carry an endpoint and aren't already a preset. */
function catalogProviders(catalog: Catalog) {
  return [...catalog.values()]
    .filter((p) => p.api && !presetFor(p.id))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Datalist entries: a live local list when one was detected, else the catalog's models. */
function optionsFor(provider: string, catalog: Catalog, localModels: string[] | null): { id: string; label: string }[] {
  if (localModels && presetFor(provider)?.local) return localModels.map((id) => ({ id, label: 'local' }))
  const models: CatalogModel[] = catalog.get(provider)?.models ?? []
  return models.map((m) => ({ id: m.id, label: modelLabel(m) }))
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', ...hairBottom }}>
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  )
}

const ctrl = { fontSize: 12.5, padding: '6px 9px', border: `1px solid ${HAIR}`, borderRadius: 5, background: 'var(--surface)', color: INK, minWidth: 180 }

const reloadBtn = (busy: boolean) => ({
  width: 28,
  height: 28,
  flexShrink: 0,
  border: `1px solid ${HAIR}`,
  borderRadius: 5,
  background: 'var(--surface)',
  color: busy ? FAINT : MUT,
  fontSize: 13,
  lineHeight: 1,
  cursor: busy ? 'default' : 'pointer',
})
