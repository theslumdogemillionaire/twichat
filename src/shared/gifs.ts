/**
 * The GIFs a message carries. Twitch answers its GIPHY keyboard with a `gifs` tag on the
 * PRIVMSG — `<start>-<end>|<id>|<url>`, entries comma-separated — and writes a readable
 * `[title GIF by author]` in the body itself, which is what a client that knows nothing of
 * the tag shows. The address is Twitch's to give: the documentation asks that it be used in
 * full and never rewritten, so nothing here builds one.
 */
export interface GifEntry {
  /** Code-point offsets in the body, both ends included, as in the `emotes` tag. */
  start: number
  end: number
  id: string
  url: string
}

/**
 * What opens an entry. The address that follows runs to the next entry or to the end of the
 * tag: it carries a query string of its own, and a `split(',')` would cut one in half.
 */
const HEAD = /(?:^|,)(\d+)-(\d+)\|([A-Za-z0-9_-]{1,64})\|/gu
/** More than a handful in one message says the tag is not what we think it is. */
const MAX_GIFS_PER_MESSAGE = 8

/**
 * The address of an entry, or an empty string when it points anywhere but GIPHY. Given back
 * exactly as it was read — the full URL, unmodified — so the check only ever decides whether
 * the image may be shown at all.
 */
export function giphyUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { return '' }
  if (url.protocol !== 'https:') return ''
  // Credentials in a URL are the oldest way of dressing one host up as another.
  if (url.username || url.password) return ''
  const host = url.hostname.toLowerCase()
  return host === 'giphy.com' || host.endsWith('.giphy.com') ? value : ''
}

/** The entries of a `gifs` tag, in the order written, the unreadable ones left out. */
export function parseGifs(tag: string): GifEntry[] {
  if (!tag) return []
  const heads: { start: number; end: number; id: string; from: number; at: number }[] = []
  HEAD.lastIndex = 0
  for (let match = HEAD.exec(tag); match; match = HEAD.exec(tag)) {
    heads.push({ start: Number(match[1]), end: Number(match[2]), id: match[3]!, from: match.index + match[0].length, at: match.index })
  }
  const entries: GifEntry[] = []
  // The whole tag is scanned before the count is capped: an entry left unread would otherwise
  // hand its own text to the address of the one before it, which would still look like a URL.
  heads.forEach((head, index) => {
    if (!Number.isSafeInteger(head.start) || !Number.isSafeInteger(head.end) || head.end < head.start) return
    const url = giphyUrl(tag.slice(head.from, heads[index + 1]?.at ?? tag.length))
    if (url) entries.push({ start: head.start, end: head.end, id: head.id, url })
  })
  return entries.slice(0, MAX_GIFS_PER_MESSAGE)
}

/** A tag written back from its entries: only the offsets may have moved, never the address. */
export function formatGifs(entries: readonly GifEntry[]): string {
  return entries.map(entry => `${entry.start}-${entry.end}|${entry.id}|${entry.url}`).join(',')
}
