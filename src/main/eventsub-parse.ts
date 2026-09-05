import { channelName } from '../shared/validation'

/** An outgoing raid: the watched channel takes its viewers somewhere else. */
export interface RaidNotice {
  from: string
  to: string
  toDisplayName: string
  viewers: number
}

/**
 * An EventSub frame cut down to what the connection needs. Everything else — subscription
 * types Twichat never asks for, unknown fields — falls back to `ignored`:
 * an unreadable frame must never cut the socket.
 */
export type EventSubFrame =
  | { type: 'welcome'; sessionId: string; keepalive: number }
  | { type: 'keepalive' }
  | { type: 'reconnect'; url: string }
  | { type: 'revocation' }
  | { type: 'raid'; raid: RaidNotice }
  | { type: 'ignored' }

const IGNORED: EventSubFrame = { type: 'ignored' }

/** The raid as Twitch describes it, brought back to the ids the rest of the app handles. */
export function raidNotice(payload: unknown): RaidNotice | null {
  if (!payload || typeof payload !== 'object') return null
  const event = payload as Record<string, unknown>
  try {
    const from = channelName(event.from_broadcaster_user_login)
    const to = channelName(event.to_broadcaster_user_login)
    // Twitch can raid a channel to itself during a test: following it would amount to doing nothing.
    if (from === to) return null
    const name = typeof event.to_broadcaster_user_name === 'string' ? event.to_broadcaster_user_name.slice(0, 60) : ''
    const viewers = Number(event.viewers)
    return { from, to, toDisplayName: name || to, viewers: Number.isFinite(viewers) && viewers > 0 ? Math.floor(viewers) : 0 }
  } catch { return null }
}

export function parseEventSubFrame(raw: string): EventSubFrame {
  let frame: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return IGNORED
    frame = value as Record<string, unknown>
  } catch { return IGNORED }
  const metadata = (frame.metadata ?? {}) as Record<string, unknown>
  const payload = (frame.payload ?? {}) as Record<string, unknown>
  const session = (payload.session ?? {}) as Record<string, unknown>
  switch (metadata.message_type) {
    case 'session_welcome': {
      const sessionId = typeof session.id === 'string' ? session.id : ''
      // Twitch sets its own keepalive pace; the watchdog follows what it announces.
      const keepalive = Number(session.keepalive_timeout_seconds)
      if (!sessionId) return IGNORED
      return { type: 'welcome', sessionId, keepalive: Number.isFinite(keepalive) && keepalive > 0 ? Math.min(600, keepalive) : 10 }
    }
    case 'session_keepalive': return { type: 'keepalive' }
    case 'session_reconnect': {
      const url = typeof session.reconnect_url === 'string' ? session.reconnect_url : ''
      return url.startsWith('wss://') ? { type: 'reconnect', url } : IGNORED
    }
    case 'revocation': return { type: 'revocation' }
    case 'notification': {
      if (metadata.subscription_type !== 'channel.raid') return IGNORED
      const raid = raidNotice(payload.event)
      return raid ? { type: 'raid', raid } : IGNORED
    }
    default: return IGNORED
  }
}
