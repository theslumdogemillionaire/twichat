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
/** The source of an incoming raid, preserved from Twitch's USERNOTICE tags. */
export interface IncomingRaid {
  login: string
  displayName: string
  viewers: number | null
  avatarUrl: string
}
export interface ChatMessage {
  id: string
  channel: string
  user: string
  login: string
  text: string
  color: string
  /** `set/version` pairs, as the tag spells them: the version is what picks the badge image. */
  badges: string[]
  time: number
  action: boolean
  own?: boolean
  /** Local echo of a send: its `id` stays provisional until Twitch has confirmed the message. */
  pending?: boolean
  system?: boolean
  raid?: IncomingRaid
  /** The `msg-id` of a Twitch NOTICE. Stable where its text is translated and reworded. */
  notice?: string
  emotes?: string
  /** The `gifs` tag as Twitch sent it: `<start>-<end>|<id>|<url>`, one entry per GIPHY image. */
  gifs?: string
  reply?: ReplyReference
  /** `first-msg=1`: this viewer had never written in this channel before. */
  firstMessage?: boolean
  /** `msg-id=highlighted-message`: the channel-points redemption that lifts a message out of the log. */
  highlighted?: boolean
  /**
   * Set when the message was written in another channel and mirrored here by a Twitch shared-chat
   * session. `badges` then already holds the source channel's sets rather than this room's.
   * `channel` is the source's name when it could be put to the id at no cost — a room this
   * session has also joined — and `''` otherwise: a bare numeric id tells a reader nothing.
   */
  source?: { roomId: string; channel: string }
  /**
   * The `bits` tag: what the whole message cheered. The body carries the tokens that add up to
   * it, so this is not what the log prints — it is what says the tokens are cheers at all, and
   * a `Cheer100` in a message without it stays the five characters somebody typed.
   */
  bits?: number
}
export type ChatEvent =
  | { type: 'status'; status: Connection; detail: string }
  | { type: 'account'; login: null; detail: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'joined'; channel: string }
  /**
   * A JOIN Twitch never echoed back. It sends nothing when a join does not take, so this is our
   * own deadline running out rather than an answer — the room is in the list without being in.
   */
  | { type: 'joinFailed'; channel: string }
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
  /** A whisper opens its conversation window, behind what you are doing, and rings once. */
  whispers: boolean
}
/**
 * The typeface the conversations are set in — the channel's messages and a whisper's alike.
 * `default` is the one shipped with the application; the others name a family the system
 * already has, so nothing is downloaded to honour the choice.
 */
export type ChatFont = 'default' | 'system' | 'sans' | 'serif' | 'mono'
/** How the chat itself reads. */
export interface ChatPreferences {
  /** Turns the addresses in a message into links opening in the browser. When false, they stay plain text. */
  links: boolean
  /** Shows the address and asks before leaving for the browser. Turned off from the dialog itself, or here. */
  confirm: boolean
  /** Shows the GIFs sent from Twitch's GIPHY keyboard. When false, the title Twitch wrote in the body stays. */
  gifs: boolean
  /** The typeface of the messages and of what you type, in the room and in a conversation window. */
  font: ChatFont
  /**
   * Shows the time beside each message in the room's log. A conversation window ignores it: its
   * times are day separators rather than a column, and hiding them would leave a thread with no
   * chronology at all.
   */
  timestamps: boolean
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
  /**
   * Whether the window's own buttons are laid over the title bar, as macOS does with
   * `hiddenInset`. Where they are, the bar's left corner belongs to them and anything the page
   * puts there — the back and forward buttons — has to start after them. It is not read from
   * `commandKey`: that one is pinned by the smoke checks to draw the Ctrl labels on a Mac,
   * and the window's chrome does not move when it is.
   */
  insetWindowControls: boolean
  /** The language resolved by the main process: the account's choice, otherwise the system's. */
  locale: Locale
  /** The account these preferences belong to. It goes back unchanged on save. */
  scope: string
  status: Connection
  account: string | null
  savedAccounts: string[]
  savedAvatars: Record<string, string>
  /**
   * The pictures of the joined rooms, as data URLs, from the disk cache. The sidebar draws from
   * these before the first `rooms:profiles` answer — and, when Twitch answers without an avatar,
   * instead of it.
   */
  channelAvatars: Record<string, string>
  roomStates: Record<string, Record<string, string>>
  userBadges: Record<string, string[]>
  /** What this token was granted beyond chat. Sent again, on its own channel, at every account change. */
  scopes: AccountScopes
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
  /**
   * The frame Twitch keeps of the running stream, for the sidebar preview. Helix only: the public
   * page carries an 80x45 version, too small to show, and the size is not ours to rewrite.
   */
  thumbnailUrl?: string
}
/**
 * What the room header knows about the channel apart from its stream: the size of its audience
 * over time, and the category and tags it is listed under. All three survive the stream going
 * offline, so none of them belongs to `RoomProfile`, which is refreshed for twenty rooms at a time.
 */
