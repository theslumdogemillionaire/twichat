import type { ThirdPartyEmote } from '../shared/types'

export type MessageFragment =
  | { type: 'text'; text: string }
  | { type: 'emote'; id?: string; text: string; url: string; source: 'twitch' | ThirdPartyEmote['source'] }

interface EmoteOccurrence {
  id: string
  start: number
  end: number
}

const MAX_EMOTES_PER_MESSAGE = 100
const EMOTE_ID = /^[a-z0-9_-]{1,128}$/i

/** The `default` format serves the animated file when Twitch has one, and the static image otherwise. */
export function twitchEmoteUrl(id: string) {
  if (!EMOTE_ID.test(id)) return ''
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`
}

/** Matches emote codes on whole words: Twitch's own list wins, as it does server-side. */
function wordFragments(text: string, emotes?: ReadonlyMap<string, ThirdPartyEmote>, ownEmotes?: ReadonlyMap<string, string>): MessageFragment[] {
  if (!text || (!emotes?.size && !ownEmotes?.size)) return [{ type: 'text', text }]
  return text.split(/(\s+)/u).map(token => {
    const twitchId = ownEmotes?.get(token)
    const url = twitchId ? twitchEmoteUrl(twitchId) : ''
    if (url) return { type: 'emote' as const, id: twitchId, text: token, url, source: 'twitch' as const }
    const found = emotes?.get(token)
    return found ? { type: 'emote' as const, text: token, url: found.url, source: found.source } : { type: 'text' as const, text: token }
  })
}

/**
 * `ownEmotes` maps a Twitch emote name to its id. Twitch never echoes the sender's own PRIVMSG,
 * so a message the app displays locally carries no emote tag and must be matched by name.
 */
export function messageFragments(text: string, emoteTag = '', thirdParty?: ReadonlyMap<string, ThirdPartyEmote>, ownEmotes?: ReadonlyMap<string, string>): MessageFragment[] {
  if (!text || !emoteTag) return wordFragments(text, thirdParty, ownEmotes)

  // Twitch positions are Unicode code-point offsets, while String#slice uses UTF-16.
  const characters = Array.from(text)
  const occurrences: EmoteOccurrence[] = []

  for (const group of emoteTag.split('/')) {
    const separator = group.indexOf(':')
    if (separator < 1) continue
    const id = group.slice(0, separator)
    if (!twitchEmoteUrl(id)) continue

    for (const range of group.slice(separator + 1).split(',')) {
      const match = /^(\d+)-(\d+)$/.exec(range)
      if (!match) continue
      const start = Number(match[1])
      const end = Number(match[2])
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= characters.length) continue
      occurrences.push({ id, start, end })
      if (occurrences.length >= MAX_EMOTES_PER_MESSAGE) break
    }
    if (occurrences.length >= MAX_EMOTES_PER_MESSAGE) break
  }

  occurrences.sort((left, right) => left.start - right.start || left.end - right.end)
  const fragments: MessageFragment[] = []
  let cursor = 0
  for (const occurrence of occurrences) {
    if (occurrence.start < cursor) continue
    if (occurrence.start > cursor) fragments.push(...wordFragments(characters.slice(cursor, occurrence.start).join(''), thirdParty, ownEmotes))
    const emoteText = characters.slice(occurrence.start, occurrence.end + 1).join('')
    fragments.push({ type: 'emote', id: occurrence.id, text: emoteText, url: twitchEmoteUrl(occurrence.id), source: 'twitch' })
    cursor = occurrence.end + 1
  }
  if (cursor < characters.length) fragments.push(...wordFragments(characters.slice(cursor).join(''), thirdParty, ownEmotes))
  return fragments.length ? fragments : wordFragments(text, thirdParty, ownEmotes)
}
