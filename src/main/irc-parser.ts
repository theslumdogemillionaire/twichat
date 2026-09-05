import type { ReplyReference } from '../shared/types'
import { formatGifs, parseGifs } from '../shared/gifs'
import { m, numbers } from '../shared/i18n'
import { fail } from '../shared/errors'

export interface IrcMessage {
  tags: Record<string, string>
  prefix: string
  command: string
  params: string[]
}

const escapes: Record<string, string> = { s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' }
export function parseIrc(line: string): IrcMessage | null {
  let rest = line.replace(/\r$/, '')
  const tags: Record<string, string> = {}
  let prefix = ''
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ')
    if (end < 0) return null
    for (const item of rest.slice(1, end).split(';')) {
      const split = item.indexOf('=')
      const key = split < 0 ? item : item.slice(0, split)
      tags[key] = (split < 0 ? '' : item.slice(split + 1)).replace(/\\(.)/g, (_, char: string) => escapes[char] ?? char)
    }
    rest = rest.slice(end + 1)
  }
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ')
    if (end < 0) return null
    prefix = rest.slice(1, end)
    rest = rest.slice(end + 1)
  }
  const trailing = rest.indexOf(' :')
  const parts = (trailing < 0 ? rest : rest.slice(0, trailing)).split(/ +/).filter(Boolean)
  const command = parts.shift()
  if (!command) return null
  if (trailing >= 0) parts.push(rest.slice(trailing + 2))
  return { tags, prefix, command, params: parts }
}

export class IrcFramer {
  private buffer = ''
  push(chunk: string): string[] {
    this.buffer += chunk
    if (this.buffer.length > 1024 * 1024) { this.buffer = ''; fail('ircFrameTooLarge') }
    const lines = this.buffer.split('\r\n')
    this.buffer = lines.pop() ?? ''
    return lines.filter(Boolean)
  }
}

/** Summarizes a USERNOTICE (sub, gift, raid, announcement); falls back to Twitch's `system-msg`. */
export function userNoticeSummary(tags: Record<string, string>): string {
  const name = tags['msg-param-displayName'] || tags['display-name'] || tags.login || m.chat.someone
  const plan = m.chat.subscriptionPlans[tags['msg-param-sub-plan'] ?? ''] ?? ''
  const months = Number(tags['msg-param-cumulative-months']) || 0
  const number = (value: string) => Number(value) || 0
  switch (tags['msg-id']) {
    case 'sub': return m.chat.subscribed(name, plan)
    case 'resub': return m.chat.resubscribed(name, months, plan)
    case 'subgift': return m.chat.giftedSub(name, plan, tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || m.chat.aViewer)
    case 'submysterygift': return m.chat.giftedSubs(name, number(tags['msg-param-mass-gift-count'] ?? ''))
    case 'giftpaidupgrade':
    case 'anongiftpaidupgrade': return m.chat.continuesGiftedSub(name)
    case 'raid': return m.chat.raid(name, number(tags['msg-param-viewerCount'] ?? ''))
    case 'unraid': return m.chat.raidCancelled
    case 'announcement': return m.chat.announcement(name)
    case 'viewermilestone': return tags['msg-param-category'] === 'watch-streak'
      ? m.chat.watchStreak(name, number(tags['msg-param-value'] ?? ''))
      : m.chat.loyaltyMilestone(name)
    case 'bitsbadgetier': return m.chat.bitsBadge(name, numbers.format(number(tags['msg-param-threshold'] ?? '')))
    default: return (tags['system-msg'] || '').trim()
  }
}


const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A Twitch message id, or '': it ends up in an IRC tag, and no other format may enter one. */
export const messageId = (value: unknown) => typeof value === 'string' && MESSAGE_ID.test(value) ? value : ''

/** `@Name ` at the head of a body, measured in code points like the emote offsets. */
function mentionPrefix(text: string, ...names: string[]) {
  const match = /^@(\S+)[ ]/u.exec(text)
  if (!match) return 0
  const mentioned = match[1].toLowerCase()
  if (!names.some(name => name && name.toLowerCase() === mentioned)) return 0
  return Array.from(match[0]).length
}

/** Shifts the offsets of an `emotes` tag, dropping the ranges that fell before the start. */
function shiftEmotes(tag: string, shift: number) {
  if (!tag || shift <= 0) return tag
  const groups: string[] = []
  for (const group of tag.split('/')) {
    const separator = group.indexOf(':')
    if (separator < 1) continue
    const ranges: string[] = []
    for (const range of group.slice(separator + 1).split(',')) {
      const match = /^(\d+)-(\d+)$/.exec(range)
      if (!match) continue
      const start = Number(match[1]) - shift
      const end = Number(match[2]) - shift
      if (start >= 0 && end >= start) ranges.push(`${start}-${end}`)
    }
    if (ranges.length) groups.push(`${group.slice(0, separator)}:${ranges.join(',')}`)
  }
  return groups.join('/')
}

/** The same shift on a `gifs` tag, entry by entry; the address is carried over untouched. */
function shiftGifs(tag: string, shift: number) {
  if (!tag || shift <= 0) return tag
  return formatGifs(parseGifs(tag)
    .filter(entry => entry.start >= shift)
    .map(entry => ({ ...entry, start: entry.start - shift, end: entry.end - shift })))
}

/**
 * Twitch prefixes a reply body with `@ParentName ` and counts the emote and GIF offsets against
 * that prefixed body. The quote makes the mention redundant: it is stripped and the offsets shift.
 */
export function stripReplyMention(text: string, emotes: string, gifs: string, ...names: string[]) {
  const shift = mentionPrefix(text, ...names)
  if (!shift) return { text, emotes, gifs }
  return { text: Array.from(text).slice(shift).join(''), emotes: shiftEmotes(emotes, shift), gifs: shiftGifs(gifs, shift) }
}

/**
 * The quoted reply, rebuilt from the `reply-*` tags alone: nothing is looked up in the
 * history, which may no longer hold the parent.
 */
export function replyReference(tags: Record<string, string>): ReplyReference | undefined {
  const id = messageId(tags['reply-parent-msg-id'])
  if (!id) return undefined
  const login = (tags['reply-parent-user-login'] || '').toLowerCase()
  const user = tags['reply-parent-display-name'] || login
  const threadId = messageId(tags['reply-thread-parent-msg-id']) || id
  const threadLogin = (tags['reply-thread-parent-user-login'] || '').toLowerCase()
  // A parent that is not the thread root is itself a reply: its body therefore carries the
  // `@Name ` of the grandparent, whose name appears nowhere in the tags.
  const body = tags['reply-parent-msg-body'] || ''
  const text = threadId === id ? body : body.replace(/^@\S+[ ]/u, '')
  return { id, login, user, text, threadId, threadLogin, threadUser: tags['reply-thread-parent-display-name'] || threadLogin }
}
