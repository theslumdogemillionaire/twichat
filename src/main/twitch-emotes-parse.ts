import type { TwitchEmote } from '../shared/types'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
// Twitch names are punctuation-heavy (":)", "<3", "R)"), so only whitespace and length are rejected.
const NAME = /^\S{1,64}$/u
const TYPES = new Set(['subscriptions', 'follower', 'bitstier', 'globals', 'smilies', 'prime', 'turbo', 'limitedtime', 'rewards', 'hypetrain', 'none'])

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function parseTwitchEmotes(payload: unknown, scope: TwitchEmote['scope']): TwitchEmote[] {
  const values = Array.isArray(object(payload)?.data) ? object(payload)!.data as unknown[] : []
  const result: TwitchEmote[] = []
  const seen = new Set<string>()
  for (const value of values.slice(0, 1000)) {
    const item = object(value)
    const id = item?.id
    const name = item?.name
    if (typeof id !== 'string' || typeof name !== 'string' || !ID.test(id) || !NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    const type = typeof item?.emote_type === 'string' && TYPES.has(item.emote_type) ? item.emote_type : scope === 'global' ? 'globals' : 'other'
    result.push({ id, name, scope, type })
  }
  return result
}

/** Later groups win, so a channel emote overrides a global one sharing its name. */
export function mergeTwitchEmotes(...groups: TwitchEmote[][]): TwitchEmote[] {
  const merged = new Map<string, TwitchEmote>()
  for (const group of groups) for (const item of group) merged.set(item.name, item)
  return [...merged.values()]
}
