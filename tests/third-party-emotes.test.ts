import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeThirdPartyEmotes, parseBetterTtv, parseFrankerFaceZ, parseSevenTv } from '../src/main/third-party-emotes-parse'

test('normalizes the responses of the three providers and refuses their external URLs', () => {
  const seven = parseSevenTv({ emotes: [{ name: 'Seven', data: { animated: true, host: { url: '//cdn.7tv.app/emote/abc', files: [{ name: '2x.webp' }] } } }] })
  const bttv = parseBetterTtv([{ id: 'def', code: 'Better', imageType: 'gif' }])
  const ffz = parseFrankerFaceZ({ sets: { 1: { emoticons: [
    { name: 'Franker', urls: { 2: '//cdn.frankerfacez.com/emote/12/2' } },
    { name: 'Tracker', urls: { 2: 'https://example.com/tracker.gif' } }
  ] } } })
  assert.deepEqual(seven, [{ code: 'Seven', url: 'https://cdn.7tv.app/emote/abc/2x.webp', source: '7tv', animated: true }])
  assert.deepEqual(bttv, [{ code: 'Better', url: 'https://cdn.betterttv.net/emote/def/2x', source: 'bttv', animated: true }])
  assert.deepEqual(ffz, [{ code: 'Franker', url: 'https://cdn.frankerfacez.com/emote/12/2', source: 'ffz', animated: false }])
})

test('limits the FFZ globals to the default sets', () => {
  const result = parseFrankerFaceZ({ default_sets: [2], sets: {
    1: { emoticons: [{ name: 'Hidden', urls: { 2: '//cdn.frankerfacez.com/emote/1/2' } }] },
    2: { emoticons: [{ name: 'Global', urls: { 2: '//cdn.frankerfacez.com/emote/2/2' } }] }
  } }, true)
  assert.deepEqual(result.map(item => item.code), ['Global'])
})

test('the last merged scope replaces a global code', () => {
  const global = [{ code: 'Same', url: 'https://cdn.frankerfacez.com/emote/1/2', source: 'ffz' as const, animated: false }]
  const room = [{ code: 'Same', url: 'https://cdn.7tv.app/emote/2/2x.webp', source: '7tv' as const, animated: true }]
  assert.deepEqual(mergeThirdPartyEmotes(global, room), room)
})

test('prefers the FrankerFaceZ animated file when it exists', () => {
  const [emote] = parseFrankerFaceZ({ sets: { 1: { emoticons: [
    { name: 'catJAM', urls: { 2: 'https://cdn.frankerfacez.com/emoticon/1/2' }, animated: { 2: 'https://cdn.frankerfacez.com/emoticon/1/animated/2.webp' } }
  ] } } })
  assert.deepEqual(emote, { code: 'catJAM', url: 'https://cdn.frankerfacez.com/emoticon/1/animated/2.webp', source: 'ffz', animated: true })
})

test('falls back to the still image when the animated file is unusable', () => {
  const [emote] = parseFrankerFaceZ({ sets: { 1: { emoticons: [
    { name: 'catJAM', urls: { 2: 'https://cdn.frankerfacez.com/emoticon/1/2' }, animated: { 2: 'https://ailleurs.example/2.webp' } }
  ] } } })
  assert.deepEqual(emote, { code: 'catJAM', url: 'https://cdn.frankerfacez.com/emoticon/1/2', source: 'ffz', animated: false })
})
