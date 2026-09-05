import { net } from 'electron'
import { deduplicate, ExpiringCache } from './cache'
import type { ThirdPartyEmote } from '../shared/types'
import { mergeThirdPartyEmotes, parseBetterTtv, parseFrankerFaceZ, parseSevenTv } from './third-party-emotes-parse'
import { fail } from '../shared/errors'

type Cached = { expires: number; value: ThirdPartyEmote[] }
let globalCache: Cached | undefined
/** Bounded per room, and deduplicated: four providers are asked for one room at once. */
const roomCache = new ExpiringCache<ThirdPartyEmote[]>(100)
const roomInFlight = new Map<string, Promise<ThirdPartyEmote[]>>()

async function json(url: string): Promise<unknown> {
  const response = await net.fetch(url, {
    headers: { 'User-Agent': 'Twichat/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(7000)
  })
  if (!response.ok) fail('emotesUnavailable', response.status)
  const declared = Number(response.headers.get('Content-Length') ?? 0)
  if (declared > 8 * 1024 * 1024) fail('emotePackTooLarge')
  const text = await response.text()
  if (text.length > 8 * 1024 * 1024) fail('emotePackTooLarge')
  return JSON.parse(text)
}

async function settled(requests: Array<Promise<ThirdPartyEmote[]>>): Promise<ThirdPartyEmote[][]> {
  return (await Promise.allSettled(requests)).map(result => result.status === 'fulfilled' ? result.value : [])
}

async function globals(): Promise<ThirdPartyEmote[]> {
  if (globalCache && globalCache.expires > Date.now()) return globalCache.value
  const [ffz, bttv, sevenTv] = await settled([
    json('https://api.frankerfacez.com/v1/set/global').then(value => parseFrankerFaceZ(value, true)),
    json('https://api.betterttv.net/3/cached/emotes/global').then(parseBetterTtv),
    json('https://7tv.io/v3/emote-sets/global').then(parseSevenTv)
  ])
  const value = mergeThirdPartyEmotes(ffz, bttv, sevenTv)
  // An empty answer is usually a transient failure: it must not silence the picker for an hour.
  globalCache = { value, expires: Date.now() + (value.length ? 60 * 60_000 : 60_000) }
  return value
}

async function room(channel: string, roomId: string): Promise<ThirdPartyEmote[]> {
  const key = `${channel}:${roomId}`
  const cached = roomCache.get(key)
  if (cached) return cached
  return deduplicate(roomInFlight, key, async () => {
    const [ffz, bttv, sevenTv] = await settled([
      json(`https://api.frankerfacez.com/v1/room/id/${roomId}`).then(value => parseFrankerFaceZ(value)),
      json(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`).then(parseBetterTtv),
      json(`https://7tv.io/v3/users/twitch/${roomId}`).then(parseSevenTv)
    ])
    const value = mergeThirdPartyEmotes(ffz, bttv, sevenTv)
    return roomCache.set(key, value, value.length ? 15 * 60_000 : 60_000)
  })
}

export async function getThirdPartyEmotes(channel: string, roomId: string): Promise<ThirdPartyEmote[]> {
  const [global, local] = await Promise.all([globals(), room(channel, roomId)])
  // Repeat provider priority after combining both scopes: local packs always win.
  return mergeThirdPartyEmotes(global, local)
}
