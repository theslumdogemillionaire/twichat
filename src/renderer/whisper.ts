import '@fontsource-variable/atkinson-hyperlegible-next'
import './style.css'
import type { ChatPreferences, ThirdPartyEmote, TwitchEmote, Whisper } from '../shared/types'
import { hydrateIcons } from './icons'
import { hydrate } from './hydrate'
import { createEmotePicker } from './emote-picker'
import { replaceRange } from './composer-text'
import { paintMessageBody } from './message-body'
import { applyTheme } from './theme'
import { adoptChatFont, applyChatFont } from './chat-font'
import { errorText } from '../shared/errors'
import { clock, locale, m, setLocale } from '../shared/i18n'

declare global { interface Window { twichat: import('../shared/types').TwichatAPI } }

/**
 * One conversation, one window. Twitch delivers a whisper once, to whoever is connected at that
 * second, and gives no way to read back the ones it kept: what this window shows is what passed
 * through Twichat, and the footer says where the rest is rather than letting an empty thread pass
 * for an empty correspondence.
 *
 * The bodies go through `paintMessageBody`, the very function the room uses, so the reading rules
 * cannot drift apart. What differs is what Twitch sent: a whisper carries neither the `emotes`
 * tag nor the `gifs` one, so emotes are matched by name against the sets that belong to no
 * channel, and a GIF stays the title Twitch wrote into the body itself.
 */
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const api = window.twichat
const log = $('#whisper-log')
const empty = $('#whisper-empty')
const linkDialog = $<HTMLDialogElement>('#link-dialog')
const form = $<HTMLFormElement>('#whisper-form')
const input = $<HTMLTextAreaElement>('#whisper-input')
const sendButton = $<HTMLButtonElement>('#whisper-send')
const error = $('#whisper-error')

const seen = new Set<string>()
const lines: Whisper[] = []
/** Whispers that landed while the thread was still being read: held, then played in order. */
const pending: Whisper[] = []
let ready = false
let chat: ChatPreferences = { links: true, confirm: true, gifs: true, font: 'default' }
let thirdParty: ReadonlyMap<string, ThirdPartyEmote> | undefined
let twitchEmotes: readonly TwitchEmote[] | undefined
let twitchNames: ReadonlyMap<string, string> | undefined
let pendingLink = ''

/** Pinned to the bottom unless the reader has scrolled up to look at something. */
const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40
let pinned = true
log.addEventListener('scroll', () => { pinned = atBottom() })
const pinToBottom = () => { log.scrollTop = log.scrollHeight }

/** Two whispers of the same day, by the clock of whoever is reading. */
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()
/** Past this, two messages from the same person stop reading as one breath. */
const GROUPING = 5 * 60_000

function dayLabel(at: number) {
  const day = new Date(at)
  const today = new Date()
  if (sameDay(at, today.getTime())) return m.whisperWindow.today
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay(at, yesterday.getTime())) return m.whisperWindow.yesterday
  const format = new Intl.DateTimeFormat(locale, day.getFullYear() === today.getFullYear()
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' })
  return format.format(day)
}

/**
 * One whisper. `previous` is what it follows, and it decides two things a conversation needs to
 * read as one: a rule when the day turns — a thread here spans sessions, so a bare clock would
 * lie — and the name dropped when the same person carries on within a few minutes.
 */
