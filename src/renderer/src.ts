import '@fontsource-variable/atkinson-hyperlegible-next'
import './style.css'
import type { BufferMode, ChatEvent, ChatMessage, Connection, FollowStatus, LayoutPreferences, NotificationPreferences, PlaybackPreferences, Preferences, RoomProfile, ScopedPreferences, Snapshot, StreamSummary, ThirdPartyEmote, TwitchEmote, UpdateNotice, UserCard } from '../shared/types'
import { bufferMode, idleChannelHours } from '../shared/validation'
import { hydrateIcons, icon } from './icons'
import { ChatStore } from './chat-store'
import { VirtualLog } from './virtual-log'
import { StreamPlayer, type StreamPlayerState } from './player'
import { messageFragments } from './emotes'
import { liveUptime } from './live-stats'
import { idleChannels } from './idle-channels'
import { createComposer } from './composer'
import { isMention, mentionSegments, resetMentionCache } from './mentions'
import { exemptFromFollowersOnly, followNotice, followersOnlyMinutes } from './follow-gate'
import { setupTheme, currentTheme, applyTheme } from './theme'
import { hydrate } from './hydrate'
import { commandKey, composing, label as keyLabel, matches, platformKeys, setCommandKey, type Chord } from './keys'

/**
 * Every shortcut the window answers, in one place. The modifier is named rather than assumed:
 * what `command` means is decided by the platform, in `keys.ts`.
 */
const SHORTCUTS: Record<'join' | 'sidebar' | 'chatOnly', Chord> = {
  join: { key: 'k', command: true },
  sidebar: { key: 'b', command: true },
  chatOnly: { key: 'v', command: true, shift: true }
}
import { clock, collator, compactNumbers, locale, m, numbers, resolveLocale, setLocale } from '../shared/i18n'
import { errorKey, errorText } from '../shared/errors'

declare global { interface Window { twichat: import('../shared/types').TwichatAPI } }

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(m.errors.missingElement(selector))
  return element
}
const store = new ChatStore()
const unread = new Map<string, number>()
// Mentions are counted separately: they alone put the badge into its alert state.
const mentions = new Map<string, number>()
// The last known activity of each room, read once per account then kept up to date here.
// A room absent from the map has no history: it stays visible, dormancy never rests on an unknown.
const channelActivity = new Map<string, number>()
// Rooms redated since the last send: the database is written in batches, not once per message.
const pendingActivity = new Set<string>()
let idleExpanded = false
const roomModes = new Map<string, Record<string, string>>()
const roomProfiles = new Map<string, RoomProfile>()
const chatterAvatars = new Map<string, string>()
const chatterAvatarRetryAt = new Map<string, number>()
const thirdPartyEmotes = new Map<string, Map<string, ThirdPartyEmote>>()
const thirdPartyRoomKeys = new Map<string, string>()
const twitchEmotes = new Map<string, TwitchEmote[]>()
const twitchEmoteIds = new Map<string, Map<string, string>>()
const twitchRoomKeys = new Map<string, string>()
const roomIds = new Map<string, string>()
// The account badges, room by room: a moderator, a VIP or a subscriber writes despite followers-only mode.
const roomBadges = new Map<string, string[]>()
// The follow is set on twitch.tv, outside the application: nothing is kept beyond the session,
// and the "Check again" button asks Twitch instead of re-reading a stale answer.
const followStatuses = new Map<string, FollowStatus>()
const followChecks = new Set<string>()
// An unreachable Twitch leaves the question unanswered: without this delay the banner would ask
// again at once, since it is precisely the missing answer that triggers the request.
const followRetryAt = new Map<string, number>()
const FOLLOW_RETRY_DELAY = 60_000
const pendingChatterAvatars = new Set<string>()
const userCards = new Map<string, UserCard>()
const selectedCategories = new Set<string>()
let state: Snapshot
let active = ''
// The account display name, when Twitch gives one: a non-Latin nickname looks nothing like its login.
let accountDisplayName = ''
type View = 'welcome' | 'room' | 'discover' | 'settings'
const VIEWS: Record<View, string> = { welcome: '#welcome', room: '#room-view', discover: '#discover', settings: '#settings' }
let currentView: View = 'welcome'
/** A single view at a time: the four sections of `main` exclude one another. */
function showView(view: View) {
  currentView = view
  for (const [name, selector] of Object.entries(VIEWS)) $(selector).hidden = name !== view
  updateTitlebarNote()
}
/**
 * The note in the title bar names the open page. It is the workspace's one, not the session
 * gate's, which keeps its own sentence. The room shows the login rather than the display name:
 * the heading below it shows the same thing, and the profile lands well after the room opens.
 */
function updateTitlebarNote() {
  $('#app .titlebar-note').textContent =
    currentView === 'room' && active ? m.app.titlebarRoom(active.toLocaleUpperCase(locale))
    : currentView === 'discover' ? m.app.titlebarDiscover
    : currentView === 'settings' ? m.app.titlebarSettings
    // The welcome page keeps the sentence the HTML carries: one wording, one key.
    : m.ui.app.noPageLoaded
}

let updateNotice: UpdateNotice | null = null
/** Nothing until the main process finds something: an app that is current says so by staying quiet. */
function renderUpdateNotice() {
  const element = $<HTMLButtonElement>('#update-notice')
  element.hidden = !updateNotice
  if (!updateNotice) return
  element.textContent = updateNotice.state === 'ready' ? m.app.updateReady(updateNotice.version) : m.app.updateAvailable(updateNotice.version)
  element.title = updateNotice.state === 'ready' ? m.app.updateInstall : m.app.updateOpen
}
let joined = new Set<string>()
let discoveredStreams: StreamSummary[] = []
let followedStreams: StreamSummary[] = []
let followedOffline: RoomProfile[] = []
/** Twitch was still offering more than the list holds: the count above it says so. */
let followedTruncated = false
let discoveryScope: 'top' | 'followed' = 'top'
/**
 * The errors that condemn a saved account: its row leaves the session screen.
 * The key decides, not the sentence — that one changes with the language.
 */
const STALE_ACCOUNT_ERRORS = new Set(['accountForgotten', 'accountCorrupted', 'accountSessionInvalid', 'tokenInvalid', 'tokenFormat', 'tokenRejected', 'tokenMismatch', 'tokenRenewedMismatch', 'twitchSessionExpired'])
let discoveryLoading = false
let followedLoading = false
// The explorer's content filter is not the interface language, but it starts from the same one:
// an English-speaking account must not open a French-only catalog.
// `locale` still holds the fallback when this module is evaluated: `syncDiscoveryLanguage` sets it
// once the account language is resolved.
let discoveryLanguage: string = locale
let discoveryUpdatedAt = 0
let followedUpdatedAt = 0
let discoveryQueryTimer = 0
let chatterAvatarLoading = false
let chatterAvatarTimer = 0
let toastTimer = 0
let saveTimer = 0
/** The scope a pending save belongs to, so closing can send it where it was meant to go. */
let pendingScope: string | null = null
let workspaceEntered = false
let currentPlayerState: StreamPlayerState = 'stopped'
let contextRoom = ''
let contextMessage: ChatMessage | null = null
let cardLogin = ''
let cardPinned = false
let cardOpenTimer = 0
let cardCloseTimer = 0
let cardGeneration = 0
let browserAuthAttempt = 0
let accountAvatarGeneration = 0
let liveRefreshTimer = 0
let uptimeTimer = 0
// Width set with the handle, `0` while the user leaves it at the default.
let playerWidth = 0
// The channel whose video plays in its own window, empty while it sits in the dock.
let detachedChannel = ''
// What the account chose, which outlives the window: the next launch reopens it.
let detachedWanted = false
// A session going away closes the window without the account changing its mind.
let closingSession = false
// The player volume: the native video controls being hidden, it lives here and follows the account.
let volume = 1
let muted = false


hydrateIcons()
const appRoot = $('#app')
const sessionGate = $('#session-gate')
const joinDialog = $<HTMLDialogElement>('#join-dialog')
const accountDialog = $<HTMLDialogElement>('#account-dialog')
const chatLog = $('#chat-log')
const space = $('#virtual-space')
const video = $<HTMLVideoElement>('#video')
const resume = $<HTMLButtonElement>('#resume')
const streamDock = $('#stream-dock')
const playerResizer = $('#player-resizer')
const fullscreenButton = $<HTMLButtonElement>('#fullscreen-stream')
const ownChannelBlock = $('#own-channel-block')
const ownChannelButton = $<HTMLButtonElement>('#own-channel')
const virtualLog = new VirtualLog(chatLog, space, createMessage, pinned => { resume.hidden = pinned })
const streamPlayer = new StreamPlayer(video, window.twichat, updatePlayer)
/**
 * The player as the room sees it. While the video lives in its own window, `play` and `stop`
 * do nothing: this is the single guard for the fifteen places that drive playback, and what
 * keeps the promise of one active video stream at a time.
 */
const player = {
  play: (channel: string, quality: string, buffer: BufferMode) => detachedChannel
    ? window.twichat.commandPlayer('play', channel, quality, buffer).catch(() => {})
    : streamPlayer.play(channel, quality, buffer),
  stop: () => {
    if (detachedChannel) void window.twichat.commandPlayer('stop').catch(() => {})
    else streamPlayer.stop()
  }
}
const composer = createComposer({
  send: (text, reply) => window.twichat.send(active, text, reply),
  emotes: () => thirdPartyEmotes.get(active),
  twitch: () => twitchEmotes.get(active),
  reload: () => reloadEmotes(active),
  messages: () => store.get(active),
  avatar: login => chatterAvatars.get(login),
  error: failure => toast(displayError(failure))
})

/** The text of an error for the screen: a known error reads in the current language. */
function displayError(error: unknown): string { return errorText(error) }
function toast(message: string) {
  const element = $('#toast')
  element.textContent = message; element.hidden = false
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { element.hidden = true }, 4500)
}

function avatarImage(source: string, alt: string, size: number) {
  const image = document.createElement('img')
  image.src = source; image.alt = alt; image.width = size; image.height = size
  image.addEventListener('error', () => image.remove(), { once: true })
  return image
}

function renderSavedAccounts() {
  const section = $('#saved-accounts')
  const list = $('#saved-account-list')
  list.replaceChildren()
  section.hidden = state.savedAccounts.length === 0
  for (const login of state.savedAccounts) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'session-choice saved-choice'; button.dataset.login = login
    const avatar = document.createElement('span'); avatar.className = 'session-choice-icon'; avatar.textContent = login.slice(0, 1)
    const cached = state.savedAvatars[login]
    if (cached) avatar.append(avatarImage(cached, '', 38))
    const copy = document.createElement('span')
    const name = document.createElement('strong'); name.textContent = login
    const detail = document.createElement('small'); detail.textContent = m.app.continueWithAccount
    copy.append(name, detail)
    const arrow = document.createElement('span'); arrow.innerHTML = icon('arrow')
    button.append(avatar, copy, arrow)
    button.addEventListener('click', () => void useSavedAccount(login, button))
    list.append(button)
  }
}

/**
 * The restore left behind by the last entry. When it succeeds the gate disappears and we never
 * play it: its buttons would otherwise stay disabled, and its label stuck on "Connecting…",
 * until the next sign-out shows them again as they are.
 */
let releaseSessionGate: (() => void) | undefined
function sessionBusy(button: HTMLButtonElement, label: string) {
  const buttons = sessionGate.querySelectorAll<HTMLButtonElement>('button')
  buttons.forEach(item => { item.disabled = true })
  const original = button.querySelector('strong')?.textContent ?? button.textContent ?? ''
  const title = button.querySelector('strong')
  if (title) title.textContent = label
  const release = () => {
    buttons.forEach(item => { item.disabled = false })
    if (title) title.textContent = original
  }
  releaseSessionGate = release
  return release
}

function enterWorkspace(login: string | null) {
  if (workspaceEntered) return
  workspaceEntered = true
  updateAccount(login)
  sessionGate.hidden = true
  appRoot.hidden = false
  appRoot.classList.add('session-enter')
  window.setTimeout(() => appRoot.classList.remove('session-enter'), 250)
  scheduleLiveRefresh()
  if (active) activate(active)
  else showView('welcome')
}

function returnToSessionChoice() {
  player.stop()
  if (detachedChannel) { closingSession = true; void window.twichat.attachPlayer().catch(() => { closingSession = false }) }
  virtualLog.setVisible(false)
  workspaceEntered = false
  currentView = 'welcome'
  appRoot.hidden = true
  // The saved accounts are rewritten below; "Sign in" and "Continue anonymously", though, are the
  // same buttons as on the way in and would come back disabled.
  releaseSessionGate?.()
  releaseSessionGate = undefined
  sessionGate.hidden = false
  sessionGate.classList.add('ready')
  sessionGate.setAttribute('aria-busy', 'false')
  $('#session-error').textContent = ''
  renderSavedAccounts()
  void refreshSavedAvatars()
  updateConnection('offline', m.app.pickSessionToReconnect)
  $<HTMLButtonElement>('#anonymous-session').focus()
}

// The avatar of an account connected during this session only reaches the disk cache in the background.
async function refreshSavedAvatars() {
  try {
    const avatars = await window.twichat.savedAvatars()
    if (workspaceEntered) return
    state.savedAvatars = avatars
    renderSavedAccounts()
  } catch (error) { console.warn('Unable to read the cached account avatars:', displayError(error)) }
}

async function useSavedAccount(login: string, button: HTMLButtonElement) {
  const restore = sessionBusy(button, m.app.checking)
  $('#session-error').textContent = ''
  try {
    const account = await window.twichat.useSavedAccount(login)
    state.savedAccounts = [account, ...state.savedAccounts.filter(item => item !== account)]
    resetFollowed()
    enterWorkspace(account)
  } catch (error) {
    if (STALE_ACCOUNT_ERRORS.has(errorKey(error) ?? '')) state.savedAccounts = state.savedAccounts.filter(account => account !== login)
    renderSavedAccounts()
    $('#session-error').textContent = `${displayError(error)} ${m.app.reconnectThisAccount}`
  } finally { if (!workspaceEntered) restore() }
}

