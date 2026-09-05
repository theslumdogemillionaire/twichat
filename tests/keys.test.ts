import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composing, label, matches, platformKeys, sends, type Chord } from '../src/renderer/keys'

const JOIN: Chord = { key: 'k', command: true }
const CHAT_ONLY: Chord = { key: 'v', command: true, shift: true }

test('Enter sends, unless an input method is settling a candidate', () => {
  assert.equal(sends({ key: 'Enter' }), true)
  // What a Japanese, Chinese or Korean keyboard does on the Enter that confirms a character.
  assert.equal(sends({ key: 'Enter', isComposing: true }), false)
  // The same press, on a browser that raises the flag one press late.
  assert.equal(sends({ key: 'Enter', keyCode: 229 }), false)
  assert.equal(sends({ key: 'a' }), false)
})

test('a key handed to an input method is composing whichever way it says so', () => {
  assert.equal(composing({ key: 'Enter' }), false)
  assert.equal(composing({ key: 'Enter', isComposing: true }), true)
  assert.equal(composing({ key: 'ArrowDown', keyCode: 229 }), true)
})

test('the command key is Meta on a Mac and Control everywhere else', () => {
  assert.equal(matches({ key: 'k', metaKey: true }, JOIN, 'meta'), true)
  assert.equal(matches({ key: 'k', ctrlKey: true }, JOIN, 'ctrl'), true)
})

test('the modifier the platform does not use fires nothing', () => {
  // The bug this replaces: every shortcut read `metaKey`, so on Windows the key that opens the
  // start menu was the application's shortcut and Ctrl did nothing.
  assert.equal(matches({ key: 'k', metaKey: true }, JOIN, 'ctrl'), false)
  assert.equal(matches({ key: 'k', ctrlKey: true }, JOIN, 'meta'), false)
})

test('a second modifier held down is a different shortcut', () => {
  assert.equal(matches({ key: 'k', metaKey: true, ctrlKey: true }, JOIN, 'meta'), false)
  assert.equal(matches({ key: 'k', metaKey: true, altKey: true }, JOIN, 'meta'), false)
  assert.equal(matches({ key: 'k', metaKey: true, shiftKey: true }, JOIN, 'meta'), false)
})

test('a shortcut that wants Shift needs it, and only it', () => {
  assert.equal(matches({ key: 'v', metaKey: true, shiftKey: true }, CHAT_ONLY, 'meta'), true)
  assert.equal(matches({ key: 'v', ctrlKey: true, shiftKey: true }, CHAT_ONLY, 'ctrl'), true)
  assert.equal(matches({ key: 'v', metaKey: true }, CHAT_ONLY, 'meta'), false)
})

test('the letter is read whatever case the keyboard reports it in', () => {
  assert.equal(matches({ key: 'K', metaKey: true }, JOIN, 'meta'), true)
  assert.equal(matches({ key: 'B', metaKey: true }, JOIN, 'meta'), false)
})

test('no shortcut fires while an input method is composing', () => {
  assert.equal(matches({ key: 'k', metaKey: true, isComposing: true }, JOIN, 'meta'), false)
})

test('the written label follows the platform, and the Shift glyph does not move', () => {
  assert.equal(label(JOIN, 'meta'), '⌘ K')
  assert.equal(label(JOIN, 'ctrl'), 'Ctrl K')
  assert.equal(label(CHAT_ONLY, 'meta'), '⌘ ⇧ V')
  assert.equal(label(CHAT_ONLY, 'ctrl'), 'Ctrl ⇧ V')
})

test('a sentence carrying the command glyph is rewritten for the platform', () => {
  assert.equal(platformKeys('20 CHANNELS AT ONCE · ⌘ K TO SWITCH', 'meta'), '20 CHANNELS AT ONCE · ⌘ K TO SWITCH')
  assert.equal(platformKeys('20 CHANNELS AT ONCE · ⌘ K TO SWITCH', 'ctrl'), '20 CHANNELS AT ONCE · Ctrl K TO SWITCH')
  assert.equal(platformKeys('Chat only (⌘ ⇧ V)', 'ctrl'), 'Chat only (Ctrl ⇧ V)')
})
