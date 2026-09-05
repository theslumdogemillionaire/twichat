export const MESSAGE_BYTE_LIMIT = 450

export type TokenKind = 'text' | 'mention' | 'emote' | 'emoji' | 'command' | 'invalid' | 'url' | 'overflow'
export interface HighlightToken { text: string; kind: TokenKind }
export interface HighlightContext {
  emotes?: ReadonlySet<string>
  emojiNames?: ReadonlySet<string>
  self?: string
}

const encoder = new TextEncoder()
const MENTION = /^(@[a-zA-Z0-9_]{1,25})([\s\S]*)$/
const SHORTCODE = /^:([a-z0-9_+-]{2,32}):$/i
const LINK = /^https?:\/\/\S+$/i
const LEADING_COMMAND = /^\/([a-zA-Z]*)/

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Splits a token at the byte budget so the surplus can be painted as an error. */
function markOverflow(tokens: HighlightToken[], limit: number): HighlightToken[] {
  const result: HighlightToken[] = []
  let used = 0
  let exceeded = false
  for (const token of tokens) {
    if (exceeded) { result.push({ text: token.text, kind: 'overflow' }); continue }
    const size = byteLength(token.text)
    if (used + size <= limit) { used += size; result.push(token); continue }
    let kept = ''
    for (const character of token.text) {
      const next = byteLength(character)
      if (used + next > limit) break
      used += next
      kept += character
    }
    exceeded = true
    if (kept) result.push({ text: kept, kind: token.kind })
    const rest = token.text.slice(kept.length)
    if (rest) result.push({ text: rest, kind: 'overflow' })
  }
  return result
}

export function tokenizeMessage(text: string, context: HighlightContext = {}, limit = MESSAGE_BYTE_LIMIT): HighlightToken[] {
  const tokens: HighlightToken[] = []
  const push = (value: string, kind: TokenKind) => {
    if (!value) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += value
    else tokens.push({ text: value, kind })
  }

  let body = text
  const command = LEADING_COMMAND.exec(text)
  if (command) {
    // Only /me survives shared validation, so any other command is flagged before it is sent.
    push(command[0], command[1].toLowerCase() === 'me' ? 'command' : 'invalid')
    body = text.slice(command[0].length)
  }

  for (const chunk of body.split(/(\s+)/u)) {
    if (!chunk) continue
    if (/^\s+$/u.test(chunk)) { push(chunk, 'text'); continue }
    if (LINK.test(chunk)) { push(chunk, 'url'); continue }
    const mention = MENTION.exec(chunk)
    if (mention) {
      push(mention[1], 'mention')
      push(mention[2], 'text')
      continue
    }
    const shortcode = SHORTCODE.exec(chunk)
    if (shortcode && context.emojiNames?.has(shortcode[1].toLowerCase())) { push(chunk, 'emoji'); continue }
    if (context.emotes?.has(chunk)) { push(chunk, 'emote'); continue }
    push(chunk, 'text')
  }
  return markOverflow(tokens, limit)
}

export type CompletionKind = 'mention' | 'emoji' | 'emote'
export interface CompletionQuery {
  kind: CompletionKind
  term: string
  start: number
  end: number
}

/** Reads the word under the caret; plain words only complete when the user asks for it with Tab. */
export function completionQuery(text: string, caret: number, forced = false): CompletionQuery | null {
  const position = Math.max(0, Math.min(caret, text.length))
  let start = position
  while (start > 0 && !/\s/u.test(text[start - 1])) start -= 1
  let end = position
  while (end < text.length && !/\s/u.test(text[end])) end += 1
  const prefix = text.slice(start, position)
  if (!prefix && !forced) return null
  if (start === 0 && prefix.startsWith('/')) return null
  if (prefix.startsWith('@')) return { kind: 'mention', term: prefix.slice(1), start, end }
  if (prefix.startsWith(':') && prefix.length >= 2 && !prefix.endsWith(':')) return { kind: 'emoji', term: prefix.slice(1), start, end }
  if (forced && prefix.length >= 1 && !prefix.startsWith(':')) return { kind: 'emote', term: prefix, start, end }
  return null
}

export interface Insertion { text: string; caret: number }

export function replaceRange(text: string, start: number, end: number, insert: string, spaceAfter = true): Insertion {
  const trailing = spaceAfter && text.slice(end, end + 1) !== ' ' ? ' ' : ''
  const next = `${text.slice(0, start)}${insert}${trailing}${text.slice(end)}`
  return { text: next, caret: start + insert.length + trailing.length }
}

export function applyCompletion(text: string, query: CompletionQuery, value: string): Insertion {
  return replaceRange(text, query.start, query.end, value)
}

/** Twitch refuses line breaks, so the composer normalises them instead of failing at send time. */
export function sanitizeOutgoing(text: string): string {
  return text.replace(/[\r\n\t\0]+/gu, ' ').replace(/ {2,}/gu, ' ').trim()
}

export interface Ranked<T> { item: T; score: number }

export function rankByTerm<T>(items: readonly T[], term: string, keys: (item: T) => readonly string[], limit = 40): T[] {
  const needle = term.trim().toLowerCase()
  const ranked: Array<Ranked<T>> = []
  for (const item of items) {
    let score = 0
    for (const key of keys(item)) {
      const value = key.toLowerCase()
      if (!needle) { score = Math.max(score, 1); continue }
      if (value === needle) { score = Math.max(score, 4); continue }
      if (value.startsWith(needle)) { score = Math.max(score, 3); continue }
      if (value.includes(needle)) score = Math.max(score, 1)
    }
    if (score) ranked.push({ item, score })
  }
  ranked.sort((left, right) => right.score - left.score)
  return ranked.slice(0, limit).map(entry => entry.item)
}