async function enterAnonymously() {
  const button = $<HTMLButtonElement>('#anonymous-session')
  const restore = sessionBusy(button, m.app.connectingToChat)
  $('#session-error').textContent = ''
  try { await window.twichat.anonymous(); enterWorkspace(null) }
  catch (error) { $('#session-error').textContent = displayError(error); restore() }
}
/** The playback settings as the Settings page carries them: the player re-reads them on every start. */
function playback(): PlaybackPreferences {
  return { buffer: bufferMode($<HTMLSelectElement>('#buffer').value), autoplay: $<HTMLInputElement>('#autoplay').checked, detached: detachedWanted, volume, muted }
}
function notifications(): NotificationPreferences {
  return { mentions: $<HTMLInputElement>('#notify-mentions').checked }
}
/** The controls that carry a preference: they repaint on opening as on every account switch. */
function paintPreferenceControls(source: Preferences) {
  $<HTMLSelectElement>('#language').value = source.language
  $<HTMLSelectElement>('#quality').value = source.quality
  $<HTMLSelectElement>('#preferred-quality').value = source.quality
  $<HTMLSelectElement>('#buffer').value = source.playback.buffer
  $<HTMLInputElement>('#autoplay').checked = source.playback.autoplay
  detachedWanted = source.playback.detached
  $<HTMLInputElement>('#detached-video').checked = detachedWanted
  $<HTMLInputElement>('#notify-mentions').checked = source.notifications.mentions
  $<HTMLInputElement>('#hide-idle').checked = source.layout.hideIdleChannels
  $<HTMLSelectElement>('#idle-delay').value = String(source.layout.idleChannelHours)
  applySound(source.playback.volume, source.playback.muted)
}

/**
 * Switching from one account to another. Everything the previous account carried is thrown away
 * before adopting the new set: its rooms, its messages, its counters, its badges, its subscriber
 * emotes and its followed channels. Public avatars stay: they say nothing about the account.
 */
function adoptScope({ scope, preferences: next, locale }: ScopedPreferences) {
  if (!state || scope === state.scope) return
  const previous = state.preferences.channels
  player.stop()
  if (detachedChannel) { closingSession = true; void window.twichat.attachPlayer().catch(() => { closingSession = false }) }
  closeFloatingLayers()
  for (const channel of previous) if (!next.channels.includes(channel)) void window.twichat.part(channel).catch(() => {})
  store.reset(); unread.clear(); mentions.clear()
  roomModes.clear(); roomProfiles.clear(); roomIds.clear(); roomBadges.clear()
  channelActivity.clear(); pendingActivity.clear(); idleExpanded = false
  followStatuses.clear(); followChecks.clear(); followRetryAt.clear()
  twitchEmotes.clear(); twitchEmoteIds.clear(); twitchRoomKeys.clear()
  thirdPartyEmotes.clear(); thirdPartyRoomKeys.clear()
  discoveredStreams = []; resetFollowed()
  joined.clear()
  accountDisplayName = ''
  resetMentionCache()
  virtualLog.set([], true)

  state.scope = scope
  state.preferences = next
  // The account switch rehydrates the document, which puts the shipped "guest" wording back over
  // the account button and the sign-in dialog: the account is written again, in the new language.
  if (locale !== undefined) { setLocale(locale); hydrate(); paintAccountLabels(state.account); syncDiscoveryLanguage() }
  active = next.active
  applyTheme(next.theme)
  paintPreferenceControls(next)
  applyLayout(next.layout)
  applyPlayerMode()
  for (const channel of next.channels) void window.twichat.join(channel).catch(() => {})
  renderRooms()
  void loadChannelActivity()
  void refreshProfiles(next.channels)
  if (!workspaceEntered) return
  if (active) activate(active)
  else showView('welcome')
}

function preferences(): Preferences {
  const idle = idleSetting()
  return {
    channels: state.preferences.channels, active, quality: $<HTMLSelectElement>('#quality').value, theme: currentTheme(),
    language: $<HTMLSelectElement>('#language').value,
    layout: {
      playerWidth, sidebarCollapsed: appRoot.classList.contains('sidebar-collapsed'),
      hideIdleChannels: idle.enabled, idleChannelHours: idle.hours
    },
    playback: playback(), notifications: notifications()
  }
}
function save() {
  if (!state) return
  clearTimeout(saveTimer)
  // The scope leaves with the payload: a save one switch behind is dropped by the main process
  // rather than written into the next account's preferences.
  const scope = state.scope
  pendingScope = scope
  saveTimer = window.setTimeout(() => {
    saveTimer = 0; pendingScope = null
    window.twichat.savePreferences(preferences(), scope).catch(error => toast(displayError(error)))
  }, 180)
}

/**
 * The change made in the last fraction of a second before closing.
 *
 * The debounce above exists so that dragging a slider does not write once per pixel, but the
 * window can close inside it. The main process waits for the writes it has already received
 * and knows nothing of a timer still running here, so the last gesture — a setting toggled,
 * then the window closed — was simply lost.
 */
function flushPreferences() {
  if (!saveTimer || pendingScope === null) return
  clearTimeout(saveTimer)
  const scope = pendingScope
  saveTimer = 0; pendingScope = null
  window.twichat.savePreferences(preferences(), scope).catch(() => {})
}

/**
 * A room that has just come alive: a message arriving, a stream starting, a visit. It leaves
 * dormancy at once; the database learns the date at the next flush, not once per message.
 */
function markActivity(channel: string, at = Date.now()) {
  if (!state?.preferences.channels.includes(channel)) return
  channelActivity.set(channel, at)
  pendingActivity.add(channel)
}

/** The dates gathered since the last send. A failed write is retried on the next flush. */
function flushActivity() {
  if (!pendingActivity.size) return
  const channels = [...pendingActivity]
  pendingActivity.clear()
  void window.twichat.markChannelActivity(channels).catch(() => { for (const channel of channels) pendingActivity.add(channel) })
}

/** The dates of the account being entered. Without them no room goes dormant: the list stays whole. */
async function loadChannelActivity() {
  const scope = state.scope
  try {
    const activity = await window.twichat.channelActivity()
    if (state.scope !== scope) return
    channelActivity.clear()
    for (const [channel, at] of Object.entries(activity)) channelActivity.set(channel, at)
    renderRooms()
  } catch { /* An unread date is an unknown one, and an unknown one keeps the room in sight. */ }
}

/** The dormancy setting as the Settings page carries it, like playback and notifications. */
function idleSetting() {
  return { enabled: $<HTMLInputElement>('#hide-idle').checked, hours: idleChannelHours(Number($<HTMLSelectElement>('#idle-delay').value)) }
}

/** The rooms folded away right now. Nothing is left: only the sidebar hides them. */
function dormantChannels(): Set<string> {
  return new Set(idleChannels(state.preferences.channels.map(channel => ({
    channel,
    live: roomProfiles.get(channel)?.live === true,
    unread: (unread.get(channel) ?? 0) + (mentions.get(channel) ?? 0),
    open: channel === active,
    lastActive: channelActivity.get(channel)
  })), idleSetting()))
}

// Avatar, name and live dot are painted the same way on a room row and on the own-channel shortcut.
function paintRoomButton(button: HTMLButtonElement, channel: string, hint: string, fallbackName = `# ${channel}`) {
  const profile = roomProfiles.get(channel)
  const live = profile ? (profile.live ? 'true' : 'false') : 'unknown'
  const status = profile ? (profile.live ? profile.viewers ? m.app.liveWithViewers(numbers.format(profile.viewers), profile.viewers) : m.app.live : m.app.offline) : ''
  const title = status ? `${status} · ${hint}` : hint
  if (button.title !== title) button.title = title
  button.classList.toggle('is-live', live === 'true')
  button.classList.toggle('is-offline', live === 'false')
  button.setAttribute('aria-current', String(channel === active && currentView === 'room'))
  const displayName = profile?.displayName || fallbackName
  const avatarKey = `${displayName}\n${profile?.avatarUrl ?? ''}`
  const initial = button.querySelector<HTMLElement>('.room-avatar')!
  if (button.dataset.avatarKey !== avatarKey) {
    initial.replaceChildren((profile?.displayName || channel).slice(0, 1))
    if (profile?.avatarUrl) {
      const image = document.createElement('img'); image.src = profile.avatarUrl; image.alt = ''; image.width = 28; image.height = 28
      image.addEventListener('error', () => image.remove())
      initial.append(image)
    }
    button.dataset.avatarKey = avatarKey
  }
  const name = button.querySelector<HTMLElement>('.room-name')!
  if (name.textContent !== displayName) name.textContent = displayName
  const dot = button.querySelector<HTMLElement>('.room-live')
  if (dot && dot.dataset.live !== live) dot.dataset.live = live
  const dotLabel = dot?.firstElementChild
  if (dotLabel && dotLabel.textContent !== status) dotLabel.textContent = status
}

// Connected, your own channel stays one click away, whether or not it sits in the room list.
function renderOwnChannel() {
  const login = state.account
  ownChannelBlock.hidden = !login
  if (!login) return
  const hint = state.preferences.channels.includes(login) ? m.app.goToYourChannel : m.app.openYourChannelChat
  // Before the profile lands, the row reads as your own login, never as a room to join.
  paintRoomButton(ownChannelButton, login, hint, login)
  // The shortcut counts like any other row — but only your own channel joined has anything to count.
  paintUnreadBadge(ownChannelButton, login)
}

/** The unread counter, painted the same way on a room row and on the own-channel shortcut. */
function paintUnreadBadge(button: HTMLButtonElement, channel: string) {
  const count = unread.get(channel) ?? 0
  const mentionCount = mentions.get(channel) ?? 0
  let badge = button.querySelector<HTMLElement>('.unread')
  if (!badge) { badge = document.createElement('span'); badge.className = 'unread'; button.append(badge) }
  badge.hidden = count === 0 && mentionCount === 0
  // A mention comes before the total: that is the number you act on.
  badge.classList.toggle('mentions', mentionCount > 0)
  if (badge.hidden) { badge.removeAttribute('aria-label'); return }
  const shown = mentionCount || count
  const label = shown > 99 ? '99+' : String(shown)
  if (badge.textContent !== label) badge.textContent = label
  badge.setAttribute('aria-label', [
    mentionCount ? m.app.unreadMentions(mentionCount) : '',
    count ? m.app.unreadMessages(count) : ''
  ].filter(Boolean).join(', '))
}

function renderRooms() {
  const nav = $('#rooms')
  const idleNav = $('#idle-rooms')
  const existing = new Map([...document.querySelectorAll<HTMLButtonElement>('.room-button[data-channel]')].map(button => [button.dataset.channel!, button]))
  const expected = new Set(state.preferences.channels)
  for (const [channel, button] of existing) if (!expected.has(channel)) button.remove()
  const dormant = dormantChannels()
  // Two lists, one order: each row goes to its own list at its own rank.
  const ranks = new Map<HTMLElement, number>([[nav, 0], [idleNav, 0]])
  state.preferences.channels.forEach(channel => {
    let button = existing.get(channel)
    if (!button) {
      button = document.createElement('button')
      button.className = 'room-button'; button.type = 'button'; button.dataset.channel = channel
      const initial = document.createElement('span'); initial.className = 'room-avatar'
      const name = document.createElement('span'); name.className = 'room-name'
      const liveDot = document.createElement('span'); liveDot.className = 'room-live'; liveDot.dataset.live = 'unknown'
      const liveLabel = document.createElement('span'); liveLabel.className = 'sr-only'; liveDot.append(liveLabel)
      const badge = document.createElement('span'); badge.className = 'unread'; badge.hidden = true
      button.append(initial, name, liveDot, badge)
      button.addEventListener('click', () => activate(channel))
      button.addEventListener('contextmenu', event => { event.preventDefault(); openRoomContextMenu(channel, event.clientX, event.clientY) })
      button.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault(); const bounds = button!.getBoundingClientRect(); openRoomContextMenu(channel, bounds.right - 8, bounds.top + 8)
      })
    }
    paintRoomButton(button, channel, m.app.rightClickToLeave)
    paintUnreadBadge(button, channel)
    const target = dormant.has(channel) ? idleNav : nav
    const rank = ranks.get(target)!
    ranks.set(target, rank + 1)
    const current = target.children.item(rank)
    if (current !== button) target.insertBefore(button, current)
  })
  // The heading counts the whole list, dormant rooms included: it is that total the 20-room cap bounds.
  const roomCount = String(state.preferences.channels.length)
  if ($('#room-count').textContent !== roomCount) $('#room-count').textContent = roomCount
  // An emptied section closes: reopening it would otherwise show a heading with nothing under it.
  if (!dormant.size) idleExpanded = false
  $('#idle-block').hidden = dormant.size === 0
  $('#idle-count').textContent = String(dormant.size)
  $('#idle-toggle').setAttribute('aria-expanded', String(idleExpanded))
  idleNav.hidden = !idleExpanded
  $('#sidebar-empty').hidden = state.preferences.channels.length > 0
  renderOwnChannel()
}

