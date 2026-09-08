import { net } from 'electron'
import { deduplicate, ExpiringCache } from './cache'
import type { ChatBadge } from '../shared/types'
import { mergeTwitchBadges, parseTwitchBadges } from './twitch-badges-parse'
import { fail } from '../shared/errors'

export interface BadgeAuth { token: string; clientId: string }

type Cached = { expires: number; value: ChatBadge[] }
// Twitch's own sets change about never; a channel's subscriber tiers change with its stream.
const GLOBAL_TTL = 6 * 60 * 60_000
const CHANNEL_TTL = 30 * 60_000
// An empty answer is usually a transient failure: it must not leave a room in text for hours.
const EMPTY_TTL = 60_000
let globalCache: Cached | undefined
/** One entry per channel whose badges were read, bounded and deduplicated as the emotes are. */
const channelCache = new ExpiringCache<ChatBadge[]>(100)
const channelInFlight = new Map<string, Promise<ChatBadge[]>>()

async function helix(path: string, { token, clientId }: BadgeAuth): Promise<unknown> {
  const response = await net.fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    signal: AbortSignal.timeout(8000)
  })
  if (response.status === 401) fail('badgesSessionExpired')
  if (!response.ok) fail('badgesUnavailable', response.status)
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) fail('badgesTooLarge')
  return JSON.parse(text)
}

async function globals(auth: BadgeAuth): Promise<ChatBadge[]> {
  if (globalCache && globalCache.expires > Date.now()) return globalCache.value
  const value = parseTwitchBadges(await helix('chat/badges/global', auth))
  globalCache = { value, expires: Date.now() + (value.length ? GLOBAL_TTL : EMPTY_TTL) }
  return value
}

async function channel(roomId: string, auth: BadgeAuth): Promise<ChatBadge[]> {
  const cached = channelCache.get(roomId)
  if (cached) return cached
  return deduplicate(channelInFlight, roomId, async () => {
    const value = parseTwitchBadges(await helix(`chat/badges?broadcaster_id=${encodeURIComponent(roomId)}`, auth))
    return channelCache.set(roomId, value, value.length ? CHANNEL_TTL : EMPTY_TTL)
  })
}

/**
 * The badges of a room: Twitch's sets, then the channel's own over them. The channel endpoint
 * answers with what belongs to the channel alone — its subscriber tiers, its bits — so this is a
 * union, and the overlap is exactly the point: a subscriber badge is the channel's before it is
 * Twitch's. One side failing does not cost the other, as for the emotes: a moderator's sword is
 * worth showing even when the channel's own sets are out of reach.
 */
export async function getTwitchBadges(roomId: string, auth: BadgeAuth): Promise<ChatBadge[]> {
  const [global, local] = await Promise.allSettled([globals(auth), channel(roomId, auth)])
  if (global.status === 'rejected' && local.status === 'rejected') throw global.reason
  return mergeTwitchBadges(
    global.status === 'fulfilled' ? global.value : [],
    local.status === 'fulfilled' ? local.value : []
  )
}
