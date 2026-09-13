import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatColor } from '../src/main/chat-color-parse'
import { CHAT_COLORS, chatColorChoice } from '../src/shared/validation'
import { errorKey } from '../src/shared/errors'

test('reads the colour out of the list Twitch answers with', () => {
  assert.equal(parseChatColor({ data: [{ user_id: '11111', user_login: 'speedy', user_name: 'Speedy', color: '#9146FF' }] }), '#9146ff')
})

test('an account that never picked one is answered with an empty colour, which is an answer', () => {
  // Twitch then derives a colour from the name, and says nowhere which: the IRC `color` tag is
  // empty for those accounts too. Nothing here may invent one to fill the gap.
  assert.equal(parseChatColor({ data: [{ user_id: '44444', color: '' }] }), '')
  assert.equal(parseChatColor({ data: [] }), '')
  assert.equal(parseChatColor(null), '')
  assert.equal(parseChatColor({ data: [{ color: 'rebeccapurple' }] }), '')
  assert.equal(parseChatColor({ data: [{ color: '#fff' }] }), '')
})

test('the fifteen named colours are spelled the way Twitch spells them', () => {
  // Pinned against the Twitch API reference for Update User Chat Color, read on 2026-09-13. A
  // sixteenth, or one spelled otherwise, is refused by Twitch with a 400 that reads like a bug
  // on this side — so the list is a fact about Twitch rather than a choice of ours.
  assert.deepEqual([...CHAT_COLORS], [
    'blue', 'blue_violet', 'cadet_blue', 'chocolate', 'coral', 'dodger_blue', 'firebrick',
    'golden_rod', 'green', 'hot_pink', 'orange_red', 'red', 'sea_green', 'spring_green', 'yellow_green'
  ])
  for (const preset of CHAT_COLORS) assert.equal(chatColorChoice(preset), preset)
})

test('a hex is accepted here and left for Twitch to refuse', () => {
  // Only Turbo and Prime accounts may set one, and no endpoint says which accounts those are.
  // Refusing it here would take the choice from someone entitled to it.
  assert.equal(chatColorChoice('#9146FF'), '#9146ff')
  assert.equal(chatColorChoice('  Blue_Violet '), 'blue_violet')
})

test('anything else is named by what the person can do about it', () => {
  for (const bad of ['rebeccapurple', '#fff', '#12345g', 'blue violet', '', 42, null, {}]) {
    assert.throws(() => chatColorChoice(bad), error => errorKey(error) === 'chatColorInvalid', `accepted ${String(bad)}`)
  }
})
