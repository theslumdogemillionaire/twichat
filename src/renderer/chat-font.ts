import type { ChatFont } from '../shared/types'
import { chatFont } from '../shared/validation'

let current: ChatFont = 'default'

export function currentChatFont(): ChatFont { return current }

/**
 * The typeface of the conversations, set on the root the way the theme is: the stylesheet
 * turns the attribute into `--chat-font`, which only the reading and writing surfaces claim —
 * the rest of the interface keeps the application's own font either way.
 *
 * `default` writes nothing, so the shipped font stays the one declared on `:root`.
 */
export function applyChatFont(font: ChatFont): void {
  current = font
  if (font === 'default') delete document.documentElement.dataset.chatFont
  else document.documentElement.dataset.chatFont = font
  // The cards live in the room's settings and nowhere else; a conversation window finds none,
  // which is the whole reason this reads the document rather than being handed the controls.
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=chat-font]')) input.checked = input.value === font
}

/**
 * The same, from whatever a window was handed across the bridge: a value we do not know reads
 * as `default`. The name that was applied comes back, for a window keeping its own copy.
 */
export function adoptChatFont(value: unknown): ChatFont {
  const font = chatFont(value)
  applyChatFont(font)
  return font
}

/** The cards, wired the way the theme's are: the choice lands before the caller is told of it. */
export function setupChatFont(initial: ChatFont, onChange: (font: ChatFont) => void): void {
  applyChatFont(initial)
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=chat-font]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return
      applyChatFont(chatFont(input.value))
      onChange(current)
    })
  }
}
