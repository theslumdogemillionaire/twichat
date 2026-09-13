import { languageName, locale, m } from '../shared/i18n'
import { commandKey, platformKeys } from './keys'

/**
 * The HTML carries keys, not sentences. Three markers, and nothing else:
 *
 * - `data-i18n` replaces the whole content of an element that carries only text;
 * - `data-i18n-text` replaces only its first text run, for a button whose
 *   remainder is an icon — so the structure does not move;
 * - `data-i18n-attr="title=key;aria-label=key"` sets the readable attributes.
 *
 * The values come from the catalog, never from user input: `innerHTML` serves there only to
 * keep the `<br>` of a sentence written across two lines.
 */
function walk(root: unknown, key: string): string | undefined {
  let node: unknown = root
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

function lookup(key: string): string | undefined {
  // The HTML keys are relative to the `ui` section: that is the one describing the document. The
  // conversation window is the exception — its section sits beside `ui` rather than under it, and
  // `whisper.html` names it from the root, so a key `ui` has not got is looked up there as well.
  // Without that second read its eight sentences stayed as the markup wrote them, in every language.
  const value = walk(m.ui, key) ?? walk(m, key)
  // The catalogs write a shortcut the way a Mac does, `⌘ K`. On a platform whose command key is
  // Ctrl, that glyph names a modifier the keyboard does not have.
  return value === undefined ? undefined : platformKeys(value, commandKey())
}

function paint(element: HTMLElement, value: string) {
  if (value.includes('<') || value.includes('&')) element.innerHTML = value
  else element.textContent = value
}

/** The first text run of an element, leaving its children — icons included — in place. */
function firstTextNode(element: HTMLElement): Text | null {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return node as Text
  }
  return null
}

export function hydrate(root: ParentNode = document): void {
  document.documentElement.lang = locale
  // The shortcut labels the markup carries on its own, with no sentence around them to translate.
  for (const element of root.querySelectorAll<HTMLElement>('[data-keys]')) {
    element.textContent = platformKeys(element.dataset.keys ?? '', commandKey())
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = lookup(element.dataset.i18n ?? '')
    if (value !== undefined) paint(element, value)
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-text]')) {
    const value = lookup(element.dataset.i18nText ?? '')
    const node = firstTextNode(element)
    // The whitespace around the text holds the layout next to an icon: it is kept.
    if (value !== undefined && node) node.textContent = node.textContent!.replace(/\S.*\S|\S/u, value)
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (element.dataset.i18nAttr ?? '').split(';')) {
      const [name, key] = pair.split('=')
      const value = name && key ? lookup(key) : undefined
      if (value !== undefined) element.setAttribute(name!, value)
    }
  }
  paintContentLanguages()
}

/**
 * The Twitch filter languages are a content choice, not the interface language:
 * `Intl.DisplayNames` names them in the current language, which avoids hand-writing
 * eight language labels in every catalog.
 */
function paintContentLanguages() {
  const select = document.querySelector<HTMLSelectElement>('#discover-language')
  if (!select) return
  for (const option of select.options) {
    option.textContent = option.value ? languageName(option.value) : m.ui.discover.allLanguages
  }
}
