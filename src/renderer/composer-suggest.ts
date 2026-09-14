import { searchEmojis } from './emoji'
import { everyEmote } from './emote-picker'
import { rememberRecent } from './recent-emotes'
import { m } from '../shared/i18n'
import type { ThirdPartyEmote, TwitchEmote } from '../shared/types'
import {
  applyCompletion, completionQuery, mergeCompletions, rankByTerm, type CompletionQuery
} from './composer-text'

export interface Suggestion {
  value: string
  label: string
  detail: string
  url?: string
  char?: string
  login?: string
}

export interface SuggestParts {
  /** The box being typed into. It carries `aria-expanded` for the shelf. */
  input: HTMLTextAreaElement
  /** Where the rows are drawn. Hidden while nothing is proposed. */
  list: HTMLElement
  emotes(): ReadonlyMap<string, ThirdPartyEmote> | undefined
  twitch(): readonly TwitchEmote[] | undefined
  /** A room completes the people in it; a conversation has one interlocutor and nothing to rank. */
  mentions?(term: string): Suggestion[]
  avatar?(login: string): string | undefined
  /** Puts an accepted row in place. The caller owns its own repaint. */
  apply(text: string, caret: number): void
}

const SUGGESTION_ROWS = 8

/**
 * The completion shelf, shared by the room and the conversation windows. It knows the emotes,
 * the emojis and how a chosen row lands in the text; what it does not know is the box it serves,
 * which is why the markup and the repaint stay with the caller.
 */
export function createSuggestions(parts: SuggestParts) {
  const { input, list } = parts
  let suggestions: Suggestion[] = []
  let query: CompletionQuery | null = null
  let index = 0

  function emojiRows(term: string): Suggestion[] {
    return searchEmojis(term, SUGGESTION_ROWS).map(emoji => ({ value: emoji.char, label: `:${emoji.name}:`, detail: m.composer.emoji, char: emoji.char }))
  }

  function emoteRows(term: string): Suggestion[] {
    return rankByTerm(everyEmote(parts.emotes(), parts.twitch()), term, entry => [entry.label], SUGGESTION_ROWS).map(entry => ({
      value: entry.value, label: entry.label, detail: entry.source, url: entry.url
    }))
  }

  /**
   * A colon opens both shelves at once. An emote is written like a shortcode here, so `:kap` has to
   * reach Kappa and `:joy` still has to reach 😂; the channel's emotes come first, because that is
   * what a Twitch room is spoken in.
   */
  function shortcodeRows(term: string): Suggestion[] {
    const needle = term.trim().toLowerCase()
    const named = (suggestion: Suggestion) => suggestion.label.toLowerCase().replace(/^:|:$/gu, '')
    return mergeCompletions(
      emoteRows(term), emojiRows(term), SUGGESTION_ROWS,
      needle ? suggestion => named(suggestion) === needle : undefined
    )
  }

  function build(asked: CompletionQuery): Suggestion[] {
    if (asked.kind === 'mention') return parts.mentions?.(asked.term) ?? []
    if (asked.kind === 'emoji') return shortcodeRows(asked.term)
    return emoteRows(asked.term)
  }

  function render() {
    list.replaceChildren()
    suggestions.forEach((suggestion, row) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'suggest-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(row === index))
      if (suggestion.url) {
        const image = document.createElement('img')
        image.src = suggestion.url; image.alt = ''; image.loading = 'lazy'
        image.addEventListener('error', () => image.remove(), { once: true })
        button.append(image)
      } else if (suggestion.char) {
        const glyph = document.createElement('span')
        glyph.className = 'suggest-emoji'; glyph.textContent = suggestion.char
        button.append(glyph)
      } else if (suggestion.login) {
        const avatar = document.createElement('span')
        avatar.className = 'suggest-avatar'
        avatar.textContent = suggestion.label.slice(0, 1)
        const url = parts.avatar?.(suggestion.login)
        if (url) {
          const image = document.createElement('img')
          image.src = url; image.alt = ''
          image.addEventListener('error', () => image.remove(), { once: true })
          avatar.replaceChildren(image)
        }
        button.append(avatar)
      }
      const label = document.createElement('strong')
      label.textContent = suggestion.label
      const detail = document.createElement('small')
      detail.textContent = suggestion.detail
      button.append(label, detail)
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', () => accept(row))
      list.append(button)
    })
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
    list.children.item(index)?.scrollIntoView({ block: 'nearest' })
  }

  function close() {
    if (list.hidden) return
    list.hidden = true
    list.replaceChildren()
    query = null
    suggestions = []
    input.setAttribute('aria-expanded', 'false')
  }

  function refresh(forced = false) {
    const asked = completionQuery(input.value, input.selectionStart ?? 0, forced)
    if (!asked || input.selectionStart !== input.selectionEnd) { close(); return false }
    const found = build(asked)
    if (!found.length) { close(); return false }
    query = asked
    suggestions = found
    index = 0
    render()
    return true
  }

  function accept(row = index) {
    const suggestion = suggestions[row]
    if (!query || !suggestion) return
    // What the shelf is answering is not what was asked for: a colon opens the emotes and the
    // emojis at once, so the row that was taken says what it was, not the query. A mention is
    // nobody's recent anything.
    if (!suggestion.login) rememberRecent(suggestion.char ? 'emoji' : 'emote', suggestion.value)
    const next = applyCompletion(input.value, query, suggestion.value)
    close()
    input.focus()
    parts.apply(next.text, next.caret)
    close()
  }

  function move(step: number) {
    index = (index + step + suggestions.length) % suggestions.length
    render()
  }

  return {
    isOpen: () => !list.hidden,
    size: () => suggestions.length,
    refresh, accept, move, close
  }
}