function paint(line: Whisper, previous?: Whisper) {
  if (!previous || !sameDay(previous.at, line.at)) {
    const day = document.createElement('div')
    day.className = 'whisper-day'
    const label = document.createElement('span')
    label.textContent = dayLabel(line.at)
    day.append(label)
    log.append(day)
  }
  const continued = !!previous && previous.outgoing === line.outgoing
    && sameDay(previous.at, line.at) && line.at - previous.at < GROUPING
  const item = document.createElement('article')
  item.className = `whisper-line${line.outgoing ? ' own' : ''}${continued ? ' continued' : ''}`
  const at = document.createElement('time')
  at.className = 'whisper-time'
  const date = new Date(line.at)
  at.dateTime = date.toISOString()
  at.textContent = clock.format(date)
  if (continued) {
    // Nothing above it to hang a clock on: the hour waits in the margin until the pointer asks.
    item.append(at)
  } else {
    const meta = document.createElement('div')
    meta.className = 'whisper-meta'
    const who = document.createElement('span')
    who.className = 'whisper-who'
    who.textContent = line.outgoing ? m.whisperWindow.you : line.peerName || line.peer
    meta.append(who, at)
    item.append(meta)
  }
  const body = document.createElement('p')
  body.className = 'whisper-text'
  // No mention to underline: a whisper is already addressed to you, and the whole of it would
  // light up on your own name.
  paintMessageBody(body, line.text, { thirdParty, twitchNames, links: chat.links, channels: true, focusableLinks: true })
  item.append(body)
  log.append(item)
  // An emote lands after the line is measured and makes it taller: without this, a message that
  // carries one leaves the reader a few pixels short of the bottom they were pinned to.
  for (const image of item.querySelectorAll('img')) {
    image.addEventListener('load', () => { if (pinned) pinToBottom() }, { once: true })
  }
}

function append(line: Whisper, keepPlace = false) {
  // The same whisper twice — a frame repeated across a reconnect, or one already in the thread
  // the window opened with — is one line.
  if (seen.has(line.id)) return
  seen.add(line.id)
  const follow = keepPlace || atBottom()
  const previous = lines[lines.length - 1]
  lines.push(line)
  empty.hidden = true
  paint(line, previous)
  if (follow) { pinned = true; pinToBottom() }
}

/** The emote sets landing after the thread was drawn: the same lines, read again. */
function repaint() {
  const follow = atBottom()
  // The day rules go too: grouping is decided in sequence, so the thread is drawn again whole.
  for (const item of [...log.querySelectorAll('.whisper-line, .whisper-day')]) item.remove()
  lines.forEach((line, index) => paint(line, lines[index - 1]))
  if (follow) { pinned = true; pinToBottom() }
}

function openLink(href: string) {
  if (!chat.confirm) { void api.openLink(href).catch(() => {}); return }
  let url: URL
  // Already checked when the link was painted; a second reading costs nothing and names the host.
  try { url = new URL(href) } catch { return }
  pendingLink = href
  $('#link-scheme').textContent = `${url.protocol}//`
  $('#link-host').textContent = url.host
  $('#link-rest').textContent = `${url.pathname}${url.search}${url.hash}`
  linkDialog.showModal()
  // The safe answer is the one the Enter key reaches.
  $<HTMLButtonElement>('#link-cancel').focus()
}

log.addEventListener('click', event => {
  // The window never navigates: the address goes to the system browser, checked once more there.
  const link = (event.target as Element).closest<HTMLAnchorElement>('a.message-link')
  if (link) { event.preventDefault(); openLink(link.href); return }
  const room = (event.target as Element).closest<HTMLElement>('[data-channel]')
  if (room?.dataset.channel) void api.openChannel(room.dataset.channel).catch(() => {})
})
// The cross in the corner carries no id of its own, only the dialog it closes.
for (const button of document.querySelectorAll<HTMLElement>('[data-close="link-dialog"]')) {
  button.addEventListener('click', () => { pendingLink = ''; linkDialog.close() })
}
$('#link-open').addEventListener('click', () => {
  const href = pendingLink
  pendingLink = ''
  linkDialog.close()
  if (href) void api.openLink(href).catch(() => {})
})

let sending = false
function refreshComposer() {
  sendButton.disabled = sending || !input.value.trim()
}

/**
 * The room's own panel, in this window. A conversation is said nowhere, so what it offers is the
 * sets that belong to no channel — the same panel, on a narrower shelf.
 */
