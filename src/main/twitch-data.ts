import { net } from 'electron'
import { ExpiringCache } from './cache'
import { channelName } from '../shared/validation'
import type { ChannelInfo, FollowStatus, FollowedChannels, RoomProfile, StreamSummary, UserCard } from '../shared/types'
import { channelTags, combineHelix, followerTotal, helixUsersToProfiles, helixUserToCard, offlineFollowed, parseFollowedAt, parseFollowedChannels, parsePublicProfile, type FollowedChannel, type HelixStream, type HelixUser } from './twitch-data-parse'
import { fail, type ErrorKey } from '../shared/errors'
import { locale } from '../shared/i18n'

export interface HelixAuth { token: string; clientId: string }
interface Identity { displayName: string; avatarUrl: string }
interface LiveState { live: boolean; viewers?: number; title?: string; startedAt?: string }

/**
 * Identity (name, avatar) barely moves; live status must stay fresh; a bio and a follower count sit
 * between the two. Three caches, three lifetimes — and a ceiling on each, because these are keyed
 * by channel and the discovery list walks past far more channels than anyone joins.
 *
 * The ceilings are generous next to the twenty rooms the application holds: they are there so the
 * maps cannot grow without end, not to make anything miss.
 */
const identities = new ExpiringCache<Identity>(500)
const liveStates = new ExpiringCache<LiveState>(500)
const cards = new ExpiringCache<UserCard>(200)
const channelInfos = new ExpiringCache<ChannelInfo>(200)
const IDENTITY_TTL = 30 * 60_000
const UNKNOWN_IDENTITY_TTL = 5 * 60_000
// Kept well under the two minutes between two renderer refreshes: at an equal lifetime the entry
// was still valid when the poll arrived, and the audience only moved every other round.
const LIVE_TTL = 60_000
const CARD_TTL = 10 * 60_000
// A follower count and a list of tags move on the scale of a stream, not of a poll: this one is
// read when a room opens, and the lifetime is what keeps a walk through the rooms from asking again.
const CHANNEL_INFO_TTL = 10 * 60_000
const EMPTY_CHANNEL_INFO_TTL = 60_000

function rememberIdentity(channel: string, value: Partial<Identity>) {
  const previous = identities.get(channel)
  const merged: Identity = { displayName: value.displayName || previous?.displayName || channel, avatarUrl: value.avatarUrl || previous?.avatarUrl || '' }
  identities.set(channel, merged, merged.avatarUrl ? IDENTITY_TTL : UNKNOWN_IDENTITY_TTL)
}
function rememberLive(channel: string, value: LiveState) {
  liveStates.set(channel, value, LIVE_TTL)
}
function knownIdentity(channel: string): Identity | null { return identities.get(channel) }
function knownLive(channel: string): LiveState | null { return liveStates.get(channel) }
function profileOf(channel: string): RoomProfile {
  const identity = knownIdentity(channel)
  const live = knownLive(channel) ?? { live: false }
  return { channel, displayName: identity?.displayName || channel, avatarUrl: identity?.avatarUrl ?? '', ...live }
}

async function scrapeProfile(channel: string): Promise<void> {
  try {
    const response = await net.fetch(`https://www.twitch.tv/${channel}`, {
      // Twitch's public page is translated: ask for it in the user's own language.
      headers: { 'User-Agent': 'Twichat/0.1', 'Accept-Language': `${locale},${locale === 'en' ? 'fr' : 'en'};q=0.6` },
      signal: AbortSignal.timeout(10000), redirect: 'follow'
    })
    if (!response.ok) fail('twitchProfileUnavailable')
    const declared = Number(response.headers.get('Content-Length') ?? 0)
    if (declared > 3 * 1024 * 1024) fail('twitchProfileTooLarge')
    const html = await response.text()
    if (html.length > 3 * 1024 * 1024) fail('twitchProfileTooLarge')
    const value = parsePublicProfile(channel, html)
    rememberIdentity(channel, { displayName: value.displayName, avatarUrl: value.avatarUrl })
    // No audience count: Twitch's public page names none, Helix is the only source of one.
    rememberLive(channel, { live: value.live, title: value.title, startedAt: value.startedAt })
  } catch { /* The room stays usable: keep whatever is already known. */ }
}

