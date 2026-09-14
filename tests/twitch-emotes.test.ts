import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTwitchEmotes, parseTwitchEmotes, parseUserEmotes } from '../src/main/twitch-emotes-parse'

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

// `chat/emotes/user` answers a shape of its own: no `images` per emote, a single top-level
// `template`, and pages behind a cursor. Saved from the Twitch API reference on 2026-09-13.
const userPage = {
  data: [
    { emote_set_id: '', emote_type: 'hypetrain', format: ['static'], id: '304420818', name: 'HypeLol', owner_id: '477339272', scale: ['1.0', '2.0', '3.0'], theme_mode: ['light', 'dark'] },
    { emote_set_id: '301590448', emote_type: 'subscriptions', format: ['static', 'animated'], id: '301428277', name: 'zeratorLove', owner_id: '41719107', scale: ['1.0'], theme_mode: ['dark'] }
  ],
  template: 'https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}',
  pagination: { cursor: 'eyJiIjpudWxsLJxhIjoiIn0gf5' }
}

test('reads the account own emotes, and the cursor the next page hangs off', () => {
  const answer = parseUserEmotes(userPage)
  assert.deepEqual(answer.emotes, [
    { id: '304420818', name: 'HypeLol', scope: 'account', type: 'hypetrain' },
    { id: '301428277', name: 'zeratorLove', scope: 'account', type: 'subscriptions' }
  ])
  assert.equal(answer.cursor, 'eyJiIjpudWxsLJxhIjoiIn0gf5')
})

test('the last page ends the walk, and a payload that is not one ends it too', () => {
  assert.equal(parseUserEmotes({ data: [], template: userPage.template, pagination: {} }).cursor, '')
  assert.deepEqual(parseUserEmotes(null), { emotes: [], cursor: '' })
  assert.equal(parseUserEmotes({ data: [], pagination: { cursor: 'x'.repeat(600) } }).cursor, '')
})

test('the types this endpoint alone answers with are kept rather than flattened', () => {
  // `channelpoints`, `owl2019` and `twofactor` never come back from a channel or the global set.
  // Read as unknown they would all become "other", and the picker would say nothing about them.
  const emotes = parseUserEmotes({ data: [
    { id: '1', name: 'Points', emote_type: 'channelpoints' },
    { id: '2', name: 'Prime', emote_type: 'prime' },
    { id: '3', name: 'Mystery', emote_type: 'something-new' }
  ] }).emotes
  assert.deepEqual(emotes.map(emote => emote.type), ['channelpoints', 'prime', 'other'])
})

test('the global set the account carries is filed as global, not as its own', () => {
  // `chat/emotes/user` answers with everything the account may type, Twitch's own global set
  // included. The picker sorts its tabs by scope: read as the account's, Kappa would leave the
  // Twitch tab and sit under "yours" beside the emotes that were actually earned.
  const emotes = parseUserEmotes({ data: [
    { id: '25', name: 'Kappa', emote_type: 'globals' },
    { id: '1', name: ':)', emote_type: 'smilies' },
    { id: '77', name: 'zeratorLove', emote_type: 'subscriptions' }
  ] }).emotes
  assert.deepEqual(emotes.map(emote => [emote.name, emote.scope]), [['Kappa', 'global'], [':)', 'global'], ['zeratorLove', 'account']])
  // Only the account scope is rewritten: a channel payload naming that type stays the channel's.
  assert.equal(parseTwitchEmotes({ data: [{ id: '25', name: 'Kappa', emote_type: 'globals' }] }, 'channel')[0].scope, 'channel')
})

test('a global emote the account also carries stays in the Twitch tab', () => {
  const merged = mergeTwitchEmotes(
    parseTwitchEmotes({ data: [{ id: '25', name: 'Kappa', emote_type: 'globals' }] }, 'global'),
    parseUserEmotes({ data: [{ id: '25', name: 'Kappa', emote_type: 'globals' }] }).emotes
  )
  assert.deepEqual(merged, [{ id: '25', name: 'Kappa', scope: 'global', type: 'globals' }])
})

test('the room own set wins a name collision with the account own', () => {
  // A subscriber emote of the channel being watched belongs under that channel, where the person
  // is writing. What the account set is for is the emotes of every *other* channel.
  const merged = mergeTwitchEmotes(
    [{ id: '25', name: 'Kappa', scope: 'global', type: 'globals' }],
    [{ id: '77', name: 'zeratorLove', scope: 'account', type: 'subscriptions' }, { id: '78', name: 'ponceHype', scope: 'account', type: 'subscriptions' }],
    [{ id: '77', name: 'zeratorLove', scope: 'channel', type: 'subscriptions' }]
  )
  assert.deepEqual(merged.map(emote => [emote.name, emote.scope]), [['Kappa', 'global'], ['zeratorLove', 'channel'], ['ponceHype', 'account']])
})
