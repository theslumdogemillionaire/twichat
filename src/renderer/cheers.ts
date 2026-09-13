import type { Cheermote, CheermoteTier } from '../shared/types'

export interface CheerSegment {
  text: string
  /** Set on a cheer token: what was cheered, the prefix it was cheered under, and its tier. */
  cheer?: { prefix: string; bits: number; tier: CheermoteTier }
}

/** What a cheer ends with. Nine digits is far past any amount Twitch will take. */
const AMOUNT = /\d{1,9}$/
const LETTER = /[a-zA-Z]/

/** The tier an amount reaches. `tiers` arrives biggest first, so the first match is the one. */
export function cheerTier(cheermote: Cheermote, bits: number): CheermoteTier | undefined {
  return cheermote.tiers.find(tier => bits >= tier.minBits)
}

/**
 * The cheer a token spells, or nothing.
 *
 * The amount is the run of digits the token ends with. Where the prefix stops is not simply where
 * those digits start: a Twitch prefix may itself hold digits and may open with one — `4Head` is
 * one of their own, and `4Head5000` is a real cheer. So every cut whose tail is all digits is
 * tried, the longest prefix first, and the first one this room actually knows wins.
 *
 * Cutting no further left than the digit run is what keeps overlapping prefixes unambiguous:
 * `Cheerwhal100` can only ever be read as `Cheerwhal` + `100`, never as `Cheer` + `whal100`.
 */
function cheerToken(token: string, cheermotes: ReadonlyMap<string, Cheermote>) {
  const amount = AMOUNT.exec(token)
  if (!amount) return undefined
  const shortest = token.length - amount[0].length
  for (let cut = token.length - 1; cut >= shortest; cut--) {
    const prefix = token.slice(0, cut)
    // A prefix with no letter in it is not one: `100` would otherwise cheer `1` for `00`.
    if (!LETTER.test(prefix)) continue
    const cheermote = cheermotes.get(prefix.toLowerCase())
    if (!cheermote) continue
    const bits = Number(token.slice(cut))
    // An amount below the lowest tier is not a cheer Twitch would have counted.
    const tier = bits > 0 ? cheerTier(cheermote, bits) : undefined
    if (tier) return { prefix: cheermote.prefix, bits, tier }
  }
  return undefined
}

/**
 * The cheer tokens of a body — Twitch's `Cheer100`, and each channel's own prefixes.
 *
 * **This runs on a text fragment, never on the raw message.** Twitch's `emotes` and `gifs` tags
 * announce their images as offsets counted in code points over the body as it was typed, and
 * `messageFragments` walks those offsets before anything else. Replacing `Cheer100` with an
 * image before that walk would move every range after it by five characters and paint the wrong
 * words as emotes; after it, the ranges are already spent and a split can no longer shift one.
 * That ordering is the whole reason this is a separate function rather than a step in there.
 */
export function cheerSegments(text: string, cheermotes?: ReadonlyMap<string, Cheermote>): CheerSegment[] {
  if (!text || !cheermotes?.size) return [{ text }]
  const segments: CheerSegment[] = []
  for (const token of text.split(/(\s+)/u)) {
    if (!token) continue
    const cheer = cheerToken(token, cheermotes)
    segments.push(cheer ? { text: token, cheer } : { text: token })
  }
  return segments.length ? segments : [{ text }]
}

/** The prefixes of a room, keyed for the lookup above: Twitch matches a cheer without regard to case. */
export function cheermoteIndex(cheermotes: readonly Cheermote[]): ReadonlyMap<string, Cheermote> {
  return new Map(cheermotes.map(cheermote => [cheermote.prefix.toLowerCase(), cheermote]))
}
