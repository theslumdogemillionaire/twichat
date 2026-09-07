import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/main/database'
import { WhisperStore } from '../src/main/whispers'
import type { Whisper } from '../src/shared/types'

const whisper = (overrides: Partial<Whisper> = {}): Whisper => ({
  id: '3c4719ba-fe16-4c75-8f00-78142a375cf1', peer: 'cat_on_keyboard', peerId: '9', peerName: 'Cat_On_Keyboard',
  outgoing: false, text: 'mrrrp', at: 1_757_160_000_000, ...overrides
})
const store = () => new WhisperStore(openDatabase(':memory:'))

test('a whisper is kept for the account that received it, sender and date included', () => {
  const whispers = store()
  assert.equal(whispers.record('alice', whisper()), true)
  assert.deepEqual(whispers.thread('alice', 'cat_on_keyboard'), [whisper()])
  // Another account on the same machine shares nothing.
  assert.deepEqual(whispers.thread('bob', 'cat_on_keyboard'), [])
})

test('the id a reply is addressed to is the last one that person was seen under', () => {
  const whispers = store()
  whispers.record('alice', whisper({ id: 'a', peerId: '9', at: 1 }))
  // A whisper Twitch sent without a usable id must not erase the one we already had.
  whispers.record('alice', whisper({ id: 'b', peerId: undefined, at: 2 }))
  assert.equal(whispers.peerId('alice', 'cat_on_keyboard'), '9')
  assert.equal(whispers.peerId('alice', 'radio_ancienne'), '')
  // Someone who came back under a new id: the reply follows the newer one.
  whispers.record('alice', whisper({ id: 'c', peerId: '12', at: 3 }))
  assert.equal(whispers.peerId('alice', 'cat_on_keyboard'), '12')
})

test('the same whisper twice is one line: EventSub repeats a frame across a reconnect', () => {
  const whispers = store()
  assert.equal(whispers.record('alice', whisper()), true)
  assert.equal(whispers.record('alice', whisper({ text: 'the same frame again' })), false)
  assert.deepEqual(whispers.thread('alice', 'cat_on_keyboard').map(one => one.text), ['mrrrp'])
})

test('a conversation reads oldest first, whichever way each message went', () => {
  const whispers = store()
  whispers.record('alice', whisper({ id: 'a', text: 'tu regardes quoi ?', at: 2 }))
  whispers.record('alice', whisper({ id: 'b', text: 'la rediff', at: 3, outgoing: true }))
  whispers.record('alice', whisper({ id: 'c', text: 'salut', at: 1 }))
  assert.deepEqual(whispers.thread('alice', 'cat_on_keyboard').map(one => [one.text, one.outgoing]),
    [['salut', false], ['tu regardes quoi ?', false], ['la rediff', true]])
})

test('a whisper with nothing to show is not written down', () => {
  const whispers = store()
  assert.equal(whispers.record('alice', whisper({ text: '   ' })), false)
  assert.equal(whispers.record('alice', whisper({ id: '' })), false)
  assert.deepEqual(whispers.thread('alice', 'cat_on_keyboard'), [])
})

test('an unreadable date falls back to now rather than losing the message', () => {
  const whispers = store()
  const before = Date.now()
  whispers.record('alice', whisper({ at: 0 }))
  const [kept] = whispers.thread('alice', 'cat_on_keyboard')
  assert.ok(kept.at >= before, `dated ${kept.at}, before ${before}`)
})

test('forgetting a conversation takes it off this machine and leaves the others', () => {
  const whispers = store()
  whispers.record('alice', whisper())
  whispers.record('alice', whisper({ id: 'other', peer: 'radio_ancienne' }))
  whispers.forget('alice', 'cat_on_keyboard')
  assert.deepEqual(whispers.thread('alice', 'cat_on_keyboard'), [])
  assert.equal(whispers.thread('alice', 'radio_ancienne').length, 1)
})
