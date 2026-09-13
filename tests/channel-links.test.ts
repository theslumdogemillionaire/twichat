import test from 'node:test'
import assert from 'node:assert/strict'
import { channelFromUrl, channelSegments } from '../src/renderer/links'

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

test('a twitch address names the room it points at', () => {
  // The form a shoutout bot posts, with and without the host it leaves implicit.
  assert.equal(channelFromUrl('https://twitch.tv/studio_nova'), 'studio_nova')
  assert.equal(channelFromUrl('https://www.twitch.tv/studio_nova'), 'studio_nova')
  assert.equal(channelFromUrl('https://m.twitch.tv/studio_nova'), 'studio_nova')
  assert.equal(channelFromUrl('https://twitch.tv/studio_nova/'), 'studio_nova')
  // Written how a person writes it; opened how Twitch stores it.
  assert.equal(channelFromUrl('https://Twitch.tv/Studio_Nova'), 'studio_nova')
  // The tracking a bot appends says nothing about which room this is.
  assert.equal(channelFromUrl('https://twitch.tv/studio_nova?tt_content=text_link'), 'studio_nova')
  assert.equal(channelFromUrl('https://twitch.tv/studio_nova#chat'), 'studio_nova')
})

test('an address that is not a channel page stays a link', () => {
  for (const url of [
    // Twitch's own pages that read exactly like a login.
    'https://twitch.tv/directory', 'https://twitch.tv/videos', 'https://twitch.tv/settings',
    // More than one segment: a page, not a room.
    'https://twitch.tv/videos/1234', 'https://twitch.tv/popout/studio_nova/chat',
    'https://twitch.tv/directory/game/Chess', 'https://twitch.tv/',
    // Another host, including one dressed up as Twitch.
    'https://youtube.com/studio_nova', 'https://twitch.tv.evil.example/studio_nova',
    'https://nottwitch.tv/studio_nova',
    // A login Twitch would never hand out, and a scheme we never open.
    'https://twitch.tv/' + 'a'.repeat(26), 'https://twitch.tv/studio-nova',
    'javascript:alert(1)', 'not a url at all'
  ]) {
    assert.equal(channelFromUrl(url), '', url)
  }
})

test('a bare twitch address names a room, the way a hash does', () => {
  // What a bot writes when it does not spell out the scheme. `linkSegments` leaves this one
  // alone on purpose, so before now it was plain text going nowhere.
  assert.deepEqual(cut('allez voir twitch.tv/studio_nova !'),
    ['allez voir ', ['twitch.tv/studio_nova', 'studio_nova'], ' !'])
  assert.deepEqual(cut('www.twitch.tv/Studio_Nova'), [['www.twitch.tv/Studio_Nova', 'studio_nova']])
  assert.deepEqual(cut('m.twitch.tv/studio_nova'), [['m.twitch.tv/studio_nova', 'studio_nova']])
  // Both forms in one message, each cut where it stands.
  assert.deepEqual(cut('#alpha et twitch.tv/beta'),
    [['#alpha', 'alpha'], ' et ', ['twitch.tv/beta', 'beta']])
})

test('an address already carrying its scheme is left to the links', () => {
  // With the links on, `linkSegments` has taken this out long before; with the links off, the
  // reader asked for no addresses at all. Cutting the tail out of one would serve neither.
  for (const text of ['https://twitch.tv/studio_nova', 'http://www.twitch.tv/studio_nova',
                      'mirror.twitch.tv/studio_nova', 'contact@twitch.tv/studio_nova']) {
    assert.deepEqual(channelSegments(text), [{ text }], text)
  }
})

test('a bare address that is not a channel page is left alone', () => {
  for (const text of ['twitch.tv/directory', 'twitch.tv/settings', 'twitch.tv/videos/1234',
                      'twitch.tv/studio_nova/about', 'twitch.tv/', 'twitch.tv']) {
    assert.deepEqual(channelSegments(text), [{ text }], text)
  }
})
