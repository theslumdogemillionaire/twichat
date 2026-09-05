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
