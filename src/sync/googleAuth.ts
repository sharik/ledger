import { KV } from '../persist/idb'
import { RemoteAuthError, RemoteTransientError } from './adapter'

/**
 * Google OAuth for a browser-only app: authorization code + PKCE with
 * `access_type=offline`, so we get a refresh token and the user is not sent
 * back to a consent popup every hour. The implicit/token flow would be simpler
 * but yields a 1-hour token with no refresh, and its silent-renewal iframe is
 * blocked by Safari — on exactly the phones this adapter exists to serve.
 *
 * The client secret travels in the bundle. That is Google's documented posture
 * for clients that cannot keep one; it is not a credential on its own, and the
 * grant it can produce reaches nothing but the `drive.file` files this app
 * created.
 */

const TOKEN_KEY = 'sync.gdriveToken'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/** Refresh with this much life left, so a push never dies mid-flight (SYNC §6.4). */
const PRE_REFRESH_MS = 10 * 60 * 1000

export interface GoogleToken {
  accessToken: string
  refreshToken?: string
  /** epoch ms */
  expiresAt: number
}

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
}

export interface GoogleAuthDeps {
  fetch?: typeof fetch
  now?: () => number
  /** Opens the consent screen; resolves the redirect's query string, or null if the user closed it. */
  openConsent?: (url: string) => Promise<string | null>
  redirectUri?: () => string
}

/** Build credentials, or null when this build has none — then Drive is simply not offered. */
export function googleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** The user closed the consent popup — a no-op, not an error (cf. AbortError on file pickers). */
export class GoogleAuthCancelled extends Error {
  constructor() {
    super('sign-in cancelled')
    this.name = 'GoogleAuthCancelled'
  }
}

export class GoogleAuth {
  private token: GoogleToken | null | undefined // undefined = not yet loaded from L1
  private inFlight: Promise<string> | null = null
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly openConsent: (url: string) => Promise<string | null>
  private readonly redirectUri: () => string

  constructor(
    private kv: KV,
    private config: GoogleOAuthConfig,
    deps: GoogleAuthDeps = {},
  ) {
    this.fetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
    this.now = deps.now ?? (() => Date.now())
    this.openConsent = deps.openConsent ?? openConsentPopup
    this.redirectUri = deps.redirectUri ?? redirectUri
  }

  /** Is a grant stored at all? (It may still be expired — that's `getAccessToken`'s problem.) */
  async connected(): Promise<boolean> {
    return (await this.load()) !== null
  }

  /** Full consent round-trip. Must be called from a user gesture — it opens a popup. */
  async authorize(): Promise<void> {
    const session = await createPkceSession()
    const url = buildUrl(AUTH_URL, {
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      // Without this, a user who has consented before is sent back an access
      // token and no refresh token, and the whole flow degrades to implicit.
      prompt: 'consent',
      state: session.state,
      code_challenge: session.challenge,
      code_challenge_method: 'S256',
    })

    const search = await this.openConsent(url)
    if (search === null) throw new GoogleAuthCancelled()

    const params = new URLSearchParams(search)
    if (params.get('error')) throw new RemoteAuthError()
    // The state nonce is what stops a third party from feeding us their code.
    if (params.get('state') !== session.state) throw new RemoteAuthError()
    const code = params.get('code')
    if (!code) throw new RemoteAuthError()

    await this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: session.verifier,
    })
  }

  /**
   * A usable access token, refreshing ahead of expiry. Throws RemoteAuthError
   * when only the user can fix it (engine → REAUTH_NEEDED) and
   * RemoteTransientError when the network is at fault (engine → ERROR_BACKOFF).
   */
  getAccessToken(): Promise<string> {
    // Single-flight: a focus poll and a push can both land here at once, and two
    // parallel refreshes would race to invalidate each other's token.
    this.inFlight ??= this.resolveToken().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async resolveToken(): Promise<string> {
    const token = await this.load()
    if (!token) throw new RemoteAuthError()
    if (token.expiresAt - this.now() > PRE_REFRESH_MS) return token.accessToken
    if (!token.refreshToken) throw new RemoteAuthError()
    await this.exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken })
    return (await this.load())!.accessToken
  }

  async revoke(): Promise<void> {
    const token = await this.load()
    if (token) {
      try {
        await this.fetch(buildUrl(REVOKE_URL, { token: token.refreshToken ?? token.accessToken }), { method: 'POST' })
      } catch {
        // Best effort. Dropping our copy is what actually matters here.
      }
    }
    this.token = null
    await this.kv.delete(TOKEN_KEY)
  }

  private async load(): Promise<GoogleToken | null> {
    if (this.token === undefined) this.token = (await this.kv.get<GoogleToken>(TOKEN_KEY)) ?? null
    return this.token
  }

  /** POST to the token endpoint and store what comes back. */
  private async exchange(body: Record<string, string>): Promise<void> {
    let res: Response
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...body,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }).toString(),
      })
    } catch (e) {
      throw new RemoteTransientError(String(e))
    }

    if (!res.ok) {
      // 4xx means the grant itself is dead (revoked, expired refresh token):
      // drop it so we ask for consent rather than retrying a doomed refresh.
      if (res.status >= 400 && res.status < 500) {
        this.token = null
        await this.kv.delete(TOKEN_KEY)
        throw new RemoteAuthError()
      }
      throw new RemoteTransientError(`token endpoint ${res.status}`)
    }

    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token) throw new RemoteAuthError()

    const token: GoogleToken = {
      accessToken: data.access_token,
      // A refresh response omits the refresh token; keep the one we already hold.
      refreshToken: data.refresh_token ?? (await this.load())?.refreshToken,
      expiresAt: this.now() + (data.expires_in ?? 3600) * 1000,
    }
    this.token = token
    await this.kv.put(TOKEN_KEY, token)
  }
}

/** Same-origin static page registered as the OAuth redirect URI. */
export function redirectUri(): string {
  return new URL('oauth-result/gdrive.html', location.href).href
}

function buildUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.href
}

interface PkceSession {
  state: string
  verifier: string
  challenge: string
}

async function createPkceSession(): Promise<PkceSession> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return {
    state: base64url(crypto.getRandomValues(new Uint8Array(16))),
    verifier,
    challenge: base64url(new Uint8Array(digest)),
  }
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Consent in a popup; `public/oauth-result/gdrive.html` posts the query string
 * back before it closes. Posting first is deliberate — iOS Safari in standalone
 * mode refuses to close the popup, and we still get the code.
 */
function openConsentPopup(url: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'ledger-gdrive-oauth', 'width=600,height=700,menubar=no,toolbar=no')
    if (!popup) return reject(new RemoteAuthError())

    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      clearInterval(closedPoll)
      try {
        popup.close()
      } catch {
        // Already gone, or a browser that won't let us.
      }
      resolve(value)
    }

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return
      const data = e.data as { storage?: string; search?: string } | null
      if (!data || data.storage !== 'gdrive' || typeof data.search !== 'string') return
      finish(data.search)
    }
    window.addEventListener('message', onMessage)

    const closedPoll = setInterval(() => {
      if (popup.closed) finish(null)
    }, 500)
  })
}
