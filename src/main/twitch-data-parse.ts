import { channelName } from '../shared/validation'
import type { RoomProfile, StreamSummary, UserCard } from '../shared/types'

export interface HelixStream {
  id?: unknown; user_id?: unknown; user_login?: unknown; user_name?: unknown; title?: unknown; game_name?: unknown
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

export function parsePublicProfile(channelInput: string, html: string): RoomProfile {
  const channel = channelName(channelInput)
  const image = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i)?.[1]
  const title = htmlValue(html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i)?.[1] ?? '')
  const description = htmlValue(html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] ?? '')
  // A login Twitch does not know is answered with the site's own home page, which names Twitch and
  // shows the Twitch logo. Only a real channel page is typed `video.other`, so nothing on the page
  // is read as the channel's own unless that type is there: the login stands in instead.
  const known = /<meta\s+property=["']og:type["']\s+content=["']video\.other["']/i.test(html)
  return {
    channel,
    displayName: (known && cleanText(title.replace(/\s*[-–]\s*(?:Live (?:on|sur) Twitch|Twitch).*$/i, ''), 50)) || channel,
    avatarUrl: known ? safeAvatar(image ? htmlValue(image) : '') : '',
    // `video.other` is the type of every channel page, on air or not, so the JSON-LD broadcast is
    // the only thing that tells them apart. The public page carries no audience count at all.
    live: /"isLiveBroadcast"\s*:\s*true/i.test(html),
    title: (known && cleanText(description.replace(/\s*\|\s*Streaming .*$/i, ''), 140)) || undefined,
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
        game: cleanText(stream.game_name, 80), viewers, tags: Array.isArray(stream.tags) ? stream.tags.map(tag => cleanText(tag, 40)).filter(Boolean).slice(0, 10) : [],
        language: cleanText(stream.language, 10), startedAt: cleanText(stream.started_at, 40)
      }]
    } catch { return [] }
  }).sort((a, b) => b.viewers - a.viewers)
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
    return {
      login,
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
