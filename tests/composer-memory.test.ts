import test from 'node:test'
import assert from 'node:assert/strict'
import { ComposerMemory } from '../src/renderer/composer-memory'
import type { ReplyReference } from '../src/shared/types'

const reply: ReplyReference = { id: 'm1', login: 'alice', user: 'Alice', text: 'hello', threadId: 'm1', threadLogin: 'alice', threadUser: 'Alice' }

test('a draft waits in the room it was written in', () => {
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.keepDraft('zerator', 'salut ')
  memory.keepDraft('anyme023', 'bonsoir ')

  assert.equal(memory.draft('zerator'), 'salut ')
  assert.equal(memory.draft('anyme023'), 'bonsoir ')
  assert.equal(memory.draft('never-visited'), '')
  // An emptied box leaves nothing behind rather than an empty draft.
  memory.keepDraft('zerator', '')
  assert.equal(memory.draft('zerator'), '')
})

test('another account finds none of what the previous one wrote', () => {
  // The rooms are keyed by name, and two accounts share the room names: without this, a
  // sentence typed by one was handed to the next one opening the same room in the same window.
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.keepDraft('zerator', 'un brouillon privé')
  memory.remember('zerator', 'un message envoyé')
  memory.setReply('zerator', reply)

  assert.equal(memory.setAccount('bob'), true)
  assert.equal(memory.draft('zerator'), '')
  assert.deepEqual(memory.history('zerator'), [])
  assert.equal(memory.reply('zerator'), undefined)
})

test('signing out is the same boundary as changing account', () => {
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.keepDraft('zerator', 'à moitié écrit')

  assert.equal(memory.setAccount(null), true)
  assert.equal(memory.draft('zerator'), '')
  // Signing back in as the same account does not bring it back either.
  assert.equal(memory.setAccount('alice'), true)
  assert.equal(memory.draft('zerator'), '')
})

test('the account it already had is not a change, and erases nothing', () => {
  // The window announces its account on more than a sign-in: a redraw must not eat a draft.
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.keepDraft('zerator', 'en cours')

  assert.equal(memory.setAccount('alice'), false)
  assert.equal(memory.draft('zerator'), 'en cours')
  // The very first announcement is a change, whatever it names.
  assert.equal(new ComposerMemory().setAccount(null), true)
})

test('a sent message joins its own room, once and at the front', () => {
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.remember('zerator', 'premier')
  memory.remember('zerator', 'second')
  memory.remember('anyme023', 'ailleurs')
  memory.remember('zerator', 'premier')

  assert.deepEqual(memory.history('zerator'), ['premier', 'second'])
  assert.deepEqual(memory.history('anyme023'), ['ailleurs'])
  // Nothing empty gets in, and neither does a room without a name.
  memory.remember('zerator', '')
  memory.remember('', 'nulle part')
  assert.deepEqual(memory.history('zerator'), ['premier', 'second'])
  assert.deepEqual(memory.history(''), [])
})

test('a history stops growing at forty messages', () => {
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  for (let index = 0; index < 45; index++) memory.remember('zerator', `message ${index}`)

  const history = memory.history('zerator')
  assert.equal(history.length, 40)
  assert.equal(history[0], 'message 44')
  assert.equal(history.at(-1), 'message 5')
})

test('the reply being composed belongs to its room', () => {
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  memory.setReply('zerator', reply)

  assert.deepEqual(memory.reply('zerator'), reply)
  assert.equal(memory.reply('anyme023'), undefined)
  memory.setReply('zerator', null)
  assert.equal(memory.reply('zerator'), undefined)
})

test('a send that answers late knows which account it was written under', () => {
  // What `submit` reads back once Twitch answers, to drop the right draft — or none at all.
  const memory = new ComposerMemory()
  memory.setAccount('alice')
  const scope = memory.scope
  memory.setAccount('bob')

  assert.notEqual(scope, memory.scope)
  assert.equal(memory.scope, 'bob')
})