async function refreshLiveWithHelix(channels: string[], { token, clientId }: HelixAuth): Promise<void> {
  const query = new URLSearchParams()
  for (const channel of channels) query.append('user_login', channel)
  const response = await net.fetch(`https://api.twitch.tv/helix/streams?${query}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }, signal: AbortSignal.timeout(10000)
  })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('twitchStreamsUnavailable')
  const payload = await response.json() as { data?: HelixStream[] }
  const live = new Map(combineHelix(payload.data, []).map(stream => [stream.channel, stream]))
  for (const channel of channels) {
    const stream = live.get(channel)
    // Helix only returns live streams, so an absent login is an answer, not a gap.
    rememberLive(channel, stream ? { live: true, viewers: stream.viewers, title: stream.title || undefined, startedAt: stream.startedAt || undefined } : { live: false })
  }
}

export async function getRoomProfiles(input: unknown, auth: HelixAuth | null): Promise<RoomProfile[]> {
  if (!Array.isArray(input) || input.length > 20) fail('channelListInvalid')
  const channels = [...new Set(input.map(channelName))]
  const stale = channels.filter(channel => !knownLive(channel))
  if (stale.length && auth) {
    try {
      await Promise.all([refreshLiveWithHelix(stale, auth), getHelixProfiles(stale, auth.token, auth.clientId)])
      return channels.map(profileOf)
    } catch { /* Without Helix, the public page remains a complete source. */ }
  }
  const remaining = stale.filter(channel => !knownLive(channel))
  for (let index = 0; index < remaining.length; index += 4) await Promise.all(remaining.slice(index, index + 4).map(scrapeProfile))
  return channels.map(profileOf)
}

export async function getHelixProfiles(input: unknown, token: string, clientId: string): Promise<RoomProfile[]> {
  if (!Array.isArray(input) || input.length > 100) fail('userListInvalid')
  const logins = [...new Set(input.map(channelName))]
  const missing = logins.filter(login => !knownIdentity(login)?.avatarUrl)
  if (missing.length) {
    const query = new URLSearchParams()
    for (const login of missing) query.append('login', login)
    const response = await net.fetch(`https://api.twitch.tv/helix/users?${query}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }, signal: AbortSignal.timeout(10000)
    })
    if (response.status === 401) fail('twitchSessionExpired')
    if (!response.ok) fail('twitchAvatarsUnavailable')
    const payload = await response.json() as { data?: HelixUser[] }
    const byLogin = new Map(helixUsersToProfiles(payload.data).map(profile => [profile.channel, profile]))
    for (const login of missing) {
      const profile = byLogin.get(login)
      rememberIdentity(login, { displayName: profile?.displayName, avatarUrl: profile?.avatarUrl })
    }
  }
  return logins.map(profileOf)
}

// An empty language browses every locale; otherwise Helix narrows the catalog itself.
export async function getHelixStreams(token: string, clientId: string, language = ''): Promise<StreamSummary[]> {
  const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
  const streamsQuery = new URLSearchParams({ first: '100' })
  if (language) streamsQuery.set('language', language)
  const response = await net.fetch(`https://api.twitch.tv/helix/streams?${streamsQuery}`, { headers, signal: AbortSignal.timeout(12000) })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('twitchCatalogUnavailable')
  const payload = await response.json() as { data?: HelixStream[] }
  const ids = (payload.data ?? []).map(stream => String(stream.user_id ?? '')).filter(Boolean).slice(0, 100)
  if (!ids.length) return []
  const query = new URLSearchParams()
  for (const id of ids) query.append('id', id)
  const usersResponse = await net.fetch(`https://api.twitch.tv/helix/users?${query}`, { headers, signal: AbortSignal.timeout(12000) })
  if (!usersResponse.ok) fail('twitchProfilesUnavailable')
  const usersPayload = await usersResponse.json() as { data?: HelixUser[] }
  const streams = combineHelix(payload.data, usersPayload.data)
  for (const stream of streams) {
    rememberIdentity(stream.channel, { displayName: stream.displayName, avatarUrl: stream.avatarUrl })
    rememberLive(stream.channel, { live: true, viewers: stream.viewers, title: stream.title || undefined, startedAt: stream.startedAt || undefined })
  }
  return streams
}

// Twitch pages followed channels a hundred at a time: three pages cover real lists
// without letting an outsized collection stall the explorer.
/**
 * Walks a paged Helix list. `truncated` says the ceiling was reached with a cursor still in hand:
 * the caller has part of the list, not all of it, and until this was reported the difference was
 * invisible — a search over the followed channels simply did not find what it had never loaded.
 */
async function helixPages<T>(url: string, headers: Record<string, string>, pages: number, failure: ErrorKey): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  let cursor = ''
  for (let page = 0; page < pages; page++) {
    const query = new URL(url)
    if (cursor) query.searchParams.set('after', cursor)
    const response = await net.fetch(query.href, { headers, signal: AbortSignal.timeout(12000) })
    // Twitch answers 401 to both refusals here — a dead token and a token without the scope —
    // so the scope is settled before the call, from what the validation listed. A 401 that
    // reaches this line is the token itself; the 403 stays for the day Twitch tells them apart.
    if (response.status === 401) fail('twitchSessionExpired')
    if (response.status === 403) fail(failure)
    if (!response.ok) fail('twitchFollowedUnavailable')
    const payload = await response.json() as { data?: T[]; pagination?: { cursor?: unknown } }
    rows.push(...(Array.isArray(payload.data) ? payload.data : []))
    cursor = typeof payload.pagination?.cursor === 'string' ? payload.pagination.cursor : ''
    if (!cursor) break
  }
  return { rows, truncated: Boolean(cursor) }
}

