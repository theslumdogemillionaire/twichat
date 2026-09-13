import { channelName } from '../shared/validation'
import type { CategoryMatch, RoomProfile, StreamSummary, UserCard } from '../shared/types'

export interface HelixStream {
  id?: unknown; user_id?: unknown; user_login?: unknown; user_name?: unknown; title?: unknown; game_name?: unknown; game_id?: unknown
  viewer_count?: unknown; tags?: unknown; language?: unknown; started_at?: unknown; thumbnail_url?: unknown
}
export interface HelixUser {
  id?: unknown; login?: unknown; display_name?: unknown; profile_image_url?: unknown
  description?: unknown; created_at?: unknown; broadcaster_type?: unknown
}

function htmlValue(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
function safeAvatar(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'static-cdn.jtvnw.net' ? url.href : ''
  } catch { return '' }
}
// Helix hands back a `{width}x{height}` template. The URL parser percent-encodes those
// braces, so the size has to be substituted before the host is validated.
export function safeThumbnail(value: unknown, width = 440, height = 248): string {
  if (typeof value !== 'string' || value.length > 1000) return ''
  return safeAvatar(value.replace('{width}', String(width)).replace('{height}', String(height)))
}
function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maximum) : ''
}

// The public page's JSON-LD dates the current live stream; only the block marked `isLiveBroadcast`
// counts, the reruns listed further down carrying dates of their own.
function liveStart(html: string): string | undefined {
  const publication = html.match(/"publication"\s*:\s*\{([^{}]{0,400})\}/i)?.[1]
  if (!publication || !/"isLiveBroadcast"\s*:\s*true/i.test(publication)) return undefined
  const started = publication.match(/"startDate"\s*:\s*"([^"]{1,40})"/i)?.[1]
  return started && Number.isFinite(Date.parse(started)) ? started : undefined
}

