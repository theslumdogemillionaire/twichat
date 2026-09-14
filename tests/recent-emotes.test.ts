import test from 'node:test'
import assert from 'node:assert/strict'

/** The browser store, reduced to what the module touches. `throws` stands in for a refusing one. */
const store = { value: null as string | null, throws: false }
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => key === 'twichat.recent-emotes' ? store.value : null,
    setItem: (key: string, value: string) => {
      if (store.throws) throw new Error('storage is full')
      if (key === 'twichat.recent-emotes') store.value = value
    }
  }
})

const { readRecents, rememberRecent, splitRecent } = await import('../src/renderer/recent-emotes')

test('a key is split on its first colon: a Twitch name is punctuation', () => {
  assert.deepEqual(splitRecent('emote:Kappa'), { kind: 'emote', value: 'Kappa' })
  assert.deepEqual(splitRecent('emote::)'), { kind: 'emote', value: ':)' })
  assert.deepEqual(splitRecent('emoji:😂'), { kind: 'emoji', value: '😂' })
  assert.equal(splitRecent('mention:zerator'), undefined)
  assert.equal(splitRecent('emote:'), undefined)
})

test('what was just written comes first, and is not kept twice', () => {
  store.value = null
  rememberRecent('emote', 'Kappa')
  rememberRecent('emoji', '😂')
  assert.deepEqual(rememberRecent('emote', 'Kappa'), ['emote:Kappa', 'emoji:😂'])
  assert.deepEqual(readRecents(), ['emote:Kappa', 'emoji:😂'])
})

test('the list stops at thirty, dropping the oldest', () => {
  store.value = null
  for (let index = 0; index < 35; index++) rememberRecent('emote', `Emote${index}`)
  const recents = readRecents()
  assert.equal(recents.length, 30)
  assert.equal(recents[0], 'emote:Emote34')
  assert.equal(recents.at(-1), 'emote:Emote5')
})

test('a write re-reads: the other window recorded something in the meantime', () => {
  // The room and the conversation window each hold a panel over this one list. A panel writing
  // back a copy it read when it was built would undo whatever the other one recorded since.
  store.value = null
  rememberRecent('emote', 'Kappa')
  store.value = JSON.stringify(['emote:PogChamp', 'emote:Kappa'])
  assert.deepEqual(rememberRecent('emote', 'LUL'), ['emote:LUL', 'emote:PogChamp', 'emote:Kappa'])
})

test('a store holding nonsense is read as an empty list, and one that refuses is survived', () => {
  store.value = '{"not":"a list"}'
  assert.deepEqual(readRecents(), [])
  store.value = 'nope'
  assert.deepEqual(readRecents(), [])
  store.value = JSON.stringify(['emote:Kappa', 42, 'nope', { of: 'course' }])
  assert.deepEqual(readRecents(), ['emote:Kappa'])
  store.throws = true
  assert.deepEqual(rememberRecent('emote', 'LUL'), ['emote:LUL', 'emote:Kappa'])
  store.throws = false
})