async function helixUsersById(ids: string[], headers: Record<string, string>): Promise<HelixUser[]> {
  const users: HelixUser[] = []
  for (let index = 0; index < ids.length; index += 100) {
    const query = new URLSearchParams()
    for (const id of ids.slice(index, index + 100)) query.append('id', id)
    const response = await net.fetch(`https://api.twitch.tv/helix/users?${query}`, { headers, signal: AbortSignal.timeout(12000) })
    if (!response.ok) break // Without avatars the list stays readable: the initials take over.
    const payload = await response.json() as { data?: HelixUser[] }
    users.push(...(payload.data ?? []))
  }
  return users
}

// A token from a session opened before this view existed has no `user:read:follows`. The session
// checks that before calling; this key covers a grant revoked on twitch.tv since — Twitch answers
// 403 there — and only this section says so: the explorer keeps its catalog.
const FOLLOWS_DENIED = 'twitchFollowedScope' as const
/** A hundred channels a page. Reached, the list is short and the window says so. */
const FOLLOWED_PAGES = 20

export async function getFollowedChannels(userId: string, { token, clientId }: HelixAuth): Promise<FollowedChannels> {
  if (!/^\d{1,30}$/.test(userId)) fail('twitchFollowedReconnect')
  const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
  // Twenty pages rather than three. Pagination stops on its own when the cursor runs out, so an
  // account following forty channels pays for one request either way; the ceiling is only ever
  // reached by somebody who really does follow two thousand, and they are told when it is.
  const [followedPages, streamPages] = await Promise.all([
    helixPages<unknown>(`https://api.twitch.tv/helix/channels/followed?user_id=${userId}&first=100`, headers, FOLLOWED_PAGES, FOLLOWS_DENIED),
    helixPages<HelixStream>(`https://api.twitch.tv/helix/streams/followed?user_id=${userId}&first=100`, headers, FOLLOWED_PAGES, FOLLOWS_DENIED)
  ])
  const { rows: followedRows } = followedPages
  const { rows: streamRows } = streamPages
  const followed: FollowedChannel[] = parseFollowedChannels(followedRows)
  const liveIds = streamRows.map(stream => String(stream.user_id ?? '')).filter(id => /^\d{1,30}$/.test(id))
  const streaming = new Set(streamRows.flatMap(stream => { try { return [channelName(stream.user_login)] } catch { return [] } }))
  // Live stream avatars first: those are the cards seen without scrolling.
  const offlineIds = followed.filter(entry => entry.id && !streaming.has(entry.channel)).map(entry => entry.id)
  const users = await helixUsersById([...new Set([...liveIds, ...offlineIds])].slice(0, 300), headers)
  const live = combineHelix(streamRows, users)
  const offline = offlineFollowed(followed, live, users)
  for (const stream of live) {
    rememberIdentity(stream.channel, { displayName: stream.displayName, avatarUrl: stream.avatarUrl })
    rememberLive(stream.channel, { live: true, viewers: stream.viewers, title: stream.title || undefined, startedAt: stream.startedAt || undefined })
  }
  // Only identity is kept for offline channels: marking three hundred rooms
  // "not live" would make the sidebar lie for two minutes the first time one goes live.
  for (const profile of offline) rememberIdentity(profile.channel, { displayName: profile.displayName, avatarUrl: profile.avatarUrl })
  return { live, offline, truncated: followedPages.truncated || streamPages.truncated }
}

// A channel's numeric id never changes: keeping it avoids a `users` call on every
// follow check. The follow state itself is never cached — it changes on twitch.tv,
// outside the app, and a stale answer would keep someone waiting for nothing.
const broadcasterIds = new ExpiringCache<string>(500)
/** An id never changes, so the lifetime is only there to let an entry age out of the ceiling. */
const BROADCASTER_ID_TTL = 24 * 60 * 60_000

async function broadcasterId(login: string, hint: string, headers: Record<string, string>): Promise<string> {
  if (/^\d{1,30}$/.test(hint)) return broadcasterIds.set(login, hint, BROADCASTER_ID_TTL)
  const known = broadcasterIds.get(login)
  if (known) return known
  const response = await net.fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
    headers, signal: AbortSignal.timeout(10000)
  })
  if (response.status === 401) fail('twitchSessionExpired')
  if (!response.ok) fail('twitchProfileUnavailable')
  const payload = await response.json() as { data?: HelixUser[] }
  const id = String(payload.data?.[0]?.id ?? '')
  if (!/^\d{1,30}$/.test(id)) fail('twitchAccountGone')
  // Emptying the whole table on its five-hundredth entry threw away four hundred and ninety-nine
  // good answers to make room for one: the ceiling now evicts the oldest write instead.
  return broadcasterIds.set(login, id, BROADCASTER_ID_TTL)
}