export interface ChannelInfo {
  channel: string
  /** Absent when the endpoint turned the token down: the header drops the line rather than showing a zero. */
  followers?: number
  /** The category the channel is listed under. Absent when Twitch named none — a channel that has never streamed has none. */
  game?: string
  /** Twitch's id for that category, and what browsing it is made of. Absent when the payload carried no usable one: the chip then filters rather than browses. */
  gameId?: string
  tags: string[]
}
/**
 * A Twitch category as the search answers it. The id is what `helix/streams` browses by — a name
 * browses nothing — and the box art is the one picture a category has.
 */
/**
 * A page of a Twitch listing: the rows, and where the next page starts. An empty cursor is the end
 * of the list — the one thing a caller needs to know to stop asking.
 */
export interface CategoryPage {
  categories: CategoryMatch[]
  cursor: string
}
export interface StreamPage {
  streams: StreamSummary[]
  cursor: string
}
export interface CategoryMatch {
  id: string
  name: string
  boxArtUrl: string
}
export interface StreamSummary {
  id: string
  channel: string
  displayName: string
  avatarUrl: string
  thumbnailUrl: string
  title: string
  game: string
  /** Twitch's id for that category. Empty when the row carried none: the card filters instead of browsing. */
  gameId: string
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
/**
 * What a name search found. Off air is not a miss: a channel that is not streaming is still a chat
 * to join, and dropping it is how a search comes back empty on a name it did find.
 */
export interface ChannelSearch {
  live: StreamSummary[]
  offline: RoomProfile[]
}
export interface UserCard {
  login: string
  /** Twitch's id for them. Empty when the payload carried none: blocking needs an id, not a name. */
  userId: string
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
  /**
   * `account` is the set the viewer carries rather than one the room publishes: subscriptions to
   * other channels, Prime and Turbo emotes, what a Hype Train left behind. It exists as a third
   * value because those are typable here while belonging to nowhere in particular, and the picker
   * has to say where they came from rather than passing them off as the channel's.
   */
  scope: 'global' | 'channel' | 'account'
  type: string
}
/** Someone the account has blocked on Twitch itself. The login is what a chat message carries. */
export interface BlockedUser {
  login: string
  userId: string
  displayName: string
}
/**
 * Which of the optional scopes the signed-in token actually carries.
 *
 * Every one of these was added to the sign-in after accounts were already stored on machines, and
 * a token only gains a scope through the browser round-trip: an account saved before is not
 * broken, it simply cannot do these three things. The window reads this rather than discovering
 * it from a refusal, so a button that would only ever fail is not drawn in the first place.
 */
export interface AccountScopes {
  /** `user:read:emotes`: the account's own emotes, in every room rather than only in theirs. */
  emotes: boolean
  /** `user:read:blocked_users` and `user:manage:blocked_users`, granted together or not at all. */
  blocks: boolean
  /** `user:manage:chat_color`. Reading the colour back needs no scope; only setting it does. */
  chatColor: boolean
}
/**
 * A chat badge, keyed the way the `badges` tag names it — `moderator/1`, `subscriber/0` — so a
 * message carries the key and nothing else. `title` is Twitch's own wording, shown on hover.
 */
export interface ChatBadge {
  id: string
  url: string
  title: string
}
/**
 * One tier of a cheermote: the amount it starts at, the colour Twitch writes that amount in, and
 * the image standing for it. A body says `Cheer100`, and the tier applying is the highest
 * `minBits` the amount reaches.
 */
export interface CheermoteTier {
  minBits: number
  /** Twitch's own tier colour, `#rrggbb`. It is the whole grammar of a cheer: grey, purple, gold. */
  color: string
  url: string
}
/** A cheer prefix and its tiers: Twitch's own `Cheer`, and each channel's — `Kappa`, `uni`. */
export interface Cheermote {
  prefix: string
  tiers: CheermoteTier[]
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
/**
 * One whisper as Twichat keeps it. `peer` is the other party in the conversation, whichever way
 * the message went: Twitch gives no thread of its own, so the pair is what gathers them.
 */
export interface Whisper {
  id: string
  peer: string
  /** Twitch's id for the peer, when it is known: what a reply is addressed to. */
  peerId?: string
  peerName: string
  outgoing: boolean
  text: string
  at: number
}
/** What a conversation window is handed on opening: who it is with, and everything said so far. */
export interface WhisperContext {
  peer: string
  peerName: string
  thread: Whisper[]
  /** The same reading rules as the room: links on or off, and whether one is confirmed first. */
  chat: ChatPreferences
  theme: Theme
  locale: Locale
}
/** The emote sets that belong to no channel, for a body Twitch sent without an `emotes` tag. */
export interface GlobalEmotes { thirdParty: ThirdPartyEmote[]; twitch: TwitchEmote[] }
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
  /** Followers and tags of the open channel. `roomId` spares the id lookup when ROOMSTATE has given it. */
  channelInfo(channel: string, roomId?: string): Promise<ChannelInfo>
  /** `roomId` avoids a round trip when ROOMSTATE has already given the channel's id. */
  followStatus(channel: string, roomId?: string): Promise<FollowStatus>
  thirdPartyEmotes(channel: string, roomId: string): Promise<ThirdPartyEmote[]>
  twitchEmotes(roomId: string): Promise<TwitchEmote[]>
  /** The badge images of a room: Twitch's own sets, with the channel's over them. */
  twitchBadges(roomId: string): Promise<ChatBadge[]>
  /** The cheer prefixes of a room, Twitch's own and the channel's: one call carries both. */
  cheermotes(roomId: string): Promise<Cheermote[]>
  /**
   * The catalog in a language, or — with `gameId` — the same catalog narrowed to one category by
   * Twitch itself. `after` is the cursor of the page before: the explorer asks for the next one as
   * the reader reaches the bottom, rather than stopping at the hundred it opened with.
   */
  discover(language: string, refresh?: boolean, gameId?: string, after?: string): Promise<StreamPage>
  /** Twitch's categories matching a name, so the box can answer "category" and not only "channel". */
  searchCategories(query: string): Promise<CategoryMatch[]>
  /** Twitch's categories by audience: the explorer's own front door onto what exists, a page at a time. */
  topCategories(refresh?: boolean, after?: string): Promise<CategoryPage>
  /**
   * The categories this account has opened, most recently first. Local to this machine and to this
   * account: it is written to the database beside the rooms and the whispers, and sent nowhere.
   */
  visitedCategories(): Promise<CategoryMatch[]>
  /**
   * Notes a category as opened, and answers the list as it now stands. `scope` is the account the
   * window believed it was under: a visit that lags a switch is dropped, not written to the next.
   */
  visitCategory(category: CategoryMatch, scope: string): Promise<CategoryMatch[]>
  followed(refresh?: boolean): Promise<FollowedChannels>
  /**
   * Searches Twitch by channel name — logins and display names — rather than filtering the
   * catalog `discover` loaded.
   */
  searchChannels(query: string): Promise<ChannelSearch>
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
  /**
   * What the token may do, when that changes. It rides its own channel rather than the
   * preferences, because the change this exists for does not move the scope: signing in again as
   * the same account to grant a new permission leaves every preference exactly where it was.
   */
  onAccountScopes(callback: (scopes: AccountScopes) => void): () => void
  /**
   * Everyone this account has blocked on Twitch. Read once per account and kept: Twitch keeps
   * sending a blocked person's messages down the chat socket, so the list is what hides them.
   * Refused with `blocksScopeMissing` when the token predates the scope.
   */
  blockedUsers(refresh?: boolean): Promise<BlockedUser[]>
  /**
   * Blocks someone, for real and on Twitch. Answers the list as it stands afterwards, re-read
   * rather than assumed. `userId` is Twitch's, as the card carries it: a login is not enough.
   */
  blockUser(login: string, userId: string): Promise<BlockedUser[]>
  /** Undoes it. The same road back, from the same place. */
  unblockUser(login: string, userId: string): Promise<BlockedUser[]>
  /**
   * The colour the account's own name is written in, `#rrggbb`, or empty when Twitch derives one
   * from the name. Readable by any token: only setting it needs the scope.
   */
  chatColor(): Promise<string>
  /**
   * Sets it: one of the fifteen names Twitch offers everybody, or a `#rrggbb` — which Twitch
   * accepts from Turbo and Prime accounts alone and refuses to the rest with a bare 400.
   * Answers the colour Twitch now has.
   */
  setChatColor(color: string): Promise<string>
  /**
   * The back and forward the system reports as a command rather than as a key press: the mouse's
   * side buttons and a keyboard's browser keys, on the platforms where the window sees them
   * before the page does.
   */
  onNavigate(callback: (direction: 'back' | 'forward') => void): () => void
  onEvents(callback: (events: ChatEvent[]) => void): () => void
  /** The conversation window asking who it is with. The peer comes from the main process,
   * never from the page: a window cannot name someone else's conversation. */
  whisperContext(): Promise<WhisperContext>
  globalEmotes(): Promise<GlobalEmotes>
  /** Sends into the conversation this window holds. The recipient is never named by the page. */
  sendWhisper(text: string): Promise<Whisper>
  /** The peer's picture and the name Twitch shows them under, asked for after the thread is drawn. */
  whisperProfile(): Promise<{ avatarUrl: string; displayName: string }>
  /** Opens the conversation with someone, from the room: their window, brought to the front. */
  openWhisper(login: string): Promise<void>
  /** A channel named inside a whisper: the room comes forward and goes there. */
  openChannel(channel: string): Promise<void>
  onChannelOpen(callback: (channel: string) => void): () => void
  onWhisper(callback: (whisper: Whisper) => void): () => void
  /**
   * The typeface of the conversations, changed while a conversation window is open. It arrives
   * unchecked, like anything crossing the bridge: the window runs it past the validator.
   */
  onChatFont(callback: (font: string) => void): () => void
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
