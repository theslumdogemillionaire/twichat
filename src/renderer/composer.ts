import { ComposerMemory } from './composer-memory'
import { composing, sends } from './keys'
import type { ChatMessage, ReplyReference, ThirdPartyEmote, TwitchEmote } from '../shared/types'
import { twitchEmoteUrl } from './emotes'
import { EMOJIS, EMOJI_GROUPS, searchEmojis, type Emoji } from './emoji'
import { m } from '../shared/i18n'
import { AppError } from '../shared/errors'

/** The label of a picker tab: its identifier does not change language, its name does. */
const tabLabel = (id: string) => id === 'recent' ? m.composer.recent : id === 'channel' ? m.composer.channel : id === 'twitch' ? 'Twitch' : (m.emoji.groups as Record<string, string>)[id] ?? id
import {
  MESSAGE_BYTE_LIMIT, applyCompletion, byteLength, completionQuery, rankByTerm,
  replaceRange, sanitizeOutgoing, tokenizeMessage, type CompletionQuery
} from './composer-text'

export interface ComposerHooks {
  send(text: string, reply?: ReplyReference): Promise<void>
  emotes(): ReadonlyMap<string, ThirdPartyEmote> | undefined
  twitch(): readonly TwitchEmote[] | undefined
  messages(): readonly ChatMessage[]
  avatar(login: string): string | undefined
  error(failure: unknown): void
  reload(): Promise<void>
}

interface Suggestion {
  value: string
  label: string
  detail: string
  url?: string
  char?: string
  login?: string
}
interface PickerEntry {
  kind: 'emote' | 'emoji'
  value: string
  label: string
  url?: string
  source: string
}

const RECENT_KEY = 'twichat.recent-emotes'
const RECENT_LIMIT = 30
const SOURCE_LABELS: Record<string, string> = { '7tv': '7TV', bttv: 'BetterTTV', ffz: 'FrankerFaceZ', twitch: 'Twitch' }
const EMOJI_NAMES = new Set(EMOJIS.map(emoji => emoji.name))
const EMOJI_BY_CHAR = new Map(EMOJIS.map(emoji => [emoji.char, emoji]))

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(m.errors.missingElement(selector))
  return element
}