// Twitch renders the same tag with its attributes in either order — `property` first on one page,
// `content` first on the next — so every tag read here has to be matched both ways round.
function metaContent(html: string, attribute: 'name' | 'property', name: string): string {
  return html.match(new RegExp(`<meta\\s+${attribute}=["']${name}["']\\s+content=["']([^"']*)["']`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attribute}=["']${name}["']`, 'i'))?.[1]
    ?? ''
}

export function parsePublicProfile(channelInput: string, html: string): RoomProfile {
  const channel = channelName(channelInput)
  const image = metaContent(html, 'property', 'og:image')
  const title = htmlValue(metaContent(html, 'property', 'og:title'))
  const description = htmlValue(metaContent(html, 'name', 'description'))
  // A login Twitch does not know is answered with one of Twitch's own pages — the home page, or a
  // route such as `/directory` that a login can collide with — and each of those carries an
  // og:image of its own, the Twitch logo. They are all typed `website`, while a channel is typed
  // `video.other` on air and `profile` off it. Nothing on the page is read as the channel's own
  // unless it is one of those two types: the login stands in instead.
  const type = metaContent(html, 'property', 'og:type').toLowerCase()
  const known = type === 'video.other' || type === 'profile'
  return {
    channel,
    displayName: (known && cleanText(title.replace(/\s*[-–]\s*(?:Live (?:on|sur) Twitch|Twitch).*$/i, ''), 50)) || channel,
    avatarUrl: known ? safeAvatar(htmlValue(image)) : '',
    // The type separates the two states as well, but the JSON-LD broadcast states it directly and
    // is what survived Twitch retyping the offline page from `video.other` to `profile`. The
    // public page carries no audience count at all.
    live: /"isLiveBroadcast"\s*:\s*true/i.test(html),
    // The page is served in the reader's language, and so is the tail Twitch appends to the
    // title: `| Streaming <game> for N viewers.` in English, `| Stream de <game> pour N
    // viewers.` in French. Both go; what is left is what the streamer actually wrote.
    title: (known && cleanText(description.replace(/\s*\|\s*Stream(?:ing|\s+de)\s.*$/i, ''), 140)) || undefined,
    startedAt: liveStart(html)
  }
}

export function combineHelix(streamsInput: unknown, usersInput: unknown): StreamSummary[] {
  const streams = Array.isArray(streamsInput) ? streamsInput as HelixStream[] : []
  const users = Array.isArray(usersInput) ? usersInput as HelixUser[] : []
  const avatars = new Map(users.map(user => [String(user.id ?? ''), safeAvatar(user.profile_image_url)]))
  return streams.slice(0, 100).flatMap(stream => {
    try {
      const channel = channelName(stream.user_login)
      const viewers = Number(stream.viewer_count)
      if (!Number.isFinite(viewers) || viewers < 0) return []
      return [{
        id: cleanText(stream.id, 80), channel, displayName: cleanText(stream.user_name, 50) || channel,
        avatarUrl: avatars.get(String(stream.user_id ?? '')) ?? '', thumbnailUrl: safeThumbnail(stream.thumbnail_url),
        title: cleanText(stream.title, 140),
        game: cleanText(stream.game_name, 80),
        // The name names the category, the id browses it. Answered empty unless it is a plain
        // number, exactly as `channelCategory` does: a card then filters where it cannot go.
        gameId: /^\d{1,30}$/.test(String(stream.game_id ?? '')) ? String(stream.game_id) : '',
        viewers, tags: Array.isArray(stream.tags) ? stream.tags.map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 10) : [],
        language: cleanText(stream.language, 10), startedAt: cleanText(stream.started_at, 40)
      }]
    } catch { return [] }
  }).sort((a, b) => b.viewers - a.viewers)
}

export interface HelixSearchChannel {
  id?: unknown; broadcaster_login?: unknown; display_name?: unknown; thumbnail_url?: unknown
}
/** A channel found by name: its identity, before the streams call says what it is airing. */
export interface SearchedChannel { id: string; channel: string; displayName: string; avatarUrl: string }

/**
 * `search/channels` matches a query against logins and display names — the one Twitch endpoint
 * that reaches past the hundred streams the catalog holds.
 *
 * It answers identities, not streams: no audience, and `thumbnail_url` is the profile picture
 * rather than the stream preview. The rows are kept for their ids, which is what the caller
 * exchanges for a card's worth of stream.
 *
 * Its own `is_live` is not read, and `live_only` is not asked for: measured against `streams`,
 * two rows in forty came back on the wrong side of it. Which channels are on air is settled by
 * `streams` alone; the order here is Twitch's own relevance, and it is worth keeping.
 */
export function parseChannelSearch(input: unknown): SearchedChannel[] {
  const rows = Array.isArray(input) ? input as HelixSearchChannel[] : []
  const seen = new Set<string>()
  return rows.flatMap(row => {
    try {
      const channel = channelName(row.broadcaster_login)
      if (seen.has(channel)) return []
      seen.add(channel)
      const id = String(row.id ?? '')
      if (!/^\d{1,30}$/.test(id)) return []
      return [{ id, channel, displayName: cleanText(row.display_name, 50) || channel, avatarUrl: safeAvatar(row.thumbnail_url) }]
    } catch { return [] }
  })
}

/**
 * The cursor a paged Helix answer carries, or an empty string when there is no page after this
 * one. Opaque to us — Twitch's own position in a ranking — so it is only ever checked for being a
 * plausible token: a string, of the alphabet a cursor is written in, short enough to put in a URL.
 * Anything else is read as the end of the list, which costs a page and never a malformed query.
 */
export function pageCursor(payload: unknown): string {
  const cursor = (payload as { pagination?: { cursor?: unknown } } | null)?.pagination?.cursor
  return typeof cursor === 'string' && /^[A-Za-z0-9+/=_.-]{1,500}$/.test(cursor) ? cursor : ''
}

export interface HelixCategory { id?: unknown; name?: unknown; box_art_url?: unknown }

/**
 * The rows of a list of categories, whichever endpoint wrote it: `search/categories` matches a
 * name, `games/top` ranks by audience, and both answer the same three fields.
 *
 * The id is what the browse is made of, so a row without a usable one is dropped rather than
 * carded: a card that cannot be opened is worse than one that is not there. The box art is asked
 * for at its own shape — Twitch substitutes whatever is written into the template, and the
 * catalog's 440x248 would ask it for a stretched stream preview.
 *
 * Capped here rather than trusted to the caller's `first`: both callers ask for a hundred at most,
 * and the ceiling is what keeps that true of the next one.
 */
export function parseCategories(input: unknown): CategoryMatch[] {
  const rows = Array.isArray(input) ? input as HelixCategory[] : []
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const id = String(row.id ?? '')
    const name = cleanText(row.name, 80)
    if (!/^\d{1,30}$/.test(id) || !name || seen.has(id)) return []
    seen.add(id)
    return [{ id, name, boxArtUrl: safeThumbnail(row.box_art_url, 144, 192) }]
  }).slice(0, 100)
}

export interface HelixFollowedChannel { broadcaster_id?: unknown; broadcaster_login?: unknown; broadcaster_name?: unknown }
/** A followed channel, cut down to what is used later: the id for the avatar, the login for the room. */
export interface FollowedChannel { id: string; channel: string; displayName: string }

export function parseFollowedChannels(input: unknown): FollowedChannel[] {
  const rows = Array.isArray(input) ? input as HelixFollowedChannel[] : []
  const seen = new Set<string>()
  return rows.flatMap(row => {
    try {
      const channel = channelName(row.broadcaster_login)
      if (seen.has(channel)) return []
      seen.add(channel)
      const id = String(row.broadcaster_id ?? '')
      return [{ id: /^\d{1,30}$/.test(id) ? id : '', channel, displayName: cleanText(row.broadcaster_name, 50) || channel }]
    } catch { return [] }
  })
}