function activate(channel: string) {
  if (!state.preferences.channels.includes(channel)) return
  closeFloatingLayers()
  const entering = currentView !== 'room' || active !== channel
  if (active && active !== channel) player.stop()
  active = channel
  state.preferences.active = channel
  unread.set(channel, 0); mentions.set(channel, 0)
  markActivity(channel)
  showView('room')
  virtualLog.setVisible(true)
  $('#channel-title').textContent = channel
  applyPlayerMode()
  $('#chat-empty').hidden = store.get(channel).length > 0
  $('#join-state').textContent = joined.has(channel) ? m.app.roomJoined : m.app.roomJoining
  updateCount()
  updateModes()
  updateFollowGate()
  updateRoomLive()
  virtualLog.set(store.get(channel), true)
  renderRooms(); save()
  if (entering) restorePlayerWidth()
  if (entering) {
    const start = playback().autoplay && !$('#room-body').classList.contains('chat-only')
    // The account may have left the video in its own window: it reopens there rather than in the dock.
    if (detachedWanted && !detachedChannel) applyDetachedChoice(start)
    else if (start) void player.play(channel, $<HTMLSelectElement>('#quality').value, playback().buffer)
  }
  composer.setRoom(channel)
  composer.focus()
}

// Menus and the profile card share one rule: open where asked, never outside the window.
function placeFloating(element: HTMLElement, requestedX: number, requestedY: number) {
  element.hidden = false
  const bounds = element.getBoundingClientRect()
  element.style.left = `${Math.max(8, Math.min(requestedX, innerWidth - bounds.width - 8))}px`
  element.style.top = `${Math.max(8, Math.min(requestedY, innerHeight - bounds.height - 8))}px`
}
function closeFloatingLayers() { closeAccountMenu(); closeRoomContextMenu(); closeMessageContextMenu(); closeUserCard() }

function closeAccountMenu() {
  $('#account-menu').hidden = true
  $('#account-button').setAttribute('aria-expanded', 'false')
}
/**
 * Settings and sign-out start from the same button: the collapsed bar keeps only the avatar, and
 * a lone cogwheel there suggested the account could no longer be left.
 */
function openAccountMenu() {
  closeRoomContextMenu(); closeMessageContextMenu(); closeUserCard()
  const login = state.account
  $('#account-menu-title').textContent = login || m.app.guest
  $<HTMLButtonElement>('#account-menu-connect').hidden = !!login
  $<HTMLButtonElement>('#account-menu-logout').hidden = !login
  $<HTMLButtonElement>('#account-menu-forget').hidden = !login
  // Reopening the menu asks again: an armed button left over from a moment ago is a trap.
  disarmForget()
  const menu = $('#account-menu')
  // The menu sits above the button: flush with the bottom of the window, it has no room to drop.
  menu.hidden = false
  const anchor = $('#account-button').getBoundingClientRect()
  placeFloating(menu, anchor.left + 8, anchor.top - menu.getBoundingClientRect().height - 6)
  $('#account-button').setAttribute('aria-expanded', 'true')
  $<HTMLButtonElement>(login ? '#account-menu-settings' : '#account-menu-connect').focus()
}

function closeRoomContextMenu() {
  contextRoom = ''
  $('#room-context-menu').hidden = true
}
function openRoomContextMenu(channel: string, requestedX: number, requestedY: number) {
  closeAccountMenu(); closeMessageContextMenu(); closeUserCard()
  contextRoom = channel
  $('#room-context-title').textContent = `# ${roomProfiles.get(channel)?.displayName || channel}`
  placeFloating($('#room-context-menu'), requestedX, requestedY)
  $<HTMLButtonElement>('#room-context-leave').focus()
}

function closeMessageContextMenu() {
  contextMessage = null
  $('#message-context-menu').hidden = true
}
// A chat line offers what can be done with it: its author, its text, its channel.
function openMessageContextMenu(message: ChatMessage, requestedX: number, requestedY: number) {
  closeAccountMenu(); closeRoomContextMenu(); closeUserCard()
  contextMessage = message
  const login = message.login.toLowerCase()
  const identified = !message.system && /^[a-z0-9_]{1,25}$/.test(login)
  const menu = $('#message-context-menu')
  $('#message-context-title').textContent = message.system ? m.app.channelMessage : message.user
  $('#message-context-profile').hidden = !identified
  const reply = $<HTMLButtonElement>('#message-context-reply')
  // A send not yet confirmed carries a temporary id: Twitch would refuse it as a parent.
  reply.hidden = message.system === true || message.pending === true
  reply.disabled = !state.account
  const mention = $<HTMLButtonElement>('#message-context-mention')
  mention.hidden = !identified || message.own === true
  mention.disabled = !state.account
  $('#message-context-copy').hidden = !message.text
  $('#message-context-copy-name').hidden = !identified
  const join = $('#message-context-join')
  join.hidden = !identified || login === active
  $('#message-context-join-label').textContent = state.preferences.channels.includes(login) ? m.app.goToTheirChannel : m.app.joinTheirChannel
  $('#message-context-twitch').hidden = !identified
  placeFloating(menu, requestedX, requestedY)
  menu.querySelector<HTMLButtonElement>('button:not([hidden]):not(:disabled)')?.focus()
}

function mentionUser(name: string) {
  if (!composer.mention(name)) toast(m.errors.ircNeedAccount)
}
function replyToMessage(message: ChatMessage) {
  if (!composer.reply(message)) toast(m.errors.ircNeedAccount)
}
/** Jumps back to the quoted message, while it is still in the room history. */
function revealMessage(id: string) {
  if (!virtualLog.scrollTo(id)) { toast(m.app.messageGone); return }
  const row = chatLog.querySelector<HTMLElement>(`.message[data-id="${CSS.escape(id)}"]`)
  if (!row) return
  row.classList.remove('is-revealed')
  void row.offsetWidth // force le redémarrage de l’animation quand on recite le même message
  row.classList.add('is-revealed')
}
async function copyText(text: string, done: string) {
  try { await window.twichat.copy(text); toast(done) }
  catch (error) { toast(displayError(error)) }
}
async function openChannelOf(login: string) {
  if (state.preferences.channels.includes(login)) { activate(login); return }
  try { await joinChannel(login) } catch (error) { toast(displayError(error)) }
}

const CARD_OPEN_DELAY = 300
const CARD_CLOSE_DELAY = 250

function closeUserCard() {
  clearTimeout(cardOpenTimer); clearTimeout(cardCloseTimer)
  cardOpenTimer = 0; cardCloseTimer = 0; cardLogin = ''; cardPinned = false; cardGeneration++
  $('#user-card').hidden = true
}
function scheduleCardClose() {
  if (cardPinned) return
  clearTimeout(cardCloseTimer)
  cardCloseTimer = window.setTimeout(() => { if (!cardPinned) closeUserCard() }, CARD_CLOSE_DELAY)
}

