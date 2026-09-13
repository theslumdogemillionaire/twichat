import test from 'node:test'
import assert from 'node:assert/strict'
import { cheerSegments, cheermoteIndex, cheerTier } from '../src/renderer/cheers'
import { messageFragments } from '../src/renderer/emotes'
import { parseCheermotes } from '../src/main/twitch-cheermotes-parse'
import type { Cheermote } from '../src/shared/types'

const CDN = 'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated'
const image = (tier: string) => `${CDN}/${tier}/2.gif`

// The shape of Twitch's own documented example, cut down to the fields that are read.
const payload = {
  data: [
    {
      prefix: 'Cheer',
      type: 'global_first_party',
      tiers: [
        { min_bits: 1, id: '1', color: '#979797', images: { dark: { animated: { '1': image('1'), '2': image('1') }, static: {} }, light: {} } },
        { min_bits: 100, id: '100', color: '#9c3ee8', images: { dark: { animated: { '2': image('100') }, static: {} }, light: {} } },
        { min_bits: 1000, id: '1000', color: '#1db2a5', images: { dark: { animated: { '2': image('1000') }, static: {} }, light: {} } }
      ]
    },
    { prefix: 'Kappa', type: 'channel_custom', tiers: [{ min_bits: 1, id: '1', color: '#f43021', images: { dark: { animated: { '2': image('kappa') }, static: {} } } }] },
    // One of Twitch's own, and the reason a prefix cannot be assumed to be letters alone.
    { prefix: '4Head', type: 'global_first_party', tiers: [{ min_bits: 1, id: '1', color: '#f43021', images: { dark: { animated: { '2': image('4head') }, static: {} } } }] }
  ]
}

const cheermotes = () => cheermoteIndex(parseCheermotes(payload))

test('reads the prefixes and their tiers, biggest tier first', () => {
  const parsed = parseCheermotes(payload)
  assert.deepEqual(parsed.map(entry => entry.prefix), ['Cheer', 'Kappa', '4Head'])
  assert.deepEqual(parsed[0].tiers.map(tier => tier.minBits), [1000, 100, 1])
  assert.equal(parsed[0].tiers[0].color, '#1db2a5')
  assert.equal(parsed[0].tiers[0].url, image('1000'))
})

test('drops a tier whose image comes from anywhere but Twitch, and a prefix left with none', () => {
  const parsed = parseCheermotes({
    data: [
      { prefix: 'Evil', tiers: [{ min_bits: 1, color: '#ffffff', images: { dark: { animated: { '2': 'https://evil.test/1.gif' } } } }] },
      { prefix: 'Sneaky', tiers: [{ min_bits: 1, color: '#ffffff', images: { dark: { animated: { '2': 'https://user:pass@d3aqoihi2n8ty8.cloudfront.net/1.gif' } } } }] },
      { prefix: 'Plain', tiers: [{ min_bits: 1, color: '#ffffff', images: { dark: { animated: { '2': `http://d3aqoihi2n8ty8.cloudfront.net/1.gif` } } } }] },
      { prefix: 'bad prefix', tiers: [{ min_bits: 1, color: '#ffffff', images: { dark: { animated: { '2': image('1') } } } }] }
    ]
  })
  assert.deepEqual(parsed, [])
  assert.deepEqual(parseCheermotes(null), [])
  assert.deepEqual(parseCheermotes({ data: 'nope' }), [])
})

test('a colour that is not Twitch’s own hex never reaches the style property', () => {
  const [parsed] = parseCheermotes({
    data: [{ prefix: 'Cheer', tiers: [{ min_bits: 1, color: 'red; background:url(evil)', images: { dark: { animated: { '2': image('1') } } } }] }]
  })
  assert.equal(parsed.tiers[0].color, '')
})

test('the still image stands in where Twitch animated nothing', () => {
  const [parsed] = parseCheermotes({
    data: [{ prefix: 'Cheer', tiers: [{ min_bits: 1, color: '#979797', images: { dark: { animated: {}, static: { '2': image('still') } } } }] }]
  })
  assert.equal(parsed.tiers[0].url, image('still'))
})

test('the tier is the highest one the amount reaches', () => {
  const [cheer] = parseCheermotes(payload)
  assert.equal(cheerTier(cheer, 1)?.minBits, 1)
  assert.equal(cheerTier(cheer, 99)?.minBits, 1)
  assert.equal(cheerTier(cheer, 100)?.minBits, 100)
  assert.equal(cheerTier(cheer, 5000)?.minBits, 1000)
  // Below the lowest tier there is no cheer at all: Twitch would not have counted it.
  const above: Cheermote = { prefix: 'Big', tiers: [{ minBits: 100, color: '', url: image('1') }] }
  assert.equal(cheerTier(above, 50), undefined)
})

