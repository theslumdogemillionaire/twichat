import type { BufferMode, ChatFont, ChatPreferences, LayoutPreferences, NotificationPreferences, PlaybackPreferences, PlayerWindowState, ReplyReference, Theme, WindowBounds } from './types'
import { fail, type ErrorKey } from './errors'
import { isLocale } from './i18n'

export function channelName(value: unknown): string {
  if (typeof value !== 'string') fail('channelInvalid')
  const channel = value.trim().replace(/^#/, '').toLowerCase()
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) fail('channelFormat')
  return channel
}

export function chatText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) fail('messageEmpty')
  const text = value.trim()
  // Leaves room for IRC command framing within Twitch’s line limit.
  if (Buffer.byteLength(text, 'utf8') > 450) fail('messageTooLong')
  if (text.startsWith('/') && !text.startsWith('/me ')) fail('messageCommandUnsupported')
  return text
}

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const name = (value: unknown) => typeof value === 'string' ? value.slice(0, 60) : ''
/** A reply's parent as it comes back from the renderer: bounded before it leaves for Twitch and the display. */
export function chatReply(value: unknown): ReplyReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !MESSAGE_ID.test(input.id)) fail('messageParentInvalid')
  const threadId = typeof input.threadId === 'string' && MESSAGE_ID.test(input.threadId) ? input.threadId : input.id
  return {
    id: input.id, login: name(input.login).toLowerCase(), user: name(input.user),
    text: typeof input.text === 'string' ? input.text.replace(/[\r\n\0]+/gu, ' ').slice(0, 500) : '',
    threadId, threadLogin: name(input.threadLogin).toLowerCase(), threadUser: name(input.threadUser)
  }
}

export const QUALITIES = ['best', '720p60,720p,best', '480p,best', '360p,worst', 'audio_only'] as const

export function qualityName(value: unknown): string {
  if (typeof value !== 'string' || !(QUALITIES as readonly string[]).includes(value)) fail('qualityInvalid')
  return value
}

export const THEMES = ['system', 'light', 'dark'] as const

/** An unknown preference falls back to the system theme rather than failing: the theme is not critical. */
export function themeName(value: unknown): Theme {
  return (THEMES as readonly string[]).includes(value as string) ? value as Theme : 'system'
}

/** The chosen language: empty to follow the system, otherwise a language we know how to speak. */
export function languageChoice(value: unknown): string {
  return isLocale(value) ? value : ''
}

export const BUFFER_MODES = ['live', 'balanced', 'comfort'] as const

/** Like the theme: an unknown mode falls back to the player's original buffer instead of bringing the whole file down. */
export function bufferMode(value: unknown): BufferMode {
  return (BUFFER_MODES as readonly string[]).includes(value as string) ? value as BufferMode : 'balanced'
}

/** Nothing critical here either: the defaults reproduce the player's behavior from before this setting. */
export function playbackPreferences(value: unknown): PlaybackPreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  // A missing volume means full: that is what the native controls did before they gave way.
  const volume = typeof input.volume === 'number' && Number.isFinite(input.volume) ? Math.min(1, Math.max(0, input.volume)) : 1
  return { buffer: bufferMode(input.buffer), autoplay: input.autoplay !== false, detached: input.detached === true, volume, muted: input.muted === true }
}

/** No preference means consent: mentions already notified before the setting existed. */
export function notificationPreferences(value: unknown): NotificationPreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { mentions: input.mentions !== false, whispers: input.whispers !== false }
}

export const CHAT_FONTS = ['default', 'system', 'sans', 'serif', 'mono'] as const

/** Like the theme: an unknown typeface falls back to the shipped one rather than failing. */
export function chatFont(value: unknown): ChatFont {
  return (CHAT_FONTS as readonly string[]).includes(value as string) ? value as ChatFont : 'default'
}

/**
 * Same rule: the links were clickable before the setting, so only an explicit false switches
 * them off. The GIFs follow it rather than starting hidden — Twitch shows them, and a message
 * whose image is missing reads as a message someone truncated.
 */
export function chatPreferences(value: unknown): ChatPreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { links: input.links !== false, confirm: input.confirm !== false, gifs: input.gifs !== false, font: chatFont(input.font) }
}

