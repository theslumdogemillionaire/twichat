import type { FollowStatus } from '../shared/types'
import { m } from '../shared/i18n'

// The badges Twitch exempts from followers-only mode: the channel, its moderators, its VIPs and
// its subscribers — `founder` being the subscriber badge of the earliest supporters.
const EXEMPT = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'founder'])
export function exemptFromFollowersOnly(badges: string[] | undefined): boolean {
  return (badges ?? []).some(badge => EXEMPT.has(badge))
}

/**
 * Followers-only mode as ROOMSTATE carries it: tag absent or `-1` when everyone
 * may write, otherwise the number of follow minutes required — `0` meaning "following is enough".
 */
export function followersOnlyMinutes(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,7}$/.test(value)) return null
  const minutes = Number(value)
  return minutes < 0 ? null : minutes
}

/**
 * A follow duration phrased the way it is read. Twitch sets this mode in minutes, but a room that
 * asks for three days must not display "4320 minutes".
 */
export function followDelay(minutes: number): string {
  const total = Math.max(0, Math.ceil(minutes))
  if (total < 60) return m.follow.minutes(total)
  const hours = Math.floor(total / 60)
  if (total < 1440) return total % 60 ? m.follow.hoursAndMinutes(hours, total % 60) : m.follow.hours(hours)
  const days = Math.floor(total / 1440)
  const rest = Math.floor((total % 1440) / 60)
  return rest ? m.follow.daysAndHours(days, rest) : m.follow.days(days)
}

/** What the banner above the input field shows, and whether it still has an action to offer. */
export interface FollowNotice {
  title: string
  detail: string
  /** True as long as following the channel changes something: the button to Twitch appears only there. */
  follow: boolean
}

/**
 * What the connected account lacks to write in this room. `null` when nothing is lacking —
 * room open to everyone, exempt badge, follow old enough — or when the answer is not there yet:
 * a banner that blinks for the length of a network call is worth less than no banner at all.
 */
export function followNotice(minutes: number | null, status: FollowStatus | undefined, channel: string, now = Date.now()): FollowNotice | null {
  if (minutes === null || !status) return null
  if (!status.known) return {
    title: m.follow.followersOnlyTitle(channel),
    detail: m.follow.reconnectForFollow,
    follow: true
  }
  if (!status.following) return {
    title: m.follow.followToWrite(channel),
    detail: minutes > 0 ? m.follow.followForDelay(followDelay(minutes)) : m.follow.followersOnly,
    follow: true
  }
  const since = Date.parse(status.followedAt)
  if (!Number.isFinite(since)) return null
  const remaining = Math.ceil((since + minutes * 60_000 - now) / 60_000)
  if (remaining <= 0) return null
  return {
    title: m.follow.waitBeforeWriting(followDelay(remaining)),
    detail: m.follow.followedSinceButNeeds(channel, followDelay(Math.floor((now - since) / 60_000)), followDelay(minutes)),
    follow: false
  }
}
