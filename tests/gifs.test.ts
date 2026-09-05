import test from 'node:test'
import assert from 'node:assert/strict'
import { formatGifs, giphyUrl, parseGifs } from '../src/shared/gifs'

// The example of the Twitch documentation, `gifs` entry of the PRIVMSG tags.
const URL = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=095d7a5d&ep=v1_gifs_trending&rid=giphy.gif&ct=g'
const TAG = `0-33|joSNxeswxuc74Juo8X|${URL}`

test('reads the entry of a `gifs` tag as Twitch writes it', () => {
  assert.deepEqual(parseGifs(TAG), [{ start: 0, end: 33, id: 'joSNxeswxuc74Juo8X', url: URL }])
  assert.deepEqual(parseGifs(''), [])
  assert.deepEqual(parseGifs('pas un tag'), [])
})

test('an address holding a comma stays whole', () => {
  // The entries are comma-separated and the address carries a query string: only what opens
  // an entry — `<start>-<end>|<id>|` — ends the one before it.
  const comma = 'https://media0.giphy.com/media/abc/giphy.gif?ct=g,h&rid=giphy.gif'
  assert.deepEqual(parseGifs(`4-9|abc|${comma}`), [{ start: 4, end: 9, id: 'abc', url: comma }])
  const two = parseGifs(`0-3|abc|${comma},5-8|def|${URL}`)
  assert.deepEqual(two.map(entry => entry.url), [comma, URL])
  assert.deepEqual(two.map(entry => `${entry.start}-${entry.end}`), ['0-3', '5-8'])
})

test('only a GIPHY address over HTTPS may be shown', () => {
  assert.equal(giphyUrl(URL), URL)
  assert.equal(giphyUrl('https://giphy.com/media/abc/giphy.gif'), 'https://giphy.com/media/abc/giphy.gif')
  // The host is read, never trusted from what precedes it: none of these is GIPHY.
  for (const address of [
    'http://media4.giphy.com/media/abc/giphy.gif',
    'https://giphy.com.evil.example/abc.gif',
    'https://user:pass@media4.giphy.com/abc.gif',
    'https://media4.giphy.evil/abc.gif',
    'javascript:alert(1)',
    'pas une adresse'
  ]) assert.equal(giphyUrl(address), '')
  assert.deepEqual(parseGifs('0-3|abc|https://cdn.example.com/a.gif'), [])
})

test('a tag written back keeps the address it was given', () => {
  assert.equal(formatGifs(parseGifs(TAG)), TAG)
  // What Twitch sends beyond a handful of images in one message is not a tag we understand.
  const many = Array.from({ length: 12 }, (_, index) => `${index * 4}-${index * 4 + 2}|id${index}|${URL}`).join(',')
  assert.equal(parseGifs(many).length, 8)
})