export function createComposer(hooks: ComposerHooks) {
  const form = $<HTMLFormElement>('#message-form')
  const input = $<HTMLTextAreaElement>('#composer')
  const mirror = $('#composer-mirror')
  const box = form.querySelector<HTMLElement>('.composer-box')!
  const counter = $('#composer-counter')
  const sendButton = $<HTMLButtonElement>('#send-message')
  const emoteButton = $<HTMLButtonElement>('#emote-button')
  const picker = $('#emote-picker')
  const pickerSearch = $<HTMLInputElement>('#emote-search')
  const pickerTabs = $('#picker-tabs')
  const pickerResults = $('#emote-results')
  const pickerPreview = $('#emote-preview')
  const suggestList = $('#composer-suggest')
  const replyBar = $('#composer-reply')
  const replyUser = $('#composer-reply-user')
  const replyText = $('#composer-reply-text')

  // Drafts, histories and reply targets, kept per room and dropped with the account.
  const memory = new ComposerMemory()
  let channel = ''
  let account: string | null = null
  let suggestions: Suggestion[] = []
  let suggestQuery: CompletionQuery | null = null
  let suggestIndex = 0
  let historyIndex = -1
  let historyDraft = ''
  let pickerTab = 'channel'
  let recents: string[] = readRecents()

  function readRecents(): string[] {
    try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, RECENT_LIMIT) }
    catch { return [] }
  }
  function rememberRecent(entry: PickerEntry) {
    const key = `${entry.kind}:${entry.value}`
    recents = [key, ...recents.filter(item => item !== key)].slice(0, RECENT_LIMIT)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)) } catch { /* private mode keeps the session-only list */ }
  }

  function emoteCodes(): ReadonlySet<string> {
    const codes = new Set<string>(hooks.emotes()?.keys() ?? [])
    for (const emote of hooks.twitch() ?? []) codes.add(emote.name)
    return codes
  }

  // The mirror only paints backgrounds behind the textarea, so its metrics must never diverge from it.
  function paint() {
    const text = input.value
    const tokens = tokenizeMessage(text, { emotes: emoteCodes(), emojiNames: EMOJI_NAMES })
    const fragment = document.createDocumentFragment()
    for (const token of tokens) {
      if (token.kind === 'text') { fragment.append(document.createTextNode(token.text)); continue }
      const span = document.createElement('span')
      span.className = `tk-${token.kind}`
      span.textContent = token.text
      fragment.append(span)
    }
    fragment.append(document.createTextNode('​'))
    mirror.replaceChildren(fragment)
    mirror.scrollTop = input.scrollTop

    const bytes = byteLength(sanitizeOutgoing(text))
    const over = bytes > MESSAGE_BYTE_LIMIT
    counter.hidden = bytes < MESSAGE_BYTE_LIMIT - 130
    counter.textContent = `${bytes}/${MESSAGE_BYTE_LIMIT}`
    counter.dataset.state = over ? 'over' : bytes > MESSAGE_BYTE_LIMIT - 70 ? 'warn' : 'ok'
    box.dataset.over = String(over)
    sendButton.disabled = input.disabled || over || !sanitizeOutgoing(text)
  }

  function resize() {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 104)}px`
  }

  function setValue(text: string, caret = text.length) {
    input.value = text
    input.setSelectionRange(caret, caret)
    resize(); paint(); refreshSuggestions()
  }

  function insert(value: string) {
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const next = replaceRange(input.value, start, end, value)
    input.focus()
    setValue(next.text, next.caret)
  }

  /* ----- completion ----- */

  function chatters(term: string): Suggestion[] {
    const seen = new Map<string, string>()
    const messages = hooks.messages()
    for (let index = messages.length - 1; index >= 0 && seen.size < 250; index -= 1) {
      const message = messages[index]
      if (message.system || !message.login) continue
      if (!seen.has(message.login)) seen.set(message.login, message.user || message.login)
    }
    if (channel && !seen.has(channel)) seen.set(channel, channel)
    const candidates = [...seen].map(([login, user]) => ({ login, user }))
    return rankByTerm(candidates, term, candidate => [candidate.login, candidate.user], 8).map(candidate => ({
      value: `@${candidate.user.toLowerCase() === candidate.login ? candidate.user : candidate.login}`,
      label: candidate.user,
      detail: m.composer.mention,
      login: candidate.login
    }))
  }

  function emojiSuggestions(term: string): Suggestion[] {
    return searchEmojis(term, 8).map(emoji => ({ value: emoji.char, label: `:${emoji.name}:`, detail: m.composer.emoji, char: emoji.char }))
  }

  function emoteSuggestions(term: string): Suggestion[] {
    return rankByTerm(everyEmote(), term, entry => [entry.label], 8).map(entry => ({
      value: entry.value, label: entry.label, detail: entry.source, url: entry.url
    }))
  }

  function buildSuggestions(query: CompletionQuery): Suggestion[] {
    if (query.kind === 'mention') return chatters(query.term)
    if (query.kind === 'emoji') return emojiSuggestions(query.term)
    return emoteSuggestions(query.term)
  }

  function closeSuggestions() {
    if (suggestList.hidden) return
    suggestList.hidden = true
    suggestList.replaceChildren()
    suggestQuery = null
    suggestions = []
    input.setAttribute('aria-expanded', 'false')
  }

  function renderSuggestions() {
    suggestList.replaceChildren()
    suggestions.forEach((suggestion, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'suggest-row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === suggestIndex))
      if (suggestion.url) {
        const image = document.createElement('img')
        image.src = suggestion.url; image.alt = ''; image.loading = 'lazy'
        image.addEventListener('error', () => image.remove(), { once: true })
        row.append(image)
      } else if (suggestion.char) {
        const glyph = document.createElement('span')
        glyph.className = 'suggest-emoji'; glyph.textContent = suggestion.char
        row.append(glyph)
      } else if (suggestion.login) {
        const avatar = document.createElement('span')
        avatar.className = 'suggest-avatar'
        avatar.textContent = suggestion.label.slice(0, 1)
        const url = hooks.avatar(suggestion.login)
        if (url) {
          const image = document.createElement('img')
          image.src = url; image.alt = ''
          image.addEventListener('error', () => image.remove(), { once: true })
          avatar.replaceChildren(image)
        }
        row.append(avatar)
      }
      const label = document.createElement('strong')
      label.textContent = suggestion.label
      const detail = document.createElement('small')
      detail.textContent = suggestion.detail
      row.append(label, detail)
      row.addEventListener('mousedown', event => event.preventDefault())
      row.addEventListener('click', () => accept(index))
      suggestList.append(row)
    })
    suggestList.hidden = false
    input.setAttribute('aria-expanded', 'true')
    suggestList.children.item(suggestIndex)?.scrollIntoView({ block: 'nearest' })
  }

  function refreshSuggestions(forced = false) {
    const query = completionQuery(input.value, input.selectionStart ?? 0, forced)
    if (!query || input.selectionStart !== input.selectionEnd) { closeSuggestions(); return false }
    const found = buildSuggestions(query)
    if (!found.length) { closeSuggestions(); return false }
    suggestQuery = query
    suggestions = found
    suggestIndex = 0
    renderSuggestions()
    return true
  }

  function accept(index = suggestIndex) {
    const suggestion = suggestions[index]
    if (!suggestQuery || !suggestion) return
    const next = applyCompletion(input.value, suggestQuery, suggestion.value)
    closeSuggestions()
    input.focus()
    setValue(next.text, next.caret)
    closeSuggestions()
  }

  function move(step: number) {
    suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length
    renderSuggestions()
  }

  /* ----- picker ----- */

  function twitchLabel(emote: TwitchEmote): string {
    if (emote.type === 'subscriptions') return m.composer.twitchSubscribers
    if (emote.type === 'follower') return m.composer.twitchFollowers
    if (emote.type === 'bitstier') return m.composer.twitchBits
    return 'Twitch'
  }
  function twitchEntries(scope: TwitchEmote['scope']): PickerEntry[] {
    const entries: PickerEntry[] = []
    for (const emote of hooks.twitch() ?? []) {
      if (emote.scope !== scope) continue
      const url = twitchEmoteUrl(emote.id)
      if (url) entries.push({ kind: 'emote', value: emote.name, label: emote.name, url, source: twitchLabel(emote) })
    }
    return entries
  }
  function everyEmote(): PickerEntry[] {
    return [...twitchEntries('channel'), ...roomEntries(), ...twitchEntries('global')]
  }
  function roomEntries(): PickerEntry[] {
    return [...(hooks.emotes()?.values() ?? [])].map(emote => ({
      kind: 'emote' as const, value: emote.code, label: emote.code, url: emote.url, source: SOURCE_LABELS[emote.source] ?? emote.source
    }))
  }
  function emojiEntry(emoji: Emoji): PickerEntry {
    return { kind: 'emoji', value: emoji.char, label: `:${emoji.name}:`, source: emoji.group }
  }
  function recentEntries(): PickerEntry[] {
    const emotes = hooks.emotes()
    const known = everyEmote()
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
      const fromTwitch = known.find(entry => entry.value === value)
      if (fromTwitch) entries.push(fromTwitch)
    }
    return entries
  }

  function renderTabs() {
    pickerTabs.replaceChildren()
    for (const name of ['recent', 'channel', 'twitch', ...EMOJI_GROUPS]) {
      if (name === 'recent' && !recents.length) continue
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'picker-tab'
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(name === pickerTab))
      tab.textContent = tabLabel(name)
      tab.addEventListener('click', () => { pickerTab = name; pickerSearch.value = ''; renderTabs(); renderPicker() })
      pickerTabs.append(tab)
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
        insert(entry.value)
        renderTabs()
      })
      grid.append(button)
    }
    pickerResults.append(heading, grid)
  }

  function showPreview(entry: PickerEntry) {
    pickerPreview.replaceChildren()
    if (entry.url) {
      const image = document.createElement('img')
      image.src = entry.url; image.alt = ''
      pickerPreview.append(image)
    } else pickerPreview.append(document.createTextNode(`${entry.value} `))
    const name = document.createElement('b')
    name.textContent = entry.label
    pickerPreview.append(name, document.createTextNode(` · ${entry.source}`))
  }

  function emptyState(message: string) {
    const empty = document.createElement('p')
    empty.className = 'picker-empty'
    empty.textContent = message
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'picker-retry'
    retry.textContent = m.app.retry
    retry.addEventListener('click', () => { void hooks.reload().then(() => renderPicker()) })
    pickerResults.append(empty, retry)
  }

  function renderPicker() {
    pickerResults.replaceChildren()
    const term = pickerSearch.value.trim()
    if (term) {
      const emotes = rankByTerm(everyEmote(), term, entry => [entry.label], 120)
      const emojis = searchEmojis(term, 80).map(emojiEntry)
      if (emotes.length) section(m.composer.emotes, emotes)
      if (emojis.length) section(m.composer.emojis, emojis)
      if (!emotes.length && !emojis.length) emptyState(m.composer.noResult)
      return
    }
    if (pickerTab === 'recent') { section(m.composer.recentlyUsed, recentEntries()); return }
    if (pickerTab === 'channel') {
      const fromChannel = twitchEntries('channel')
      const entries = roomEntries()
      if (fromChannel.length) section(m.composer.channelEmotes(fromChannel.length), fromChannel)
      const grouped = new Map<string, PickerEntry[]>()
      for (const entry of entries) grouped.set(entry.source, [...(grouped.get(entry.source) ?? []), entry])
      for (const [source, list] of grouped) section(`${source} · ${list.length}`, list.slice(0, 300))
      if (!fromChannel.length && !entries.length) emptyState(m.composer.noChannelEmotes)
      return
    }
    if (pickerTab === 'twitch') {
      const entries = twitchEntries('global')
      if (entries.length) section(m.composer.twitchEmotes(entries.length), entries)
      else emptyState(m.composer.twitchEmotesUnavailable)
      return
    }
    section(tabLabel(pickerTab), EMOJIS.filter(emoji => emoji.group === pickerTab).map(emojiEntry))
  }

  function openPicker() {
    if (input.disabled) return
    if (pickerTab === 'recent' && !recents.length) pickerTab = 'channel'
    picker.hidden = false
    emoteButton.setAttribute('aria-expanded', 'true')
    pickerSearch.value = ''
    renderTabs(); renderPicker()
    pickerSearch.focus()
  }
  function closePicker(refocus = false) {
    if (picker.hidden) return
    picker.hidden = true
    emoteButton.setAttribute('aria-expanded', 'false')
    if (refocus) input.focus()
  }

  /* ----- history and drafts ----- */

  function history(): string[] {
    return memory.history(channel)
  }
  function recall(step: number) {
    const entries = history()
    if (!entries.length) return false
    if (historyIndex === -1) {
      if (step < 0) return false
      historyDraft = input.value
      historyIndex = 0
    } else {
      const next = historyIndex + step
      if (next < 0) { historyIndex = -1; setValue(historyDraft); return true }
      if (next >= entries.length) return true
      historyIndex = next
    }
    setValue(entries[historyIndex])
    return true
  }

  /** The thread the message will belong to: the parent's root, or the parent if it is the root already. */
  function replyTo(message: ChatMessage): ReplyReference {
    return {
      id: message.id, login: message.login.toLowerCase(), user: message.user, text: message.text,
      threadId: message.reply?.threadId || message.id,
      threadLogin: message.reply?.threadLogin || message.login.toLowerCase(),
      threadUser: message.reply?.threadUser || message.user
    }
  }
  function renderReply() {
    const target = memory.reply(channel)
    replyBar.hidden = !target
    if (!target) return
    replyUser.textContent = target.user
    replyText.textContent = target.text ? ` · ${target.text}` : ''
  }
  function setReply(target: ReplyReference | null) {
    memory.setReply(channel, target)
    renderReply()
  }

  async function submit() {
    const text = sanitizeOutgoing(input.value)
    if (!text) return
    if (byteLength(text) > MESSAGE_BYTE_LIMIT) { hooks.error(new AppError('messageTooLong')); return }
    // Sending waits on the network, and the room can change under that wait. The message
    // belongs to the room and the account it was written in: its history, and the draft it
    // clears, are theirs — not those of whatever room is being read when Twitch answers.
    const room = channel
    const scope = memory.scope
    try {
      await hooks.send(text, memory.reply(room))
      if (scope !== memory.scope) return
      memory.remember(room, text)
      memory.dropDraft(room)
      memory.setReply(room, null)
      if (room !== channel) return
      historyIndex = -1
      renderReply()
      closeSuggestions(); closePicker()
      setValue('')
    } catch (failure) {
      hooks.error(failure)
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); void submit() })

  input.addEventListener('input', () => { resize(); paint(); refreshSuggestions(); historyIndex = -1 })
  input.addEventListener('scroll', () => { mirror.scrollTop = input.scrollTop })
  input.addEventListener('blur', () => { window.setTimeout(closeSuggestions, 120) })
  input.addEventListener('click', () => refreshSuggestions())
  input.addEventListener('paste', event => {
    const pasted = event.clipboardData?.getData('text')
    if (!pasted) return
    event.preventDefault()
    const clean = pasted.replace(/[\r\n\t]+/gu, ' ')
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const next = replaceRange(input.value, start, end, clean, false)
    setValue(next.text, next.caret)
  })
  input.addEventListener('keydown', event => {
    // An input method composes with the same keys this composer navigates with: Enter settles a
    // candidate, Tab and the arrows walk the candidate list. While it is composing, none of them
    // are ours — acting on them sends half a word to the channel, or swallows the choice.
    if (composing(event)) return
    const open = !suggestList.hidden
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); closeSuggestions(); return }
      if (!picker.hidden) { event.preventDefault(); closePicker(true); return }
      if (memory.reply(channel)) { event.preventDefault(); setReply(null) }
      return
    }
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); return }
    if (event.key === 'Tab' && !event.shiftKey) {
      if (open) { event.preventDefault(); accept(); return }
      if (refreshSuggestions(true)) { event.preventDefault(); if (suggestions.length === 1) accept(0) }
      return
    }
    if (sends(event)) {
      // Twitch refuses line breaks, so Enter always sends and Shift+Enter never inserts one.
      event.preventDefault()
      if (open) { accept(); return }
      void submit()
      return
    }
    if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && input.selectionStart === input.selectionEnd) {
      const caret = input.selectionStart ?? 0
      const atEdge = event.key === 'ArrowUp' ? caret === 0 || !input.value : caret === input.value.length
      if (atEdge && recall(event.key === 'ArrowUp' ? 1 : -1)) event.preventDefault()
    }
  })

  $('#composer-reply-cancel').addEventListener('click', () => { setReply(null); input.focus() })

  emoteButton.addEventListener('click', () => { if (picker.hidden) openPicker(); else closePicker(true) })
  $('#emote-close').addEventListener('click', () => closePicker(true))
  pickerSearch.addEventListener('input', renderPicker)
  pickerSearch.addEventListener('keydown', event => { if (event.key === 'Escape' && !composing(event)) { event.preventDefault(); closePicker(true) } })
  picker.addEventListener('mousedown', event => { if (event.target !== pickerSearch) event.preventDefault() })
  document.addEventListener('pointerdown', event => {
    const target = event.target as Element | null
    if (!target?.closest('#emote-picker') && !target?.closest('#emote-button')) closePicker()
  }, true)

  return {
    focus() { input.focus() },
    /** Used by the message menu: targets a message and shows what will be quoted. */
    reply(message: ChatMessage) {
      if (input.disabled) return false
      setReply(replyTo(message))
      input.focus()
      return true
    },
    /** Used by the message menu: appends a mention without bypassing the highlighting. */
    mention(name: string) {
      if (input.disabled) return false
      const current = input.value.replace(/\s+$/u, '')
      input.focus()
      setValue(`${current ? `${current} ` : ''}@${name} `)
      return true
    },
    /** Keeps one draft and one history per room, like a chat client rather than a form. */
    setRoom(next: string) {
      if (next === channel) return
      memory.keepDraft(channel, input.value)
      channel = next
      historyIndex = -1
      closeSuggestions(); closePicker()
      renderReply()
      setValue(memory.draft(next))
      if (account) input.placeholder = m.composer.writeIn(next || m.composer.channelWord)
      renderTabs(); if (!picker.hidden) renderPicker()
    },
    setAccount(login: string | null) {
      account = login
      input.disabled = !login
      emoteButton.disabled = !login
      input.placeholder = login ? m.composer.writeIn(channel || m.composer.channelWord) : m.composer.connectToParticipate
      // Another account, or none: nothing written under the previous one stays reachable —
      // not the drafts, not the histories, not the reply being composed, not the line in the
      // box. The rooms are named the same for everybody; the memory of them is not shared.
      if (memory.setAccount(login)) {
        closeSuggestions(); closePicker()
        historyIndex = -1; historyDraft = ''
        setValue('')
        renderReply()
      }
      paint()
    },
    refresh() {
      paint()
      if (!picker.hidden) renderPicker()
    }
  }
}