// What the room already knows about a chatter: enough for a card to open before Helix answers, and all it gets when no account is connected.
function localChatter(login: string) {
  const messages = store.get(active).filter(message => !message.system && message.login.toLowerCase() === login)
  const last = messages.at(-1)
  return { count: messages.length, user: last?.user ?? '', color: last?.color && /^#[0-9a-f]{6}$/i.test(last.color) ? last.color : '' }
}

function renderUserCard(login: string, card: UserCard | null, note: string) {
  const element = $('#user-card')
  const local = localChatter(login)
  const displayName = card?.displayName || local.user || login
  element.replaceChildren()

  const head = document.createElement('div'); head.className = 'user-card-head'
  const avatar = document.createElement('span'); avatar.className = 'user-card-avatar'; avatar.textContent = displayName.slice(0, 1)
  const avatarUrl = card?.avatarUrl || chatterAvatars.get(login) || ''
  if (avatarUrl) avatar.append(avatarImage(avatarUrl, '', 72))
  const identity = document.createElement('div'); identity.className = 'user-card-identity'
  const name = document.createElement('div'); name.className = 'user-card-name'
  const label = document.createElement('span'); label.textContent = displayName
  if (local.color) label.style.setProperty('--chatter', local.color)
  name.append(label)
  if (card?.broadcasterType) {
    const seal = document.createElement('span'); seal.className = 'user-card-seal'
    seal.innerHTML = icon('verified')
    seal.title = card.broadcasterType === 'partner' ? m.app.partnerChannel : m.app.affiliateChannel
    name.append(seal)
  }
  const handle = document.createElement('p'); handle.className = 'user-card-login'; handle.textContent = `@${login}`
  identity.append(name, handle)
  if (card) {
    const live = document.createElement('span'); live.className = `user-card-live${card.live ? '' : ' offline'}`
    live.append(document.createElement('i'))
    live.append(card.live ? card.viewers ? m.app.liveWithViewers(numbers.format(card.viewers), card.viewers) : m.app.live : m.app.offline)
    identity.append(live)
  }
  head.append(avatar, identity)
  element.append(head)

  if (card?.description) { const bio = document.createElement('p'); bio.className = 'user-card-bio'; bio.textContent = card.description; element.append(bio) }

  const stats = document.createElement('div'); stats.className = 'user-card-stats'
  const addStat = (value: string, caption: string, title = '') => {
    const stat = document.createElement('div'); stat.className = 'user-card-stat'
    if (title) stat.title = title
    const figure = document.createElement('strong'); figure.textContent = value
    const legend = document.createElement('span'); legend.textContent = caption
    stat.append(figure, legend); stats.append(stat)
  }
  // Twitch only exposes a follower total to this token; a subscriber count belongs to the broadcaster alone.
  if (card?.followers !== undefined) addStat(compactNumbers.format(card.followers), 'Followers', m.app.followerCount(numbers.format(card.followers), card.followers))
  const created = card?.createdAt ? new Date(card.createdAt) : null
  if (created && !Number.isNaN(created.getTime())) addStat(String(created.getFullYear()), m.app.onTwitch)
  addStat(numbers.format(local.count), m.app.messagesHere(local.count))
  element.append(stats)

  if (card?.live && card.title) { const title = document.createElement('p'); title.className = 'user-card-title'; title.textContent = card.title; element.append(title) }
  if (note) { const paragraph = document.createElement('p'); paragraph.className = 'user-card-note'; paragraph.textContent = note; element.append(paragraph) }

  const actions = document.createElement('div'); actions.className = 'user-card-actions'
  const mention = document.createElement('button'); mention.type = 'button'; mention.innerHTML = `${icon('chat')}${m.app.mentionUser}`
  mention.disabled = !state.account || currentView !== 'room'
  mention.addEventListener('click', () => { closeUserCard(); mentionUser(displayName) })
  const join = document.createElement('button'); join.type = 'button'
  join.innerHTML = `${icon('hash')}${state.preferences.channels.includes(login) ? m.app.theirChannel : m.app.join}`
  join.disabled = login === active
  join.addEventListener('click', () => { closeUserCard(); void openChannelOf(login) })
  // Following and "open on Twitch" lead to the same page: a single button, whose label says what
  // is left to do there. Three actions is also all the card's width holds.
  const twitch = document.createElement('button'); twitch.type = 'button'; twitch.className = 'user-card-follow'; twitch.dataset.follow = login
  twitch.addEventListener('click', () => { closeUserCard(); window.twichat.external('twitch', login).catch(error => toast(displayError(error))) })
  actions.append(mention, join, twitch)
  paintFollowButton(twitch, login)
  element.append(actions)
}

/**
 * The way through to Twitch, from the card. Twichat cannot follow on the user's behalf — Twitch
 * closed that endpoint on 27 July 2021 — but it knows where the follow stands: while it is still
 * to be set, the button offers it; once set, it becomes a plain link to the channel.
 */
function paintFollowButton(button: HTMLElement, login: string) {
  const status = followStatuses.get(login)
  const answered = !!status?.known
  const following = answered && status.following
  button.innerHTML = `${icon(answered && !following ? 'heart' : 'external')}${answered && !following ? m.app.follow : 'Twitch'}`
  button.dataset.following = String(following)
  button.title = following ? m.app.youFollowOpens(login) : m.app.followOnTwitch(login)
}
/** An answer from Twitch arriving after the card opened: the button updates without a redraw. */
function paintCardFollow(login: string) {
  const button = document.querySelector<HTMLElement>(`#user-card [data-follow="${CSS.escape(login)}"]`)
  if (button) paintFollowButton(button, login)
}
function openUserCard(login: string, requestedX: number, requestedY: number, pinned: boolean) {
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return
  closeAccountMenu(); closeRoomContextMenu(); closeMessageContextMenu()
  clearTimeout(cardOpenTimer); clearTimeout(cardCloseTimer); cardOpenTimer = 0; cardCloseTimer = 0
  cardLogin = login; cardPinned = pinned
  const generation = ++cardGeneration
  const element = $('#user-card')
  const cached = userCards.get(login)
  renderUserCard(login, cached ?? null, cached ? '' : state.account ? m.app.loadingProfile : m.app.profileNeedsAccount)
  placeFloating(element, requestedX, requestedY)
  if (!state.account) return
  // Opening a card is a gesture, not a loop: a question left unanswered deserves to be asked again
  // here, otherwise the button would say "Twitch" to someone who does not follow, without saying why.
  if (!followStatuses.has(login)) void refreshFollowStatus(login, true)
  if (cached) return
  void window.twichat.userCard(login).then(profile => {
    userCards.set(login, profile)
    if (generation !== cardGeneration) return
    // The card grew or shrank around its own corner: re-clamp from where it already sits.
    const bounds = element.getBoundingClientRect()
    renderUserCard(login, profile, '')
    placeFloating(element, bounds.left, bounds.top)
  }).catch(error => {
    if (generation !== cardGeneration) return
    const bounds = element.getBoundingClientRect()
    renderUserCard(login, null, displayError(error))
    placeFloating(element, bounds.left, bounds.top)
  })
}

function cardAnchorPoint(trigger: HTMLElement) {
  const bounds = trigger.getBoundingClientRect()
  return [bounds.right + 10, bounds.top - 8] as const
}

async function leaveRoom(channel: string) {
  if (!state.preferences.channels.includes(channel)) return
  closeFloatingLayers()
  const wasActive = channel === active
  try { await window.twichat.part(channel) } catch (error) { toast(displayError(error)); return }
  if (wasActive) player.stop()
  store.remove(channel); state.preferences.channels = state.preferences.channels.filter(item => item !== channel)
  unread.delete(channel); mentions.delete(channel); joined.delete(channel); roomModes.delete(channel)
  thirdPartyEmotes.delete(channel); thirdPartyRoomKeys.delete(channel)
  twitchEmotes.delete(channel); twitchEmoteIds.delete(channel); twitchRoomKeys.delete(channel); roomIds.delete(channel)
  if (!wasActive) { renderRooms(); save(); return }
  const next = state.preferences.channels[0] ?? ''
  active = next; state.preferences.active = next
  composer.setRoom(next)
  if (currentView !== 'room') { renderRooms(); save(); return }
  if (next) activate(next)
  else { virtualLog.setVisible(false); showView('welcome'); renderRooms(); save() }
}

// The cap Twitch imposes on a client is announced here, before the room list grows past it.
async function joinChannel(channel: string) {
  if (!state.preferences.channels.includes(channel) && state.preferences.channels.length >= 20) {
    throw new Error(m.app.roomLimitReached)
  }
  await window.twichat.join(channel)
  if (!state.preferences.channels.includes(channel)) state.preferences.channels.push(channel)
  joinDialog.close(); activate(channel); save(); void refreshProfiles([channel])
}

/**
 * Following a raid, the way Twitch does: the watched channel takes its viewers along, the arrival
 * room opens and becomes active. The one left behind stays in the list: a raid is not a goodbye,
 * and Twichat keeps its channels as rooms.
 */
async function followRaid(raid: Extract<ChatEvent, { type: 'raid' }>) {
  // The raid only moves whoever was watching that channel: elsewhere it is just a line of chat.
  if (raid.channel !== active || currentView !== 'room') return
  try { await joinChannel(raid.to) } catch (error) { toast(displayError(error)); return }
  toast(m.app.raidFollowed(raid.toDisplayName))
}

async function addRoom(value?: string) {
  if (!value) {
    joinDialog.showModal()
    const input = $<HTMLInputElement>('#channel-input'); input.value = ''; input.focus()
    return
  }
  try { await joinChannel(value.trim().replace(/^#/, '').toLowerCase()) }
  catch (error) { $('#join-error').textContent = displayError(error) }
}

const railHints = (): [string, string][] => [['#open-discover', m.app.exploreChannels], ['#add-room', platformKeys(m.app.joinChannelShortcut, commandKey())], ['#own-channel', m.app.yourChannel], ['#account-button', m.app.accountAndSettings]]
function setSidebarCollapsed(collapsed: boolean, remember = true) {
  appRoot.classList.toggle('sidebar-collapsed', collapsed)
  const toggle = $('#toggle-sidebar')
  const label = collapsed ? m.app.expandSidebar : m.app.collapseSidebar
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.setAttribute('aria-label', label)
  toggle.title = `${label} (${keyLabel(SHORTCUTS.sidebar, commandKey())})`
  // Reduced to avatars, every row needs the tooltip its label used to carry.
  for (const [selector, hint] of railHints()) { const element = $(selector); if (collapsed) element.title = hint; else element.removeAttribute('title') }
  if (remember) save()
}

function scheduleLiveRefresh() {
  clearInterval(liveRefreshTimer)
  // A stream starts or ends without warning, so the sidebar refreshes itself.
  liveRefreshTimer = window.setInterval(() => {
    // The dates leave whatever the window is doing: a hidden window keeps receiving messages.
    flushActivity()
    if (document.hidden || !workspaceEntered) return
    void refreshProfiles(state.preferences.channels)
    void refreshOwnProfile()
  }, 120_000)
  // The displayed duration is only a subtraction: it moves on without asking Twitch again.
  clearInterval(uptimeTimer)
  uptimeTimer = window.setInterval(() => { if (!document.hidden && workspaceEntered) { updateRoomLive(); updateFollowGate() } }, 30_000)
}

async function refreshProfiles(channels: string[]) {
  if (!channels.length) return
  try {
    const profiles = await window.twichat.profiles(channels)
    for (const profile of profiles) { roomProfiles.set(profile.channel, profile); if (profile.live) markActivity(profile.channel) }
    renderRooms(); updateRoomLive()
  } catch { /* The initials remain a complete, offline-safe fallback. */ }
}

// Asked apart from the room list: folding the own login into that call could push it past the 20-channel cap.
async function refreshOwnProfile() {
  const login = state.account
  if (!login) return
  try {
    const profiles = await window.twichat.profiles([login])
    for (const profile of profiles) roomProfiles.set(profile.channel, profile)
    if (state.account !== login) return
    const displayName = profiles.find(profile => profile.channel === login)?.displayName ?? ''
    if (displayName && displayName !== accountDisplayName) { accountDisplayName = displayName; virtualLog.refresh() }
    renderRooms(); updateRoomLive()
  } catch { /* The initial remains a complete, offline-safe fallback. */ }
}

function discoveryStatus(title: string, copy: string, action: 'login' | 'retry' | null = null) {
  const status = $('#discover-status')
  status.hidden = false
  status.querySelector('h2')!.textContent = title
  status.querySelector('p')!.textContent = copy
  const button = $<HTMLButtonElement>('#discover-login')
  button.hidden = !action
  button.textContent = action === 'retry' ? m.app.retry : m.app.connectMyAccount
  button.dataset.action = action ?? ''
  $('#discover-results').hidden = true
  $('#discover-skeleton').hidden = true
  $('#discover-categories').hidden = true
  $('#followed-offline').hidden = true
}

/** Both tabs share the grid: a single list is alive at a time. */
function scopeStreams(): StreamSummary[] { return discoveryScope === 'followed' ? followedStreams : discoveredStreams }

// Thumbnails arrive over the network, so the grid keeps its shape while they load.
function showDiscoverySkeleton() {
  const root = $('#discover-skeleton')
  if (!root.childElementCount) {
    for (let index = 0; index < 8; index++) {
      const card = document.createElement('div'); card.className = 'stream-card skeleton-card'
      card.innerHTML = '<div class="skeleton-preview"></div><div class="skeleton-lines"><span></span><span></span></div>'
      root.append(card)
    }
  }
  root.hidden = false
  $('#discover-summary').textContent = discoveryScope === 'followed' ? m.app.loadingFollowed : m.app.loadingChannels
  $('#discover-status').hidden = true
  $('#discover-results').hidden = true
  $('#followed-offline').hidden = true
}

function uptimeLabel(startedAt: string): string {
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start)) return ''
  const minutes = Math.floor((Date.now() - start) / 60_000)
  if (minutes < 1) return m.app.startingUp
  if (minutes < 60) return `${minutes} min`
  return m.follow.hoursAndMinutes(Math.floor(minutes / 60), minutes % 60)
}

function toggleCategory(category: string) {
  if (selectedCategories.has(category)) selectedCategories.delete(category); else selectedCategories.add(category)
  renderDiscoveryCategories(); renderDiscoveryResults()
}

function renderDiscoveryCategories() {
  const counts = new Map<string, number>()
  for (const stream of scopeStreams()) if (stream.game) counts.set(stream.game, (counts.get(stream.game) ?? 0) + 1)
  const categories = [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 18)
  const root = $('#discover-tag-list'); root.replaceChildren()
  $('#discover-categories').hidden = !categories.length
  const all = document.createElement('button'); all.type = 'button'; all.className = 'tag-filter'; all.textContent = m.app.allCategories; all.setAttribute('aria-pressed', String(selectedCategories.size === 0))
  all.addEventListener('click', () => { selectedCategories.clear(); renderDiscoveryCategories(); renderDiscoveryResults() }); root.append(all)
  for (const [category, count] of categories) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tag-filter'
    button.textContent = category
    const badge = document.createElement('b'); badge.textContent = String(count); button.append(badge)
    button.setAttribute('aria-pressed', String(selectedCategories.has(category)))
    button.addEventListener('click', () => toggleCategory(category))
    root.append(button)
  }
}

function discoveryCard(stream: StreamSummary) {
  const article = document.createElement('article'); article.className = 'stream-card'
  const joinedRoom = state.preferences.channels.includes(stream.channel)

  const preview = document.createElement('div'); preview.className = 'stream-preview'
  if (stream.thumbnailUrl) {
    const image = document.createElement('img'); image.className = 'stream-thumb'
    image.src = stream.thumbnailUrl; image.alt = ''; image.width = 440; image.height = 248
    image.loading = 'lazy'; image.decoding = 'async'
    image.addEventListener('error', () => image.remove())
    preview.append(image)
  }
  const badge = document.createElement('span'); badge.className = 'stream-live'; badge.innerHTML = '<i></i>'; badge.append(m.app.liveTag)
  const uptime = uptimeLabel(stream.startedAt)
  if (uptime) { const since = document.createElement('span'); since.className = 'stream-uptime'; since.innerHTML = icon('clock'); since.append(` ${uptime}`); since.title = m.app.liveSince(uptime); preview.append(since) }
  const viewers = document.createElement('span'); viewers.className = 'stream-viewers'; viewers.innerHTML = icon('people')
  viewers.append(` ${compactNumbers.format(stream.viewers)}`); viewers.title = m.app.viewerCount(numbers.format(stream.viewers), stream.viewers)
  preview.append(badge, viewers)

  const body = document.createElement('div'); body.className = 'stream-card-body'
  const avatar = document.createElement('span'); avatar.className = 'stream-avatar'; avatar.textContent = stream.displayName.slice(0, 1)
  if (stream.avatarUrl) { const image = document.createElement('img'); image.src = stream.avatarUrl; image.alt = ''; image.width = 40; image.height = 40; image.loading = 'lazy'; image.addEventListener('error', () => image.remove()); avatar.append(image) }
  const identity = document.createElement('div'); identity.className = 'stream-identity'
  const name = document.createElement('strong'); name.textContent = stream.displayName
  const title = document.createElement('p'); title.className = 'stream-title'; title.textContent = stream.title || m.app.liveConversation
  if (stream.title) title.title = stream.title
  identity.append(name, title)
  body.append(avatar, identity)

  const meta = document.createElement('div'); meta.className = 'stream-meta'
  if (stream.game) {
    const game = document.createElement('button'); game.type = 'button'; game.className = 'stream-game'; game.textContent = stream.game
    game.title = m.app.filterOnGame(stream.game); game.setAttribute('aria-pressed', String(selectedCategories.has(stream.game)))
    game.addEventListener('click', () => toggleCategory(stream.game))
    meta.append(game)
  }
  for (const tag of stream.tags.slice(0, 3)) { const label = document.createElement('span'); label.className = 'stream-tag'; label.textContent = tag; meta.append(label) }

  const join = document.createElement('button'); join.type = 'button'; join.className = 'join-stream'
  join.innerHTML = icon('chat'); join.append(joinedRoom ? m.app.openChannel : m.app.joinChannel)
  if (joinedRoom) join.dataset.joined = 'true'
  join.setAttribute('aria-label', joinedRoom ? m.app.openChannelOf(stream.displayName) : m.app.joinChannelOf(stream.displayName))
  join.addEventListener('click', () => void addRoom(stream.channel))

  article.append(preview, body, meta, join)
  return article
}

// An offline followed channel has neither thumbnail nor audience: it fits on one row,
// and its room stays readable even once the live stream is over.
function followedCard(profile: RoomProfile) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'followed-card'
  const joinedRoom = state.preferences.channels.includes(profile.channel)
  if (joinedRoom) button.dataset.joined = 'true'
  const avatar = document.createElement('span'); avatar.className = 'followed-avatar'; avatar.textContent = profile.displayName.slice(0, 1)
  if (profile.avatarUrl) {
    const image = document.createElement('img'); image.src = profile.avatarUrl; image.alt = ''; image.width = 32; image.height = 32
    image.loading = 'lazy'; image.addEventListener('error', () => image.remove())
    avatar.append(image)
  }
  const name = document.createElement('span'); name.className = 'followed-name'; name.textContent = profile.displayName
  button.append(avatar, name)
  button.setAttribute('aria-label', joinedRoom ? m.app.openChannelOf(profile.displayName) : m.app.joinChannelOf(profile.displayName))
  button.title = button.getAttribute('aria-label')!
  button.addEventListener('click', () => void addRoom(profile.channel))
  return button
}

// A category filter only speaks of live streams: it pushes the offline list back.
function renderFollowedOffline(query: string): number {
  const section = $('#followed-offline')
  if (discoveryScope !== 'followed' || selectedCategories.size) { section.hidden = true; return 0 }
  const matches = followedOffline.filter(profile => !query || `${profile.displayName} ${profile.channel}`.toLocaleLowerCase(locale).includes(query))
  $('#followed-offline-list').replaceChildren(...matches.map(followedCard))
  section.hidden = !matches.length
  // A list that stops short without saying so reads as a broken search rather than a short list:
  // the channel that is missing is one this window never loaded.
  $('#followed-offline-label').textContent = followedTruncated && !query
    ? m.app.followedPartial(followedOffline.length)
    : m.app.offlineChannels(matches.length)
  return matches.length
}

