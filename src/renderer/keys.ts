import type { CommandKey } from '../shared/types'

/**
 * The keyboard, told apart from the platform it is on.
 *
 * Two things used to be assumed here. That the command key is `metaKey` — true on a Mac, where
 * `⌘` is the modifier every shortcut hangs off, and false everywhere else: on Windows and Linux
 * the same shortcuts are Ctrl, and `Meta` is the system key that opens the start menu. And that a
 * key press means what it says, which stops being true while an input method is composing:
 * Japanese, Chinese and Korean text is typed as a sequence of candidate keys, and the Enter that
 * settles a candidate is the same Enter that sends a message.
 *
 * Both answers live here rather than at the call sites, so a shortcut added later cannot be
 * written Mac-only without noticing.
 */

/** A shortcut, as the application means it rather than as a keyboard reports it. */
export interface Chord { key: string; command?: boolean; shift?: boolean }

/** What is read of a keyboard event. A test hands over an object literal. */
export interface KeyStroke {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

/**
 * Whether an input method is putting this key press together rather than delivering it.
 *
 * `isComposing` is the standard answer. `keyCode` 229 is the other one: it is the value browsers
 * report for any key handed to an input method, and some of them raise the composing flag one
 * press later than they set it. Both are read, because the cost of being wrong is one-sided —
 * a key held back during composition is one the input method was going to consume anyway, while
 * a key let through sends half a sentence to a channel.
 */
export function composing(event: KeyStroke): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** Enter, meaning it: the one that sends a message rather than settling a candidate. */
export function sends(event: KeyStroke): boolean {
  return event.key === 'Enter' && !composing(event)
}

/**
 * Whether a key press is this shortcut on this platform.
 *
 * The modifier that is not the command key must be up. Without that, `Ctrl K` on a Mac and the
 * Windows key on a PC would both fire a shortcut their platform reserves for something else.
 */
export function matches(event: KeyStroke, chord: Chord, command: CommandKey): boolean {
  if (composing(event) || event.altKey === true) return false
  const held = (command === 'meta' ? event.metaKey : event.ctrlKey) === true
  const foreign = (command === 'meta' ? event.ctrlKey : event.metaKey) === true
  if (foreign || held !== (chord.command === true)) return false
  if ((event.shiftKey === true) !== (chord.shift === true)) return false
  return event.key.toLowerCase() === chord.key.toLowerCase()
}

/**
 * The command key as it is written for the reader.
 *
 * `⌘` is the notation the catalogs and the HTML are written in, since that is what the majority
 * of these strings said already; on a platform where the command key is Ctrl it becomes `Ctrl`.
 * `⇧` is left alone: it is the same glyph on every platform, and translating it would mean a
 * shortcut label that changes with the interface language.
 */
export function platformKeys(text: string, command: CommandKey): string {
  return command === 'meta' ? text : text.replace(/⌘/g, 'Ctrl')
}

/** The label of a shortcut built in code rather than written in the markup. */
export function label(chord: Chord, command: CommandKey): string {
  return platformKeys([chord.command ? '⌘' : '', chord.shift ? '⇧' : '', chord.key.toUpperCase()].filter(Boolean).join(' '), command)
}

/**
 * The platform's command key, for everything drawing a label. It is told once, by the main
 * process, which is the only side that knows what it is running on.
 */
let current: CommandKey = 'meta'
export function setCommandKey(command: CommandKey) { current = command }
export function commandKey(): CommandKey { return current }
