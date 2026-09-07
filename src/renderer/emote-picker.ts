import type { ThirdPartyEmote, TwitchEmote } from '../shared/types'
import { EMOJIS, EMOJI_GROUPS, searchEmojis, type Emoji } from './emoji'
import { twitchEmoteUrl } from './emotes'
import { rankByTerm } from './composer-text'
import { composing } from './keys'
import { icon } from './icons'
import { m } from '../shared/i18n'

export interface PickerEntry {
  kind: 'emote' | 'emoji'
  value: string
  label: string
  url?: string
  source: string
}

const RECENT_KEY = 'twichat.recent-emotes'
const RECENT_LIMIT = 30
const SOURCE_LABELS: Record<string, string> = { '7tv': '7TV', bttv: 'BetterTTV', ffz: 'FrankerFaceZ', twitch: 'Twitch' }
const EMOJI_BY_CHAR = new Map(EMOJIS.map(emoji => [emoji.char, emoji]))

/* ----- the entries, built from the sets alone: the suggestions read them too ----- */

function twitchLabel(emote: TwitchEmote): string {
  if (emote.type === 'subscriptions') return m.composer.twitchSubscribers
  if (emote.type === 'follower') return m.composer.twitchFollowers
  if (emote.type === 'bitstier') return m.composer.twitchBits
  return 'Twitch'
}
export function twitchEntries(twitch: readonly TwitchEmote[] | undefined, scope: TwitchEmote['scope']): PickerEntry[] {
  const entries: PickerEntry[] = []
  for (const emote of twitch ?? []) {
    if (emote.scope !== scope) continue
    const url = twitchEmoteUrl(emote.id)
    if (url) entries.push({ kind: 'emote', value: emote.name, label: emote.name, url, source: twitchLabel(emote) })
  }
  return entries
}
export function thirdPartyEntries(emotes: ReadonlyMap<string, ThirdPartyEmote> | undefined): PickerEntry[] {
  return [...(emotes?.values() ?? [])].map(emote => ({
    kind: 'emote' as const, value: emote.code, label: emote.code, url: emote.url, source: SOURCE_LABELS[emote.source] ?? emote.source
  }))
}
/** Everything that can be written as an emote right here, whatever it came from. */
export function everyEmote(emotes: ReadonlyMap<string, ThirdPartyEmote> | undefined, twitch: readonly TwitchEmote[] | undefined): PickerEntry[] {
  return [...twitchEntries(twitch, 'channel'), ...thirdPartyEntries(emotes), ...twitchEntries(twitch, 'global')]
}
const emojiEntry = (emoji: Emoji): PickerEntry => ({ kind: 'emoji', value: emoji.char, label: `:${emoji.name}:`, source: emoji.group })

export interface EmotePickerParts {
  /** Where the panel is appended. It positions itself against this, so it must be positioned. */
  host: HTMLElement
  /** The button that opens it, and carries `aria-expanded` for it. */
  trigger: HTMLButtonElement
  /** Where a chosen emote lands. */
  insert(value: string): void
  /** True where nothing may be written right now: the panel then refuses to open. */
  blocked(): boolean
  /** Where the focus goes when the panel closes on a deliberate gesture. */
  refocus(): void
  emotes(): ReadonlyMap<string, ThirdPartyEmote> | undefined
  twitch(): readonly TwitchEmote[] | undefined
  /** Asked to fetch the sets again, from the empty state's own button. */
  reload(): Promise<void>
  /**
   * Whose emotes these are. A room has a channel's own; a conversation is said nowhere, so it
   * offers the sets that belong to no channel. Only the wording changes — the panel is the same.
   */
  scope: 'channel' | 'global'
}

/**
 * The emote and emoji panel, markup included. It is built here rather than written twice in
 * HTML: the room and the conversation windows show the same thing, and a panel that exists in
 * one file cannot drift from a panel that exists in another.
 */
