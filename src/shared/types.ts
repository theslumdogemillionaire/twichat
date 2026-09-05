import type { Locale } from './i18n'
export type Connection = 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'error'
/**
 * The quoted parent of a reply, as Twitch delivers it in the `reply-*` tags.
 * Everything comes from the tags: the quote stays accurate even when the parent has left
 * the history, predates joining the room, or was deleted.
 */
export interface ReplyReference {
  id: string
  login: string
  user: string
  text: string
  /** Thread root: `reply-thread-parent-msg-id`. Equals `id` when replying to the root itself. */
  threadId: string
  threadLogin: string
  threadUser: string
}
export interface ChatMessage {
  id: string
  channel: string
  user: string
  login: string
  text: string
  color: string
  badges: string[]
  time: number
  action: boolean
  own?: boolean
  /** Local echo of a send: its `id` stays provisional until Twitch has confirmed the message. */
  pending?: boolean
  system?: boolean
  /** The `msg-id` of a Twitch NOTICE. Stable where its text is translated and reworded. */
  notice?: string
  emotes?: string
  /** The `gifs` tag as Twitch sent it: `<start>-<end>|<id>|<url>`, one entry per GIPHY image. */
  gifs?: string
  reply?: ReplyReference
}
export type ChatEvent =
  | { type: 'status'; status: Connection; detail: string }
  | { type: 'account'; login: null; detail: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'joined'; channel: string }
  | { type: 'clear'; channel: string; user?: string; id?: string }
  | { type: 'roomstate'; channel: string; tags: Record<string, string> }
  /** The signed-in account's badges in this room: they alone say who escapes followers-only mode. */
  | { type: 'userstate'; channel: string; badges: string[] }
  /**
   * An outgoing raid, as EventSub reports it: the chat of the departing channel says nothing.
   * `channel` is the one being watched, `to` the one where the live stream carries on.
   */
  | { type: 'raid'; channel: string; to: string; toDisplayName: string; viewers: number }
/** The interface theme. `system` follows the machine's light/dark setting. */
export type Theme = 'system' | 'light' | 'dark'
/**
 * The video buffer size, meaning the seconds of lead kept in memory.
 * `live` hugs the live stream and copes badly with hiccups; `comfort` keeps a roomy
 * reserve at the cost of latency. `balanced` takes back the player's original values.
 */
export type BufferMode = 'live' | 'balanced' | 'comfort'
/** What governs the player, independently of the quality chosen room by room. */
export interface PlaybackPreferences {
  buffer: BufferMode
  /** Starts the video on entering a room. When false, the chat opens alone and the video waits for a click. */
  autoplay: boolean
  /** Plays the video in its own window rather than in the room. Kept per account, like the rest. */
  detached: boolean
  /** The player volume, from 0 to 1. The native video controls being hidden, it is set — and remembered — by the application. */
  volume: number
  muted: boolean
}
/** What the application is allowed to raise with the system. */
export interface NotificationPreferences {
  /** System notification when you are mentioned, window in the background. The list counter does not depend on this choice. */
  mentions: boolean
}
/** How the chat itself reads. */
export interface ChatPreferences {
  /** Turns the addresses in a message into links opening in the browser. When false, they stay plain text. */
  links: boolean
  /** Shows the address and asks before leaving for the browser. Turned off from the dialog itself, or here. */
  confirm: boolean
  /** Shows the GIFs sent from Twitch's GIPHY keyboard. When false, the title Twitch wrote in the body stays. */
  gifs: boolean
}
/** The sizes set by hand: they follow the account from one room to the next and from one session to the next. */
export interface LayoutPreferences {
  /** Width of the video dock, in pixels. `0` leaves the default width, computed from the window. */
  playerWidth: number
  sidebarCollapsed: boolean
  /** Folds into "idle" the rooms nothing has stirred for `idleChannelHours` hours. */
  hideIdleChannels: boolean
  /** The delay, in hours, past which a silent room goes idle. */
  idleChannelHours: number
}
/** The window geometry: it belongs to the main process, the only one able to measure it. */
export interface WindowBounds { width: number; height: number; x?: number; y?: number; maximized: boolean }
/** The detached window keeps one thing beyond its geometry: whether it stays above the others. */
export interface PlayerWindowState extends WindowBounds { pinned: boolean }
export interface Preferences {
  channels: string[]; active: string; quality: string; theme: Theme; layout: LayoutPreferences
  /** The interface language. When empty, it follows the system's. */
  language: string
  playback: PlaybackPreferences; notifications: NotificationPreferences; chat: ChatPreferences; window?: WindowBounds
  /** The geometry and the pinning of the detached video window, once it has been opened at least once. */
  playerWindow?: PlayerWindowState
}
/** What an account pushes to the renderer when the session switches from one account to another. */
export interface ScopedPreferences { scope: string; preferences: Preferences; locale: Locale }
/**
 * Which modifier plays the part of the command key: `⌘` on a Mac, Ctrl on Windows and Linux.
 * It is shared rather than decided in the window, because only the main process knows.
 */
