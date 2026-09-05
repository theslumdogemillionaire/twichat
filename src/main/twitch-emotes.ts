import { net } from 'electron'
import { deduplicate, ExpiringCache } from './cache'
import type { TwitchEmote } from '../shared/types'
import { mergeTwitchEmotes, parseTwitchEmotes } from './twitch-emotes-parse'
import { fail } from '../shared/errors'

export interface EmoteAuth { token: string; clientId: string }

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

/** Returns whatever Twitch answered: one failing scope must not hide the other. */
export async function getTwitchEmotes(roomId: string, auth: EmoteAuth): Promise<TwitchEmote[]> {
  const [global, local] = await Promise.allSettled([globals(auth), channel(roomId, auth)])
  if (global.status === 'rejected' && local.status === 'rejected') throw global.reason
  return mergeTwitchEmotes(
    global.status === 'fulfilled' ? global.value : [],
    local.status === 'fulfilled' ? local.value : []
  )
}