export function createEmotePicker(parts: EmotePickerParts) {
  const panel = document.createElement('div')
  panel.id = 'emote-picker'
  panel.className = 'emote-picker'
  panel.role = 'dialog'
  panel.hidden = true
  panel.innerHTML = `<div class="picker-head"><span class="picker-search">${icon('search')}<input id="emote-search" type="text" autocomplete="off" spellcheck="false" maxlength="32"></span><button id="emote-close" class="picker-close" type="button">${icon('close')}</button></div><div id="picker-tabs" class="picker-tabs" role="tablist"></div><div id="emote-results" class="picker-results" role="listbox"></div><div class="picker-foot"><span id="emote-preview"></span></div>`
  parts.host.append(panel)

  const search = panel.querySelector<HTMLInputElement>('#emote-search')!
  const tabs = panel.querySelector<HTMLElement>('#picker-tabs')!
  const results = panel.querySelector<HTMLElement>('#emote-results')!
  const preview = panel.querySelector<HTMLElement>('#emote-preview')!
  const closeButton = panel.querySelector<HTMLButtonElement>('#emote-close')!

  let recents: string[] = readRecents()
  let tab = 'channel'

  /** The wording, applied on every opening rather than once: the language can change under it. */
  function translate() {
    panel.setAttribute('aria-label', m.ui.messageForm.label.emotes)
    search.placeholder = m.ui.emotePicker.placeholder.search
    closeButton.setAttribute('aria-label', m.ui.emotePicker.label.close)
    tabs.setAttribute('aria-label', m.ui.emotePicker.label.categories)
    results.setAttribute('aria-label', m.ui.emotePicker.label.grid)
    parts.trigger.setAttribute('aria-label', m.ui.messageForm.label.emotes)
  }
  const tabLabel = (id: string) => id === 'recent' ? m.composer.recent
    : id === 'channel' ? (parts.scope === 'channel' ? m.composer.channel : m.composer.emotes)
      : id === 'twitch' ? 'Twitch' : (m.emoji.groups as Record<string, string>)[id] ?? id

  function readRecents(): string[] {
    try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT) }
    catch { return [] }
  }
  function rememberRecent(entry: PickerEntry) {
    const key = `${entry.kind}:${entry.value}`
    recents = [key, ...recents.filter(item => item !== key)].slice(0, RECENT_LIMIT)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)) } catch { /* private mode keeps the session-only list */ }
  }

  const known = () => everyEmote(parts.emotes(), parts.twitch())

  function recentEntries(): PickerEntry[] {
    const emotes = parts.emotes()
    const all = known()
    const entries: PickerEntry[] = []
    for (const key of recents) {
      const separator = key.indexOf(':')
      const kind = key.slice(0, separator)
      const value = key.slice(separator + 1)
      if (kind === 'emoji') {
        const emoji = EMOJI_BY_CHAR.get(value)
        entries.push(emoji ? emojiEntry(emoji) : { kind: 'emoji', value, label: value, source: m.composer.emoji })
        continue
      }
      const emote = emotes?.get(value)
      if (emote) { entries.push({ kind: 'emote', value, label: value, url: emote.url, source: SOURCE_LABELS[emote.source] ?? emote.source }); continue }
      const fromTwitch = all.find(entry => entry.value === value)
      if (fromTwitch) entries.push(fromTwitch)
    }
    return entries
  }

  function renderTabs() {
    tabs.replaceChildren()
    for (const name of ['recent', 'channel', 'twitch', ...EMOJI_GROUPS]) {
      if (name === 'recent' && !recents.length) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'picker-tab'
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(name === tab))
      button.textContent = tabLabel(name)
      button.addEventListener('click', () => { tab = name; search.value = ''; renderTabs(); render() })
      tabs.append(button)
    }
  }

  function section(title: string, entries: PickerEntry[]) {
    const heading = document.createElement('span')
    heading.className = 'picker-group'
    heading.textContent = title
    const grid = document.createElement('div')
    grid.className = 'picker-grid'
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'picker-item'
      button.tabIndex = -1
      button.title = entry.label
      button.setAttribute('role', 'option')
      button.setAttribute('aria-label', entry.label)
      if (entry.url) {
        const image = document.createElement('img')
        image.src = entry.url; image.alt = entry.label; image.loading = 'lazy'; image.decoding = 'async'
        // A broken CDN image would leave an unlabelled 38px cell: the code takes its place.
        image.addEventListener('error', () => { image.remove(); button.classList.add('picker-item-text'); button.textContent = entry.label }, { once: true })
        button.append(image)
      } else button.textContent = entry.value
      button.addEventListener('mouseenter', () => showPreview(entry))
      button.addEventListener('focus', () => showPreview(entry))
      button.addEventListener('click', () => {
        rememberRecent(entry)
        parts.insert(entry.value)
        renderTabs()
      })
      grid.append(button)
    }
    results.append(heading, grid)
  }

  function showPreview(entry: PickerEntry) {
    preview.replaceChildren()
    if (entry.url) {
      const image = document.createElement('img')
      image.src = entry.url; image.alt = ''
      preview.append(image)
    } else preview.append(document.createTextNode(`${entry.value} `))
    const name = document.createElement('b')
    name.textContent = entry.label
    preview.append(name, document.createTextNode(` · ${entry.source}`))
  }

  function emptyState(message: string) {
    const empty = document.createElement('p')
    empty.className = 'picker-empty'
    empty.textContent = message
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'picker-retry'
    retry.textContent = m.app.retry
    retry.addEventListener('click', () => { void parts.reload().then(() => render()) })
    results.append(empty, retry)
  }

  function render() {
    results.replaceChildren()
    preview.textContent = m.ui.emotePicker.hint
    const term = search.value.trim()
    if (term) {
      const emotes = rankByTerm(known(), term, entry => [entry.label], 120)
      const emojis = searchEmojis(term, 80).map(emojiEntry)
      if (emotes.length) section(m.composer.emotes, emotes)
      if (emojis.length) section(m.composer.emojis, emojis)
      if (!emotes.length && !emojis.length) emptyState(m.composer.noResult)
      return
    }
    if (tab === 'recent') { section(m.composer.recentlyUsed, recentEntries()); return }
    if (tab === 'channel') {
      const fromChannel = twitchEntries(parts.twitch(), 'channel')
      const entries = thirdPartyEntries(parts.emotes())
      if (fromChannel.length) section(m.composer.channelEmotes(fromChannel.length), fromChannel)
      const grouped = new Map<string, PickerEntry[]>()
      for (const entry of entries) grouped.set(entry.source, [...(grouped.get(entry.source) ?? []), entry])
      for (const [source, list] of grouped) section(`${source} · ${list.length}`, list.slice(0, 300))
      if (!fromChannel.length && !entries.length) emptyState(parts.scope === 'channel' ? m.composer.noChannelEmotes : m.composer.noEmotes)
      return
    }
    if (tab === 'twitch') {
      const entries = twitchEntries(parts.twitch(), 'global')
      if (entries.length) section(m.composer.twitchEmotes(entries.length), entries)
      else emptyState(m.composer.twitchEmotesUnavailable)
      return
    }
    section(tabLabel(tab), EMOJIS.filter(emoji => emoji.group === tab).map(emojiEntry))
  }

  function open() {
    if (parts.blocked()) return
    if (tab === 'recent' && !recents.length) tab = 'channel'
    translate()
    panel.hidden = false
    parts.trigger.setAttribute('aria-expanded', 'true')
    search.value = ''
    renderTabs(); render()
    search.focus()
  }
  function close(refocus = false) {
    if (panel.hidden) return
    panel.hidden = true
    parts.trigger.setAttribute('aria-expanded', 'false')
    if (refocus) parts.refocus()
  }

  // A click inside the panel must not take the focus off what is being written: only the search
  // field of the panel itself may hold it.
  panel.addEventListener('mousedown', event => { if (event.target !== search) event.preventDefault() })
  parts.trigger.addEventListener('click', () => { if (panel.hidden) open(); else close(true) })
  closeButton.addEventListener('click', () => close(true))
  search.addEventListener('input', render)
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !composing(event)) { event.preventDefault(); close(true) }
  })
  document.addEventListener('pointerdown', event => {
    const target = event.target as Element | null
    if (!target?.closest('#emote-picker') && target !== parts.trigger && !target?.closest('#emote-button')) close()
  })
  translate()

  return {
    open,
    close,
    isOpen: () => !panel.hidden,
    /** The sets changed under it: the tabs and, if it is open, what they show. */
    refresh() { renderTabs(); if (!panel.hidden) render() }
  }
}
