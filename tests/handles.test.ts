import test from 'node:test'
import assert from 'node:assert/strict'
import { handleSegments } from '../src/renderer/links'

const cut = (text: string) => handleSegments(text).map(segment => segment.login ? [segment.text, segment.login] : segment.text)

test('a viewer named with an at sign becomes a way to their card', () => {
  assert.deepEqual(cut('bien vu @studio_nova, on regarde'),
    ['bien vu ', ['@studio_nova', 'studio_nova'], ', on regarde'])
  // Twitch logins are lowercase: what is shown stays what was written, what opens is their card.
  assert.deepEqual(cut('@Studio_Nova'), [['@Studio_Nova', 'studio_nova']])
  assert.deepEqual(cut('@a et @b'), [['@a', 'a'], ' et ', ['@b', 'b']])
})

test('an at sign that names nobody is left as text', () => {
  // An address carries the only other `@` a message is likely to hold.
  for (const text of ['écris à bonjour@studio-nova.fr', 'un @ tout seul', 'deux @@ de suite', 'café @ 15h']) {
    assert.deepEqual(handleSegments(text), [{ text }], text)
  }
})

test('a handle is not cut out of a longer word', () => {
  // The nickname has to stand on its own, exactly as the mention highlight requires.
  assert.deepEqual(handleSegments('mail@studio_nova'), [{ text: 'mail@studio_nova' }])
  assert.deepEqual(handleSegments('@studio_nova2000_et_des_poussieres_encore'), [{ text: '@studio_nova2000_et_des_poussieres_encore' }])
})

test('a name longer than a Twitch login is not cut down to one that exists', () => {
  // `@studio_nova_bis_ter` must not open `@studio_nova_bis_te`: 25 characters is the limit,
  // and a name that runs past it names nobody.
  const long = `@${'a'.repeat(26)}`
  assert.deepEqual(handleSegments(long), [{ text: long }])
  assert.deepEqual(cut(`@${'a'.repeat(25)}`), [[`@${'a'.repeat(25)}`, 'a'.repeat(25)]])
})

test('a nickname written in another script names nobody', () => {
  // The card opens on the login, and Twitch keeps that one Latin: the display name is not it.
  assert.deepEqual(handleSegments('salut @Ϩ_ϩ'), [{ text: 'salut @Ϩ_ϩ' }])
})

test('digits alone stay a handle, unlike a channel', () => {
  // `#1` is a rank; `@123` is a login and nothing else is written that way.
  assert.deepEqual(cut('merci @123'), ['merci ', ['@123', '123']])
})

test('a message with no at sign is handed back whole', () => {
  assert.deepEqual(handleSegments('bonjour'), [{ text: 'bonjour' }])
  assert.deepEqual(handleSegments(''), [{ text: '' }])
})