const picker = createEmotePicker({
  host: form, trigger: $<HTMLButtonElement>('#emote-button'), scope: 'global',
  insert: value => {
    const start = input.selectionStart ?? input.value.length
    const next = replaceRange(input.value, start, input.selectionEnd ?? start, value)
    input.value = next.text
    input.focus()
    input.setSelectionRange(next.caret, next.caret)
    refreshComposer(); autosize()
  },
  blocked: () => sending,
  refocus: () => input.focus(),
  emotes: () => thirdParty,
  twitch: () => twitchEmotes,
  reload: loadEmotes
})
input.addEventListener('input', () => { refreshComposer(); autosize() })
// A whisper is one line as far as Twitch is concerned: Enter sends it rather than breaking it.
input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  form.requestSubmit()
})
function autosize() {
  input.style.height = 'auto'
  // The same ceiling as the room's composer, and the one its own `max-height` sets.
  input.style.height = `${Math.min(104, input.scrollHeight)}px`
}
form.addEventListener('submit', async event => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || sending) return
  sending = true
  refreshComposer()
  error.textContent = ''
  try {
    // Twitch answers a send with nothing at all: the line comes back from the main process,
    // already written down, and it is the only trace this message will ever have.
    append(await api.sendWhisper(text))
    input.value = ''
    autosize()
  } catch (failure) {
    // The message stays in the box: a refusal must not cost what was typed.
    error.textContent = errorText(failure)
  } finally {
    sending = false
    refreshComposer()
    input.focus()
  }
})

/**
 * The peer's picture, once the conversation is on screen. Asked for apart from the context so a
 * Helix call is never what a thread waits on; the initial holds the place until it lands, and
 * keeps it if it never does.
 */
async function loadProfile() {
  try {
    const profile = await api.whisperProfile()
    if (profile.displayName) {
      $('#whisper-name').textContent = profile.displayName
      document.title = m.whisperWindow.title(profile.displayName)
    }
    if (!profile.avatarUrl) return
    const avatar = $('#whisper-avatar')
    const image = document.createElement('img')
    image.src = profile.avatarUrl; image.alt = ''; image.width = 34; image.height = 34
    // The initial is already there, underneath: a picture that fails simply uncovers it.
    image.addEventListener('error', () => image.remove(), { once: true })
    avatar.append(image)
  } catch { /* An avatar is not worth a line of error in a conversation. */ }
}

async function loadEmotes() {
  try {
    const sets = await api.globalEmotes()
    thirdParty = new Map(sets.thirdParty.map(item => [item.code, item]))
    twitchEmotes = sets.twitch
    twitchNames = new Map(sets.twitch.map(emote => [emote.name, emote.id]))
    picker.refresh()
    if (lines.length) repaint()
  } catch { /* A conversation reads without its emotes; it does not read without its words. */ }
}

async function start() {
  let context: Awaited<ReturnType<typeof api.whisperContext>>
  try { context = await api.whisperContext() }
  catch { return }
  setLocale(context.locale)
  applyTheme(context.theme)
  hydrate()
  hydrateIcons()
  chat = context.chat
  applyChatFont(chat.font)
  const name = context.peerName || context.peer
  $('#whisper-name').textContent = name
  $('#whisper-login').textContent = `@${context.peer}`
  $('#whisper-avatar').textContent = name.slice(0, 1).toLocaleUpperCase(locale)
  document.title = m.whisperWindow.title(name)
  const twitch = $<HTMLButtonElement>('#whisper-twitch')
  twitch.title = m.whisperWindow.openOnTwitch(context.peer)
  twitch.addEventListener('click', () => { void api.external('twitch', context.peer).catch(() => {}) })
  for (const line of context.thread) append(line, true)
  refreshComposer()
  ready = true
  for (const line of pending.splice(0)) append(line)
  empty.hidden = lines.length > 0
  void loadEmotes()
  void loadProfile()
}

// Registered before the context is asked for: a whisper landing during that round trip is held
// rather than lost, and lands after the thread it belongs to rather than above it.
api.onWhisper(line => { if (ready) append(line); else pending.push(line) })
// The typeface is the one thing the settings change under an open window: the rest of what the
// context carries was read once, and a window opened after the change reads the new value anyway.
api.onChatFont(font => { chat = { ...chat, font: adoptChatFont(font) } })
void start()
