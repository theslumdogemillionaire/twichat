import { ComposerMemory } from './composer-memory'
import { composing, sends } from './keys'
import type { ChatMessage, ReplyReference, ThirdPartyEmote, TwitchEmote } from '../shared/types'
import { inlineEmoteNodes } from './emotes'
import { EMOJIS, searchEmojis } from './emoji'
import { createEmotePicker, everyEmote as allEmotes } from './emote-picker'
import { m } from '../shared/i18n'
import { AppError } from '../shared/errors'

import {
  MESSAGE_BYTE_LIMIT, applyCompletion, byteLength, completionQuery, mergeCompletions, rankByTerm,
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
const EMOJI_NAMES = new Set(EMOJIS.map(emoji => emoji.name))
const SUGGESTION_ROWS = 8

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
  // The panel builds itself into the composer: the room and the conversation windows run the
  // same one, so what is added to it is added to both.
  const picker = createEmotePicker({
    host: form, trigger: emoteButton, scope: 'channel',
    insert: value => insert(value),
    blocked: () => input.disabled,
    refocus: () => input.focus(),
    emotes: () => hooks.emotes(),
    twitch: () => hooks.twitch(),
    reload: () => hooks.reload()
  })
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

  function emoteCodes(): ReadonlySet<string> {
    const codes = new Set<string>(hooks.emotes()?.keys() ?? [])
    for (const emote of hooks.twitch() ?? []) codes.add(emote.name)
    return codes
  }

  /** Name to id, as the log holds it for our own messages: a body with no emote tag needs it. */
  function twitchEmoteIds(): ReadonlyMap<string, string> {
    return new Map((hooks.twitch() ?? []).map(emote => [emote.name, emote.id]))
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
    return searchEmojis(term, SUGGESTION_ROWS).map(emoji => ({ value: emoji.char, label: `:${emoji.name}:`, detail: m.composer.emoji, char: emoji.char }))
  }

  function emoteSuggestions(term: string): Suggestion[] {
    return rankByTerm(allEmotes(hooks.emotes(), hooks.twitch()), term, entry => [entry.label], SUGGESTION_ROWS).map(entry => ({
      value: entry.value, label: entry.label, detail: entry.source, url: entry.url
    }))
  }

  /**
   * A colon opens both shelves at once. An emote is written like a shortcode here, so `:kap` has to
   * reach Kappa and `:joy` still has to reach 😂; the channel's emotes come first, because that is
   * what a Twitch room is spoken in.
   */
  function shortcodeSuggestions(term: string): Suggestion[] {
    const needle = term.trim().toLowerCase()
    const named = (suggestion: Suggestion) => suggestion.label.toLowerCase().replace(/^:|:$/gu, '')
    return mergeCompletions(
      emoteSuggestions(term), emojiSuggestions(term), SUGGESTION_ROWS,
      needle ? suggestion => named(suggestion) === needle : undefined
    )
  }

  function buildSuggestions(query: CompletionQuery): Suggestion[] {
    if (query.kind === 'mention') return chatters(query.term)
    if (query.kind === 'emoji') return shortcodeSuggestions(query.term)
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
    // The same name matching as the quote in the log: the target is recognised by its emotes.
    replyText.replaceChildren()
    if (target.text) replyText.append(' · ', ...inlineEmoteNodes(target.text, hooks.emotes(), twitchEmoteIds()))
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
      closeSuggestions(); picker.close()
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
      if (picker.isOpen()) { event.preventDefault(); picker.close(true); return }
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
      closeSuggestions(); picker.close()
      renderReply()
      setValue(memory.draft(next))
      if (account) input.placeholder = m.composer.writeIn(next || m.composer.channelWord)
      picker.refresh()
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
        closeSuggestions(); picker.close()
        historyIndex = -1; historyDraft = ''
        setValue('')
        renderReply()
      }
      paint()
    },
    refresh() {
      paint()
      picker.refresh()
    }
  }
}
