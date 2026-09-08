import type { ChatBadge } from '../shared/types'

/**
 * A badge is named by its set and its version, the way the IRC tag spells the pair:
 * `moderator/1`, `subscriber/0`, `bits/1000`. The version is not decoration — it is what
 * picks the image, and it is why `badgeNames` in `irc.ts` cannot be what the log renders.
 */
const SET = /^[a-zA-Z0-9_-]{1,64}$/
const VERSION = /^[a-zA-Z0-9_.-]{1,32}$/
// Twitch serves every badge from the host the renderer's CSP already allows for the emotes.
const BADGE_HOST = 'static-cdn.jtvnw.net'
const MAX_BADGES = 2000
const MAX_TITLE = 100

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The address Twitch gave, or nothing. Built by no one here: a badge id says nothing about its file. */
function badgeImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === BADGE_HOST && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

/** The key both sides agree on: what the `badges` tag carries, unchanged. */
export const badgeKey = (set: string, version: string) => `${set}/${version}`

export function parseTwitchBadges(payload: unknown): ChatBadge[] {
  const sets = Array.isArray(object(payload)?.data) ? object(payload)!.data as unknown[] : []
  const result: ChatBadge[] = []
  for (const value of sets) {
    const set = object(value)
    const setId = set?.set_id
    if (typeof setId !== 'string' || !SET.test(setId) || !Array.isArray(set?.versions)) continue
    for (const item of set.versions as unknown[]) {
      const version = object(item)
      const id = version?.id
      if (typeof id !== 'string' || !VERSION.test(id)) continue
      // The 2x file lands in an 18-pixel slot: it is the one that stays sharp on a dense screen.
      const url = badgeImage(version?.image_url_2x) || badgeImage(version?.image_url_1x)
      if (!url) continue
      const title = typeof version?.title === 'string' ? version.title.trim().slice(0, MAX_TITLE) : ''
      result.push({ id: badgeKey(setId, id), url, title: title || setId })
      if (result.length >= MAX_BADGES) return result
    }
  }
  return result
}

/** Later groups win, so a channel's own subscriber badge takes the place of the global one. */
export function mergeTwitchBadges(...groups: ChatBadge[][]): ChatBadge[] {
  const merged = new Map<string, ChatBadge>()
  for (const group of groups) for (const badge of group) merged.set(badge.id, badge)
  return [...merged.values()]
}
