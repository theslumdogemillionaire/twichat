/**
 * The links a chat message carries. Only what announces itself as a link is one: an explicit
 * `http://` or `https://` scheme, or a `www.` host. Bare domains are left alone on purpose —
 * `node.js`, `e.g.` and `1.5` would all pass for one, and a false link is worse than a missed
 * one when the click leaves the application.
 */
export interface LinkSegment {
  text: string
  /** The absolute URL to open. Absent on ordinary text. */
  url?: string
}

// Not anchored, unlike the composer's own pattern: this one scans a message that is mostly prose.
// The lookbehind keeps `bonjourwww.site.fr` and `mail@www.site.fr` from starting a link mid-word.
const LINK = /(?<![\p{L}\p{N}@_])(?:https?:\/\/|www\.)[^\s<>"'`]+/giu
/** Sentence punctuation that follows a link far more often than it belongs to one. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '’', '»', '”', '·'])
/** A closing bracket only leaves the link when nothing inside it opened one. */
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }

function occurrences(text: string, character: string): number {
  let total = 0
  for (const found of text) if (found === character) total += 1
  return total
}

/**
 * Gives the sentence back what belongs to it. `https://example.com/foo.` ends on a full stop,
 * and `(https://example.com)` on the parenthesis that opened before the link — but the closing
 * one of `https://en.wikipedia.org/wiki/Twitch_(service)` is part of the address.
 */
function trimTrailing(url: string): string {
  let end = url.length
  while (end > 0) {
    const last = url[end - 1]!
    const opening = PAIRS[last]
    if (opening) {
      const head = url.slice(0, end)
      if (occurrences(head, last) <= occurrences(head, opening)) break
      end -= 1
      continue
    }
    if (!TRAILING.has(last)) break
    end -= 1
  }
  return url.slice(0, end)
}

/**
 * The absolute URL a matched text points at, or an empty string when it points nowhere we may
 * open. `www.` gains the scheme it left implicit; anything that is not HTTP stays plain text,
 * so a `javascript:` or a `file:` written by hand never becomes clickable.
 */
export function linkTarget(text: string): string {
  const candidate = /^www\./i.test(text) ? `https://${text}` : text
  let url: URL
  try { url = new URL(candidate) } catch { return '' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  // Credentials in a URL are the oldest way of dressing one host up as another.
  if (url.username || url.password) return ''
  return url.href
}

/** Splits a text fragment so only the addresses become links, the rest staying as written. */
export function linkSegments(text: string): LinkSegment[] {
  if (!text) return [{ text }]
  const segments: LinkSegment[] = []
  let cursor = 0
  LINK.lastIndex = 0
  for (let match = LINK.exec(text); match; match = LINK.exec(text)) {
    const found = trimTrailing(match[0])
    // The trimmed tail goes back into the scan: a link may follow the punctuation. The scan
    // never stands still, or a match trimmed down to nothing would be found again forever.
    LINK.lastIndex = match.index + Math.max(found.length, match[0].length ? 1 : 0)
    const url = found ? linkTarget(found) : ''
    if (!url) continue
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index) })
    segments.push({ text: found, url })
    cursor = match.index + found.length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments.length ? segments : [{ text }]
}