export type CommandKey = 'meta' | 'ctrl'

export interface Snapshot {
  preferences: Preferences
  /**
   * Which modifier plays the part of the command key here. Resolved by the main process, since
   * it is the only side holding `process.platform`, and read by every shortcut and every label.
   */
  commandKey: CommandKey
  /** The language resolved by the main process: the account's choice, otherwise the system's. */
  locale: Locale
  /** The account these preferences belong to. It goes back unchanged on save. */
  scope: string
  status: Connection
  account: string | null
  savedAccounts: string[]
  savedAvatars: Record<string, string>
  roomStates: Record<string, Record<string, string>>
  userBadges: Record<string, string[]>
}
export interface RoomProfile {
  channel: string
  displayName: string
  avatarUrl: string
  live: boolean
  viewers?: number
  title?: string
  /** Start of the live stream, as Helix dates it in ISO 8601. Absent outside Helix: the public page does not carry it. */
  startedAt?: string
}
export interface StreamSummary {
  id: string
  channel: string
  displayName: string
  avatarUrl: string
  thumbnailUrl: string
  title: string
  game: string
  viewers: number
  tags: string[]
  language: string
  startedAt: string
}
/** The channels the signed-in account follows: the live streams first, the rest of the list after. */
export interface FollowedChannels {
  live: StreamSummary[]
  offline: RoomProfile[]
  /**
   * Twitch was still offering more than the list carries. The window says so rather than letting
   * a search look broken: a channel it never loaded is one it can never find.
   */
  truncated: boolean
}
export interface UserCard {
  login: string
  displayName: string
  avatarUrl: string
  description: string
  broadcasterType: '' | 'affiliate' | 'partner'
  createdAt: string
  followers?: number
  live: boolean
  viewers?: number
  title?: string
}
/**
 * Where the signed-in account stands with a channel. Twichat can only read it: Twitch closed
 * its "follow" and "unfollow" calls on July 27, 2021, and put nothing in their place.
 * Following therefore stays a gesture the user makes on twitch.tv; the application takes them there.
 */
