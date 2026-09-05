import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTwitchEmotes, parseTwitchEmotes } from '../src/main/twitch-emotes-parse'

const payload = {
  data: [
    { id: '25', name: 'Kappa', emote_type: 'globals' },
    { id: '1', name: ':)', emote_type: 'smilies' },
    { id: '354', name: '4Head' }
  ],
  template: 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}'
}

test('reads the global Twitch emotes, punctuation included', () => {
  const emotes = parseTwitchEmotes(payload, 'global')
  assert.deepEqual(emotes.map(emote => emote.name), ['Kappa', ':)', '4Head'])
  assert.equal(emotes[0].scope, 'global')
  assert.equal(emotes[2].type, 'globals')
})

test('rejects invalid ids, names and payloads', () => {
  const emotes = parseTwitchEmotes({
    data: [
      { id: '../evil', name: 'Nope' },
      { id: '25', name: 'deux mots' },
      { id: '26', name: 'Kappa' },
      { id: '27', name: 'Kappa' }
    ]
  }, 'channel')
  assert.deepEqual(emotes, [{ id: '26', name: 'Kappa', scope: 'channel', type: 'other' }])
  assert.deepEqual(parseTwitchEmotes(null, 'global'), [])
  assert.deepEqual(parseTwitchEmotes({ data: 'nope' }, 'global'), [])
})

test('keeps the subscription type of a channel emote', () => {
  const emotes = parseTwitchEmotes({ data: [{ id: '9', name: 'zeratorLove', emote_type: 'subscriptions' }] }, 'channel')
  assert.equal(emotes[0].type, 'subscriptions')
})

test('a channel emote wins over a global emote of the same name', () => {
  const merged = mergeTwitchEmotes(
    [{ id: '25', name: 'Kappa', scope: 'global', type: 'globals' }],
    [{ id: '99', name: 'Kappa', scope: 'channel', type: 'subscriptions' }]
  )
  assert.deepEqual(merged, [{ id: '99', name: 'Kappa', scope: 'channel', type: 'subscriptions' }])
})
