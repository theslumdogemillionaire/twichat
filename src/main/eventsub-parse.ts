import { channelName } from '../shared/validation'

/**
 * A whisper id, kept as Twitch wrote it. Deliberately not the UUID shape the one documented
 * example happens to have: this id is a deduplication key and a primary key, neither of which
 * needs a form, and a shape guessed from a single sample would discard a real whisper — for
 * good, since nothing replays it — the day Twitch writes one differently.
 */
const whisperId = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : ''
/** A login Twitch may have left out: unreadable gives an empty string, never an exception. */
const optionalLogin = (value: unknown) => { try { return channelName(value) } catch { return '' } }

/** An outgoing raid: the watched channel takes its viewers somewhere else. */
export interface RaidNotice {
  from: string
  to: string
  toDisplayName: string
  viewers: number
}

/**
 * A whisper, as EventSub delivers it. Almost nothing: the pair, an id, and plain text.
 * No emote tag, no colour, no badges — nothing of what a PRIVMSG carries — and no time
 * of its own either, which is why the frame's own timestamp is what dates it.
 */
export interface WhisperNotice {
  id: string
  from: string
  /** Twitch's own id for the sender: the identity that survives a change of login. */
  fromId: string
  fromDisplayName: string
  /** Whom Twitch delivered it to: the account it belongs to, said by the frame itself. */
  to: string
  text: string
  /** Milliseconds, from the frame's metadata; zero when Twitch dated it unreadably. */
  at: number
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
  /** `subscription` names the type Twitch took back, or is empty when the frame did not say. */
  | { type: 'revocation'; subscription: string }
  | { type: 'raid'; raid: RaidNotice }
  | { type: 'whisper'; whisper: WhisperNotice }
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

/**
 * The whisper brought back to what the application handles. A body is kept whole up to a
 * length no whisper reaches — Twitch caps them far below — so nothing legitimate is cut,
 * and a frame claiming a megabyte still cannot settle in memory.
 */
export function whisperNotice(payload: unknown, at: number): WhisperNotice | null {
  if (!payload || typeof payload !== 'object') return null
  const event = payload as Record<string, unknown>
  try {
    const id = whisperId(event.whisper_id)
    if (!id) return null
    const from = channelName(event.from_user_login)
    const body = (event.whisper ?? {}) as Record<string, unknown>
    const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : ''
    if (!text.trim()) return null
    const name = typeof event.from_user_name === 'string' ? event.from_user_name.slice(0, 60) : ''
    const fromId = typeof event.from_user_id === 'string' && /^\d{1,30}$/.test(event.from_user_id) ? event.from_user_id : ''
    return { id, from, fromId, fromDisplayName: name || from, to: optionalLogin(event.to_user_login), text, at }
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
    case 'revocation': {
      const subscription = (payload.subscription ?? {}) as Record<string, unknown>
      return { type: 'revocation', subscription: typeof subscription.type === 'string' ? subscription.type : '' }
    }
    case 'notification': {
      if (metadata.subscription_type === 'channel.raid') {
        const raid = raidNotice(payload.event)
        return raid ? { type: 'raid', raid } : IGNORED
      }
      if (metadata.subscription_type === 'user.whisper.message') {
        // The event carries no time: the frame's own is the only date the whisper will ever have.
        const stamped = Date.parse(String(metadata.message_timestamp ?? ''))
        const whisper = whisperNotice(payload.event, Number.isFinite(stamped) ? stamped : 0)
        return whisper ? { type: 'whisper', whisper } : IGNORED
      }
      return IGNORED
    }
    default: return IGNORED
  }
}
