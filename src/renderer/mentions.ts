import type { ChatMessage } from '../shared/types'

/**
 * A mention is read against the connected account: `@nick` as well as the bare nick, on a
 * whole word and regardless of case. The display name is compared on top of the login
 * for non-Latin nicknames, where the two really differ; otherwise it is a duplicate.
 */
function names(login: string | null, displayName?: string | null) {
  const list = [login ?? '', displayName ?? ''].map(name => name.trim()).filter(Boolean)
  // Longest first: in an alternation, `bob` would win over `bobby`.
  return [...new Set(list.map(name => name.toLowerCase()))].sort((left, right) => right.length - left.length)
}

let cachedKey = ''
let cachedPattern: RegExp | null = null
/**
 * The pattern is memoized on the account nickname: switching accounts must forget it,
 * otherwise the previous account's mentions would keep being detected.
 */
export function resetMentionCache() { cachedKey = ''; cachedPattern = null }
function pattern(login: string | null, displayName?: string | null) {
  const list = names(login, displayName)
  const key = list.join(' ')
  if (key !== cachedKey) {
    cachedKey = key
    const escaped = list.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    cachedPattern = escaped.length ? new RegExp(`(?<![\\p{L}\\p{N}_])@?(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null
  }
  return cachedPattern
}

/**
 * True when the message addresses the connected account. A reply to one of its messages
 * counts as a mention, even without the nickname in the text. Its own message is never
 * one: it is tested on `login`, because the Twitch echo of a send arrives without `own`.
 */
export function isMention(message: ChatMessage, login: string | null, displayName?: string | null) {
  if (!login || message.system) return false
  const account = login.toLowerCase()
  if (message.login.toLowerCase() === account) return false
  if (message.reply?.login === account) return true
  const regex = pattern(login, displayName)
  if (!regex) return false
  regex.lastIndex = 0
  return regex.test(message.text)
}

/** Splits a text fragment to wrap only the nickname, emotes already extracted. */
export function mentionSegments(text: string, login: string | null, displayName?: string | null) {
  const regex = pattern(login, displayName)
  if (!regex || !text) return [{ text, mention: false }]
  const segments: { text: string; mention: boolean }[] = []
  let cursor = 0
  regex.lastIndex = 0
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), mention: false })
    segments.push({ text: match[0], mention: true })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false })
  return segments.length ? segments : [{ text, mention: false }]
}