/**
 * How long the signed-in account has followed this channel — and nothing more: Twitch closed
 * the follow and unfollow calls on July 27, 2021, with no replacement. The gesture belongs to
 * the user, on twitch.tv; the app settles for knowing where they stand.
 */
export async function getFollowStatus(input: unknown, hint: unknown, userId: string, { token, clientId }: HelixAuth): Promise<FollowStatus> {
  const channel = channelName(input)
  const unknownStatus: FollowStatus = { channel, known: false, following: false, followedAt: '' }
  if (!/^\d{1,30}$/.test(userId)) return unknownStatus
  const headers = { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
  const id = await broadcasterId(channel, typeof hint === 'string' ? hint : '', headers)
  const response = await net.fetch(`https://api.twitch.tv/helix/channels/followed?user_id=${userId}&broadcaster_id=${id}&first=1`, {
    headers, signal: AbortSignal.timeout(10000)
  })
  // A token opened before this view existed has no `user:read:follows`: the question stays
  // unanswered, and that is exactly what the banner should say — the room itself does not change.
  if (response.status === 401 || response.status === 403) return unknownStatus
  if (!response.ok) fail('twitchFollowUnknown')
  const followedAt = parseFollowedAt(await response.json())
  return { channel, known: true, following: !!followedAt, followedAt }
}

// The follower total is a bonus line on the card: an endpoint that refuses this token
// must cost that line alone, never the profile itself.
async function getFollowerTotal(broadcasterId: string, { token, clientId }: HelixAuth): Promise<number | undefined> {
  try {
    const response = await net.fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}&first=1`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }, signal: AbortSignal.timeout(10000)
    })
    return response.ok ? followerTotal(await response.json()) : undefined
  } catch { return undefined }
}

export async function getUserCard(input: unknown, auth: HelixAuth): Promise<UserCard> {
  const login = channelName(input)
  let card = cards.get(login)
  if (!card) {
    const response = await net.fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
      headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId }, signal: AbortSignal.timeout(10000)
    })
    if (response.status === 401) fail('twitchSessionExpired')
    if (!response.ok) fail('twitchProfileUnavailable')
    const payload = await response.json() as { data?: HelixUser[] }
    const fetched = helixUserToCard(payload.data)
    if (!fetched) fail('twitchAccountGone')
    const id = String(payload.data?.[0]?.id ?? '')
    if (/^\d{1,30}$/.test(id)) fetched.followers = await getFollowerTotal(id, auth)
    rememberIdentity(login, { displayName: fetched.displayName, avatarUrl: fetched.avatarUrl })
    // Held onto rather than read back: the ceiling could evict it between the write and the read.
    card = cards.set(login, fetched, CARD_TTL)
  }
  // The live line has its own lifetime; the card reads whatever the shared cache already knows.
  if (!knownLive(login)) await refreshLiveWithHelix([login], auth).catch(() => {})
  return { ...card, ...(knownLive(login) ?? { live: false }) }
}

/**
 * What the room header says about the channel itself, rather than about the connection that
 * brought it: how many people follow it, and the tags it is listed under. Both hold while the
 * channel is offline, which is why neither comes from `helix/streams`.
 *
 * Two independent calls: a channel with no tags still has followers, and an endpoint this token
 * cannot reach costs its own line and nothing else.
 */
export async function getChannelInfo(input: unknown, hint: unknown, auth: HelixAuth): Promise<ChannelInfo> {
  const channel = channelName(input)
  const known = channelInfos.get(channel)
  if (known) return known
  const headers = { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId }
  const id = await broadcasterId(channel, typeof hint === 'string' ? hint : '', headers)
  const [followers, tags] = await Promise.all([getFollowerTotal(id, auth), getChannelTags(id, headers)])
  // Both calls swallow their own failure, so an answer with nothing in it is as likely to be a
  // token that has just expired as a channel with no tags: it is held for a minute, not for ten,
  // or the header would stay empty long after the session renewed itself.
  const empty = followers === undefined && !tags.length
  return channelInfos.set(channel, { channel, followers, tags }, empty ? EMPTY_CHANNEL_INFO_TTL : CHANNEL_INFO_TTL)
}

async function getChannelTags(broadcasterId: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const response = await net.fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, {
      headers, signal: AbortSignal.timeout(10000)
    })
    return response.ok ? channelTags(await response.json()) : []
  } catch { return [] }
}
