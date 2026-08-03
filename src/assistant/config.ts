// The assistant's own provider config and access level (ASSISTANT §2.1, §2.2).
//
// `settings.assist` holds one provider/model pair, chosen for Smart categorization. The assistant may
// override it. Rather than teach every resolver about a second config, this resolves the override into
// an ordinary `Assist` value: `wireOf`, `endpointsFor`, `authHeaders`, `needsKey`, `presetFor` and
// `maxTokensField` keep working unchanged, and so does the categorization path, which never calls this.
import type { Settings } from '../model/types'

type Assist = NonNullable<Settings['assist']>

/** How much of the vault the assistant may read. */
export type Access = 'safe' | 'full'

/**
 * Absent ⇒ 'safe'. Only the exact string 'full' opens the vault, so a malformed or half-written
 * value fails closed rather than granting access.
 */
export const chatAccess = (assist: Assist | undefined): Access => (assist?.chatAccess === 'full' ? 'full' : 'safe')

/**
 * The assistant's effective provider config.
 *
 * With no `chatProvider` the categorization config is returned as-is (with `chatModel` swapped in if
 * set) — same provider, same key, same base URL. With one, the credentials come from that provider's
 * own slot in `perProvider`, never from the active provider's: carrying a key across would send one
 * provider's secret to another's endpoint. `wire` is left possibly-undefined on purpose, because
 * `wireOf` already resolves it from the provider id.
 */
export function chatAssist(assist: Assist): Assist {
  if (!assist.chatProvider) return assist.chatModel ? { ...assist, model: assist.chatModel } : assist
  const creds = assist.perProvider?.[assist.chatProvider] ?? {}
  return {
    ...assist,
    provider: assist.chatProvider,
    wire: assist.chatWire,
    baseUrl: creds.baseUrl,
    model: assist.chatModel ?? '',
    apiKey: creds.apiKey ?? '',
  }
}
