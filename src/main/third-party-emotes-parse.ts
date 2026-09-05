import type { EmoteSource, ThirdPartyEmote } from '../shared/types'

type JsonObject = Record<string, unknown>

const CODE = /^\S{1,64}$/u
const HOSTS: Record<EmoteSource, string> = {
  '7tv': 'cdn.7tv.app',
  bttv: 'cdn.betterttv.net',
  ffz: 'cdn.frankerfacez.com'
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function imageUrl(raw: unknown, source: EmoteSource): string {
  if (typeof raw !== 'string' || raw.length > 1000) return ''
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (url.protocol !== 'https:' || url.hostname !== HOSTS[source] || url.username || url.password || url.port) return ''
    return url.href
  } catch { return '' }
}

function emote(code: unknown, url: unknown, source: EmoteSource, animated = false): ThirdPartyEmote | undefined {
  const safeUrl = imageUrl(url, source)
  if (typeof code !== 'string' || !CODE.test(code) || !safeUrl) return undefined
  return { code, url: safeUrl, source, animated }
}

export function parseSevenTv(payload: unknown): ThirdPartyEmote[] {
  const root = object(payload)
  const set = object(root?.emote_set) ?? root
  const values = Array.isArray(set?.emotes) ? set.emotes : []
  const result: ThirdPartyEmote[] = []
  for (const value of values.slice(0, 2000)) {
    const item = object(value); const data = object(item?.data); const host = object(data?.host)
    const files = Array.isArray(host?.files) ? host.files.map(object).filter(Boolean) as JsonObject[] : []
    const preferred = files.find(file => file.name === '2x.webp') ?? files.find(file => file.name === '1x.webp') ?? files[0]
    const base = typeof host?.url === 'string' ? host.url.replace(/\/$/, '') : ''
    const parsed = emote(item?.name, preferred && typeof preferred.name === 'string' ? `${base}/${preferred.name}` : '', '7tv', data?.animated === true)
    if (parsed) result.push(parsed)
  }
  return result
}

export function parseBetterTtv(payload: unknown): ThirdPartyEmote[] {
  const root = object(payload)
  const values = Array.isArray(payload) ? payload : [
    ...(Array.isArray(root?.channelEmotes) ? root.channelEmotes : []),
    ...(Array.isArray(root?.sharedEmotes) ? root.sharedEmotes : [])
  ]
  const result: ThirdPartyEmote[] = []
  for (const value of values.slice(0, 2000)) {
    const item = object(value)
    const parsed = emote(item?.code, typeof item?.id === 'string' ? `https://cdn.betterttv.net/emote/${encodeURIComponent(item.id)}/2x` : '', 'bttv', item?.animated === true || item?.imageType === 'gif')
    if (parsed) result.push(parsed)
  }
  return result
}

export function parseFrankerFaceZ(payload: unknown, global = false): ThirdPartyEmote[] {
  const root = object(payload); const sets = object(root?.sets) ?? {}
  const defaults = global && Array.isArray(root?.default_sets) ? new Set(root.default_sets.map(String)) : undefined
  const result: ThirdPartyEmote[] = []
  for (const [setId, rawSet] of Object.entries(sets)) {
    if (defaults && !defaults.has(setId)) continue
    const values = object(rawSet)?.emoticons
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (result.length >= 2000) return result
      const item = object(value); const urls = object(item?.urls); const moving = object(item?.animated)
      // FrankerFaceZ serves animated files under a separate map; without it the emote renders as a still.
      const parsed = moving
        ? emote(item?.name, moving['2'] ?? moving['4'] ?? moving['1'], 'ffz', true) ?? emote(item?.name, urls?.['2'] ?? urls?.['4'] ?? urls?.['1'], 'ffz', false)
        : emote(item?.name, urls?.['2'] ?? urls?.['4'] ?? urls?.['1'], 'ffz', false)
      if (parsed) result.push(parsed)
    }
  }
  return result
}

/** Later groups win: channel packs override globals, then 7TV > BTTV > FFZ. */
export function mergeThirdPartyEmotes(...groups: ThirdPartyEmote[][]): ThirdPartyEmote[] {
  const merged = new Map<string, ThirdPartyEmote>()
  for (const group of groups) for (const item of group) merged.set(item.code, item)
  return [...merged.values()]
}