function renderDiscoveryResults() {
  const streams = scopeStreams()
  const query = $<HTMLInputElement>('#discover-query').value.trim().toLocaleLowerCase(locale)
  if (!streams.length && !(discoveryScope === 'followed' && followedOffline.length)) {
    if (discoveryScope === 'followed') discoveryStatus(m.app.noFollowedChannels, m.app.noFollowedHint, 'retry')
    else discoveryStatus(m.app.noLiveChannel, m.app.noChannelForLanguage, 'retry')
    return
  }
  const filtered = streams.filter(stream => {
    const haystack = [stream.displayName, stream.channel, stream.title, stream.game, ...stream.tags].join(' ').toLocaleLowerCase(locale)
    const matchesQuery = !query || haystack.includes(query)
    const matchesCategory = !selectedCategories.size || selectedCategories.has(stream.game)
    return matchesQuery && matchesCategory
  })
  const mode = $<HTMLSelectElement>('#discover-sort').value
  filtered.sort((a, b) => mode === 'viewers-asc' ? a.viewers - b.viewers
    : mode === 'name' ? collator.compare(a.displayName, b.displayName)
    : mode === 'recent' ? (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
    : b.viewers - a.viewers)
  const root = $('#discover-results'); root.replaceChildren(...filtered.map(discoveryCard))
  root.hidden = !filtered.length; $('#discover-status').hidden = true; $('#discover-skeleton').hidden = true
  const offline = renderFollowedOffline(query)
  const total = filtered.reduce((sum, stream) => sum + stream.viewers, 0)
  const live = m.app.liveChannels(filtered.length)
  if (discoveryScope === 'followed') {
    $('#discover-summary').textContent = filtered.length || offline
      ? `${live}${offline ? m.app.offlineSuffix(offline) : ''}${filtered.length ? m.app.viewersTotal(compactNumbers.format(total)) : ''}`
      : m.app.noFollowedMatch
  } else {
    $('#discover-summary').textContent = filtered.length ? m.app.liveAndViewers(live, compactNumbers.format(total)) : m.app.noChannelMatchFilters
  }
  if (!filtered.length && !offline) discoveryStatus(m.app.noChannelMatch, m.app.noChannelMatchHint, null)
}

function updateDiscoveryFreshness() {
  const updatedAt = discoveryScope === 'followed' ? followedUpdatedAt : discoveryUpdatedAt
  const label = $('#discover-freshness')
  label.hidden = !updatedAt
  if (updatedAt) label.textContent = m.app.updatedAt(clock.format(updatedAt))
}

async function loadFollowed(refresh = false) {
  if (!state.account) { discoveryStatus(m.app.connectAccountShort, m.app.followedNeedsAccount, 'login'); return }
  if (followedLoading) return
  followedLoading = true; $<HTMLButtonElement>('#refresh-discover').disabled = true
  // The list already loaded stays on screen during the update: only an empty tab needs skeletons.
  if (followedStreams.length || followedOffline.length) { renderDiscoveryCategories(); renderDiscoveryResults() }
  else showDiscoverySkeleton()
  const asked = state.account
  try {
    const followed = await window.twichat.followed(refresh)
    // A late answer must not overwrite the catalog if the tab changed meanwhile — nor if the
    // account did: these are the channels somebody else follows.
    if (discoveryScope !== 'followed' || asked !== state.account) return
    followedStreams = followed.live; followedOffline = followed.offline; followedTruncated = followed.truncated; followedUpdatedAt = Date.now()
    for (const category of [...selectedCategories]) if (!followedStreams.some(stream => stream.game === category)) selectedCategories.delete(category)
    updateDiscoveryFreshness(); renderDiscoveryCategories(); renderDiscoveryResults()
  } catch (error) {
    // A request the main process turned down because the account changed under it is not a
    // failure the reader needs to hear about: the view it belonged to is gone.
    // Retrying a call the token has no scope for would only fail again: those two send the reader
    // to the sign-in, which is the one gesture that brings the missing authorisation back.
    const reconnect = ['twitchFollowedScope', 'twitchFollowedReconnect'].includes(errorKey(error) ?? '')
    if (discoveryScope === 'followed' && asked === state.account) discoveryStatus(m.app.followedLoadFailed, displayError(error), state.account && !reconnect ? 'retry' : 'login')
  } finally {
    followedLoading = false; $<HTMLButtonElement>('#refresh-discover').disabled = false
  }
}

function resetFollowed() { followedStreams = []; followedOffline = []; followedTruncated = false; followedUpdatedAt = 0 }

function setDiscoveryScope(scope: 'top' | 'followed') {
  if (discoveryScope === scope) return
  discoveryScope = scope
  selectedCategories.clear()
  $('#scope-top').setAttribute('aria-pressed', String(scope === 'top'))
  $('#scope-followed').setAttribute('aria-pressed', String(scope === 'followed'))
  // The language only filters the public catalog: Twitch returns followed channels as they are.
  $<HTMLSelectElement>('#discover-language').disabled = scope === 'followed'
  $('#discover-language-field').classList.toggle('is-muted', scope === 'followed')
  updateDiscoveryFreshness()
  void loadDiscovery()
}

async function loadDiscovery(refresh = false) {
  if (discoveryScope === 'followed') return loadFollowed(refresh)
  if (!state.account) { discoveryStatus(m.app.connectAccountShort, m.app.discoverNeedsAccount, 'login'); return }
  if (discoveryLoading) return
  discoveryLoading = true; $<HTMLButtonElement>('#refresh-discover').disabled = true
  const language = discoveryLanguage
  // Refreshing in place keeps the grid readable; only an empty view needs placeholders.
  if (discoveredStreams.length) { renderDiscoveryCategories(); renderDiscoveryResults() }
  else showDiscoverySkeleton()
  const asked = state.account
  try {
    const streams = await window.twichat.discover(language, refresh)
    // A slower answer for a language the user already left must not replace the visible grid,
    // and neither must one fetched under an account that has since been signed out.
    if (language !== discoveryLanguage || discoveryScope !== 'top' || asked !== state.account) return
    discoveredStreams = streams; discoveryUpdatedAt = Date.now()
    for (const category of [...selectedCategories]) if (!discoveredStreams.some(stream => stream.game === category)) selectedCategories.delete(category)
    updateDiscoveryFreshness(); renderDiscoveryCategories(); renderDiscoveryResults()
  } catch (error) {
    if (language === discoveryLanguage && discoveryScope === 'top' && asked === state.account) discoveryStatus(m.app.discoverLoadFailed, displayError(error), state.account ? 'retry' : 'login')
  }
  finally {
    discoveryLoading = false; $<HTMLButtonElement>('#refresh-discover').disabled = false
    // A language picked mid-request was skipped by the reentrancy guard: honour it now.
    if (language !== discoveryLanguage && discoveryScope === 'top') void loadDiscovery()
  }
}

function openDiscover() {
  closeFloatingLayers()
  player.stop(); virtualLog.setVisible(false); showView('discover'); renderRooms(); void loadDiscovery()
}

function showChatterAvatar(login: string, url: string) {
  document.querySelectorAll<HTMLElement>('.message-avatar[data-login]').forEach(avatar => {
    if (avatar.dataset.login !== login || avatar.querySelector('img')) return
    const image = document.createElement('img'); image.src = url; image.alt = ''; image.width = 34; image.height = 34
    image.addEventListener('error', () => image.remove())
    avatar.append(image)
  })
}

function queueChatterAvatar(loginInput: string) {
  const login = loginInput.toLowerCase()
  if (!state?.account || !/^[a-z0-9_]{1,25}$/.test(login)) return
  const cached = chatterAvatars.get(login)
  if (cached) { showChatterAvatar(login, cached); return }
  if ((chatterAvatarRetryAt.get(login) ?? 0) > Date.now()) return
  pendingChatterAvatars.add(login)
  clearTimeout(chatterAvatarTimer)
  chatterAvatarTimer = window.setTimeout(() => void loadChatterAvatars(), 180)
}

async function loadChatterAvatars() {
  if (chatterAvatarLoading || !state.account || !pendingChatterAvatars.size) return
  const batch = [...pendingChatterAvatars].slice(0, 100)
  for (const login of batch) { pendingChatterAvatars.delete(login); chatterAvatarRetryAt.set(login, Date.now() + 5 * 60_000) }
  chatterAvatarLoading = true
  try {
    const profiles = await window.twichat.chatterProfiles(batch)
    for (const profile of profiles) {
      if (!profile.avatarUrl) continue
      chatterAvatars.set(profile.channel, profile.avatarUrl)
      showChatterAvatar(profile.channel, profile.avatarUrl)
    }
  } catch {
    for (const login of batch) chatterAvatarRetryAt.set(login, Date.now() + 30_000)
  } finally {
    chatterAvatarLoading = false
    if (pendingChatterAvatars.size) chatterAvatarTimer = window.setTimeout(() => void loadChatterAvatars(), 180)
  }
}

function queueRecentChatterAvatars() {
  if (!active) return
  for (const message of store.get(active).slice(-60)) if (!message.system) queueChatterAvatar(message.login)
}

async function loadThirdPartyEmotes(channel: string, roomId: string) {
  const key = `${channel}:${roomId}`
  if (thirdPartyRoomKeys.get(channel) === key) return
  thirdPartyRoomKeys.set(channel, key)
  try {
    const emotes = await window.twichat.thirdPartyEmotes(channel, roomId)
    if (thirdPartyRoomKeys.get(channel) !== key) return
    thirdPartyEmotes.set(channel, new Map(emotes.map(item => [item.code, item])))
    if (channel === active) composer.refresh()
    if (channel === active && currentView === 'room') virtualLog.refresh()
  } catch {
    if (thirdPartyRoomKeys.get(channel) === key) thirdPartyRoomKeys.delete(channel)
  }
}

/** Twitch emotes stay in their own list: only the IRC ranges may turn a word into a Twitch emote. */
async function loadTwitchEmotes(channel: string, roomId: string) {
  if (!state.account) return
  const key = `${channel}:${roomId}`
  if (twitchRoomKeys.get(channel) === key) return
  twitchRoomKeys.set(channel, key)
  try {
    const emotes = await window.twichat.twitchEmotes(roomId)
    if (twitchRoomKeys.get(channel) !== key) return
    twitchEmotes.set(channel, emotes)
    twitchEmoteIds.set(channel, new Map(emotes.map(emote => [emote.name, emote.id])))
    if (channel === active) { composer.refresh(); if (currentView === 'room') virtualLog.refresh() }
  } catch (error) {
    if (twitchRoomKeys.get(channel) === key) twitchRoomKeys.delete(channel)
    console.warn('Unable to load the Twitch emotes:', displayError(error))
  }
}

async function reloadEmotes(channel: string) {
  const roomId = roomIds.get(channel)
  if (!channel || !roomId) return
  thirdPartyRoomKeys.delete(channel); twitchRoomKeys.delete(channel)
  await Promise.allSettled([loadThirdPartyEmotes(channel, roomId), loadTwitchEmotes(channel, roomId)])
}

function createMessage(message: ChatMessage) {
  const row = document.createElement('article')
  const mention = isMention(message, state.account, accountDisplayName)
  row.className = `message${message.action ? ' action' : ''}${message.own ? ' own' : ''}${message.system ? ' system' : ''}${mention ? ' mention' : ''}`
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = message.user.slice(0, 1)
  const login = message.login.toLowerCase()
  // An identified author is what both the profile card and the message menu hang on.
  const identified = !message.system && /^[a-z0-9_]{1,25}$/.test(login)
  // Both handles carry the same promise, so the menu is discoverable from either one.
  const handleTitle = m.app.profileOf(message.user)
  if (identified) {
    row.dataset.login = login
    avatar.dataset.login = login; avatar.dataset.card = login; avatar.title = handleTitle
    const avatarUrl = chatterAvatars.get(login)
    if (avatarUrl) { const image = document.createElement('img'); image.src = avatarUrl; image.alt = ''; image.width = 34; image.height = 34; image.addEventListener('error', () => image.remove()); avatar.append(image) }
    else queueChatterAvatar(login)
  }
  const main = document.createElement('div'); main.className = 'message-main'
  // The quote comes from the `reply-*` tags alone: it stays right when the parent has left the
  // history, precedes our arrival in the room, or has been deleted.
  if (message.reply) {
    const quote = document.createElement('button')
    quote.type = 'button'; quote.className = 'message-quote'; quote.tabIndex = -1
    quote.dataset.reply = message.reply.id
    quote.title = m.app.goToMessageOf(message.reply.user)
    const who = document.createElement('span'); who.className = 'message-quote-user'; who.textContent = message.reply.user
    const said = document.createElement('span'); said.className = 'message-quote-text'
    // The parent body arrives without an `emotes` tag: no offset would let us render it as images.
    said.textContent = message.reply.text || m.app.deletedMessage
    quote.append(who, said)
    main.append(quote)
  }
  const meta = document.createElement('div'); meta.className = 'message-meta'
  const user = document.createElement(identified ? 'button' : 'span'); user.className = 'message-user'; user.textContent = message.user
  if (identified) {
    // Not a tab stop: a virtualised log would put hundreds of them between the reader and the composer.
    const trigger = user as HTMLButtonElement
    trigger.type = 'button'; trigger.tabIndex = -1; trigger.dataset.card = login; trigger.title = handleTitle
  }
  // The Twitch color goes through a variable: the light theme pulls it back to a readable lightness.
  if (message.color && /^#[0-9a-f]{6}$/i.test(message.color)) user.style.setProperty('--chatter', message.color)
  meta.append(user)
  for (const badgeName of message.badges.slice(0, 2)) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = badgeName; meta.append(badge) }
  const time = document.createElement('time'); time.className = 'message-time'; time.dateTime = new Date(message.time).toISOString(); time.textContent = clock.format(message.time); meta.append(time)
  const text = document.createElement('p'); text.className = 'message-text'
  for (const fragment of messageFragments(message.text, message.emotes, thirdPartyEmotes.get(message.channel), message.own ? twitchEmoteIds.get(message.channel) : undefined)) {
    if (fragment.type === 'text') {
      if (!mention) { text.append(document.createTextNode(fragment.text)); continue }
      // A reply to one of your own messages is a mention with no nickname in the text: nothing to underline.
      for (const segment of mentionSegments(fragment.text, state.account, accountDisplayName)) {
        if (!segment.mention) { text.append(document.createTextNode(segment.text)); continue }
        const marked = document.createElement('b'); marked.className = 'message-mention'; marked.textContent = segment.text
        text.append(marked)
      }
      continue
    }
    const image = document.createElement('img')
    const source = fragment.source === 'twitch' ? 'Twitch' : fragment.source === '7tv' ? '7TV' : fragment.source === 'bttv' ? 'BetterTTV' : 'FrankerFaceZ'
    image.className = 'message-emote'; image.alt = fragment.text; image.title = `${fragment.text} · ${source}`; image.loading = 'lazy'; image.decoding = 'async'
    image.addEventListener('error', () => image.replaceWith(document.createTextNode(fragment.text)), { once: true })
    image.src = fragment.url
    text.append(image)
  }
  main.append(meta, text); row.append(avatar, main)
  return row
}

function updateCount() {
  const count = store.get(active).length
  $('#message-count').textContent = m.app.messageCount(count)
  $('#chat-empty').hidden = count > 0
}
function updateModes() {
  const modes = roomModes.get(active) ?? {}
  const labels: string[] = []
  if (modes['slow'] && modes['slow'] !== '0') labels.push(m.app.modeSlow(modes['slow']))
  if (modes['followers-only'] && modes['followers-only'] !== '-1') labels.push(m.app.modeFollowers)
  if (modes['subs-only'] === '1') labels.push(m.app.modeSubs)
  if (modes['emote-only'] === '1') labels.push(m.app.modeEmotes)
  const root = $('#room-modes'); root.replaceChildren()
  for (const label of labels) { const tag = document.createElement('span'); tag.className = 'mode-tag'; tag.textContent = label; root.append(tag) }
}
/**
 * The banner above the input, when the room is in followers-only mode and the account does not
 * answer it yet. Twichat cannot follow on its behalf — Twitch closed that endpoint on 27 July
 * 2021 — so it says what is missing and opens the channel for the gesture to happen there.
 */
async function refreshFollowStatus(channel: string, force = false) {
  if (!channel || !state.account || followChecks.has(channel)) return
  if (!force && (followStatuses.has(channel) || (followRetryAt.get(channel) ?? 0) > Date.now())) return
  followChecks.add(channel)
  updateFollowGate()
  // Whose follow this is. The map is emptied when the account changes, and an answer that
  // arrives after that change describes somebody else's channels: it is dropped, not stored.
  const asked = state.account
  try {
    const status = await window.twichat.followStatus(channel, roomIds.get(channel) ?? '')
    if (asked !== state.account) return
    followStatuses.set(channel, status)
    followRetryAt.delete(channel)
  } catch {
    // Without an answer, the banner keeps what it knows: the room stays usable.
    if (asked === state.account) followRetryAt.set(channel, Date.now() + FOLLOW_RETRY_DELAY)
  }
  finally {
    followChecks.delete(channel)
    updateFollowGate()
    paintCardFollow(channel)
  }
}
function updateFollowGate() {
  const gate = $('#composer-gate')
  const minutes = currentView === 'room' && active && state.account && !exemptFromFollowersOnly(roomBadges.get(active))
    ? followersOnlyMinutes(roomModes.get(active)?.['followers-only'])
    : null
  $<HTMLButtonElement>('#composer-gate-recheck').disabled = followChecks.has(active)
  if (minutes === null) { gate.hidden = true; return }
  void refreshFollowStatus(active)
  const notice = followNotice(minutes, followStatuses.get(active), active)
  if (!notice) { gate.hidden = true; return }
  $('#composer-gate-title').textContent = notice.title
  $('#composer-gate-detail').textContent = notice.detail
  $<HTMLButtonElement>('#composer-gate-follow').hidden = !notice.follow
  gate.hidden = false
}
// The audience and the uptime, in the room header: Helix gives both numbers, and the duration
// is recomputed in place between two refreshes.
function updateRoomLive() {
  const element = $('#channel-live')
  element.replaceChildren()
  const profile = currentView === 'room' && active ? roomProfiles.get(active) : undefined
  const uptime = profile?.live ? liveUptime(profile.startedAt) : ''
  // The public page carries no start time and not always an audience: each measure stands alone.
  if (!profile?.live || (profile.viewers === undefined && !uptime)) { element.hidden = true; return }
  if (profile.viewers !== undefined) {
    const viewers = document.createElement('span'); viewers.className = 'channel-live-stat'
    viewers.innerHTML = icon('people')
    viewers.append(` ${numbers.format(profile.viewers)}`)
    viewers.title = m.app.viewerCount(numbers.format(profile.viewers), profile.viewers)
    element.append(viewers)
  }
  if (uptime) {
    const duration = document.createElement('span'); duration.className = 'channel-live-stat'
    duration.innerHTML = icon('clock')
    duration.append(` ${uptime}`)
    duration.title = m.app.liveSince(uptime)
    element.append(duration)
  }
  element.hidden = false
}
function updateConnection(status: Connection, detail: string) {
  state.status = status
  const dot = $('#connection-dot'); dot.className = `status-dot ${status}`
  $('#connection-label').textContent = status === 'connected' ? m.app.chatConnected : status === 'error' ? m.app.needsAttention : status === 'offline' ? m.app.offline : m.app.connecting
  $('#technical-status').innerHTML = m.app.technicalStatus(status === 'connected' ? 'IRC / TLS' : m.app.ircWaiting)
  $('#channel-subtitle').textContent = detail
}

function handleEvents(events: ChatEvent[]) {
  let updateActive = false
  let updateRooms = false
  for (const event of events) {
    if (event.type === 'status') updateConnection(event.status, event.detail)
    if (event.type === 'account') { updateAccount(null); resetFollowed(); if (currentView === 'discover') void loadDiscovery(); toast(event.detail) }
    if (event.type === 'raid') void followRaid(event)
    if (event.type === 'joined') { joined.add(event.channel); if (event.channel === active) $('#join-state').textContent = m.app.roomJoined }
    if (event.type === 'roomstate') {
      roomModes.set(event.channel, event.tags)
      const roomId = event.tags['room-id']
      if (roomId) { roomIds.set(event.channel, roomId); void loadThirdPartyEmotes(event.channel, roomId); void loadTwitchEmotes(event.channel, roomId) }
      if (event.channel === active) { updateModes(); updateFollowGate() }
    }
    if (event.type === 'userstate') {
      roomBadges.set(event.channel, event.badges)
      if (event.channel === active) updateFollowGate()
    }
    if (event.type === 'clear') { store.clear(event.channel, event.user, event.id); if (event.channel === active && currentView === 'room') updateActive = true }
    if (event.type === 'message') {
      if (!state.preferences.channels.includes(event.message.channel)) continue
      // A message refused because of followers-only mode: Twitch has just ruled, and its answer
      // outweighs what we believed about the follow.
      if (event.message.notice?.startsWith('msg_followersonly')) void refreshFollowStatus(event.message.channel, true)
      const mention = isMention(event.message, state.account, accountDisplayName)
      store.add(event.message)
      markActivity(event.message.channel, event.message.time)
      // The main process only notifies while the window is in the background; the renderer only reports
      // a mention to it when system notifications are accepted in the settings.
      if (mention && notifications().mentions) void window.twichat.notifyMention({ channel: event.message.channel, user: event.message.user, text: event.message.text }).catch(() => {})
      const open = event.message.channel === active && currentView === 'room'
      // A system notification can be missed; the counter therefore keeps every mention that happened off
      // screen, open room included when the window is hidden. Coming back to the room clears it.
      if (mention && !(open && !document.hidden)) {
        mentions.set(event.message.channel, Math.min(100, (mentions.get(event.message.channel) ?? 0) + 1))
        updateRooms = true
      }
      if (open) updateActive = true
      else {
        unread.set(event.message.channel, Math.min(100, (unread.get(event.message.channel) ?? 0) + 1))
        updateRooms = true
      }
    }
  }
  if (updateActive) { updateCount(); virtualLog.set(store.get(active)) }
  if (updateRooms) renderRooms()
}

/**
 * Forgetting takes the account off this machine, which no undo brings back — so it asks once,
 * on the button itself. A dialog for it would be the fourth floating layer on this screen, and
 * the second click is the same confirmation with none of that.
 */
let forgetArmed: string | null = null
function disarmForget() {
  forgetArmed = null
  $('#account-menu-forget-label').textContent = m.ui.accountMenu.forget
}
/**
 * The four sentences the account writes over the shipped HTML. They are kept apart because
 * `hydrate` paints those same elements from their `data-i18n` key — the guest wording — so
 * everything that rehydrates the document has to write the account back afterwards.
 */
function paintAccountLabels(login: string | null) {
  $('#account-name').textContent = login ? login : m.app.guest
  $('#account-description').textContent = login ? m.app.twitchAccountConnected : m.app.readOnly
  $('#auth-title').textContent = login ? m.app.connectedAsDot(login) : m.app.joinTheChat
  $('#auth-copy').textContent = login ? m.app.accountEncrypted : m.app.authorizeInBrowser
}
function updateAccount(login: string | null) {
  const changed = state.account !== login
  state.account = login
  // Mentions are read against the account: the rows already rendered must run the detection again.
  if (changed) { accountDisplayName = ''; virtualLog.refresh() }
  const avatarGeneration = ++accountAvatarGeneration
  const accountAvatar = $('#account-avatar')
  accountAvatar.replaceChildren()
  accountAvatar.innerHTML = icon('user')
  if (login) {
    const cached = state.savedAvatars[login]
    if (cached) accountAvatar.replaceChildren(avatarImage(cached, m.app.avatarOf(login), 30))
    void window.twichat.chatterProfiles([login]).then(profiles => {
      if (avatarGeneration !== accountAvatarGeneration || state.account !== login) return
      const profile = profiles.find(item => item.channel === login)
      if (!profile?.avatarUrl) return
      const image = document.createElement('img')
      image.src = profile.avatarUrl; image.alt = m.app.avatarOf(profile.displayName || login); image.width = 30; image.height = 30
      image.addEventListener('error', () => {
        if (avatarGeneration !== accountAvatarGeneration) return
        if (cached) accountAvatar.replaceChildren(avatarImage(cached, m.app.avatarOf(login), 30))
        else accountAvatar.innerHTML = icon('user')
      }, { once: true })
      accountAvatar.replaceChildren(image)
    }).catch(error => console.warn('Unable to load the Twitch account avatar:', displayError(error)))
  }
  paintAccountLabels(login)
  composer.setRoom(active)
  composer.setAccount(login)
  $('#composer-login').hidden = !!login
  $('#composer-hint').hidden = !login
  $('#auth-fields').hidden = !!login
  followStatuses.clear(); followRetryAt.clear(); roomBadges.clear()
  updateFollowGate()
  renderOwnChannel()
  if (login) { void refreshOwnProfile(); chatterAvatarRetryAt.clear(); queueRecentChatterAvatars(); for (const [room, roomId] of roomIds) void loadTwitchEmotes(room, roomId) }
}

/**
 * The text under the stopped player. It announces what will actually happen: with autoplay on
 * the video starts by itself, otherwise it waits for the Play button.
 */
function idlePlayerDescription() {
  return playback().autoplay ? m.app.videoAutostarts : m.app.videoWaitsForPlay
}
function updatePlayer(playerState: StreamPlayerState, message?: string) {
  const previous = currentPlayerState
  currentPlayerState = playerState
  const placeholder = $('#video-placeholder'); const status = $('#player-status'); const error = $('#video-error')
  const reportsInterruption = ['error', 'offline', 'reconnecting'].includes(playerState)
  error.hidden = !reportsInterruption; error.textContent = message ?? ''; error.dataset.state = playerState
  $<HTMLButtonElement>('#play-stream').disabled = playerState === 'loading' || playerState === 'reconnecting'
  $<HTMLButtonElement>('#stop-stream').hidden = playerState === 'stopped'
  fullscreenButton.disabled = playerState !== 'playing'
  status.className = `quiet-tag ${playerState}`
  const anchor = $('#detached-panel-status')
  anchor.className = `quiet-tag ${playerState}`
  status.textContent = playerState === 'playing' ? m.app.liveTag : playerState === 'loading' ? m.app.playerLoading : playerState === 'offline' ? m.app.playerOffline : playerState === 'reconnecting' ? m.app.playerReconnecting : playerState === 'error' ? m.app.playerError : m.app.playerStopped
  anchor.textContent = status.textContent
  placeholder.hidden = playerState === 'playing'
  $('#video-title').textContent = playerState === 'loading' ? m.app.connectingToStream : playerState === 'offline' ? m.app.streamOver : playerState === 'reconnecting' ? m.app.streamComingBack : playerState === 'error' ? m.app.streamUnresponsive : m.app.keepAnEye
  $('#video-description').innerHTML = playerState === 'loading' ? m.app.askingTwitch : playerState === 'offline' ? m.app.resumeDetected : playerState === 'reconnecting' ? m.app.retrying : idlePlayerDescription()
  updatePlayerAction()
  if (playerState === 'playing' && (previous === 'offline' || previous === 'reconnecting')) toast(m.app.streamResumed)
}

function audioOnly() { return $<HTMLSelectElement>('#quality').value === 'audio_only' }
function updatePlayerToggleLabel() {
  const playerHidden = $('#room-body').classList.contains('chat-only')
  const audio = audioOnly()
  const toggle = $<HTMLButtonElement>('#toggle-player')
  toggle.setAttribute('aria-pressed', String(playerHidden))
  toggle.querySelector<HTMLElement>('[data-player-toggle-icon]')!.innerHTML = icon(audio ? 'audio' : 'video')
  toggle.querySelector('.button-text')!.textContent = playerHidden ? m.app.showMedia(audio ? m.app.theAudio : m.app.theVideo) : m.app.hideMedia(audio ? m.app.theAudio : m.app.theVideo)
}
function applyPlayerMode() {
  const audio = audioOnly()
  streamDock.classList.toggle('audio-only', audio)
  streamDock.setAttribute('aria-label', audio ? m.app.audioPlayerLabel : m.app.videoPlayerLabel)
  $('#player-channel').textContent = audio ? `AUDIO · # ${active}` : `# ${active}`
  // Detached, the window is showing this room: it follows a channel change even when nothing plays.
  if (detachedChannel && detachedChannel !== active && active) void window.twichat.commandPlayer('stop', active).catch(() => {})
  fullscreenButton.hidden = audio
  updatePlayerAction()
  updatePlayerToggleLabel()
}
function updatePlayerAction() {
  const retry = currentPlayerState === 'offline' || currentPlayerState === 'error'
  const button = $<HTMLButtonElement>('#play-stream')
  button.title = retry ? m.app.retry : audioOnly() ? m.app.listen : m.app.play
  button.setAttribute('aria-label', button.title)
}

const PLAYER_MIN_WIDTH = 280
const PLAYER_MAX_WIDTH = 900
function playerWidthBounds() {
  const roomWidth = $('#room-body').clientWidth
  return { min: Math.min(PLAYER_MIN_WIDTH, roomWidth), max: Math.max(Math.min(PLAYER_MIN_WIDTH, roomWidth), Math.min(PLAYER_MAX_WIDTH, Math.floor(roomWidth * .75))) }
}
function setPlayerWidth(requested: number, remember = false) {
  // Before the first layout the room measures nothing: applying a width here would freeze it at zero.
  if ($('#room-body').clientWidth <= 0) return
  const bounds = playerWidthBounds()
  const width = Math.round(Math.max(bounds.min, Math.min(bounds.max, requested)))
  streamDock.style.width = `${width}px`
  playerResizer.setAttribute('aria-valuemin', String(bounds.min))
  playerResizer.setAttribute('aria-valuemax', String(bounds.max))
  playerResizer.setAttribute('aria-valuenow', String(width))
  if (remember) { playerWidth = width; save() }
}
function defaultPlayerWidth() { return Math.min(400, Math.max(PLAYER_MIN_WIDTH, Math.floor($('#room-body').clientWidth * .3))) }
function restorePlayerWidth() {
  setPlayerWidth(playerWidth > 0 ? playerWidth : defaultPlayerWidth())
}
function resetPlayerWidth() {
  playerWidth = 0
  setPlayerWidth(defaultPlayerWidth())
  save()
}

let resizeStart: { x: number; width: number } | undefined
playerResizer.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  resizeStart = { x: event.clientX, width: streamDock.getBoundingClientRect().width }
  playerResizer.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing-player')
})
playerResizer.addEventListener('pointermove', event => {
  if (!resizeStart || !playerResizer.hasPointerCapture(event.pointerId)) return
  setPlayerWidth(resizeStart.width + resizeStart.x - event.clientX)
})
function finishPlayerResize(event: PointerEvent) {
  if (!resizeStart) return
  resizeStart = undefined
  if (playerResizer.hasPointerCapture(event.pointerId)) playerResizer.releasePointerCapture(event.pointerId)
  document.body.classList.remove('resizing-player')
  setPlayerWidth(streamDock.getBoundingClientRect().width, true)
}
playerResizer.addEventListener('pointerup', finishPlayerResize)
playerResizer.addEventListener('pointercancel', finishPlayerResize)
playerResizer.addEventListener('dblclick', resetPlayerWidth)
playerResizer.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') { resetPlayerWidth(); return }
  const direction = event.key === 'ArrowLeft' ? 1 : -1
  setPlayerWidth(streamDock.getBoundingClientRect().width + direction * (event.shiftKey ? 60 : 20), true)
})
// A narrowed window tightens the dock without erasing the wanted width: it comes back as soon as there is room.
window.addEventListener('resize', () => setPlayerWidth(playerWidth > 0 ? playerWidth : streamDock.getBoundingClientRect().width))