/** Wide bounds: they rule out the absurd values of a damaged file, the display tightens them afterwards. */
const PLAYER_WIDTH_LIMIT = 4000
/**
 * Twitch's own ceiling: 100 chat rooms at once per account, since 15 May 2024. Not a number this
 * application picked. The 20 that used to stand in its place was Twitch's *rate* — 20 JOIN per
 * 10 seconds — which the pacing in the IRC client already keeps us well under, and which says
 * nothing about how many rooms may be held at once.
 */
export const CONCURRENT_ROOMS = 100

export const WINDOW_MIN_WIDTH = 760
export const WINDOW_MIN_HEIGHT = 560
const pixels = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 32000 ? Math.round(value) : undefined

/** Nothing is critical here: a dubious layout falls back to the default layout instead of rejecting the preferences. */
export function layoutPreferences(value: unknown): LayoutPreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const width = typeof input.playerWidth === 'number' && Number.isFinite(input.playerWidth) ? Math.round(input.playerWidth) : 0
  return {
    playerWidth: width > 0 ? Math.min(width, PLAYER_WIDTH_LIMIT) : 0, sidebarCollapsed: input.sidebarCollapsed === true,
    // No setting means consent: going idle is the default behavior.
    hideIdleChannels: input.hideIdleChannels !== false, idleChannelHours: idleChannelHours(input.idleChannelHours)
  }
}

/** The idle delays offered in the settings, in hours: 6 h, 12 h, then 1, 3, 7 and 30 days. */
export const IDLE_DELAYS = [6, 12, 24, 72, 168, 720] as const
export const DEFAULT_IDLE_HOURS = 168

/**
 * The idle delay, bounded to what the settings offer. A damaged column returning
 * `0` would otherwise fold away every room that is not live, all at once.
 */
export function idleChannelHours(value: unknown): number {
  return (IDLE_DELAYS as readonly number[]).includes(value as number) ? value as number : DEFAULT_IDLE_HOURS
}

/** An incomplete geometry is forgotten: the window then takes back its original size. */
function bounds(value: unknown, minWidth: number, minHeight: number): WindowBounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const width = pixels(input.width), height = pixels(input.height)
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  const x = pixels(input.x), y = pixels(input.y)
  return {
    width: Math.max(width, minWidth), height: Math.max(height, minHeight),
    ...(x !== undefined && y !== undefined ? { x, y } : {}), maximized: input.maximized === true
  }
}

export function windowBounds(value: unknown): WindowBounds | undefined {
  return bounds(value, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
}

/** The video window has neither chat nor sidebar to house: its minimum goes far below the main window's. */
export const PLAYER_WINDOW_MIN_WIDTH = 320
export const PLAYER_WINDOW_MIN_HEIGHT = 220
export function playerWindowBounds(value: unknown): PlayerWindowState | undefined {
  const size = bounds(value, PLAYER_WINDOW_MIN_WIDTH, PLAYER_WINDOW_MIN_HEIGHT)
  return size ? { ...size, pinned: (value as Record<string, unknown>).pinned === true } : undefined
}

export function mediaUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 16000) fail('mediaUrlInvalid')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !['ttvnw.net', 'twitchcdn.net'].some(domain => url.hostname.endsWith(`.${domain}`))) {
    fail('mediaHostForbidden')
  }
  return url
}

/** Twitch refuses a longer whisper outright; cutting one here would send half a sentence. */
export const WHISPER_LIMIT = 500

/** The message as Twitch will take it. Empty and over-long are ours to catch, not its. */
export function whisperText(input: unknown): string {
  if (typeof input !== 'string') fail('whisperEmpty')
  const text = input.trim()
  if (!text) fail('whisperEmpty')
  if ([...text].length > WHISPER_LIMIT) fail('whisperTooLong')
  return text
}

/**
 * What a refusal from Twitch means, in the user's terms. The two documentation pages do not
 * agree on the code for a recipient who refuses whispers — the API reference says 403, the
 * whispers page says 400 — so both lead to the same sentence rather than to a guess about
 * which page is right.
 *
 * A 401 is the one that reads oddly: the scope was checked before the call, so what is left is
 * a session that has just died, or the verified phone number Twitch requires of every sender
 * and never mentions until it refuses. The sentence names both.
 */
export function whisperFailure(status: number): ErrorKey {
  if (status === 400 || status === 403) return 'whisperRefused'
  if (status === 401) return 'whisperNeedsPhone'
  if (status === 429) return 'whisperTooMany'
  return 'whisperUnavailable'
}
