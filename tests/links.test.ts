import test from 'node:test'
import assert from 'node:assert/strict'
import { linkSegments, linkTarget } from '../src/renderer/links'

/** The text of the segments, a link marked with `[…]`: reads the split at a glance. */
const shape = (text: string) => linkSegments(text).map(segment => segment.url ? `[${segment.text}]` : segment.text).join('')
const urls = (text: string) => linkSegments(text).flatMap(segment => segment.url ?? [])

test('an address becomes a link, the rest of the message stays as written', () => {
  assert.equal(shape('regarde https://twitch.tv/zerator maintenant'), 'regarde [https://twitch.tv/zerator] maintenant')
  assert.equal(shape('www.twitch.tv'), '[www.twitch.tv]')
  assert.equal(shape('http://example.com'), '[http://example.com]')
  // A `www.` address leaves its scheme implicit; the click still needs one.
  assert.deepEqual(urls('www.twitch.tv/zerator'), ['https://www.twitch.tv/zerator'])
  assert.equal(shape('deux https://a.example et https://b.example'), 'deux [https://a.example] et [https://b.example]')
  assert.deepEqual(linkSegments('rien à cliquer'), [{ text: 'rien à cliquer' }])
  assert.deepEqual(linkSegments(''), [{ text: '' }])
})

test('a bare domain is not a link', () => {
  // Every one of these would pass for a domain, and none of them is one.
  for (const text of ['node.js', 'e.g. ça', '1.5', 'twitch.tv', 'fichier.txt']) assert.deepEqual(urls(text), [])
})

test('the sentence keeps its own punctuation', () => {
  assert.equal(shape('vu ici : https://example.com/a.'), 'vu ici : [https://example.com/a].')
  assert.equal(shape('(https://example.com)'), '([https://example.com])')
  assert.equal(shape('https://example.com, puis'), '[https://example.com], puis')
  assert.equal(shape('« https://example.com »'), '« [https://example.com] »')
  // A parenthesis the address opened belongs to the address.
  assert.equal(shape('https://en.wikipedia.org/wiki/Twitch_(service)'), '[https://en.wikipedia.org/wiki/Twitch_(service)]')
})

test('only an address that can be opened becomes one', () => {
  // Anything that is not HTTP stays plain text: a scheme of its own would run something.
  for (const text of ['javascript:alert(1)', 'file:///etc/passwd', 'twichat://auth', 'mailto:qui@example.com']) assert.deepEqual(urls(text), [])
  // Credentials in the address are the oldest way of dressing one host up as another.
  assert.deepEqual(urls('https://twitch.tv@evil.example/a'), [])
  assert.equal(linkTarget('https://user:pw@example.com'), '')
  assert.equal(linkTarget('https://example.com/a'), 'https://example.com/a')
  assert.equal(linkTarget('WWW.Example.COM'), 'https://www.example.com/')
})

test('a link only starts on a word boundary', () => {
  assert.deepEqual(urls('bonjourwww.example.com'), [])
  assert.deepEqual(urls('nom@www.example.com'), [])
  // Attached to punctuation, on the other hand, it is one.
  assert.deepEqual(urls('(https://example.com/a)'), ['https://example.com/a'])
})

test('the scan always moves forward', () => {
  // A match trimmed down to almost nothing must not be found again forever.
  assert.equal(shape('www.. www...'), 'www.. www...')
  assert.equal(shape('https:// https://x.example'), 'https:// [https://x.example]')
})