async function togglePlayerFullscreen() {
  if (audioOnly()) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await video.requestFullscreen()
  } catch { toast(m.app.fullscreenFailed) }
}
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === video
  fullscreenButton.setAttribute('aria-label', active ? m.app.exitFullscreen : m.app.enterFullscreen)
  fullscreenButton.title = active ? m.app.exitFullscreen : m.app.fullscreen
  fullscreenButton.innerHTML = icon(active ? 'fullscreenExit' : 'fullscreen')
})

/**
 * The player volume. The video no longer shows Chromium's controls on hover — they covered the
 * picture and looked like nothing else in the application — so the volume lives here, in the
 * dock, and follows the account like the other settings.
 */
function applySound(nextVolume: number, nextMuted: boolean, remember = false) {
  volume = Math.min(1, Math.max(0, Number.isFinite(nextVolume) ? nextVolume : 1))
  muted = nextMuted
  video.volume = volume
  video.muted = muted
  const slider = $<HTMLInputElement>('#volume')
  slider.value = String(Math.round(volume * 100))
  const silent = muted || volume === 0
  slider.classList.toggle('silent', silent)
  const button = $<HTMLButtonElement>('#mute-stream')
  button.setAttribute('aria-pressed', String(silent))
  button.innerHTML = icon(silent ? 'close' : 'audio')
  button.title = silent ? m.app.unmute : m.app.mute
  button.setAttribute('aria-label', button.title)
  if (remember) save()
}
$('#mute-stream').addEventListener('click', () => applySound(muted && volume === 0 ? 1 : volume, !muted, true))
$('#volume').addEventListener('input', () => {
  const next = Number($<HTMLInputElement>('#volume').value) / 100
  applySound(next, next === 0, true)
})
// With no native controls, double-clicking the picture stays the expected gesture for fullscreen.
$('#video-stage').addEventListener('dblclick', () => { if (!audioOnly()) void togglePlayerFullscreen() })