test('cuts the cheer tokens out and leaves the rest of the line alone', () => {
  const segments = cheerSegments('merci Cheer100 !', cheermotes())
  assert.deepEqual(segments.map(segment => segment.text), ['merci', ' ', 'Cheer100', ' ', '!'])
  assert.deepEqual(segments[2].cheer, { prefix: 'Cheer', bits: 100, tier: { minBits: 100, color: '#9c3ee8', url: image('100') } })
  assert.equal(segments[0].cheer, undefined)
})

test('the token is matched whole, and without regard to case', () => {
  const index = cheermotes()
  assert.equal(cheerSegments('cheer1000', index)[0].cheer?.tier.minBits, 1000)
  // A prefix without its amount, an amount without its prefix, and a token that merely starts
  // with one: none of them is a cheer.
  for (const token of ['Cheer', '100', 'Cheer100x', 'xCheer100', 'Cheer-100', 'Nope100']) {
    assert.equal(cheerSegments(token, index)[0].cheer, undefined, token)
  }
  // A channel's own prefix counts like Twitch's.
  assert.equal(cheerSegments('Kappa50', index)[0].cheer?.prefix, 'Kappa')
})

test('a prefix that holds digits, and one that opens with one, are cheers like any other', () => {
  const index = cheermotes()
  // `4Head5000` is one of Twitch's own, and no split on "where the digits start" finds it.
  const [found] = cheerSegments('4Head5000', index)
  assert.equal(found.cheer?.prefix, '4Head')
  assert.equal(found.cheer?.bits, 5000)
  // Digits with no letter in them are an amount, never a prefix.
  for (const token of ['100', '4Head', '5000Head']) assert.equal(cheerSegments(token, index)[0].cheer, undefined, token)
})

test('a longer prefix is never mistaken for a shorter one it starts with', () => {
  const index = cheermoteIndex(parseCheermotes({
    data: [
      { prefix: 'Cheer', tiers: [{ min_bits: 1, color: '#979797', images: { dark: { animated: { '2': image('1') } } } }] },
      { prefix: 'Cheerwhal', tiers: [{ min_bits: 1, color: '#1db2a5', images: { dark: { animated: { '2': image('whal') } } } }] }
    ]
  }))
  assert.equal(cheerSegments('Cheerwhal100', index)[0].cheer?.prefix, 'Cheerwhal')
  assert.equal(cheerSegments('Cheer100', index)[0].cheer?.prefix, 'Cheer')
  // The cut never reaches back past the digits, so this is not `Cheer` cheering `whal100`.
  const unknown = cheermoteIndex(parseCheermotes({ data: [{ prefix: 'Cheer', tiers: [{ min_bits: 1, color: '', images: { dark: { animated: { '2': image('1') } } } }] }] }))
  assert.equal(cheerSegments('Cheerwhal100', unknown)[0].cheer, undefined)
})

test('without the room’s prefixes, or without a bits tag to hand them over, a cheer stays text', () => {
  assert.deepEqual(cheerSegments('Cheer100'), [{ text: 'Cheer100' }])
  assert.deepEqual(cheerSegments('Cheer100', new Map()), [{ text: 'Cheer100' }])
})

/**
 * The one that matters. Twitch counts the `emotes` offsets in code points over the body as it was
 * typed, cheer tokens included. `messageFragments` spends those offsets first and hands back the
 * uncovered text; only then may a cheer be replaced. Reversing the two moves every range after
 * the first cheer and paints the wrong words as emotes.
 */
test('an emote and a cheermote in one message: the offsets are read before the cheers are cut', () => {
  const body = 'Cheer100 Kappa merci Cheer1000'
  // `Kappa` sits at code points 9-13 of the body above — counted with the cheer tokens in place.
  assert.equal(Array.from(body).slice(9, 14).join(''), 'Kappa')
  const fragments = messageFragments(body, '25:9-13')
  assert.deepEqual(fragments.map(fragment => fragment.type === 'emote' ? `emote:${fragment.id}:${fragment.text}` : fragment.text), [
    'Cheer100 ', 'emote:25:Kappa', ' merci Cheer1000'
  ])
  // The cheers are then cut out of the text fragments alone, which cannot move an offset.
  const index = cheermotes()
  const painted = fragments.flatMap(fragment => fragment.type === 'text'
    ? cheerSegments(fragment.text, index).map(segment => segment.cheer ? `cheer:${segment.cheer.bits}` : segment.text)
    : [`emote:${fragment.text}`])
  assert.deepEqual(painted, ['cheer:100', ' ', 'emote:Kappa', ' ', 'merci', ' ', 'cheer:1000'])
})

test('a cheer inside a message whose emote follows it keeps that emote on its own word', () => {
  // `Cheer1` is one character shorter than `Cheer100`: a substitution before the walk would have
  // shifted this range and covered `LU` instead.
  const body = 'Cheer1 LUL'
  const fragments = messageFragments(body, '425618:7-9')
  const emote = fragments.find(fragment => fragment.type === 'emote')
  assert.equal(emote?.text, 'LUL')
  const [first] = cheerSegments(fragments[0].text, cheermotes())
  assert.equal(first.cheer?.bits, 1)
})