export interface FollowStatus {
  channel: string
  /** False when the token lacks `user:read:follows`: the question stays unanswered, the room stays usable. */
  known: boolean
  following: boolean
  /** The start of the follow, dated by Helix in ISO 8601. Empty as long as the channel is not followed. */
  followedAt: string
}
export interface TwitchEmote {
  id: string
  name: string
  scope: 'global' | 'channel'
  type: string
}
export type EmoteSource = '7tv' | 'bttv' | 'ffz'
export interface ThirdPartyEmote {
  code: string
  url: string
  source: EmoteSource
  animated: boolean
}
/** What the detached video window receives on opening: enough to play the channel without replaying the room's initialization. */
export interface DetachedContext {
  channel: string
  quality: string
  pinned: boolean
  /** Start the picture on opening: the room's autoplay, or the video that was already running. */
  play: boolean
  playback: PlaybackPreferences
  theme: Theme
  locale: Locale
}
/** What a mention passes to the main process: enough to title the notification, nothing more. */
export interface MentionNotice { channel: string; user: string; text: string }
export interface TwichatAPI {
  init(): Promise<Snapshot>
  join(channel: string): Promise<void>
  part(channel: string): Promise<void>
  send(channel: string, text: string, reply?: ReplyReference): Promise<void>
  reconnect(): Promise<void>
  anonymous(): Promise<void>
  useSavedAccount(login: string): Promise<string>
  savedAvatars(): Promise<Record<string, string>>
  browserLogin(mode?: 'open' | 'copy'): Promise<string>
  authenticate(token: string): Promise<string>
  logout(): Promise<void>
  /**
   * Signing out keeps the account for next time. This is the other choice: its credentials, its
   * cached picture and everything it had set go, and it is not offered again. Answers the accounts
   * that are left.
   */
  forgetAccount(login: string): Promise<string[]>
  /** `scope` is the one received with these preferences: a save that lags a switch is dropped, not written to the next account. */
  savePreferences(preferences: Preferences, scope: string): Promise<void>
  profiles(channels: string[]): Promise<RoomProfile[]>
  chatterProfiles(logins: string[]): Promise<RoomProfile[]>
  userCard(login: string): Promise<UserCard>
  /** `roomId` avoids a round trip when ROOMSTATE has already given the channel's id. */
  followStatus(channel: string, roomId?: string): Promise<FollowStatus>
  thirdPartyEmotes(channel: string, roomId: string): Promise<ThirdPartyEmote[]>
  twitchEmotes(roomId: string): Promise<TwitchEmote[]>
  discover(language: string, refresh?: boolean): Promise<StreamSummary[]>
  followed(refresh?: boolean): Promise<FollowedChannels>
  resolveStream(channel: string, quality: string): Promise<string>
  stopStream(): Promise<void>
  /** Moves the video out of the room into its own window. The dock player stops: one stream at a time. */
  detachPlayer(channel: string, quality: string, play: boolean): Promise<void>
  /**
   * Drives the detached player from the room. Detaching moves the picture, not the player:
   * every gesture that would have started or stopped the dock — entering a channel, switching
   * to another one, opening the settings, hiding the video — travels through here instead.
   */
  commandPlayer(action: 'play' | 'stop', channel?: string, quality?: string, buffer?: BufferMode): Promise<void>
  /** Closes the video window again. With no detached window, the call does nothing. */
  attachPlayer(): Promise<void>
  /** What the detached window asks for at startup: the channel to play and the settings of the moment. */
  playerContext(): Promise<DetachedContext>
  /** The detached window says where its player stands; the room shows it as if playing at home. */
  reportPlayerState(state: string, message?: string): Promise<void>
  /** The quality changed from the detached window: the room is the one that saves it, sole author of the preferences. */
  reportPlayerQuality(quality: string): Promise<void>
  /**
   * The shape of the detached window's picture: `ratio` is the video's width over its height,
   * `chrome` the height of everything below it. The window then resizes on that ratio, so the
   * picture keeps no black margin. A `ratio` of 0 releases the constraint — audio only has no shape.
   */
  reportPlayerFrame(ratio: number, chrome: number): Promise<void>
  /** Keeps the detached window above the other windows, or lets it back into the pile. */
  pinPlayer(pinned: boolean): Promise<void>
  /** Keeps the detached window above the other windows, or lets it back into the pile. */
  pinPlayer(pinned: boolean): Promise<void>
  /** The volume set from the detached window, remembered by the room as its own. */
  reportPlayerVolume(volume: number, muted: boolean): Promise<void>
  /** The detached channel, or `null` when the video comes back into the room. */
  onPlayerDetached(callback: (channel: string | null) => void): () => void
  /** What the room asks of the detached player. */
  onPlayerCommand(callback: (action: 'play' | 'stop', channel: string, quality: string, buffer: BufferMode) => void): () => void
  /** The state of the detached player, relayed to the room. */
  onPlayerState(callback: (state: string, message?: string) => void): () => void
  /** The quality chosen in the detached window. */
  onPlayerQuality(callback: (quality: string) => void): () => void
  /** The volume chosen in the detached window. */
  onPlayerVolume(callback: (volume: number, muted: boolean) => void): () => void
  /** The last known activity of each of the account's rooms, in milliseconds. */
  channelActivity(): Promise<Record<string, number>>
  /** Redates the rooms that have just come alive: a live stream starting, a message arriving. */
  markChannelActivity(channels: string[]): Promise<void>
  external(target: 'twitch' | 'auth-docs', channel?: string): Promise<void>
  /** Opens a link read in a message. The main process checks it again: only HTTP and HTTPS leave the application. */
  openLink(url: string): Promise<void>
  copy(text: string): Promise<void>
  /** A mention received. The main process stays the only judge of whether it becomes a system notification. */
  notifyMention(mention: MentionNotice): Promise<void>
  /** The click on a mention notification: it leads back to the room it came from. */
  onMentionOpen(callback: (channel: string) => void): () => void
  /** The account switch: the main process sends the new account's set of preferences. */
  onPreferences(callback: (scoped: ScopedPreferences) => void): () => void
  /** The main process's Settings menu, on the platform's own accelerator. */
  onSettings(callback: () => void): () => void
  onEvents(callback: (events: ChatEvent[]) => void): () => void
  /** A release worth knowing about, sent once per version. */
  onUpdate(callback: (notice: UpdateNotice) => void): () => void
  /** Acts on the notice: restart onto the downloaded build, or open the release page. */
  applyUpdate(): Promise<void>
}

/**
 * What the main process found. `ready` is downloaded and one restart away, which only Windows
 * reaches; `available` names a release the user installs themselves.
 */
export interface UpdateNotice { state: 'available' | 'ready'; version: string; url: string }