/**
 * The video in its own window, or back in the room. Only the surface changes: the window
 * follows the channel the room is on, stops with it, and comes back playing what it played.
 */
function setDetached(channel: string | null) {
  const previous = detachedChannel
  const wasPlaying = currentPlayerState !== 'stopped'
  detachedChannel = channel ?? ''
  streamDock.classList.toggle('detached', !!detachedChannel)
  $('#detached-panel').hidden = !detachedChannel
  $<HTMLButtonElement>('#detach-stream').disabled = !!detachedChannel
  paintDetachedAnchor()
  if (detachedChannel || !previous) return
  if (closingSession) closingSession = false
  else if (detachedWanted) { detachedWanted = false; $<HTMLInputElement>('#detached-video').checked = false; save() }
  updatePlayer('stopped')
  // Coming back picks the picture up where the window left it, in the room now open.
  if (wasPlaying && currentView === 'room' && !$('#room-body').classList.contains('chat-only')) {
    void player.play(active, $<HTMLSelectElement>('#quality').value, playback().buffer)
  }
}
/** The anchor names the channel playing on the side — which is the room's, the window following it. */
function paintDetachedAnchor() {
  $('#detached-panel-channel').textContent = detachedChannel ? `# ${detachedChannel}` : ''
}
/** Takes the video out of the room, stopping the dock first: `StreamResolver` holds one stream. */
async function detachVideo(play: boolean) {
  if (!active || detachedChannel) return
  const channel = active
  streamPlayer.stop()
  try {
    // Stopping the dock is asynchronous: we wait for it, otherwise it could cut the stream the
    // new window has just asked for — `StreamResolver` holds only one.
    await window.twichat.stopStream()
    await window.twichat.detachPlayer(channel, $<HTMLSelectElement>('#quality').value, play)
  } catch (error) { toast(displayError(error)) }
}
/** Brings what is open in line with what the account chose, wherever the choice was made. */
function applyDetachedChoice(play = currentPlayerState !== 'stopped') {
  if (detachedWanted && !detachedChannel && active && currentView === 'room') void detachVideo(play)
  else if (!detachedWanted && detachedChannel) void window.twichat.attachPlayer().catch(error => toast(displayError(error)))
}
/** The buttons and the settings switch set the same preference; only the way in differs. */
function setDetachedWanted(wanted: boolean) {
  if (detachedWanted === wanted) return
  detachedWanted = wanted
  $<HTMLInputElement>('#detached-video').checked = wanted
  save()
  applyDetachedChoice()
}
$('#detach-stream').addEventListener('click', () => setDetachedWanted(true))
$('#attach-stream').addEventListener('click', () => setDetachedWanted(false))
$('#detached-video').addEventListener('change', () => setDetachedWanted($<HTMLInputElement>('#detached-video').checked))
window.twichat.onPlayerDetached(setDetached)
// The detached window says where its player stands; the dock shows it as if it played at home.
window.twichat.onPlayerState((state, message) => { if (detachedChannel) updatePlayer(state as StreamPlayerState, message || undefined) })
// Quality and volume are set from both sides; the room stays the only one to store them.
window.twichat.onPlayerQuality(next => {
  const dock = $<HTMLSelectElement>('#quality')
  if (dock.value === next) return
  dock.value = next
  $<HTMLSelectElement>('#preferred-quality').value = next
  applyPlayerMode(); save()
})
window.twichat.onPlayerVolume((next, silent) => applySound(next, silent, true))

function openAccount() { accountDialog.showModal(); $('#auth-error').textContent = ''; if (!state.account) $<HTMLButtonElement>('#browser-auth').focus() }
function finishAuthentication(login: string) {
  state.savedAccounts = [login, ...state.savedAccounts.filter(account => account !== login)]
  renderSavedAccounts(); updateAccount(login); accountDialog.close()
  resetFollowed()
  if (!workspaceEntered) enterWorkspace(login)
  else if (currentView === 'discover') void loadDiscovery(true)
  toast(m.app.connectedAsDot(login))
}
function setChatOnly(value: boolean) {
  $('#room-body').classList.toggle('chat-only', value)
  updatePlayerToggleLabel()
  if (value) player.stop()
}

$('#add-room').addEventListener('click', () => addRoom())
$('#connect-session').addEventListener('click', openAccount)
$('#anonymous-session').addEventListener('click', () => void enterAnonymously())
$('#open-discover').addEventListener('click', openDiscover)
$('#refresh-discover').addEventListener('click', () => void loadDiscovery(true))
$('#discover-query').addEventListener('input', () => {
  clearTimeout(discoveryQueryTimer)
  discoveryQueryTimer = window.setTimeout(() => { if (scopeStreams().length || followedOffline.length) renderDiscoveryResults() }, 150)
})
$('#scope-top').addEventListener('click', () => setDiscoveryScope('top'))
$('#scope-followed').addEventListener('click', () => setDiscoveryScope('followed'))
$('#discover-sort').addEventListener('change', renderDiscoveryResults)
/** The content filter follows the account language, which is only resolved after `setLocale`. */
function syncDiscoveryLanguage() {
  discoveryLanguage = locale
  $<HTMLSelectElement>('#discover-language').value = locale
}
$('#discover-language').addEventListener('change', event => {
  discoveryLanguage = (event.target as HTMLSelectElement).value
  selectedCategories.clear(); discoveredStreams = []; discoveryUpdatedAt = 0; updateDiscoveryFreshness()
  void loadDiscovery()
})
$('#discover-login').addEventListener('click', () => { if ($<HTMLButtonElement>('#discover-login').dataset.action === 'retry') void loadDiscovery(true); else openAccount() })
$('#welcome-add').addEventListener('click', () => addRoom())
document.querySelectorAll<HTMLButtonElement>('[data-suggest]').forEach(button => button.addEventListener('click', () => addRoom(button.dataset.suggest)))
$('#join-form').addEventListener('submit', event => { event.preventDefault(); $('#join-error').textContent = ''; void addRoom($<HTMLInputElement>('#channel-input').value) })
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => $<HTMLDialogElement>(`#${button.dataset.close}`).close()))
ownChannelButton.addEventListener('click', () => {
  const login = state.account
  if (!login) return
  if (state.preferences.channels.includes(login)) { activate(login); return }
  void joinChannel(login).catch(error => toast(displayError(error)))
})
$('#idle-toggle').addEventListener('click', () => { idleExpanded = !idleExpanded; renderRooms() })
$('#account-button').addEventListener('click', () => { if ($('#account-menu').hidden) openAccountMenu(); else closeAccountMenu() })
$('#account-menu-connect').addEventListener('click', () => { closeAccountMenu(); openAccount() })
$('#account-menu-settings').addEventListener('click', () => { closeAccountMenu(); openSettings() })
$('#composer-login').addEventListener('click', openAccount)
async function startBrowserAuthentication(mode: 'open' | 'copy') {
  const attempt = ++browserAuthAttempt
  const browserButton = $<HTMLButtonElement>('#browser-auth')
  const copyButton = $<HTMLButtonElement>('#copy-auth-link')
  const error = $('#auth-error')
  error.textContent = ''
  browserButton.disabled = true; copyButton.disabled = true
  browserButton.textContent = mode === 'open' ? m.app.openingBrowser : m.app.waitingForSignIn
  copyButton.textContent = mode === 'copy' ? m.app.linkCopied : m.app.copyLink
  window.setTimeout(() => {
    if (browserAuthAttempt !== attempt) return
    browserButton.disabled = false; copyButton.disabled = false
    browserButton.innerHTML = `${icon('external')} ${m.app.reopenWithTwitch}`
    copyButton.textContent = mode === 'copy' ? m.app.copyLinkAgain : m.app.copyLink
  }, 800)
  try {
    const login = await window.twichat.browserLogin(mode)
    if (browserAuthAttempt === attempt) finishAuthentication(login)
  } catch (failure) {
    if (browserAuthAttempt === attempt) error.textContent = displayError(failure)
  } finally {
    if (browserAuthAttempt === attempt) {
      browserButton.disabled = false; copyButton.disabled = false
      browserButton.innerHTML = `${icon('external')} ${m.ui.authFields.signIn}`
      copyButton.textContent = m.app.copyLink
    }
  }
}
$('#browser-auth').addEventListener('click', () => void startBrowserAuthentication('open'))
$('#copy-auth-link').addEventListener('click', () => void startBrowserAuthentication('copy'))
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $<HTMLButtonElement>('#auth-submit'); const error = $('#auth-error'); error.textContent = ''; button.disabled = true; button.textContent = m.app.connecting
  try {
    const login = await window.twichat.authenticate($<HTMLInputElement>('#token-input').value)
    $<HTMLInputElement>('#token-input').value = ''
    finishAuthentication(login)
  }
  catch (failure) { error.textContent = displayError(failure) }
  finally { button.disabled = false; button.textContent = m.ui.authFields.submitToken }
})
$('#account-menu-logout').addEventListener('click', async () => {
  closeAccountMenu()
  await window.twichat.logout(); joined.clear(); updateAccount(null)
  accountDialog.close(); returnToSessionChoice()
})
$('#account-menu-forget').addEventListener('click', async () => {
  const login = state.account
  if (!login) return
  if (forgetArmed !== login) {
    forgetArmed = login
    $('#account-menu-forget-label').textContent = m.ui.accountMenu.forgetConfirm
    return
  }
  disarmForget(); closeAccountMenu()
  try {
    state.savedAccounts = await window.twichat.forgetAccount(login)
    delete state.savedAvatars[login]
  } catch (error) { toast(displayError(error)) }
  joined.clear(); updateAccount(null)
  accountDialog.close(); returnToSessionChoice()
})
// Following stays a gesture on twitch.tv: Twitch closed the endpoint that would have done it from here.
$('#composer-gate-follow').addEventListener('click', () => {
  window.twichat.external('twitch', active).catch(error => toast(displayError(error)))
})
$('#composer-gate-recheck').addEventListener('click', () => { void refreshFollowStatus(active, true) })
$('#auth-help').addEventListener('click', () => window.twichat.external('auth-docs'))
$('#resume').addEventListener('click', () => virtualLog.bottom())
function openSettings() {
  if (!workspaceEntered) return
  closeFloatingLayers(); player.stop(); virtualLog.setVisible(false); showView('settings'); renderRooms()
}
$('#open-settings').addEventListener('click', openSettings)
// A release the user may want: the notice stays until it is acted on, and says what a click does.
window.twichat.onUpdate(notice => { updateNotice = notice; renderUpdateNotice() })
$('#update-notice').addEventListener('click', () => void window.twichat.applyUpdate())
window.twichat.onSettings(openSettings)
// The main process loaded another account's preferences: nothing of the previous one remains.
window.twichat.onPreferences(adoptScope)
// A click on a mention notification: the main process already brought the window back; what is left is the room.
window.twichat.onMentionOpen(channel => { if (state?.preferences.channels.includes(channel)) activate(channel) })
$('#reconnect').addEventListener('click', () => window.twichat.reconnect().catch(error => toast(displayError(error))))
$('#open-twitch').addEventListener('click', () => window.twichat.external('twitch', active))
$('#leave-room').addEventListener('click', () => void leaveRoom(active))
$('#room-context-leave').addEventListener('click', () => { if (contextRoom) void leaveRoom(contextRoom) })

