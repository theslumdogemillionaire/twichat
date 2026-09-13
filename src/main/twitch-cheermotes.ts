import { net } from 'electron'
import { deduplicate, ExpiringCache } from './cache'
import type { Cheermote } from '../shared/types'
import { parseCheermotes } from './twitch-cheermotes-parse'
import { fail } from '../shared/errors'

export interface CheermoteAuth { token: string; clientId: string }

// A channel's cheer prefixes move with its bits campaigns, which is to say rarely.
const CHANNEL_TTL = 60 * 60_000
// An empty answer is usually a transient failure: it must not leave the cheers as text for an hour.
const EMPTY_TTL = 60_000
/** One entry per channel whose cheermotes were read, bounded and deduplicated as the badges are. */
const channelCache = new ExpiringCache<Cheermote[]>(100)
const channelInFlight = new Map<string, Promise<Cheermote[]>>()

/**
 * The cheermotes of a room, Twitch's own and the channel's, in one call: `helix/bits/cheermotes`
 * answers with both when it is given a `broadcaster_id`, so there is no global twin to merge here
 * the way the emotes and the badges have one.
 *
 * The endpoint asks for no scope — and still for a token. Every Helix call in this application
 * carries the account's, and an anonymous session has none, so the caller gates on the account
 * exactly as it does for the emotes and a dead session comes back as its own key rather than as
 * a silence.
 */
export async function getCheermotes(roomId: string, auth: CheermoteAuth): Promise<Cheermote[]> {
  const cached = channelCache.get(roomId)
  if (cached) return cached
  return deduplicate(channelInFlight, roomId, async () => {
    const response = await net.fetch(`https://api.twitch.tv/helix/bits/cheermotes?broadcaster_id=${encodeURIComponent(roomId)}`, {
      headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId },
      signal: AbortSignal.timeout(8000)
    })
    if (response.status === 401) fail('cheermotesSessionExpired')
    if (!response.ok) fail('cheermotesUnavailable', response.status)
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) fail('cheermotesTooLarge')
    const value = parseCheermotes(JSON.parse(text))
    return channelCache.set(roomId, value, value.length ? CHANNEL_TTL : EMPTY_TTL)
  })
}
