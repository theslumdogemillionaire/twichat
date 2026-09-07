import test from 'node:test'
import assert from 'node:assert/strict'
import { channelSegments } from '../src/renderer/links'

const cut = (text: string) => channelSegments(text).map(segment => segment.channel ? [segment.text, segment.channel] : segment.text)

test('a channel named in a message becomes a place to go', () => {
  assert.deepEqual(cut('on se retrouve sur #studio_nova ce soir'),
    ['on se retrouve sur ', ['#studio_nova', 'studio_nova'], ' ce soir'])
  // Twitch logins are lowercase: what is shown stays what was written, what is opened is the room.
  assert.deepEqual(cut('#Studio_Nova'), [['#Studio_Nova', 'studio_nova']])
  assert.deepEqual(cut('#a et #b'), [['#a', 'a'], ' et ', ['#b', 'b']])
})

test('a hash that names no channel is left as text', () => {
  // The three ways a `#` shows up without meaning a room.
  for (const text of ['écrit en C# depuis 2019', 'ticket n#1', 'rien##', 'juste un # seul', 'il est #1 du classement']) {
    assert.deepEqual(channelSegments(text), [{ text }], text)
  }
})

test('a hex colour is a channel, because nothing tells them apart', () => {
  // `#ff8800` is a valid Twitch login. Refusing it would need a rule that also refuses a real
  // channel called `abcdef`; opening a room nobody meant to open is the cheaper mistake.
  assert.deepEqual(cut('la couleur #ff8800'), ['la couleur ', ['#ff8800', 'ff8800']])
})

test('a name longer than a Twitch login is not cut down to one that exists', () => {
  // `#studio_nova_bis_ter` must not open `#studio_nova_bis_te`: 25 characters is the limit,
  // and a name that runs past it is not a channel at all.
  const long = `#${'a'.repeat(26)}`
  assert.deepEqual(channelSegments(long), [{ text: long }])
  assert.deepEqual(cut(`#${'a'.repeat(25)}`), [[`#${'a'.repeat(25)}`, 'a'.repeat(25)]])
})

test('a message with no hash is handed back whole', () => {
  assert.deepEqual(channelSegments('bonjour'), [{ text: 'bonjour' }])
  assert.deepEqual(channelSegments(''), [{ text: '' }])
})