// Live streams are already described by `combineHelix`: only the rest of the followed list is left,
// sorted by name since an offline channel has neither an audience nor a start time to compare.
export function offlineFollowed(followed: FollowedChannel[], live: StreamSummary[], usersInput: unknown): RoomProfile[] {
  const streaming = new Set(live.map(stream => stream.channel))
  const users = Array.isArray(usersInput) ? usersInput as HelixUser[] : []
  const avatars = new Map(users.map(user => [String(user.id ?? ''), safeAvatar(user.profile_image_url)]))
  return followed
    .filter(entry => !streaming.has(entry.channel))
    .map(entry => ({ channel: entry.channel, displayName: entry.displayName, avatarUrl: avatars.get(entry.id) ?? '', live: false }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function helixUsersToProfiles(usersInput: unknown): RoomProfile[] {
  const users = Array.isArray(usersInput) ? usersInput as HelixUser[] : []
  return users.flatMap(user => {
    try {
      const channel = channelName(user.login)
      return [{ channel, displayName: cleanText(user.display_name, 50) || channel, avatarUrl: safeAvatar(user.profile_image_url), live: false }]
    } catch { return [] }
  })
}

// The card is the public half of a Twitch profile: identity, bio, and the two numbers a viewer reads first.
export function helixUserToCard(usersInput: unknown): UserCard | null {
  const users = Array.isArray(usersInput) ? usersInput as HelixUser[] : []
  const user = users[0]
  if (!user) return null
  try {
    const login = channelName(user.login)
    const type = cleanText(user.broadcaster_type, 20)
    // Kept rather than dropped: blocking someone takes Twitch's id for them, and this payload is
    // the only place the card ever sees one.
    const id = String(user.id ?? '')
    return {
      login,
      userId: /^\d{1,30}$/.test(id) ? id : '',
      displayName: cleanText(user.display_name, 50) || login,
      avatarUrl: safeAvatar(user.profile_image_url),
      description: cleanText(user.description, 300),
      broadcasterType: type === 'affiliate' || type === 'partner' ? type : '',
      createdAt: cleanText(user.created_at, 40),
      live: false
    }
  } catch { return null }
}

// Helix answers the follower endpoint with an empty `data` unless the token is a moderator of
// that channel; `total` stays readable, so only that number is worth reading here.
export function followerTotal(payload: unknown): number | undefined {
  const total = Number((payload as { total?: unknown } | null)?.total)
  return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : undefined
}

// `channels/followed` filtered to a single channel answers with a list: full if the account follows,
// empty otherwise. Only the start date matters here, since it is what followers-only mode times.
export function parseFollowedAt(payload: unknown): string {
  const rows = (payload as { data?: unknown } | null)?.data
  const row = Array.isArray(rows) ? rows[0] as { followed_at?: unknown } : undefined
  const followedAt = cleanText(row?.followed_at, 40)
  return Number.isFinite(Date.parse(followedAt)) ? followedAt : ''
}

/**
 * `helix/channels` answers for a channel whether or not it is live: it is the only source of the
 * tags of an offline room. Twitch added the field after the endpoint shipped, so a payload without
 * it costs the chips alone.
 */
export function channelTags(payload: unknown): string[] {
  const rows = (payload as { data?: unknown } | null)?.data
  const row = Array.isArray(rows) ? rows[0] as { tags?: unknown } : undefined
  if (!Array.isArray(row?.tags)) return []
  const tags = row.tags.map(tag => cleanText(tag, 40)).filter(Boolean)
  return [...new Set(tags)].slice(0, 8)
}

/**
 * The category the channel is listed under, read from the same `helix/channels` payload as the
 * tags. It is the one source that survives the stream ending: `helix/streams` answers nothing at
 * all off air, and the category is what a room still says about itself the morning after.
 *
 * The id travels with the name because it is what browsing that category is made of — Twitch
 * takes a `game_id` there and never a name — and it is answered empty unless it is a plain
 * number, so a payload without one costs the browse rather than sending Twitch a malformed query.
 *
 * The name is capped like the catalog's own `game`, so the two say the same thing about the same
 * category.
 */
export function channelCategory(payload: unknown): { id: string; name: string } {
  const rows = (payload as { data?: unknown } | null)?.data
  const row = Array.isArray(rows) ? rows[0] as { game_id?: unknown; game_name?: unknown } : undefined
  const id = String(row?.game_id ?? '')
  return { id: /^\d{1,30}$/.test(id) ? id : '', name: cleanText(row?.game_name, 80) }
}