// Every row is recycled by the virtual log, so the chat listens once, at the viewport.
chatLog.addEventListener('contextmenu', event => {
  const id = (event.target as Element).closest<HTMLElement>('.message')?.dataset.id
  const message = id ? store.get(active).find(item => item.id === id) : undefined
  if (!message) return
  event.preventDefault()
  openMessageContextMenu(message, event.clientX, event.clientY)
})
chatLog.addEventListener('click', event => {
  const quote = (event.target as Element).closest<HTMLElement>('[data-reply]')
  if (quote?.dataset.reply) { revealMessage(quote.dataset.reply); return }
  const trigger = (event.target as Element).closest<HTMLElement>('[data-card]')
  if (!trigger?.dataset.card) return
  openUserCard(trigger.dataset.card, ...cardAnchorPoint(trigger), true)
})
chatLog.addEventListener('pointerover', event => {
  if (event.pointerType !== 'mouse') return
  const trigger = (event.target as Element).closest<HTMLElement>('[data-card]')
  const login = trigger?.dataset.card
  if (!login) return
  if (cardPinned) return
  clearTimeout(cardCloseTimer); cardCloseTimer = 0
  if (cardLogin === login) return
  const point = cardAnchorPoint(trigger!)
  clearTimeout(cardOpenTimer)
  cardOpenTimer = window.setTimeout(() => openUserCard(login, ...point, false), CARD_OPEN_DELAY)
})
chatLog.addEventListener('pointerout', event => {
  if (!(event.target as Element).closest('[data-card]')) return
  clearTimeout(cardOpenTimer); cardOpenTimer = 0
  scheduleCardClose()
})
// The pointer needs a moment to travel from the nickname down into the card it opened.
$('#user-card').addEventListener('pointerenter', () => { clearTimeout(cardCloseTimer); cardCloseTimer = 0 })
$('#user-card').addEventListener('pointerleave', scheduleCardClose)

$('#message-context-profile').addEventListener('click', () => {
  const message = contextMessage
  const bounds = $('#message-context-menu').getBoundingClientRect()
  closeMessageContextMenu()
  if (message) openUserCard(message.login.toLowerCase(), bounds.left, bounds.top, true)
})
$('#message-context-reply').addEventListener('click', () => { const message = contextMessage; closeMessageContextMenu(); if (message) replyToMessage(message) })
$('#message-context-mention').addEventListener('click', () => { const message = contextMessage; closeMessageContextMenu(); if (message) mentionUser(message.user) })
$('#message-context-copy').addEventListener('click', () => { const message = contextMessage; closeMessageContextMenu(); if (message) void copyText(message.text, m.app.messageCopied) })
$('#message-context-copy-name').addEventListener('click', () => { const message = contextMessage; closeMessageContextMenu(); if (message) void copyText(message.user, m.app.nicknameCopied) })
$('#message-context-join').addEventListener('click', () => { const message = contextMessage; closeMessageContextMenu(); if (message) void openChannelOf(message.login.toLowerCase()) })
$('#message-context-twitch').addEventListener('click', () => {
  const message = contextMessage
  closeMessageContextMenu()
  if (message) window.twichat.external('twitch', message.login.toLowerCase()).catch(error => toast(displayError(error)))
})

document.addEventListener('pointerdown', event => {
  const target = event.target as Element
  if (!target.closest('#account-menu') && !target.closest('#account-button')) closeAccountMenu()
  if (!target.closest('#room-context-menu')) closeRoomContextMenu()
  if (!target.closest('#message-context-menu')) closeMessageContextMenu()
  if (!target.closest('#user-card') && !target.closest('[data-card]')) closeUserCard()
}, true)
document.addEventListener('visibilitychange', () => {
  // A window put away is a window one may not come back to: the dates gathered leave now.
  if (document.hidden) { flushActivity(); return }
  if (workspaceEntered) void refreshProfiles(state.preferences.channels)
})
window.addEventListener('pagehide', () => { flushActivity(); flushPreferences() })
$('#toggle-sidebar').addEventListener('click', () => setSidebarCollapsed(!appRoot.classList.contains('sidebar-collapsed')))
$('#toggle-player').addEventListener('click', () => setChatOnly(!$('#room-body').classList.contains('chat-only')))
$('#play-stream').addEventListener('click', () => player.play(active, $<HTMLSelectElement>('#quality').value, playback().buffer))
fullscreenButton.addEventListener('click', () => void togglePlayerFullscreen())
$('#stop-stream').addEventListener('click', () => player.stop())
$('#quality').addEventListener('change', () => {
  $<HTMLSelectElement>('#preferred-quality').value = $<HTMLSelectElement>('#quality').value
  applyPlayerMode(); save()
  if (currentView === 'room' && !$('#room-body').classList.contains('chat-only') && currentPlayerState !== 'stopped') void player.play(active, $<HTMLSelectElement>('#quality').value, playback().buffer)
})
// The same setting is made from both places: the player's picker stays the source, and the one in
// Settings hands over to it rather than duplicating the store and the restart.
$('#preferred-quality').addEventListener('change', () => {
  const dock = $<HTMLSelectElement>('#quality')
  dock.value = $<HTMLSelectElement>('#preferred-quality').value
  dock.dispatchEvent(new Event('change'))
})
// The Settings page is only reachable with the player stopped: buffering therefore applies as soon
// as a room is opened again, with no running stream to restart.
/**
 * Repaints everything the script draws itself: hydration only touches the shipped HTML, not the
 * rooms, the player, the explorer or the messages already rendered.
 */
function repaintDynamic() {
  // The forget button's label is written from code — it swaps to a confirmation — so a language
  // change has to put it back itself.
  disarmForget()
  renderSavedAccounts(); renderRooms(); updateAccount(state.account)
  // The collapsed rail tooltips are set when the sidebar is toggled: we replay it for them.
  setSidebarCollapsed(appRoot.classList.contains('sidebar-collapsed'), false)
  updateConnection(state.status, active ? m.app.twitchChannel : m.app.connectingToTwitchChat)
  // `hydrate` has just put the shipped sentence back into the title bar note: it is rewritten here.
  updateTitlebarNote()
  renderUpdateNotice()
  applyPlayerMode(); applySound(volume, muted); updatePlayer(currentPlayerState); updateCount(); updateModes(); updateRoomLive()
  virtualLog.refresh()
  if (currentView === 'discover') { renderDiscoveryCategories(); renderDiscoveryResults() }
}

/** The language choice applies without a reload: catalog, HTML, then everything else. */
function applyLanguageChoice() {
  setLocale(resolveLocale($<HTMLSelectElement>('#language').value, [...navigator.languages]))
  hydrate()
  repaintDynamic()
}

for (const selector of ['#buffer', '#autoplay', '#notify-mentions', '#language', '#hide-idle', '#idle-delay']) $(selector).addEventListener('change', () => {
  save()
  // The dormancy setting is read at each paint: the list follows the choice without waiting for the save.
  if (selector === '#hide-idle' || selector === '#idle-delay') renderRooms()
  if (selector === '#language') applyLanguageChoice()
  // The player is stopped while the Settings page is open: its text must follow the choice made here.
  if (currentPlayerState === 'stopped') $('#video-description').innerHTML = idlePlayerDescription()
})
// A file dropped on an application window is inert; it must never navigate the renderer away from the app.
window.addEventListener('dragover', event => event.preventDefault())
window.addEventListener('drop', event => event.preventDefault())
window.addEventListener('keydown', event => {
  const command = commandKey()
  if (matches(event, SHORTCUTS.join, command)) { event.preventDefault(); void addRoom() }
  if (matches(event, SHORTCUTS.sidebar, command)) { event.preventDefault(); setSidebarCollapsed(!appRoot.classList.contains('sidebar-collapsed')) }
  if (matches(event, SHORTCUTS.chatOnly, command) && active) { event.preventDefault(); setChatOnly(!$('#room-body').classList.contains('chat-only')) }
  if (event.key === 'Escape' && !composing(event)) {
    // Escape does not leave fullscreen on its own in this window: the key does reach the document,
    // but Chromium does not act on it. We hand control back ourselves.
    if (document.fullscreenElement) void document.exitFullscreen()
    closeFloatingLayers(); if (joinDialog.open) joinDialog.close(); if (accountDialog.open) accountDialog.close()
  }
})

function applyLayout(layout: LayoutPreferences) {
  playerWidth = layout.playerWidth
  setSidebarCollapsed(layout.sidebarCollapsed, false)
}
/**
 * The sizes used to live in the renderer's local storage, lost on every reinstall. The first
 * launch takes them over, then the account preferences carry them alone.
 */
function adoptLocalLayout(layout: LayoutPreferences): LayoutPreferences {
  try {
    const width = Number(localStorage.getItem('twichat.playerWidth'))
    const sidebar = localStorage.getItem('twichat.sidebar')
    if (width === 0 && sidebar === null) return layout
    localStorage.removeItem('twichat.playerWidth'); localStorage.removeItem('twichat.sidebar')
    return {
      ...layout,
      playerWidth: layout.playerWidth || (Number.isFinite(width) && width > 0 ? Math.round(width) : 0),
      sidebarCollapsed: layout.sidebarCollapsed || sidebar === 'collapsed'
    }
  } catch { return layout }
}

setSidebarCollapsed(false, false)
window.twichat.onEvents(handleEvents)
window.twichat.init().then(snapshot => {
  state = snapshot; active = snapshot.preferences.active
  // The language arrives resolved from the main process: the HTML is translated before being shown.
  setLocale(snapshot.locale)
  // Before the first translation: every label the catalogs write with `⌘` is stamped for this
  // platform on its way into the document.
  setCommandKey(snapshot.commandKey)
  hydrate()
  syncDiscoveryLanguage()
  // A renderer reload keeps the IRC session alive, so the retained ROOMSTATE replaces the missing events.
  joined = new Set(Object.keys(snapshot.roomStates))
  for (const [room, tags] of Object.entries(snapshot.roomStates)) {
    roomModes.set(room, tags)
    const roomId = tags['room-id']
    if (roomId) { roomIds.set(room, roomId); void loadThirdPartyEmotes(room, roomId); void loadTwitchEmotes(room, roomId) }
  }
  // Same for USERSTATE: without those badges, a moderator would see the "follow this channel" banner.
  for (const [room, badges] of Object.entries(snapshot.userBadges)) roomBadges.set(room, badges)
  paintPreferenceControls(snapshot.preferences)
  const layout = adoptLocalLayout(snapshot.preferences.layout)
  applyLayout(layout)
  if (layout !== snapshot.preferences.layout) save()
  applyPlayerMode()
  updateConnection(snapshot.status, snapshot.status === 'connected' ? m.app.twitchChannel : m.app.connectingToTwitchChat)
  setupTheme(snapshot.preferences.theme, () => save())
  updateAccount(snapshot.account); renderSavedAccounts(); renderRooms(); void loadChannelActivity(); void refreshProfiles(snapshot.preferences.channels); updatePlayer('stopped')
  if (snapshot.account) enterWorkspace(snapshot.account)
  else { sessionGate.classList.add('ready'); sessionGate.setAttribute('aria-busy', 'false'); $<HTMLButtonElement>('#connect-session').focus() }
  document.body.dataset.ready = 'true'
}).catch(error => { document.body.dataset.ready = 'error'; toast(displayError(error)) })
