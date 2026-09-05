import { m } from '../shared/i18n'

/** How long the live stream has been running, from the ISO 8601 date Helix returns. */
export function liveUptime(startedAt: string | undefined, now = Date.now()): string {
  const start = startedAt ? Date.parse(startedAt) : NaN
  if (!Number.isFinite(start)) return ''
  // A local clock ahead of Twitch would give a negative duration: the live stream then starts right now.
  const minutes = Math.floor(Math.max(0, now - start) / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours ? m.follow.hoursAndMinutes(hours, minutes % 60) : `${minutes} min`
}
