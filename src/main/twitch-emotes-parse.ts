import type { TwitchEmote } from '../shared/types'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
// Twitch names are punctuation-heavy (":)", "<3", "R)"), so only whitespace and length are rejected.
const NAME = /^\S{1,64}$/u
// The last three come from `chat/emotes/user` alone: nothing a channel or the global set answers
// is ever typed that way, and an unknown type would otherwise flatten to "other".
const TYPES = new Set(['subscriptions', 'follower', 'bitstier', 'globals', 'smilies', 'prime', 'turbo', 'limitedtime', 'rewards', 'hypetrain', 'none', 'channelpoints', 'owl2019', 'twofactor'])
/** Twitch caps a page at 100; nothing longer than a cursor is a cursor. */
const CURSOR = /^[A-Za-z0-9_=+/-]{1,500}$/

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

/**
 * One page of `chat/emotes/user`: the emotes the account itself carries, wherever it earned them.
 *
 * Its shape is not the one the global and channel endpoints answer with. There is no `images`
 * object per emote — the addresses are built from a single top-level `template` — and the list
 * comes in pages behind a cursor. Neither matters to what is kept: the renderer builds every
 * Twitch emote address from its id (`twitchEmoteUrl`), which is that template with our own
 * choices already made, so the template is read past rather than carried around. The cursor is,
 * because an account subscribed to forty channels does not fit in one page.
 */
export function parseUserEmotes(payload: unknown): { emotes: TwitchEmote[]; cursor: string } {
  const cursor = object(object(payload)?.pagination)?.cursor
  return {
    emotes: parseTwitchEmotes(payload, 'account'),
    cursor: typeof cursor === 'string' && CURSOR.test(cursor) ? cursor : ''
  }
}

/** Later groups win, so a channel emote overrides a global one sharing its name. */
export function mergeTwitchEmotes(...groups: TwitchEmote[][]): TwitchEmote[] {
  const merged = new Map<string, TwitchEmote>()
  for (const group of groups) for (const item of group) merged.set(item.name, item)
  return [...merged.values()]
}
