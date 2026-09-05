import test from 'node:test'
import assert from 'node:assert/strict'
import { messageFragments, twitchEmoteUrl } from '../src/renderer/emotes'
import type { ThirdPartyEmote } from '../src/shared/types'

test('replaces a Twitch emote with its CDN image without losing the surrounding text', () => {
  assert.deepEqual(messageFragments('Hello Kappa !', '25:6-10'), [
    { type: 'text', text: 'Hello ' },
    { type: 'emote', id: '25', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', source: 'twitch' },
    { type: 'text', text: ' !' }
  ])
})

test('handles several occurrences and several ids', () => {
  assert.deepEqual(messageFragments('Kappa LUL Kappa', '25:0-4,10-14/425618:6-8').map(fragment => fragment.type === 'emote' ? `${fragment.id}:${fragment.text}` : fragment.text), [
    '25:Kappa', ' ', '425618:LUL', ' ', '25:Kappa'
  ])
})

test('reads the positions as Unicode code points', () => {
  const fragments = messageFragments('😀 Kappa', '25:2-6')
  assert.equal(fragments[0].text, '😀 ')
  assert.deepEqual(fragments[1], { type: 'emote', id: '25', text: 'Kappa', url: twitchEmoteUrl('25'), source: 'twitch' })
})

test('renders 7TV, BetterTTV and FrankerFaceZ emotes as whole words', () => {
  const emotes = new Map<string, ThirdPartyEmote>([
    ['OMEGALUL', { code: 'OMEGALUL', url: 'https://cdn.7tv.app/emote/id/2x.webp', source: '7tv', animated: true }],
    ['monkaS', { code: 'monkaS', url: 'https://cdn.betterttv.net/emote/id/2x', source: 'bttv', animated: false }]
  ])
  const fragments = messageFragments('wow OMEGALUL monkaS!', '', emotes)
  const rendered = fragments.filter(fragment => fragment.type === 'emote')
  assert.equal(rendered.length, 1)
  assert.deepEqual(rendered[0], { type: 'emote', text: 'OMEGALUL', url: 'https://cdn.7tv.app/emote/id/2x.webp', source: '7tv' })
})

test('a Twitch range keeps priority over an identical third-party code', () => {
  const thirdParty = new Map<string, ThirdPartyEmote>([['Kappa', { code: 'Kappa', url: 'https://cdn.7tv.app/emote/id/2x.webp', source: '7tv', animated: false }]])
  const fragments = messageFragments('Kappa Kappa', '25:0-4', thirdParty)
  assert.deepEqual(fragments.filter(fragment => fragment.type === 'emote').map(fragment => fragment.source), ['twitch', '7tv'])
})

test('ignores invalid ranges or ids', () => {
  assert.deepEqual(messageFragments('Kappa', 'bad!:0-4/25:9-20'), [{ type: 'text', text: 'Kappa' }])
  assert.equal(twitchEmoteUrl('../x'), '')
})

test('resolves Twitch emotes by name in a sent message that carries no tag', () => {
  const own = new Map([['PopNemo', 'emotesv2_abc'], ['Kappa', '25']])
  const fragments = messageFragments('salut PopNemo', '', undefined, own)
  assert.deepEqual(fragments, [
    { type: 'text', text: 'salut' },
    { type: 'text', text: ' ' },
    { type: 'emote', id: 'emotesv2_abc', text: 'PopNemo', url: twitchEmoteUrl('emotesv2_abc'), source: 'twitch' }
  ])
})

test('a Twitch emote from the sender wins over a third-party emote with the same code', () => {
  const thirdParty = new Map<string, ThirdPartyEmote>([['Kappa', { code: 'Kappa', url: 'https://cdn.7tv.app/emote/id/2x.webp', source: '7tv', animated: false }]])
  const fragments = messageFragments('Kappa', '', thirdParty, new Map([['Kappa', '25']]))
  assert.deepEqual(fragments.map(fragment => fragment.type === 'emote' ? fragment.source : fragment.text), ['twitch'])
})

test('ignores an invalid own-emote id instead of forging a URL', () => {
  assert.deepEqual(messageFragments('bad', '', undefined, new Map([['bad', '../evil']])), [{ type: 'text', text: 'bad' }])
})

// The example of the Twitch documentation: the body is the title of the GIF, the tag its address.
const GIF_URL = 'https://media4.giphy.com/media/joSNxeswxuc74Juo8X/giphy.gif?cid=095d7a5d&ep=v1_gifs_trending&rid=giphy.gif&ct=g'

test('a GIF replaces the title Twitch wrote in the body', () => {
  const body = '[Y A Y Yes GIF by Djemilah Birnie]'
  // The offsets are inclusive and counted in code points, as for the emotes: 34 characters, 0-33.
  assert.equal(Array.from(body).length, 34)
  assert.deepEqual(messageFragments(body, '', undefined, undefined, `0-33|joSNxeswxuc74Juo8X|${GIF_URL}`), [
    { type: 'gif', id: 'joSNxeswxuc74Juo8X', text: body, url: GIF_URL }
  ])
})

test('a GIF shares the message with the text and the emotes around it', () => {
  const fragments = messageFragments('Kappa [Yes GIF] hop', '25:0-4', undefined, undefined, `6-14|abc|${GIF_URL}`)
  assert.deepEqual(fragments.map(fragment => fragment.type === 'text' ? fragment.text : `${fragment.type}:${fragment.text}`), [
    'emote:Kappa', ' ', 'gif:[Yes GIF]', ' hop'
  ])
})

test('a GIF whose address is not GIPHY, or whose range is outside the body, stays text', () => {
  const body = '[Yes GIF]'
  assert.deepEqual(messageFragments(body, '', undefined, undefined, '0-8|abc|https://cdn.example.com/a.gif'), [{ type: 'text', text: body }])
  assert.deepEqual(messageFragments(body, '', undefined, undefined, `0-40|abc|${GIF_URL}`), [{ type: 'text', text: body }])
})
