import type { Cheermote, CheermoteTier } from '../shared/types'

/**
 * `helix/bits/cheermotes` read into the pairs the log needs. The network shape is what changes;
 * the matching in `src/renderer/cheers.ts` does not, which is why the two live apart.
 */
/**
 * A prefix may hold digits and may start with one — `4Head` is one of Twitch's own, and
 * `4Head5000` is a real cheer. What it may not be is digits alone, or the amount would be read
 * as the prefix. `cheers.ts` splits a token on the same rule.
 */
const PREFIX = /^(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{1,32}$/
const COLOR = /^#[0-9a-fA-F]{6}$/
/**
 * The host Twitch's own documentation gives for every cheermote file, plus the CDN the rest of
 * this application already reads emotes and badges from. Anything else is dropped rather than
 * drawn: the renderer's `img-src` would refuse it in silence, which looks like a broken image.
 */
const HOSTS = new Set(['d3aqoihi2n8ty8.cloudfront.net', 'static-cdn.jtvnw.net'])
const MAX_PREFIXES = 400
const MAX_TIERS = 16

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The address Twitch gave, or nothing. Built by no one here, as for a badge. */
function cheerImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

/**
 * The dark, animated, 2× file. Dark because `twitchEmoteUrl` asks for the dark emote too and the
 * two sit on the same line; 2× because it lands in the 28-pixel slot the emotes use. The scales
 * are tried downwards and the still image after the animated one, so a tier Twitch has not
 * animated still shows something.
 */
function tierImage(images: unknown): string {
  const dark = object(object(images)?.dark)
  const animated = object(dark?.animated)
  const still = object(dark?.static)
  for (const scale of ['2', '1.5', '1']) {
    const url = cheerImage(animated?.[scale]) || cheerImage(still?.[scale])
    if (url) return url
  }
  return ''
}

export function parseCheermotes(payload: unknown): Cheermote[] {
  const values = Array.isArray(object(payload)?.data) ? object(payload)!.data as unknown[] : []
  const result: Cheermote[] = []
  // Twitch answers with its own prefixes and the channel's in the one payload; a channel may
  // reuse a global name, and the later entry is the one that belongs to the room being read.
  const seen = new Map<string, Cheermote>()
  for (const value of values) {
    const item = object(value)
    const prefix = item?.prefix
    if (typeof prefix !== 'string' || !PREFIX.test(prefix) || !Array.isArray(item?.tiers)) continue
    const tiers: CheermoteTier[] = []
    for (const entry of (item.tiers as unknown[]).slice(0, MAX_TIERS)) {
      const tier = object(entry)
      const minBits = tier?.min_bits
      if (typeof minBits !== 'number' || !Number.isSafeInteger(minBits) || minBits < 1) continue
      const url = tierImage(tier?.images)
      if (!url) continue
      // The colour is written into a style property on the other side: only Twitch's own
      // `#rrggbb` may go through, never an arbitrary string the network happened to send.
      const color = typeof tier?.color === 'string' && COLOR.test(tier.color) ? tier.color : ''
      tiers.push({ minBits, color, url })
    }
    if (!tiers.length) continue
    // Biggest first: the renderer takes the first tier the amount reaches and stops.
    tiers.sort((left, right) => right.minBits - left.minBits)
    const existing = seen.get(prefix.toLowerCase())
    if (existing) { existing.prefix = prefix; existing.tiers = tiers; continue }
    const cheermote: Cheermote = { prefix, tiers }
    seen.set(prefix.toLowerCase(), cheermote)
    result.push(cheermote)
    if (result.length >= MAX_PREFIXES) break
  }
  return result
}
