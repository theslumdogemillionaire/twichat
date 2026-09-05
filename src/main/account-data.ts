import { fail, type ErrorKey } from '../shared/errors'
import type { FollowedChannels, StreamSummary } from '../shared/types'

/** Both lists are cheap to redraw and expensive to fetch: a minute is the compromise. */
const TTL = 60_000

export interface AccountSession {
  token: string | null; clientId: string | null; userId: string | null
  /** Whether the token carries `user:read:follows`, as the validation listed it. */
  follows: boolean
  generation: number
}

export interface AccountDataParts {
  /** Read afresh on every call: the generation it carries is what the answer is checked against. */
  session(): AccountSession
  streams(token: string, clientId: string, language: string): Promise<StreamSummary[]>
  followed(userId: string, auth: { token: string; clientId: string }): Promise<FollowedChannels>
  now?(): number
}

/**
 * The two lists that belong to an account rather than to a channel: what Twitch is streaming in
 * a language, and what the account follows.
 *
 * They live in a module of their own because of the wait in the middle. A list asked for by one
 * account can come back after another has signed in — the caches are emptied on that change, and
 * a late answer used to refill them with somebody else's channels, then hand them to the window
 * as if they were the new account's. The generation taken before the call is compared after it,
 * and an answer that no longer belongs is dropped rather than kept.
 */
export function createAccountData(parts: AccountDataParts) {
  const clock = parts.now ?? Date.now
  const streamsByLanguage = new Map<string, { expires: number; value: StreamSummary[] }>()
  let followedList: { expires: number; value: FollowedChannels } | null = null

  function authenticated(missing: ErrorKey) {
    const { token, clientId, userId, follows, generation } = parts.session()
    if (!token || !clientId) fail(missing)
    return { token, clientId, userId, follows, generation }
  }

  return {
    async streams(language: string, refresh: boolean): Promise<StreamSummary[]> {
      const session = authenticated('needAccountForDiscover')
      // Read before any wait: serving from cache must not introduce one.
      const cached = streamsByLanguage.get(language)
      if (!refresh && cached && cached.expires > clock()) return cached.value
      const value = await parts.streams(session.token, session.clientId, language)
      if (parts.session().generation !== session.generation) fail('authCancelled')
      streamsByLanguage.set(language, { value, expires: clock() + TTL })
      return value
    },

    async followed(refresh: boolean): Promise<FollowedChannels> {
      const session = authenticated('twitchFollowedReconnect')
      if (!refresh && followedList && followedList.expires > clock()) return followedList.value
      // A session opened before this view existed was granted chat and nothing else. Twitch turns
      // those two calls down with a 401 — the same status as a dead token — so the scope is read
      // where it is stated: asking anyway would cost a round trip to be told "session expired"
      // about a session that is very much alive. Below the cache on purpose: a renewal that came
      // back without the scope must not blank a list that is still good for another minute.
      if (!session.follows) fail('twitchFollowedScope')
      const value = await parts.followed(session.userId ?? '', { token: session.token, clientId: session.clientId })
      if (parts.session().generation !== session.generation) fail('authCancelled')
      followedList = { value, expires: clock() + TTL }
      return value
    },

    /** Everything the outgoing account owned: emptied on sign-in, sign-out and window teardown. */
    clear() {
      streamsByLanguage.clear()
      followedList = null
    }
  }
}
