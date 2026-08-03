import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { KV } from '../src/persist/idb'
import { RemoteAuthError, RemoteTransientError } from '../src/sync/adapter'
import { GoogleAuth, GoogleAuthCancelled, type GoogleAuthDeps, type GoogleToken } from '../src/sync/googleAuth'

const CONFIG = { clientId: 'cid', clientSecret: 'csecret' }
const HOUR = 3600_000

let dbn = 0
const freshKv = () => KV.open(`auth-${dbn++}-${Math.random().toString(36).slice(2)}`)

/** A token endpoint that records what it was asked and answers from a queue. */
function tokenEndpoint(responses: { status: number; body: unknown }[]) {
  const calls: URLSearchParams[] = []
  const fetchFn = (async (_url, init) => {
    calls.push(new URLSearchParams(String(init?.body)))
    const r = responses.shift() ?? { status: 500, body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as typeof fetch
  return { calls, fetchFn }
}

async function authWith(token: GoogleToken | null, deps: GoogleAuthDeps, now = 1_000_000) {
  const kv = await freshKv()
  if (token) await kv.put('sync.gdriveToken', token)
  return new GoogleAuth(kv, CONFIG, { now: () => now, redirectUri: () => 'https://app.test/oauth-result/gdrive.html', ...deps })
}

describe('getAccessToken', () => {
  it('returns the stored token untouched while it has life left', async () => {
    const { calls, fetchFn } = tokenEndpoint([])
    const auth = await authWith({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + HOUR }, { fetch: fetchFn })

    expect(await auth.getAccessToken()).toBe('at')
    expect(calls).toHaveLength(0)
  })

  it('refreshes ahead of expiry so a push never dies mid-flight (SYNC §6.4)', async () => {
    const { calls, fetchFn } = tokenEndpoint([{ status: 200, body: { access_token: 'fresh', expires_in: 3600 } }])
    // 9 minutes left — inside the 10-minute pre-refresh window.
    const auth = await authWith({ accessToken: 'stale', refreshToken: 'rt', expiresAt: 1_000_000 + 9 * 60_000 }, { fetch: fetchFn })

    expect(await auth.getAccessToken()).toBe('fresh')
    expect(calls[0]?.get('grant_type')).toBe('refresh_token')
    expect(calls[0]?.get('refresh_token')).toBe('rt')
    // The secret is what makes a browser client eligible for a refresh token at all.
    expect(calls[0]?.get('client_secret')).toBe('csecret')
  })

  it('keeps the refresh token across a refresh, since Google omits it in the response', async () => {
    const { fetchFn } = tokenEndpoint([{ status: 200, body: { access_token: 'fresh', expires_in: 3600 } }])
    const kv = await freshKv()
    await kv.put('sync.gdriveToken', { accessToken: 'stale', refreshToken: 'rt', expiresAt: 0 })
    const auth = new GoogleAuth(kv, CONFIG, { now: () => 1_000_000, fetch: fetchFn })

    await auth.getAccessToken()
    expect((await kv.get<GoogleToken>('sync.gdriveToken'))?.refreshToken).toBe('rt')
  })

  it('drops a dead grant on 4xx and asks for consent instead of retrying it', async () => {
    const { fetchFn } = tokenEndpoint([{ status: 400, body: { error: 'invalid_grant' } }])
    const kv = await freshKv()
    await kv.put('sync.gdriveToken', { accessToken: 'stale', refreshToken: 'revoked', expiresAt: 0 })
    const auth = new GoogleAuth(kv, CONFIG, { now: () => 1_000_000, fetch: fetchFn })

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RemoteAuthError)
    expect(await kv.get('sync.gdriveToken')).toBeUndefined()
    expect(await auth.connected()).toBe(false)
  })

  it('keeps the grant when the token endpoint is merely down', async () => {
    const { fetchFn } = tokenEndpoint([{ status: 503, body: {} }])
    const kv = await freshKv()
    await kv.put('sync.gdriveToken', { accessToken: 'stale', refreshToken: 'rt', expiresAt: 0 })
    const auth = new GoogleAuth(kv, CONFIG, { now: () => 1_000_000, fetch: fetchFn })

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RemoteTransientError)
    expect(await kv.get('sync.gdriveToken')).toBeDefined()
  })

  it('a network throw is transient, not an auth problem', async () => {
    const auth = await authWith(
      { accessToken: 'stale', refreshToken: 'rt', expiresAt: 0 },
      {
        fetch: (async () => {
          throw new TypeError('failed to fetch')
        }) as typeof fetch,
      },
    )
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RemoteTransientError)
  })

  it('with nothing stored, asks for re-auth', async () => {
    const auth = await authWith(null, {})
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(RemoteAuthError)
  })

  it('refreshes once when a poll and a push both ask at the same moment', async () => {
    const { calls, fetchFn } = tokenEndpoint([{ status: 200, body: { access_token: 'fresh', expires_in: 3600 } }])
    const auth = await authWith({ accessToken: 'stale', refreshToken: 'rt', expiresAt: 0 }, { fetch: fetchFn })

    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])
    expect([a, b]).toEqual(['fresh', 'fresh'])
    expect(calls).toHaveLength(1)
  })
})

