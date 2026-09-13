import { net } from 'electron'
import { deduplicate, ExpiringCache } from './cache'
import type { TwitchEmote } from '../shared/types'
import { mergeTwitchEmotes, parseTwitchEmotes, parseUserEmotes } from './twitch-emotes-parse'
import { fail } from '../shared/errors'

export interface EmoteAuth {
  token: string
  clientId: string
  /** The signed-in account's own id. Empty for an anonymous session: it asks for no set of its own. */
  userId?: string
  /** Whether the token carries `user:read:emotes`, as the validation listed it. */
  emotes?: boolean
}

type Cached = { expires: number; value: TwitchEmote[] }
const GLOBAL_TTL = 60 * 60_000
const CHANNEL_TTL = 15 * 60_000
// An empty answer is usually a transient failure: it must not silence the picker for an hour.
const EMPTY_TTL = 60_000
let globalCache: Cached | undefined
/**
 * One entry per channel whose emotes were read. Bounded, and deduplicated: joining a room asks
 * for its emotes while the previous repaint's request may still be out.
 */
const channelCache = new ExpiringCache<TwitchEmote[]>(100)
const channelInFlight = new Map<string, Promise<TwitchEmote[]>>()

/** A subscription bought mid-session should show up without a restart, and rarely does. */
const ACCOUNT_TTL = 15 * 60_000
/** Twitch's own page ceiling, and enough pages for an account subscribed to far more channels than it can watch. */
const ACCOUNT_PAGE = 100
const ACCOUNT_PAGES = 25
/**
 * The emotes the account carries, whatever channel it earned them in.
 *
 * Unlike the two caches above, this one is **the viewer's**, so it cannot be keyed by room and
 * left alone across an account change: the sets a channel publishes belong to Twitch and look the
 * same to everybody, while these are exactly what tells one account from another. It is keyed by
 * the account id and emptied outright on every sign-in and sign-out — `forgetUserEmotes`, called
 * from the session — because a key alone only avoids serving the wrong set, and what is wanted is
 * not keeping it at all.
 */
let accountCache: { userId: string; expires: number; value: TwitchEmote[] } | undefined
const accountInFlight = new Map<string, Promise<TwitchEmote[]>>()

async function helix(path: string, { token, clientId }: EmoteAuth): Promise<unknown> {
  const response = await net.fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    signal: AbortSignal.timeout(8000)
  })
  if (response.status === 401) fail('emotesSessionExpired')
  if (!response.ok) throw new Error(`Emotes Twitch indisponibles (${response.status}).`)
  const text = await response.text()
  if (text.length > 4 * 1024 * 1024) fail('emotesTooLarge')
  return JSON.parse(text)
}

async function globals(auth: EmoteAuth): Promise<TwitchEmote[]> {
  if (globalCache && globalCache.expires > Date.now()) return globalCache.value
  const value = parseTwitchEmotes(await helix('chat/emotes/global', auth), 'global')
  globalCache = { value, expires: Date.now() + (value.length ? GLOBAL_TTL : EMPTY_TTL) }
  return value
}

async function channel(roomId: string, auth: EmoteAuth): Promise<TwitchEmote[]> {
  const cached = channelCache.get(roomId)
  if (cached) return cached
  return deduplicate(channelInFlight, roomId, async () => {
    const value = parseTwitchEmotes(await helix(`chat/emotes?broadcaster_id=${encodeURIComponent(roomId)}`, auth), 'channel')
    return channelCache.set(roomId, value, value.length ? CHANNEL_TTL : EMPTY_TTL)
  })
}

/**
 * Everything the account may type, read page by page.
 *
 * The endpoint also takes a `broadcaster_id`, which guarantees that channel's follower emotes are
 * in the answer. It is not passed: this set is cached for the account and read from every room, so
 * a hint belonging to whichever room asked first would decide what the others see. Nothing is lost
 * by leaving it out — a room's own follower emotes are in the set the channel endpoint answers with.
 */
async function account(userId: string, auth: EmoteAuth): Promise<TwitchEmote[]> {
  if (accountCache && accountCache.userId === userId && accountCache.expires > Date.now()) return accountCache.value
  return deduplicate(accountInFlight, userId, async () => {
    const pages: TwitchEmote[][] = []
    let cursor = ''
    for (let page = 0; page < ACCOUNT_PAGES; page++) {
      const query = new URLSearchParams({ user_id: userId, first: String(ACCOUNT_PAGE) })
      if (cursor) query.set('after', cursor)
      const answer = parseUserEmotes(await helix(`chat/emotes/user?${query}`, auth))
      pages.push(answer.emotes)
      // The last page comes with an empty pagination object. A page that answers the cursor it was
      // given is not a last page but a stuck one, and walking it again would only ask for it again;
      // the ceiling above would end that eventually, this ends it at once. An empty page is not
      // read as the end — every entry on it may simply have failed validation.
      if (!answer.cursor || answer.cursor === cursor) break
      cursor = answer.cursor
    }
    const value = mergeTwitchEmotes(...pages)
    // Written under the id it was read for, and read back only under that same id. Twenty-five
    // pages take long enough for an account to change underneath them, and the emptying done at
    // that moment cannot reach a request still in flight: this is what stops its answer from
    // landing in the next account's picker.
    accountCache = { userId, expires: Date.now() + (value.length ? ACCOUNT_TTL : EMPTY_TTL), value }
    return value
  })
}

/** The account changed: what it carried is not the next one's to inherit. */
export function forgetUserEmotes() {
  accountCache = undefined
  accountInFlight.clear()
}

/** Returns whatever Twitch answered: one failing scope must not hide the other. */
/** Twitch's own global set, for a body that belongs to no channel. See the third-party twin. */
export async function getGlobalTwitchEmotes(auth: EmoteAuth): Promise<TwitchEmote[]> { return globals(auth) }

export async function getTwitchEmotes(roomId: string, auth: EmoteAuth): Promise<TwitchEmote[]> {
  // Twitch answers `chat/emotes/user` with a 401 — not a 403 — to a token that was never granted
  // `user:read:emotes`, which is the same status a dead session gets. So the scope is read where
  // the validation stated it rather than guessed from a refusal, exactly as the followed channels
  // do: asking anyway would cost a round trip to be told "session expired" about a live session.
  const mine = auth.emotes && auth.userId ? account(auth.userId, auth) : null
  const [global, own, local] = await Promise.allSettled([globals(auth), mine ?? Promise.resolve([]), channel(roomId, auth)])
  if (global.status === 'rejected' && local.status === 'rejected') throw global.reason
  // The room's own set goes last, over the account's. The overlap is every emote of this channel
  // the account is subscribed to, and those belong under the channel where the person is writing —
  // what the account's set is here for is the other channels, whose emotes nothing else carries.
  return mergeTwitchEmotes(
    global.status === 'fulfilled' ? global.value : [],
    own.status === 'fulfilled' ? own.value : [],
    local.status === 'fulfilled' ? local.value : []
  )
}