describe('authorize', () => {
  it('exchanges the code with the PKCE verifier and stores the grant', async () => {
    const { calls, fetchFn } = tokenEndpoint([
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    ])
    let consentUrl = ''
    const kv = await freshKv()
    const auth = new GoogleAuth(kv, CONFIG, {
      now: () => 1_000_000,
      fetch: fetchFn,
      redirectUri: () => 'https://app.test/oauth-result/gdrive.html',
      openConsent: async (url) => {
        consentUrl = url
        return `?code=abc&state=${new URL(url).searchParams.get('state')}`
      },
    })

    await auth.authorize()

    const sent = new URL(consentUrl).searchParams
    expect(sent.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
    expect(sent.get('code_challenge_method')).toBe('S256')
    // Without access_type=offline + prompt=consent there is no refresh token,
    // and the flow silently degrades to a one-hour implicit grant.
    expect(sent.get('access_type')).toBe('offline')
    expect(sent.get('prompt')).toBe('consent')

    expect(calls[0]?.get('grant_type')).toBe('authorization_code')
    expect(calls[0]?.get('code_verifier')).toBeTruthy()
    expect((await kv.get<GoogleToken>('sync.gdriveToken'))?.refreshToken).toBe('rt')
  })

  it('refuses a code that comes back under the wrong state', async () => {
    const { calls, fetchFn } = tokenEndpoint([])
    const auth = await authWith(null, {
      fetch: fetchFn,
      openConsent: async () => '?code=abc&state=not-the-one-we-sent',
    })

    await expect(auth.authorize()).rejects.toBeInstanceOf(RemoteAuthError)
    expect(calls).toHaveLength(0)
  })

  it('reports a closed popup as a cancellation, not a failure', async () => {
    const auth = await authWith(null, { openConsent: async () => null })
    await expect(auth.authorize()).rejects.toBeInstanceOf(GoogleAuthCancelled)
  })

  it('surfaces a denied consent as an auth error', async () => {
    const auth = await authWith(null, { openConsent: async () => '?error=access_denied' })
    await expect(auth.authorize()).rejects.toBeInstanceOf(RemoteAuthError)
  })
})

describe('revoke', () => {
  it('drops the local grant even if Google cannot be reached', async () => {
    const kv = await freshKv()
    await kv.put('sync.gdriveToken', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + HOUR })
    const auth = new GoogleAuth(kv, CONFIG, {
      fetch: (async () => {
        throw new TypeError('offline')
      }) as typeof fetch,
    })

    await auth.revoke()
    expect(await kv.get('sync.gdriveToken')).toBeUndefined()
    expect(await auth.connected()).toBe(false)
  })
})
